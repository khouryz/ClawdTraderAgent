/**
 * AccountManager - Top-level orchestrator for multi-account mode
 * 
 * Responsibilities:
 * - Discover and load account configs from accounts/ directory
 * - Build single SharedPriceProvider for all accounts (one Databento subscription)
 * - Instantiate AccountInstance for each account
 * - Start all accounts with error isolation (one failure doesn't affect others)
 * - Handle graceful shutdown (SIGINT/SIGTERM)
 * - Optional master Telegram channel for cross-account summary
 */

const fs = require('fs');
const path = require('path');
const AccountInstance = require('./AccountInstance');
const SharedPriceProvider = require('../data/SharedPriceProvider');
const { loadAccountConfigs } = require('../utils/account_config_loader');
const Notifications = require('../utils/notifications');
const logger = require('../utils/logger');

class AccountManager {
  constructor(options = {}) {
    this.accountsDir = options.accountsDir || process.env.ACCOUNTS_DIR || './accounts';
    this.globalConfig = this._loadGlobalConfig();
    this.sharedPriceProvider = null;
    this.instances = new Map(); // accountId -> AccountInstance
    this.masterNotifications = null;
    this._isShuttingDown = false;
  }

  /**
   * Load global process-level config (timezone, AI, Databento, etc.)
   */
  _loadGlobalConfig() {
    return {
      env: process.env.TRADOVATE_ENV || 'demo',
      timezone: process.env.TIMEZONE || 'America/Los_Angeles',
      tradingStartHour: parseInt(process.env.TRADING_START_HOUR) || 6,
      tradingStartMinute: parseInt(process.env.TRADING_START_MINUTE) || 30,
      tradingEndHour: parseInt(process.env.TRADING_END_HOUR) || 13,
      tradingEndMinute: parseInt(process.env.TRADING_END_MINUTE) || 0,
      avoidLunch: process.env.AVOID_LUNCH !== 'false',
      aiConfirmationEnabled: process.env.AI_CONFIRMATION_ENABLED === 'true',
      aiProvider: process.env.AI_PROVIDER || 'anthropic',
      aiApiKey: process.env.AI_API_KEY || '',
      aiModel: process.env.AI_MODEL || null,
      aiConfidenceThreshold: parseInt(process.env.AI_CONFIDENCE_THRESHOLD) || 70,
      aiTimeout: parseInt(process.env.AI_TIMEOUT) || 5000,
      aiDefaultAction: process.env.AI_DEFAULT_ACTION || 'confirm',
      databentoApiKey: process.env.DATABENTO_API_KEY || '',
      databentoDataset: process.env.DATABENTO_DATASET || 'GLBX.MDP3',
      pythonPath: process.env.PYTHON_PATH || 'python',
      // Note: trade ticks no longer subscribed. Slippage guard + real-time BE
      // now use the 1s bar close (matches backtester exactly).
      postReconnectCooldownMins: parseInt(process.env.POST_RECONNECT_COOLDOWN_MINS) || 10,
      postReconnectMinDroppedBars: parseInt(process.env.POST_RECONNECT_MIN_DROPPED_BARS) || 3,
      maxSimultaneousPositions: parseInt(process.env.MAX_SIMULTANEOUS_POSITIONS) || 2,
      // Account-level daily loss halt fallback (per-account ACCOUNT_DAILY_LOSS_LIMIT wins). 0 = off.
      accountDailyLossLimit: parseFloat(process.env.ACCOUNT_DAILY_LOSS_LIMIT) || 0,
    };
  }

