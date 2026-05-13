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
      tickStreamEnabled: process.env.TICK_STREAM_ENABLED !== 'false',
      postReconnectCooldownMins: parseInt(process.env.POST_RECONNECT_COOLDOWN_MINS) || 10,
      postReconnectMinDroppedBars: parseInt(process.env.POST_RECONNECT_MIN_DROPPED_BARS) || 3,
      maxSimultaneousPositions: parseInt(process.env.MAX_SIMULTANEOUS_POSITIONS) || 2,
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
    const startResults = await Promise.allSettled(
      configs.map(async (cfg) => {
        const dataDir = path.join('./data/accounts', cfg.accountId);
        fs.mkdirSync(dataDir, { recursive: true });

        const instance = new AccountInstance({
          ...cfg,
          sharedPriceProvider: this.sharedPriceProvider,
          globalConfig: this.globalConfig,
          dataDir,
        });

        this.instances.set(cfg.accountId, instance);
        await instance.start();
        return cfg.accountId;
      })
    );

    // 5. Report startup results
    let started = 0, failed = 0;
    for (const r of startResults) {
      if (r.status === 'fulfilled') started++;
      else {
        failed++;
        logger.error(`[AccountManager] Failed to start account: ${r.reason.message}`);
      }
    }

    logger.success(`[AccountManager] Startup complete: ${started} started, ${failed} failed`);

    if (this.masterNotifications) {
      await this.masterNotifications.send(
        `🚀 <b>ACCOUNT MANAGER STARTED</b>\n` +
        `Accounts: ${started} started, ${failed} failed\n` +
        `Running: ${[...this.instances.keys()].join(', ')}`
      ).catch(() => {});
    }

    // 6. Process-level error handlers (don't exit on uncaught exceptions)
    process.on('uncaughtException', (err) => {
      logger.error(`[AccountManager] uncaughtException: ${err.stack}`);
    });
    process.on('unhandledRejection', (err) => {
      logger.error(`[AccountManager] unhandledRejection: ${err}`);
    });

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
      tickStreamEnabled: this.globalConfig.tickStreamEnabled,
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
}

module.exports = AccountManager;
