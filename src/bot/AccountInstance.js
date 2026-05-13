/**
 * AccountInstance - Per-account trading bot encapsulation
 * 
 * Extracted from MultiInstrumentBot for multi-account support.
 * Each instance owns its own auth, client, orderWs, Telegram, and runners.
 * The SharedPriceProvider is injected so all accounts share one Databento feed.
 */

const TradovateAuth = require('../api/auth');
const TradovateClient = require('../api/client');
const TradovateWebSocket = require('../api/websocket');
const MarketHours = require('../utils/market_hours');
const Notifications = require('../utils/notifications');
const TradeAnalyzer = require('../analytics/trade_analyzer');
const logger = require('../utils/logger');
const InstrumentRunner = require('./InstrumentRunner');
const TelegramCommandHandler = require('../utils/TelegramCommandHandler');
const ContractRollReminder = require('../utils/contract_roll_reminder');

class AccountInstance extends require('events') {
  constructor(config) {
    super();
    this.accountId = config.accountId;
    this.credentials = config.credentials;
    this.telegram = config.telegram;
    this.instruments = config.instruments;
    this.sharedPriceProvider = config.sharedPriceProvider;
    this.globalConfig = config.globalConfig;
    this.dataDir = config.dataDir;

    this.auth = null;
    this.client = null;
    this.account = null;
    this.orderWs = null;
    this.marketHours = new MarketHours(this.globalConfig.timezone);
    this.notifications = new Notifications({
      telegramToken: this.telegram.token,
      telegramChatId: this.telegram.chatId,
      accountId: this.accountId,
      botName: 'TradovateBot',
    });
    this.tradeAnalyzer = new TradeAnalyzer({ dataDir: this.dataDir });
    this.notifications.setTradeAnalyzer(this.tradeAnalyzer);

    this.runners = new Map();
    this._contractIdToRunner = new Map();

    this.isRunning = false;
    this._pausedByUser = false;
    this.telegramCommands = null;
    this._sessionCheckInterval = null;
    this._positionSyncInterval = null;
    this._todayResetDone = false;
    this._eodCloseDoneToday = false;
    this._dailyReportSentToday = false;
    this._sessionStartLoggedToday = false;
    this._rollReminders = [];

    this.maxSimultaneousPositions = parseInt(this.globalConfig.maxSimultaneousPositions) || 2;
    this.tag = `[${this.accountId}]`;
  }

  canOpenNewPosition() {
    let openCount = 0;
    for (const runner of this.runners.values()) {
      if (runner.hasPosition()) openCount++;
    }
    return { allowed: openCount < this.maxSimultaneousPositions, openCount, maxAllowed: this.maxSimultaneousPositions };
  }