  /**
   * Start all accounts
   */
  async start() {
    this._logStartupBanner();

    // 1. Load account configs
    const configs = this._loadAccountConfigs();
    if (configs.length === 0) {
      throw new Error('No valid account configs found in ' + this.accountsDir);
    }
    logger.info(`[AccountManager] Loaded ${configs.length} account(s): ${configs.map(c => c.accountId).join(', ')}`);
    this._logAccountPlan(configs);

    // 2. Build SharedPriceProvider (single Databento subscription for all)
    this.sharedPriceProvider = await this._buildSharedPriceProvider(configs);

    // 3. Initialize master notifications (optional)
    if (process.env.MASTER_TELEGRAM_BOT_TOKEN && process.env.MASTER_TELEGRAM_CHAT_ID) {
      this.masterNotifications = new Notifications({
        telegramToken: process.env.MASTER_TELEGRAM_BOT_TOKEN,
        telegramChatId: process.env.MASTER_TELEGRAM_CHAT_ID,
        accountId: 'MASTER',
        botName: 'AccountManager',
      });
      logger.info('[AccountManager] Master Telegram channel configured');
    }

    // 4. Start each AccountInstance in parallel (error isolation)
    // First account is the "primary logger" for data/signal logs (avoids duplicate strategy logs)
    const startResults = await Promise.allSettled(
      configs.map(async (cfg, idx) => {
        const dataDir = path.join('./data/accounts', cfg.accountId);
        fs.mkdirSync(dataDir, { recursive: true });

        const instance = new AccountInstance({
          ...cfg,
          sharedPriceProvider: this.sharedPriceProvider,
          globalConfig: this.globalConfig,
          dataDir,
          isPrimaryLogger: idx === 0,
        });

        this.instances.set(cfg.accountId, instance);
        await instance.start();
        return cfg.accountId;
      })
    );

    // 5. Report startup results — verbose, exchange-resolved ACTIVATION SUMMARY.
    //    Confirms every login is live and counts the sub-accounts ACTUALLY resolved
    //    against Tradovate (authoritative; the plan above is only what .env requested).
    let started = 0, failed = 0, liveSubs = 0, liveMirrorLogins = 0, liveRunners = 0;
    const allInstruments = new Set();
    const summaryLines = [];
    for (const r of startResults) {
      if (r.status === 'fulfilled') {
        started++;
        const inst = this.instances.get(r.value);
        const subs = inst && Array.isArray(inst.subAccounts) ? inst.subAccounts : [];
        liveSubs += subs.length;
        if (subs.length > 1) liveMirrorLogins++;
        const mode = subs.length > 1 ? `🪞 MIRROR ×${subs.length}` : 'single';
        const subList = subs.map((s, i) => `${i === 0 ? 'PRIMARY' : 'mirror'}:${s.name}(${s.id})`).join(', ');
        // List the ACTUAL instrument engines running on this login (each is an
        // independent runner: own data feed, own orders, own risk state). This is
        // the per-login proof that multi-instrument is live where requested and
        // single-instrument elsewhere — e.g. "MNQ+MES" on one login, "MNQ" on another.
        const instrNames = inst ? [...inst.runners.keys()] : [];
        liveRunners += instrNames.length;
        instrNames.forEach((n) => allInstruments.add(n));
        const instrLabel = instrNames.length ? instrNames.join('+') : 'none';
        summaryLines.push(`   ✅ login "${r.value}" LIVE — ${mode} [${subList}] — ${instrNames.length} instrument(s): ${instrLabel}`);
      } else {
        failed++;
        summaryLines.push(`   ❌ a login FAILED to start: ${r.reason && r.reason.message ? r.reason.message : r.reason}`);
        logger.error(`[AccountManager] Failed to start account: ${r.reason && r.reason.message ? r.reason.message : r.reason}`);
      }
    }

    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.success(`[AccountManager] ✅ ACTIVATION SUMMARY — ${started}/${configs.length} login(s) LIVE, ${failed} failed`);
    for (const line of summaryLines) logger.success(line);
    logger.info('   ────────────────────────────────────');
    logger.success(`[AccountManager] LIVE TOTALS → ${started} login(s) active, ` +
      `${liveMirrorLogins} mirroring, ${liveSubs} sub-account(s) now trading`);
    logger.success(`[AccountManager] INSTRUMENT TOTALS → ${liveRunners} engine(s) across ${started} login(s) | distinct instruments: ${[...allInstruments].join(', ') || 'none'} (each engine = own feed + own orders + own risk state)`);
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    if (this.masterNotifications) {
      await this.masterNotifications.send(
        `🚀 <b>ACCOUNT MANAGER STARTED</b>\n` +
        `Accounts: ${started} started, ${failed} failed\n` +
        `Running: ${[...this.instances.keys()].join(', ')}`
      ).catch(() => {});
    }

    // 6. Process-level error handlers (don't exit on uncaught exceptions).
    //    Always log the full stack — a bare `${err}` (as before) drops the stack and
    //    leaves a crash undebuggable (the 2026-06-15 toFixed unhandledRejection had no
    //    location). Surface to the master channel so a silent background throw is seen.
    const logFatal = (kind, err) => {
      const stack = (err && err.stack) ? err.stack : String(err);
      logger.error(`[AccountManager] ${kind} (non-fatal, process continues): ${stack}`);
      if (this.masterNotifications) {
        this.masterNotifications.send(`🐞 <b>${kind}</b>\n<code>${String((err && err.message) || err).slice(0, 300)}</code>\n<i>Process continues; check logs.</i>`).catch(() => {});
      }
    };
    process.on('uncaughtException', (err) => logFatal('uncaughtException', err));
    process.on('unhandledRejection', (err) => logFatal('unhandledRejection', err));

    // 7. Graceful shutdown handlers
    const shutdown = () => this.shutdown();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  /**
   * Load account configs from directory
   */
  _loadAccountConfigs() {
    return loadAccountConfigs(this.accountsDir);
  }

  /**
   * Build single SharedPriceProvider for all accounts
   */
  async _buildSharedPriceProvider(configs) {
    // Collect all unique symbols across all accounts
    const symbols = new Set();
    for (const cfg of configs) {
      for (const inst of cfg.instruments) {
        symbols.add(inst.databentoSymbol || `${inst.baseSymbol}.FUT`);
      }
    }

    const provider = new SharedPriceProvider({
      apiKey: this.globalConfig.databentoApiKey,
      symbols: [...symbols],
      schema: 'ohlcv-1m',
      dataset: this.globalConfig.databentoDataset || 'GLBX.MDP3',
      pythonPath: this.globalConfig.pythonPath || 'python',
    });

    // Increase max listeners to accommodate N accounts (default is 10)
    provider.setMaxListeners(configs.length * 5 + 10);

    await provider.startLiveStream();
    logger.success(`[AccountManager] Shared Databento stream: ${[...symbols].join(', ')}`);

    return provider;
  }

  /**
   * Graceful shutdown of all accounts
   */
  async shutdown() {
    if (this._isShuttingDown) return;
    this._isShuttingDown = true;

    logger.info('[AccountManager] Shutting down...');

    // Shutdown all instances in parallel
    await Promise.allSettled(
      [...this.instances.values()].map(i => i.shutdown())
    );

    // Stop shared price provider
    if (this.sharedPriceProvider) {
      this.sharedPriceProvider.stop();
    }

    // Master notification
    if (this.masterNotifications) {
      await this.masterNotifications.send('🛑 <b>ACCOUNT MANAGER STOPPED</b>').catch(() => {});
    }

    logger.info('[AccountManager] Shutdown complete');
    process.exit(0);
  }

  _logStartupBanner() {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('🤖 AccountManager Starting (Multi-Account Mode)');
    logger.info(`Accounts dir: ${this.accountsDir}`);
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  /**
   * Verbose pre-flight plan from CONFIG (before any login): how many account
   * logins, how many sub-accounts each will mirror across, and which instruments
   * each runs. The authoritative sub-account counts (resolved against the live API)
   * are logged again per-login by AccountInstance and summed in the post-start
   * activation summary. Counts here are what the .env files REQUEST.
   */
  _logAccountPlan(configs) {
    const gate = process.env.MULTI_ACCOUNT === 'true'
      ? 'MULTI_ACCOUNT=true'
      : (process.env.ACCOUNTS_DIR ? `ACCOUNTS_DIR=${process.env.ACCOUNTS_DIR}` : 'auto-detected');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`[AccountManager] 📋 STARTUP PLAN — multi-account fanout ACTIVE (${gate})`);
    logger.info(`[AccountManager] ${configs.length} account login(s) to activate:`);

    let totalSubsConfigured = 0;
    let mirrorLogins = 0;
    configs.forEach((cfg, i) => {
      const names = (Array.isArray(cfg.credentials.accountNames) && cfg.credentials.accountNames.length)
        ? cfg.credentials.accountNames
        : (cfg.credentials.accountName ? [cfg.credentials.accountName] : []);
      totalSubsConfigured += names.length;
      if (names.length > 1) mirrorLogins++;
      const mode = names.length > 1 ? `🪞 MIRROR FANOUT ×${names.length}` : '1× single sub-account';
      const primary = names[0] || '(auto-select first active)';
      const mirrors = names.length > 1 ? `  → mirrors to: ${names.slice(1).join(', ')}` : '';
      const instr = (cfg.instruments || []).map(x => `${x.baseSymbol}/${x.strategy}`).join(', ') || '(none)';
      logger.info(`   ${i + 1}) login "${cfg.accountId}"  env=${cfg.credentials.env}  ${mode}`);
      logger.info(`        primary sub-account: ${primary}${mirrors}`);
      logger.info(`        instrument(s): ${instr}`);
    });

    logger.info('   ────────────────────────────────────');
    logger.info(`[AccountManager] CONFIGURED TOTALS → ${configs.length} login(s), ` +
      `${mirrorLogins} in mirror mode, ${totalSubsConfigured} sub-account(s) overall`);
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
}

module.exports = AccountManager;