  async _authenticateWithRetry(maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`${this.tag} [Auth] Attempt ${attempt}/${maxRetries}`);
        await this.auth.authenticate();
        logger.info(`${this.tag} [Auth] Success`);
        return;
      } catch (error) {
        logger.error(`${this.tag} [Auth] Attempt ${attempt} failed: ${error.message}`);
        if (attempt === maxRetries) {
          logger.error(`${this.tag} [Auth] All attempts failed - waiting 5min...`);
          await new Promise(r => setTimeout(r, 5 * 60 * 1000));
          try {
            await this.auth.authenticate();
            logger.info(`${this.tag} [Auth] Final success`);
            return;
          } catch (finalError) {
            logger.error(`${this.tag} [Auth] Final failed - will retry later`);
            return;
          }
        }
        const delay = Math.min(30000 * Math.pow(2, attempt - 1), 120000);
        logger.info(`${this.tag} [Auth] Waiting ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  async initialize() {
    this._logStartupBanner();

    const tgOk = await this.notifications.test();
    if (!tgOk) logger.warn(`${this.tag} Telegram validation failed - notifications best-effort`);

    this.auth = new TradovateAuth(this.credentials);
    await this._authenticateWithRetry();
    this.client = new TradovateClient(this.auth);

    const accounts = await this.client.getAccounts();
    if (accounts.length === 0) throw new Error(`${this.tag} No accounts found`);

    const preferredName = this.credentials.accountName;
    const preferredId = this.credentials.accountId;
    if (preferredName) {
      this.account = accounts.find(a => a.name === preferredName);
      if (!this.account) {
        const available = accounts.map(a => `${a.name} (ID: ${a.id})`).join(', ');
        throw new Error(`${this.tag} Account "${preferredName}" not found. Available: ${available}`);
      }
    } else if (preferredId) {
      this.account = accounts.find(a => a.id === preferredId);
      if (!this.account) {
        const available = accounts.map(a => `${a.name} (ID: ${a.id})`).join(', ');
        throw new Error(`${this.tag} Account ID ${preferredId} not found. Available: ${available}`);
      }
    } else {
      const active = accounts.filter(a => a.active !== false);
      this.account = active[0] || accounts[0];
      if (accounts.length > 1) {
        logger.warn(`${this.tag} Multiple accounts - using "${this.account.name}"`);
      }
    }
    logger.info(`${this.tag} Account: ${this.account.name} (ID: ${this.account.id})`);

    await this._connectOrderWebSocket();

    logger.info(`${this.tag} ${this.instruments.length} instrument(s): ${this.instruments.map(c => c.baseSymbol).join(', ')}`);

    this._wireDatabentoEvents();

    const shared = {
      accountId: this.accountId,
      client: this.client,
      account: this.account,
      orderWs: this.orderWs,
      notifications: this.notifications,
      marketHours: this.marketHours,
      tradeAnalyzer: this.tradeAnalyzer,
      globalConfig: this.globalConfig,
      sharedPriceProvider: this.sharedPriceProvider,
      bot: this,
    };

    for (const ic of this.instruments) {
      logger.info(`${'─'.repeat(60)}`);
      logger.info(`  ${this.tag} Initializing ${ic.baseSymbol} (${ic.strategy})`);
      logger.info(`${'─'.repeat(60)}`);

      const runner = new InstrumentRunner(ic, shared);
      await runner.initialize();
      this.runners.set(ic.baseSymbol, runner);

      const contractId = runner.getContractId();
      if (contractId) {
        this._contractIdToRunner.set(contractId, runner);
        logger.info(`  ${this.tag} Routing: contractId ${contractId} -> ${ic.baseSymbol}`);
      }

      runner.on('halt', async (data) => {
        logger.error(`${this.tag} ${data.instrument} HALTED: ${data.message}`);
        await this._sendDailyReport(`${data.instrument} halted: ${data.message}`);
      });
    }

    this.isRunning = true;
    logger.success(`\n✅ ${this.tag} LIVE - ${this.runners.size} instrument(s)`);

    await this.notifications.send(
      `🤖 <b>BOT STARTED</b>\nAccount: ${this.accountId}\nInstruments: ${[...this.runners.keys()].join(', ')}\nTradovate: ${this.account.name}`
    ).catch(() => {});

    this.telegramCommands = new TelegramCommandHandler({
      bot: this, notifications: this.notifications,
      telegramToken: this.telegram.token, telegramChatId: this.telegram.chatId,
      accountId: this.accountId,
    });
    this.telegramCommands.start();

    for (const [sym, runner] of this.runners) {
      const contract = runner.contract;
      if (contract && contract.name) {
        const reminder = new ContractRollReminder({
          notifications: this.notifications, contractName: contract.name,
          expirationDate: contract.expirationDate, baseSymbol: sym,
        });
        await reminder.start();
        this._rollReminders.push(reminder);
      }
    }
  }

  _wireDatabentoEvents() {
    this.sharedPriceProvider.on('disconnected', ({ code }) => {
      logger.warn(`${this.tag} [Databento] Disconnected (code: ${code})`);
      this.notifications.send('⚠️ <b>DATABENTO DISCONNECTED</b>').catch(() => {});
    });

    this.sharedPriceProvider.on('reconnected', async (data) => {
      const downtimeSec = ((data.downtimeMs || 0) / 1000).toFixed(1);
      const droppedBars = Math.floor((data.downtimeMs || 0) / 60000);
      logger.info(`${this.tag} [Databento] Reconnected after ${downtimeSec}s (~${droppedBars} bars)`);
      this.notifications.send(`✅ <b>DATABENTO RECONNECTED</b>\nDowntime: ${downtimeSec}s`).catch(() => {});
      for (const runner of this.runners.values()) {
        runner.startReconnectCooldown(droppedBars, data.downtimeMs || 0);
      }
    });

    this.sharedPriceProvider.on('maxReconnectAttemptsReached', () => {
      logger.error(`${this.tag} [Databento] Max reconnect attempts`);
      this.notifications.send('🚨 <b>DATABENTO DEAD</b>').catch(() => {});
    });
  }

  async _connectOrderWebSocket() {
    this.orderWs = new TradovateWebSocket(this.auth, 'order');

    const route = (event, handler) => {
      this.orderWs.on(event, (entity) => {
        const runner = this._contractIdToRunner.get(entity.contractId);
        if (runner) runner[handler](entity);
      });
    };
    route('order', 'handleOrderUpdate');
    route('fill', 'handleFill');
    route('position', 'handlePositionUpdate');

    this.orderWs.on('props', (data) => {
      if (!data || !data.entityType || !data.entity) return;
      const entity = data.entity;
      const runner = this._contractIdToRunner.get(entity.contractId);
      if (!runner) return;
      if (data.entityType === 'fill' && data.eventType === 'Created') runner.handleFill(entity);
      else if (data.entityType === 'order') runner.handleOrderUpdate(entity);
      else if (data.entityType === 'position') runner.handlePositionUpdate(entity);
    });

    this.orderWs.on('reconnected', async (data) => {
      try {
        await new Promise((resolve) => {
          if (this.orderWs.isAuthorized) resolve();
          else { this.orderWs.once('authorized', resolve); setTimeout(resolve, 5000); }
        });
        this.orderWs.synchronize(this.account.id);
        logger.info(`${this.tag} [OrderWs] Re-synced`);
      } catch (e) { logger.error(`${this.tag} [OrderWs] Re-sync failed: ${e.message}`); }
      if (data.requiresPositionSync) {
        for (const runner of this.runners.values()) await runner.syncPosition();
      }
    });

    this.orderWs.on('maxReconnectAttemptsReached', async (data) => {
      logger.error(`${this.tag} [OrderWs] CRITICAL: ${data.attempts} attempts - HALTING`);
      for (const [symbol, runner] of this.runners.entries()) {
        try {
          if (runner.lossLimits) runner.lossLimits.halt('WEBSOCKET_DEAD', 'Order WS lost');
        } catch (err) { logger.error(`${this.tag} Halt ${symbol} failed: ${err.message}`); }
      }
      await this.notifications.send('🚨 <b>ORDER WS DEAD</b> - All trading halted').catch(() => {});
    });

    await this.orderWs.connect();
    await new Promise((resolve) => {
      if (this.orderWs.isAuthorized) resolve();
      else { this.orderWs.once('authorized', resolve); setTimeout(resolve, 5000); }
    });
    this.orderWs.synchronize(this.account.id);
    logger.info(`${this.tag} Order WS connected`);
  }

  async start() {
    await this.initialize();
    this._startSessionManager();
    this._startPositionSyncHeartbeat();

    const pst = this._getPSTTime();
    const mins = pst.hour * 60 + pst.minute;
    const ss = this.globalConfig.tradingStartHour * 60 + this.globalConfig.tradingStartMinute;
    const se = this.globalConfig.tradingEndHour * 60 + this.globalConfig.tradingEndMinute;

    if (mins >= ss && mins < se) {
      logger.info(`${this.tag} Started mid-session - daily reset already done`);
      this._todayResetDone = true;
    } else if (mins < ss) {
      logger.info(`${this.tag} Waiting for session start at ${this.globalConfig.tradingStartHour}:${String(this.globalConfig.tradingStartMinute).padStart(2, '0')} PST`);
    } else {
      logger.info(`${this.tag} Session ended for today - will trade tomorrow`);
    }

    // Note: In multi-account mode, AccountManager owns SIGINT/SIGTERM.
    // Only register if running standalone (no sharedPriceProvider injected from AccountManager).
    if (!this.sharedPriceProvider) {
      process.on('SIGINT', () => this.shutdown());
      process.on('SIGTERM', () => this.shutdown());
    }

    logger.success(`📅 DAILY SCHEDULE (PST):`);
    logger.success(`   6:29 AM  — Daily reset`);
    logger.success(`   6:30 AM  — Session start`);
    for (const [sym, runner] of this.runners) {
      logger.success(`   ${sym}: ${runner.instrumentConfig.strategy}`);
    }
    logger.success(`  12:55 PM  — EOD force-close`);
    logger.success(`   1:00 PM  — Session end, daily report`);
  }

  _startSessionManager() {
    const checkSession = async () => {
      if (!this.isRunning) return;

      const pst = this._getPSTTime();
      const mins = pst.hour * 60 + pst.minute;
      const ss = this.globalConfig.tradingStartHour * 60 + this.globalConfig.tradingStartMinute;
      const se = this.globalConfig.tradingEndHour * 60 + this.globalConfig.tradingEndMinute;

      // Daily Reset at 6:29 AM PST
      if (pst.hour === 6 && pst.minute === 29 && !this._todayResetDone) {
        this._todayResetDone = true;
        this._eodCloseDoneToday = false;
        this._dailyReportSentToday = false;
        this._sessionStartLoggedToday = false;

        for (const runner of this.runners.values()) runner.dailyReset();
        logger.info(`${this.tag} Daily reset - all instruments`);
        await this.notifications.send('🔄 New trading day - all instruments reset').catch(() => {});
      }

      if (pst.hour === 0 && pst.minute < 2) {
        this._todayResetDone = false;
        this._dailyReportSentToday = false;
      }

      // EOD Force-Close at 12:55 PM PST
      if (mins >= se - 5 && mins < se && !this._eodCloseDoneToday) {
        this._eodCloseDoneToday = true;
        for (const runner of this.runners.values()) await runner.eodClose();
      }

      if (mins >= ss && !this._sessionStartLoggedToday) {
        this._sessionStartLoggedToday = true;
        logger.info(`${this.tag} Trading session started`);
      }

      if (mins >= se && !this._dailyReportSentToday) {
        logger.info(`${this.tag} Session ended - generating daily report`);
        await this._sendDailyReport('Session ended');
      }
    };

    this._sessionCheckInterval = setInterval(checkSession, 15000);
    checkSession();
  }

  _startPositionSyncHeartbeat() {
    this._positionSyncInterval = setInterval(async () => {
      if (!this.isRunning) return;
      if (!this._isInSession()) return;
      for (const runner of this.runners.values()) await runner.syncPosition();
    }, 60000);
    logger.info(`${this.tag} Position sync heartbeat started (60s)`);
  }

  async _sendDailyReport(reason) {
    if (this._dailyReportSentToday) return;
    this._dailyReportSentToday = true;

    try {
      const today = new Date().toISOString().split('T')[0];
      let totalPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0, totalBE = 0;
      const lines = [];

      for (const [sym, runner] of this.runners) {
        const stats = runner.getTodayStats();
        totalPnl += stats.pnl || 0;
        totalTrades += stats.trades || 0;
        totalWins += stats.wins || 0;
        totalLosses += stats.losses || 0;
        totalBE += stats.breakeven || 0;
        const pnlStr = (stats.pnl || 0) >= 0 ? `+$${(stats.pnl || 0).toFixed(2)}` : `-$${Math.abs(stats.pnl || 0).toFixed(2)}`;
        lines.push(`${sym}: ${stats.trades || 0}t ${stats.wins || 0}W/${stats.losses || 0}L/${stats.breakeven || 0}BE ${pnlStr}`);
      }

      const totalPnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
      const wr = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(0) : '0';

      const msg = `📊 <b>DAILY REPORT</b> (${today})\n` +
        `Reason: ${reason}\n\n` +
        lines.join('\n') + '\n\n' +
        `<b>TOTAL: ${totalTrades}t ${totalWins}W/${totalLosses}L/${totalBE}BE ${totalPnlStr} (${wr}% WR)</b>`;

      await this.notifications.send(msg).catch(() => {});

      const fs = require('fs');
      const path = require('path');
      const logDir = path.join('.', 'logs', this.accountId);
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

      const logEntry = { date: today, reason, totalTrades, totalWins, totalLosses, totalBE, totalPnl };
      const logFile = path.join(logDir, `daily_${today}.json`);
      fs.writeFileSync(logFile, JSON.stringify(logEntry, null, 2));
      logger.info(`${this.tag} Daily report saved to ${logFile}`);
    } catch (err) {
      logger.error(`${this.tag} Failed to send daily report: ${err.message}`);
    }
  }

  async shutdown() {
    logger.info(`${this.tag} Shutting down...`);
    this.isRunning = false;

    if (this._sessionCheckInterval) clearInterval(this._sessionCheckInterval);
    if (this._positionSyncInterval) clearInterval(this._positionSyncInterval);

    for (const runner of this.runners.values()) await runner.shutdown();

    await this.notifications.send('🛑 <b>BOT STOPPED</b>').catch(() => {});

    if (this.orderWs) this.orderWs.disconnect();
    if (this.telegramCommands) this.telegramCommands.stop();
    for (const reminder of this._rollReminders) reminder.stop();

    logger.info(`${this.tag} Stopped`);
  }

  async getAggregatedStatus() {
    const balance = await this.client.getRealTimeBalance(this.account.id);
    const positions = await this.client.getOpenPositions(this.account.id);

    let totalPnl = 0, totalTrades = 0;
    const instrumentStats = [];

    for (const [symbol, runner] of this.runners) {
      const stats = runner.getTodayStats();
      const llStatus = runner.lossLimits.getStatus();
      totalPnl += stats.pnl || 0;
      totalTrades += stats.trades || 0;
      instrumentStats.push({ symbol, pnl: stats.pnl, trades: stats.trades, isHalted: llStatus.isHalted, haltReason: llStatus.haltReason });
    }

    return { accountId: this.accountId, account: this.account, balance, positions, totalPnl, totalTrades, instrumentStats, paused: this._pausedByUser };
  }

  _getPSTTime(date = new Date()) {
    const fmt = (type) => parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', [type]: 'numeric', hour12: false }).format(date));
    return { hour: fmt('hour'), minute: fmt('minute') };
  }

  _isInSession() {
    const pst = this._getPSTTime();
    const mins = pst.hour * 60 + pst.minute;
    const ss = this.globalConfig.tradingStartHour * 60 + this.globalConfig.tradingStartMinute;
    const se = this.globalConfig.tradingEndHour * 60 + this.globalConfig.tradingEndMinute;
    return mins >= ss && mins < se;
  }

  _logStartupBanner() {
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logger.info(`🤖 AccountInstance Starting...`);
    logger.info(`Account: ${this.accountId}`);
    logger.info(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  }
}

module.exports = AccountInstance;
