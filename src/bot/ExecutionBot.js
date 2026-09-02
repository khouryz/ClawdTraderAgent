/**
 * ExecutionBot — execution-only trading bot
 *
 * Receives fully-specified trade signals from a webhook, executes them through
 * the Tradovate API (entry order → OCO bracket), and manages position lifecycle
 * (fills, P&L, loss limits, EOD flatten, Telegram notifications).
 *
 * No internal strategies. No market data feed. No indicators. No AI confirmation.
 * The external analysis process owns signal generation; this bot owns execution.
 */

const TradovateAuth = require('../api/auth');
const TradovateClient = require('../api/client');
const TradovateWebSocket = require('../api/websocket');
const RiskManager = require('../risk/manager');
const LossLimitsManager = require('../risk/loss_limits');
const SessionFilter = require('../filters/session_filter');
const { OrderManager } = require('../orders/order_manager');
const PerformanceTracker = require('../analytics/performance');
const SignalHandler = require('./SignalHandler');
const NF = require('../utils/notify_format');
const PositionHandler = require('./PositionHandler');
const WebhookServer = require('../api/webhook_server');
const TelegramCommandHandler = require('../utils/TelegramCommandHandler');
const ConfigValidator = require('../utils/config_validator');
const MarketHours = require('../utils/market_hours');
const Notifications = require('../utils/notifications');
const logger = require('../utils/logger');
const { CONTRACTS } = require('../utils/constants');

class ExecutionBot {
  constructor() {
    this.config = this._loadConfig();

    // Core
    this.auth = null;
    this.client = null;
    this.account = null;
    this.contract = null;
    this.orderWs = null;
    this.webhook = null;

    // Managers
    this.riskManager = null;
    this.lossLimits = null;
    this.sessionFilter = null;
    this.orderManager = null;
    this.performance = null;
    this.marketHours = null;
    this.notifications = null;

    // Handlers
    this.signalHandler = null;
    this.positionHandler = null;
    this.telegramCommands = null;

    // State
    this.isRunning = false;
    this._pausedByUser = false;

    // Session management (PST-based)
    this._sessionCheckInterval = null;
    this._todayResetDone = false;
    this._eodCloseDoneToday = false;
    this._dailyReportSentToday = false;
    this._sessionStartLoggedToday = false;
    this._lastEntryHourPST = parseInt(process.env.LAST_ENTRY_HOUR) || 12;
    this._lastEntryMinutePST = parseInt(process.env.LAST_ENTRY_MINUTE) || 30;

    // Max trades per day (moved from strategy)
    this._maxTradesPerDay = parseInt(process.env.MAX_TRADES_PER_DAY) || 3;
    this._tradesToday = 0;

    // Fill dedup
    this._processedFillIds = new Set();

    // Timers
    this._limitEntryTimer = null;
    this._fillWatchdogTimer = null;
  }

  // ── Config ────────────────────────────────────────────────────────

  _loadConfig() {
    const raw = {
      env: process.env.TRADOVATE_ENV,
      username: process.env.TRADOVATE_USERNAME,
      password: process.env.TRADOVATE_PASSWORD,
      cid: process.env.TRADOVATE_CID ? parseInt(process.env.TRADOVATE_CID) : null,
      secret: process.env.TRADOVATE_SECRET,
      contractSymbol: process.env.CONTRACT_SYMBOL,
      autoRollover: process.env.AUTO_ROLLOVER === 'true',
      riskPerTrade: {
        min: process.env.RISK_PER_TRADE_MIN,
        max: process.env.RISK_PER_TRADE_MAX,
      },
      maxContracts: parseInt(process.env.MAX_CONTRACTS || '10'),
      profitTargetR: process.env.PROFIT_TARGET_R,
      dailyLossLimit: process.env.DAILY_LOSS_LIMIT,
      weeklyLossLimit: process.env.WEEKLY_LOSS_LIMIT,
      maxConsecutiveLosses: process.env.MAX_CONSECUTIVE_LOSSES,
      maxDrawdownPercent: process.env.MAX_DRAWDOWN_PERCENT,
      dailyProfitTarget: process.env.DAILY_PROFIT_TARGET,
      profitTiers: process.env.DAILY_PROFIT_TIERS || '',
      tradingStartHour: process.env.TRADING_START_HOUR,
      tradingStartMinute: process.env.TRADING_START_MINUTE,
      tradingEndHour: process.env.TRADING_END_HOUR,
      tradingEndMinute: process.env.TRADING_END_MINUTE,
      avoidLunch: process.env.AVOID_LUNCH !== 'false',
      timezone: process.env.TIMEZONE,
      minStopPoints: parseFloat(process.env.MIN_STOP_POINTS) || 4,
      // How long a resting entry may work before it is auto-cancelled. A Stop
      // waits on a break that can take several bars, so it gets far longer than
      // a Limit. Overridable per-signal via entryTimeoutSec.
      limitEntryTimeoutSec: parseInt(process.env.LIMIT_ENTRY_TIMEOUT_SEC) || 180,
      stopEntryTimeoutSec: parseInt(process.env.STOP_ENTRY_TIMEOUT_SEC) || 900,
    };

    const validation = ConfigValidator.validate(raw);
    if (!validation.valid) {
      validation.errors.forEach(err => logger.error(`Config error: ${err}`));
      throw new Error('Invalid configuration. Check .env file.');
    }
    validation.warnings.forEach(w => logger.warn(`Config warning: ${w}`));
    return ConfigValidator.sanitize(raw);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async start() {
    await this._initialize();

    // Startup assertion: entry cutoff must be at least 15 min before EOD flatten
    const eodFlattenMin = this.config.tradingEndHour * 60 + this.config.tradingEndMinute - 5;
    const entryCutoffMin = this._lastEntryHourPST * 60 + this._lastEntryMinutePST;
    if (entryCutoffMin > eodFlattenMin - 15) {
      const cutoffStr = `${this._lastEntryHourPST}:${String(this._lastEntryMinutePST).padStart(2,'0')}`;
      const eodStr = `${Math.floor(eodFlattenMin / 60)}:${String(eodFlattenMin % 60).padStart(2,'0')}`;
      logger.error(`🚨 CONFIG CONFLICT: entry cutoff ${cutoffStr} PST is less than 15 min before EOD flatten ${eodStr} PST`);
      logger.error(`   Set LAST_ENTRY_HOUR/LAST_ENTRY_MINUTE at least 15 min before EOD. Refusing to start.`);
      await this.notifications?.send(
        `🚨 <b>CONFIG CONFLICT</b>\nEntry cutoff ${cutoffStr} PST is too close to EOD flatten ${eodStr} PST.\nRefusing to start — fix LAST_ENTRY_HOUR/MINUTE.`
      ).catch(() => {});
      throw new Error(`Entry cutoff ${cutoffStr} must be ≥15 min before EOD flatten ${eodStr} PST`);
    }

    this._startSessionManager();

    // If starting mid-session, mark reset as done
    const pst = this._getPSTTime();
    const mins = pst.hour * 60 + pst.minute;
    const sessionStart = this.config.tradingStartHour * 60 + this.config.tradingStartMinute;
    const sessionEnd = this.config.tradingEndHour * 60 + this.config.tradingEndMinute;

    if (mins >= sessionStart && mins < sessionEnd) {
      logger.info('⚡ Started mid-session');
      this._todayResetDone = true;
    } else if (mins < sessionStart) {
      logger.info(`⏳ Waiting for session start at ${this.config.tradingStartHour}:${String(this.config.tradingStartMinute).padStart(2, '0')} PST`);
    } else {
      logger.info('📴 Session ended for today — will trade tomorrow');
    }

    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.success('✅ Execution Bot is LIVE — awaiting webhook signals');
    logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    // Was the last stop clean? The marker is written only on graceful shutdown,
    // so its absence means a crash, a kill -9, or the machine went to sleep —
    // exactly the cases that otherwise vanish without a word.
    let uncleanRestart = false;
    try {
      const fs = require('fs');
      const path = require('path');
      const marker = path.join(__dirname, '..', '..', 'data', '.clean_shutdown');
      uncleanRestart = !fs.existsSync(marker);
      if (!uncleanRestart) fs.unlinkSync(marker);
    } catch (e) { /* treat as unknown, not unclean */ }
    if (uncleanRestart) {
      logger.warn('⚠️ Previous shutdown was NOT clean (crash, kill, or sleep)');
    }

    const symS = this.contract?.name || this.config.contractSymbol || 'MNQ';
    const two = (n) => String(n).padStart(2, '0');
    await this.notifications.send(NF.botOnline({
      symbol: symS,
      env: this.config.env,
      windowStart: `${two(this.config.tradingStartHour)}:${two(this.config.tradingStartMinute)}`,
      windowEnd: `${two(this.config.tradingEndHour)}:${two(this.config.tradingEndMinute)}`,
      entryCutoff: `${two(this._lastEntryHourPST)}:${two(this._lastEntryMinutePST)}`,
      tradesToday: this._tradesToday,
      maxTrades: this._maxTradesPerDay,
      lossBudget: this.lossLimits?.getStatus?.().dailyLossRemaining,
      uncleanRestart,
      openPosition: this.signalHandler?.getPosition() || null,
    })).catch(() => {});
  }

  async _initialize() {
    try {
      this._logStartupBanner();

      // Auth + client + account + contract
      await this._initializeCore();

      // Managers
      this._initializeManagers();

      // Handlers
      this._initializeHandlers();

      // Order WebSocket
      await this._connectOrderWebSocket();

      // Startup sync
      await this._startupSync();

      // Update equity for loss limits
      try {
        const balance = await this.client.getCashBalance(this.account.id);
        this.lossLimits.updateEquity(balance.cashBalance);
      } catch (err) {
        logger.warn(`Failed to get account balance: ${err.message}`);
      }

      this.isRunning = true;

      // Telegram
      await this.notifications.botStarted();
      this.telegramCommands = new TelegramCommandHandler(this, this.notifications);
      this.telegramCommands.start();

      // Webhook server
      if (process.env.WEBHOOK_ENABLED === 'true') {
        this.webhook = new WebhookServer(this, {
          port: parseInt(process.env.WEBHOOK_PORT) || 8787,
          token: process.env.WEBHOOK_TOKEN,
          maxQty: parseInt(process.env.MAX_WEBHOOK_QTY) || 2,
          maxStopTicks: parseInt(process.env.MAX_WEBHOOK_STOP_TICKS) || 200,
          dedupMs: parseInt(process.env.WEBHOOK_DEDUP_MS) || 300000,
        });
        await this.webhook.start();
      } else {
        logger.warn('⚠️ WEBHOOK_ENABLED not set — no signal intake. Bot will run but cannot receive signals.');
      }

    } catch (error) {
      logger.error(`Initialization failed: ${error.message}`);
      await this.notifications.error(`Initialization failed: ${error.message}`).catch(() => {});
      throw error;
    }
  }

  _logStartupBanner() {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('🤖 Execution Bot Starting...');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`Environment: ${this.config.env.toUpperCase()}`);
    logger.info(`Contract: ${this.config.contractSymbol}`);
    logger.info(`Risk: $${this.config.riskPerTrade.min}-$${this.config.riskPerTrade.max} per trade`);
    logger.info(`Max trades/day: ${this._maxTradesPerDay}`);
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  async _initializeCore() {
    // Auth with retry
    this.auth = new TradovateAuth(this.config);
    await this._authenticateWithRetry();

    // Client
    this.client = new TradovateClient(this.auth);

    // Account
    const accounts = await this.client.getAccounts();
    if (accounts.length === 0) throw new Error('No accounts found');

    const preferredName = process.env.TRADOVATE_ACCOUNT_NAME;
    const preferredId = process.env.TRADOVATE_ACCOUNT_ID ? parseInt(process.env.TRADOVATE_ACCOUNT_ID) : null;
    if (preferredName) {
      this.account = accounts.find(a => a.name === preferredName);
      if (!this.account) throw new Error(`Account "${preferredName}" not found. Available: ${accounts.map(a => `${a.name} (ID: ${a.id})`).join(', ')}`);
    } else if (preferredId) {
      this.account = accounts.find(a => a.id === preferredId);
      if (!this.account) throw new Error(`Account ID ${preferredId} not found. Available: ${accounts.map(a => `${a.name} (ID: ${a.id})`).join(', ')}`);
    } else {
      const active = accounts.filter(a => a.active !== false);
      this.account = active[0] || accounts[0];
      if (accounts.length > 1) {
        logger.warn(`⚠️ Multiple accounts — using "${this.account.name}". Set TRADOVATE_ACCOUNT_NAME to choose.`);
      }
    }

    // Contract
    if (this.config.autoRollover) {
      const baseSymbol = this.config.contractSymbol.substring(0, 3);
      this.contract = await this.client.getFrontMonthContract(baseSymbol);
    } else {
      this.contract = await this.client.findContract(this.config.contractSymbol);
    }

    logger.info(`✓ Account: ${this.account.name} (ID: ${this.account.id})`);
    logger.info(`✓ Contract: ${this.contract.name} (ID: ${this.contract.id})`);
  }

  async _authenticateWithRetry(maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Auth] Attempt ${attempt}/${maxRetries}`);
        await this.auth.authenticate();
        console.log('[Auth] ✓ Success');
        return;
      } catch (error) {
        console.error(`[Auth] ✗ Attempt ${attempt} failed: ${error.message}`);
        if (attempt === maxRetries) {
          console.error('[Auth] All attempts failed — waiting 5 min for final retry...');
          await new Promise(r => setTimeout(r, 5 * 60 * 1000));
          try {
            await this.auth.authenticate();
            console.log('[Auth] ✓ Final attempt succeeded');
            return;
          } catch (finalErr) {
            console.error('[Auth] ✗ Final attempt failed — keeping process alive');
            return;
          }
        }
        const delay = Math.min(30000 * Math.pow(2, attempt - 1), 120000);
        console.log(`[Auth] Waiting ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  _initializeManagers() {
    this.riskManager = new RiskManager(this.config);
    logger.info('✓ Risk Manager initialized');

    this.lossLimits = new LossLimitsManager(this.config);
    this.lossLimits.on('halt', async (data) => {
      logger.error(`🛑 TRADING HALTED: ${data.message}`);
      const s = this.lossLimits.getStatus();
      const pnlStr = s.dailyPnL >= 0 ? `+$${s.dailyPnL.toFixed(2)}` : `-$${Math.abs(s.dailyPnL).toFixed(2)}`;
      const floorStr = s.currentFloor !== null ? `$${s.currentFloor}` : 'none';
      let emoji, title, details;
      if (data.reason === 'DAILY_PROFIT_TARGET') {
        emoji = '🎯'; title = 'PROFIT TARGET HIT';
        details = `Target: $${s.limits.dailyProfitTarget}`;
      } else if (data.reason === 'PROFIT_PROTECTION') {
        emoji = '🔒'; title = 'PROFIT PROTECTED';
        details = `Floor: ${floorStr} | Peak: $${s.dailyPeakPnL.toFixed(2)}`;
      } else {
        emoji = '🛑'; title = 'TRADING HALTED';
        details = `Consec Losses: ${s.consecutiveLosses}/${s.limits.maxConsecutiveLosses}`;
      }
      await this.notifications.send(
        `${emoji} <b>${title}</b>\n${data.message}\n\n` +
        `Daily P&L: ${pnlStr}\n${details}\n` +
        `Trades today: ${s.tradesToday}\n\n` +
        `<i>Bot will resume tomorrow 6:30 AM PST.</i>`
      ).catch(() => {});
      await this._sendDailyReport(data.message);
    });
    logger.info('✓ Loss Limits Manager initialized');

    this.sessionFilter = new SessionFilter(this.config);
    logger.info('✓ Session Filter initialized');

    this.orderManager = new OrderManager(this.client);
    this.orderManager.startAutoCleanup();
    logger.info('✓ Order Manager initialized');

    this.performance = new PerformanceTracker();
    logger.info('✓ Performance Tracker initialized');

    this.marketHours = new MarketHours(this.config.timezone);
    this.notifications = new Notifications();
    logger.info('✓ Notifications initialized');
  }

  _initializeHandlers() {
    this.signalHandler = new SignalHandler({
      client: this.client,
      riskManager: this.riskManager,
      lossLimits: this.lossLimits,
      sessionFilter: this.sessionFilter,
      marketHours: this.marketHours,
      notifications: this.notifications,
    }, this.config);
    this.signalHandler.setContext(this.account, this.contract);

    this.positionHandler = new PositionHandler({
      performance: this.performance,
      lossLimits: this.lossLimits,
      notifications: this.notifications,
    }, this.config);
    this.positionHandler.setContract(this.contract);

    // Position closed → clear signal handler state
    this.positionHandler.on('positionClosed', () => {
      this._clearLimitEntryTimeout();
      this._clearFillWatchdog();
      this._clearExitWatchdog();
      this.signalHandler.clearPosition();
    });

    // Entry filled → place OCO bracket with fill-adjusted prices
    this.positionHandler.on('entryFilled', async (fillData) => {
      this._clearLimitEntryTimeout();
      this._clearFillWatchdog();
      const { fillPrice, signalPrice, slippage, newStop, newTarget, position } = fillData;

      // 1. Update SignalHandler's position
      this.signalHandler.updatePositionFromFill(fillData);

      // 2. Place OCO bracket(s)
      const ocoParams = position._ocoParams;
      if (ocoParams) {
        if (ocoParams.exits && Array.isArray(ocoParams.exits) && ocoParams.exits.length > 0) {
          // ── Multi-leg: one OCO per exit leg, all sharing the same stop ──
          await this._placeMultiLegOCO(ocoParams, position, newStop, fillPrice);
        } else {
          // ── Single OCO (legacy path) ──
          await this._placeSingleOCO(ocoParams, position, newStop, newTarget, fillPrice);
        }
        delete position._ocoParams;
      }

      // 3. Start exit watchdog — polls broker for exit fills in case WebSocket misses them
      this._startExitWatchdog();

      // 4. Send entry notification with real fill price and all targets
      const nd = position._notificationData;
      if (nd) {
        const patchedSignal = { ...nd.signal, price: fillPrice };
        const patchedPosition = {
          ...nd.position,
          stopPrice: newStop,
          targetPrice: newTarget,
          totalRisk: position.risk || nd.position.totalRisk,
        };

        // Build target list for notification (multi-leg or single)
        const targets = [];
        if (position.bracketLegs && position.bracketLegs.length > 0) {
          for (let i = 0; i < position.bracketLegs.length; i++) {
            targets.push({
              leg: i + 1,
              qty: position.bracketLegs[i].qty,
              targetPrice: position.bracketLegs[i].targetPrice,
            });
          }
        } else if (newTarget) {
          targets.push({ leg: 1, qty: position.quantity, targetPrice: newTarget });
        }

        try {
          // ONE message, priced off the real fill and the legs that actually
          // exist at the broker.
          //
          // This replaces two: tradeEntryDetailed printed a "Target" and a
          // "Reward" derived from profitTargetR (risk x 2.5) even when explicit
          // exits were sent — on 2 Sep it advertised target 29100.50 / $200
          // when the real legs were 29094.50 + 29012.25 worth $389, and no
          // order existed at 29100.50 at all. A second "EXIT TARGETS" message
          // then repeated the same information without the money.
          const symE = this.contract?.name || this.config.contractSymbol || 'MNQ';
          const pvE = (CONTRACTS[symE.substring(0, 3)] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
          await this.notifications.send(NF.positionOpened({
            symbol: symE,
            side: position.side,
            qty: position.quantity,
            fillPrice,
            stop: newStop,
            position,
            pointValue: pvE,
            slippage,
          })).catch(() => {});
          logger.info('✓ Entry notification sent');
        } catch (notifErr) {
          logger.error(`❌ Entry notification FAILED: ${notifErr.message}`);
        }
        delete position._notificationData;
      }
    });

    // Post-fill risk exceeded → emergency close
    this.positionHandler.on('postFillRiskExceeded', async (data) => {
      const { fillPrice, actualRisk, maxRisk, position } = data;
      logger.error(`🚨 POST-FILL RISK: actual $${actualRisk.toFixed(2)} > 150% of max $${maxRisk}`);
      await this.notifications.send(
        `🚨 <b>POST-FILL RISK EXCEEDED</b>\nFill: $${fillPrice.toFixed(2)}\nRisk: $${actualRisk.toFixed(2)} (max: $${maxRisk})\nEmergency closing...`
      ).catch(() => {});
      try {
        const closeAction = position.side === 'Buy' ? 'Sell' : 'Buy';
        const qty = position.quantity || 1;
        await this._cancelAllBracketLegs(position);
        await this.client.placeMarketOrder(this.account.id, this.contract.id, qty, closeAction);
        logger.warn('✓ Emergency close executed (post-fill risk)');
      } catch (closeErr) {
        logger.error(`❌ EMERGENCY CLOSE FAILED: ${closeErr.message} — MANUAL INTERVENTION REQUIRED`);
        await this.notifications.send('🚨🚨 <b>CRITICAL</b>\nPost-fill risk exceeded AND close failed!\nCLOSE MANUALLY NOW!').catch(() => {});
      }
    });

    logger.info('✓ Handlers initialized');
  }

  // ── WebSocket ─────────────────────────────────────────────────────

  async _connectOrderWebSocket() {
    this.orderWs = new TradovateWebSocket(this.auth, 'order');

    this.orderWs.on('order', (order) => this._onOrderUpdate(order).catch(err => logger.error(`Order update handling failed: ${err.message}`)));
    this.orderWs.on('fill', (fill) => this._onFill(fill));
    this.orderWs.on('position', (position) => this.positionHandler.handlePositionUpdate(position));

    // Props events — Tradovate wraps fills/orders/positions in props
    this.orderWs.on('props', (data) => {
      if (!data || !data.entityType || !data.entity) return;
      const entity = data.entity;
      if (data.entityType === 'fill' && data.eventType === 'Created') {
        this._onFill(entity);
      } else if (data.entityType === 'order') {
        this._onOrderUpdate(entity).catch(err => logger.error(`Order update handling failed: ${err.message}`));
      } else if (data.entityType === 'position') {
        this.positionHandler.handlePositionUpdate(entity);
      }
    });

    // CRITICAL: After authorization, send user/syncrequest so Tradovate
    // pushes fill/order/position events. Without this, the WebSocket connects
    // and authorizes but NEVER delivers any events — all fills are missed.
    this.orderWs.on('authorized', () => {
      logger.info('[WS] Authorized — sending user/syncrequest');
      this.orderWs.synchronize(this.account.id);
    });

    this.orderWs.on('reconnected', async () => {
      logger.info('[WS] Reconnected — syncing position state');
      try {
        // Re-adopt any position that may have changed during disconnect
        await this._startupSync();
        // Re-sync user data after reconnect
        this.orderWs.synchronize(this.account.id);
      } catch (err) {
        logger.warn(`[WS] Reconnect sync failed: ${err.message}`);
      }
    });

    this.orderWs.on('maxReconnectAttemptsReached', async () => {
      logger.error('🚨 WebSocket max reconnect attempts reached — halting');
      this.lossLimits.halt('WEBSOCKET_DEAD', 'Order WebSocket dead — cannot monitor fills');
      await this.notifications.send('🚨 <b>WEBSOCKET DEAD</b>\nMax reconnect attempts reached. Trading halted.').catch(() => {});
    });

    await this.orderWs.connect();
    logger.info('✓ Order WebSocket connected');
  }

  // ── OCO placement ──────────────────────────────────────────────────

  /**
   * Place a single OCO bracket (legacy path, no exits[]).
   * Retries once, then emergency-closes if still failed.
   */
  async _placeSingleOCO(ocoParams, position, newStop, newTarget, fillPrice) {
    let ocoPlaced = false;
    for (let attempt = 1; attempt <= 2 && !ocoPlaced; attempt++) {
      try {
        if (attempt > 1) {
          logger.warn(`Retrying OCO placement (attempt ${attempt})...`);
          await new Promise(r => setTimeout(r, 2000));
        }
        logger.trade(`Placing OCO: ${ocoParams.exitAction} Stop @ ${newStop.toFixed(2)} | Limit @ ${newTarget.toFixed(2)}`);
        const oco = await this.client.placeOCO(
          ocoParams.accountSpec, ocoParams.accountId, ocoParams.contractName,
          ocoParams.contracts, ocoParams.exitAction, newStop, newTarget
        );
        position.stopOrderId = oco.orderId;
        position.targetOrderId = oco.ocoId;
        position.bracketLegs = [{ orderId: oco.orderId, ocoId: oco.ocoId, qty: ocoParams.contracts, targetPrice: newTarget }];
        ocoPlaced = true;
        logger.success(`✓ OCO placed: stopOrderId=${oco.orderId}, targetOrderId=${oco.ocoId}`);
      } catch (err) {
        logger.error(`❌ OCO placement attempt ${attempt} failed: ${err.message}`);
        if (err.isAmbiguousWriteFailure) {
          await this._emergencyClose(ocoParams, 'OCO placement result was ambiguous');
          return;
        }
      }
    }
    if (!ocoPlaced) {
      await this._emergencyClose(ocoParams, 'OCO bracket FAILED after retries');
    }
  }

  /**
   * Place one OCO per exit leg, all sharing the same stop price.
   * Partial-failure handling: on any leg failure, cancel all successfully-placed
   * legs, then fall back to a single OCO for the full remaining quantity using
   * the nearest target. If that also fails, emergency market-close.
   */
  /**
   * Drop any exit leg that is on the wrong side of the ACTUAL fill.
   *
   * Targets are validated at the webhook against the SIGNAL price, but the
   * brackets are placed against the FILL price. When the two differ — slippage,
   * or a market order where `price` is only advisory — a target can land on the
   * wrong side of the real entry and fill instantly at a loss.
   *
   * Observed live 2 Sep: signal 29200 / fill 29146 on a short, target 29150 was
   * validated ("below 29200") but sat 4pt ABOVE the fill. It filled on the spot
   * as "T1", closing half the position for a loss the moment it opened.
   */
  _sanitiseLegsAgainstFill(legs, exitAction, fillPrice, newStop, profitTargetR = 2.5) {
    if (!Array.isArray(legs) || !legs.length || !Number.isFinite(fillPrice)) return legs || [];
    const isLong = exitAction === 'Sell';   // exit action is the OPPOSITE of entry
    const good = [], bad = [];
    for (const leg of legs) {
      const ok = isLong ? leg.targetPrice > fillPrice : leg.targetPrice < fillPrice;
      (ok ? good : bad).push(leg);
    }
    if (!bad.length) return legs;

    const desc = bad.map(l => `${l.qty}@${l.targetPrice}`).join(', ');
    const orphanQty = bad.reduce((s, l) => s + l.qty, 0);
    logger.error(`🚨 ${bad.length} exit leg(s) on the WRONG SIDE of the fill ${fillPrice.toFixed(2)}: ${desc}`);
    logger.error('   They would have filled instantly at a loss — targets were validated against the signal price, not the fill.');

    // CRITICAL: the dropped quantity must be re-bracketed, never left naked.
    // Move it onto the furthest surviving target (or the furthest original one
    // if every leg was wrong-side) so the full position keeps a stop and a exit.
    let out;
    if (good.length) {
      const furthest = good.reduce((a, b) =>
        Math.abs(b.targetPrice - fillPrice) > Math.abs(a.targetPrice - fillPrice) ? b : a);
      out = good.map(l => (l === furthest ? { ...l, qty: l.qty + orphanQty } : l));
      logger.error(`   Re-assigned ${orphanQty} contract(s) to the furthest valid target ${furthest.targetPrice}.`);
    } else {
      // Never submit a target known to be marketable. Derive one from the
      // actual fill and protective stop so the entire position remains safely
      // bracketed even when fill slippage invalidated every supplied level.
      const riskPts = Math.abs(fillPrice - newStop);
      const rawTarget = isLong
        ? fillPrice + riskPts * profitTargetR
        : fillPrice - riskPts * profitTargetR;
      const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
      const tickSize = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { tickSize: 0.25 }).tickSize;
      const targetPrice = parseFloat((Math.round(rawTarget / tickSize) * tickSize).toFixed(8));
      const totalQty = legs.reduce((s, l) => s + l.qty, 0);
      out = [{ qty: totalQty, targetPrice }];
      logger.error(`   All targets were wrong-side. Derived a safe fallback target ${targetPrice} for full size ${totalQty}.`);
    }

    const kept = out.map(l => `${l.qty}@${l.targetPrice}`).join(', ');
    this.notifications.send(
      `⚠️ <b>Target adjusted after fill</b>\n` +
      `Filled at ${fillPrice.toFixed(2)} — past ${bad.length === 1 ? 'one of your targets' : 'some targets'} (${desc}).\n` +
      `Those would have closed instantly at a loss, so the size moved to: ${kept}.\n` +
      `Stop unchanged at ${NF.px(newStop)}. Full position is still covered.`
    ).catch(() => {});
    return out;
  }

  async _placeMultiLegOCO(ocoParams, position, newStop, fillPrice) {
    const legs = this._sanitiseLegsAgainstFill(
      ocoParams.exits, ocoParams.exitAction, fillPrice, newStop, position.profitTargetR || this.config?.profitTargetR || 2.5
    );
    const placedLegs = [];

    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      try {
        logger.trade(`Placing OCO leg ${i+1}/${legs.length}: ${ocoParams.exitAction} ${leg.qty} Stop @ ${newStop.toFixed(2)} | Limit @ ${leg.targetPrice.toFixed(2)}`);
        const oco = await this.client.placeOCO(
          ocoParams.accountSpec, ocoParams.accountId, ocoParams.contractName,
          leg.qty, ocoParams.exitAction, newStop, leg.targetPrice
        );
        placedLegs.push({ orderId: oco.orderId, ocoId: oco.ocoId, qty: leg.qty, targetPrice: leg.targetPrice, legIndex: i });
        logger.success(`✓ OCO leg ${i+1} placed: stopOrderId=${oco.orderId}, targetOrderId=${oco.ocoId}`);
      } catch (err) {
        logger.error(`❌ OCO leg ${i+1} FAILED: ${err.message}`);
        if (err.isAmbiguousWriteFailure) {
          await this._emergencyClose(ocoParams, `OCO leg ${i+1} result was ambiguous`);
          return;
        }

        // Cancel all successfully-placed legs
        for (const pl of placedLegs) {
          try {
            await this.client.cancelOrder(pl.orderId);
            logger.warn(`Cancelled leg ${pl.legIndex + 1} (orderId=${pl.orderId}) after partial failure`);
          } catch (cancelErr) {
            logger.error(`Failed to cancel leg ${pl.legIndex + 1}: ${cancelErr.message}`);
          }
        }

        // Fallback: single OCO for full quantity using nearest target (legs[0].targetPrice)
        logger.warn(`Falling back to single OCO: ${ocoParams.contracts} Stop @ ${newStop.toFixed(2)} | Limit @ ${legs[0].targetPrice.toFixed(2)}`);
        try {
          const fallback = await this.client.placeOCO(
            ocoParams.accountSpec, ocoParams.accountId, ocoParams.contractName,
            ocoParams.contracts, ocoParams.exitAction, newStop, legs[0].targetPrice
          );
          position.stopOrderId = fallback.orderId;
          position.targetOrderId = fallback.ocoId;
          position.bracketLegs = [{ orderId: fallback.orderId, ocoId: fallback.ocoId, qty: ocoParams.contracts, targetPrice: legs[0].targetPrice }];
          logger.success(`✓ Fallback single OCO placed: stopOrderId=${fallback.orderId}`);
          await this.notifications.send(
            `⚠️ <b>MULTI-LEG FALLBACK</b>\nLeg ${i+1} failed — placed single OCO for full qty ${ocoParams.contracts} @ nearest target.`
          ).catch(() => {});
          return;
        } catch (fallbackErr) {
          logger.error(`❌ Fallback OCO also failed: ${fallbackErr.message}`);
          await this._emergencyClose(ocoParams, 'Multi-leg OCO AND fallback failed');
          return;
        }
      }
    }

    // All legs placed successfully
    position.bracketLegs = placedLegs;
    position.stopOrderId = placedLegs[0].orderId;
    position.targetOrderId = placedLegs[0].ocoId;
    logger.success(`✓ All ${placedLegs.length} OCO legs placed (stop @ ${newStop.toFixed(2)})`);
  }

  /**
   * Emergency close a naked position via market order.
   */
  async _emergencyClose(ocoParams, reason) {
    logger.error(`🚨 EMERGENCY: ${reason} — closing naked position`);
    await this.notifications.send(
      `🚨 <b>EMERGENCY</b>\n${reason}. Closing naked position.`
    ).catch(() => {});
    try {
      // The failed bracket request may actually have reached the broker. Cancel
      // every working order before closing so a delayed OCO cannot reopen the
      // account after the emergency market order.
      await this.client.cancelAllOrders(ocoParams.accountId);
      const positions = await this.client.getOpenPositions(ocoParams.accountId);
      const brokerPos = positions.find(p => p.contractId === this.contract?.id);
      const netPos = brokerPos?.netPos || 0;
      if (netPos === 0) {
        logger.warn('Emergency close: broker already flat after order cleanup');
        return;
      }
      await this.client.placeMarketOrder(
        ocoParams.accountId, this.contract.id, Math.abs(netPos), netPos > 0 ? 'Sell' : 'Buy'
      );
      logger.warn('Emergency close executed');
    } catch (closeErr) {
      logger.error(`❌ EMERGENCY CLOSE ALSO FAILED: ${closeErr.message} — MANUAL INTERVENTION REQUIRED`);
      await this.notifications.send(
        '🚨🚨 <b>CRITICAL</b>\nOCO failed AND emergency close failed!\nCLOSE MANUALLY NOW!'
      ).catch(() => {});
    }
  }

  /**
   * Move all remaining stop legs to breakeven (entry fill price) after the
   * first target fills. Uses modifyOrder (full replace). If a modify is
   * rejected, the original stop is left in place — never cancel-then-replace.
   */
  async _moveStopsToBreakEven(position, lastKnownPrice) {
    if (!position.bracketLegs || position.bracketLegs.length === 0) return;
    if (position.firstTargetFilled) return; // already done

    const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
    const tickSize = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { tickSize: 0.25 }).tickSize;
    const entryPrice = position.entryPrice;

    // A breakeven stop must still be PROTECTIVE: above the market for a short,
    // below it for a long. If price has already run back through the entry,
    // moving the stop to BE would park it on the wrong side — removing the real
    // stop and leaving the runner effectively unprotected. Observed live 2 Sep
    // (entry 29150.50, price 29159, BE buy-stop landed 8.5pt BELOW the market).
    // In that case keep the original stop: worse price, but actual protection.
    const isLong = position.side === 'Buy';
    if (Number.isFinite(lastKnownPrice)) {
      const wouldBeThroughMarket = isLong
        ? entryPrice >= lastKnownPrice
        : entryPrice <= lastKnownPrice;
      if (wouldBeThroughMarket) {
        logger.warn(`⚠️ BE move SKIPPED — breakeven ${entryPrice.toFixed(2)} is through the market (${lastKnownPrice.toFixed(2)}). Keeping the original stop so the position stays protected.`);
        await this.notifications.send(
          `⚠️ <b>Breakeven move skipped — ${this.contract?.name || 'MNQ'}</b>\n` +
          `Price is already back at ${lastKnownPrice.toFixed(2)}, so a breakeven stop at ${entryPrice.toFixed(2)} would sit on the wrong side and remove your protection.\n` +
          `Original stop ${position.stopLoss != null ? position.stopLoss.toFixed(2) : '—'} left in place.`
        ).catch(() => {});
        return;
      }
    }

    position.firstTargetFilled = true;
    let moved = 0;
    let failed = 0;

    for (let i = 0; i < position.bracketLegs.length; i++) {
      const leg = position.bracketLegs[i];
      // Skip legs whose target already filled (they self-cancelled via OCO)
      // We can't easily know which leg filled from the fill event alone,
      // so we attempt to modify all remaining legs. If a leg was already
      // cancelled by the OCO linkage, the modify will fail — that's fine.
      try {
        // Check if this stop order is still working before modifying
        const order = await this.client.getOrder(leg.orderId);
        if (!order || order.ordStatus === 'Cancelled' || order.ordStatus === 'Filled' || order.ordStatus === 'Rejected') {
          logger.info(`BE move: leg ${i+1} stopOrderId=${leg.orderId} status=${order?.ordStatus || 'gone'} — skipping`);
          continue;
        }
        logger.trade(`Moving stop to BE: leg ${i+1} orderId=${leg.orderId} → stopPrice ${entryPrice.toFixed(2)}`);
        await this.client.modifyOrder(leg.orderId, {
          orderType: 'Stop',
          orderQty: leg.qty,
          stopPrice: entryPrice,
          tickSize,
        });
        moved++;
        logger.success(`✓ BE move: leg ${i+1} stop → ${entryPrice.toFixed(2)}`);
      } catch (err) {
        failed++;
        if (err.isOrderRejection) {
          logger.warn(`BE move REJECTED for leg ${i+1}: ${err.rejectReason || err.message} — original stop remains in place`);
        } else {
          logger.error(`BE move failed for leg ${i+1}: ${err.message} — original stop remains in place`);
        }
      }
    }

    if (moved > 0) {
      await this.notifications.send(
        `🔒 <b>STOP → BREAKEVEN</b>\nMoved ${moved} leg(s) to BE @ $${entryPrice.toFixed(2)}` +
        (failed > 0 ? `\n${failed} leg(s) kept original stop (modify rejected)` : '')
      ).catch(() => {});
    }
  }

  /**
   * Cancel all bracket legs for a position. Used by EOD flatten, /flatten,
   * and post-fill risk emergency close.
   */
  async _cancelAllBracketLegs(position) {
    if (!position) return;
    // Prefer per-leg cancellation for multi-leg positions
    if (position.bracketLegs && position.bracketLegs.length > 0) {
      for (const leg of position.bracketLegs) {
        for (const oid of [leg.orderId, leg.ocoId]) {
          if (oid) {
            try { await this.client.cancelOrder(oid); } catch (e) { /* may already be cancelled */ }
          }
        }
      }
    } else {
      // Fallback: cancelAllOrders (cancels everything for the account)
      try { await this.client.cancelAllOrders(this.account.id); } catch (e) { /* ignore */ }
    }
  }

  // ── Signal execution (entry point from webhook) ───────────────────

  /**
   * Execute a validated signal from the webhook.
   * Runs through all guards before calling SignalHandler.
   * @param {Object} signal - Validated signal from WebhookServer
   * @returns {Object} { accepted, reason?, orderId?, status? }
   */
  async executeSignal(signal) {
    // Guard: paused
    if (this._pausedByUser) {
      logger.warn('Signal blocked: Trading paused by user');
      return { accepted: false, reason: 'blocked: paused by user', blocked: true };
    }

    // Guard: halted by loss limits
    const canTrade = this.lossLimits.canTrade();
    if (!canTrade.allowed) {
      logger.warn(`Signal blocked: halted (${canTrade.reason})`);
      return { accepted: false, reason: `blocked: ${canTrade.message || canTrade.reason}`, blocked: true };
    }

    // Guard: Thursday disabled
    if (process.env.DISABLE_THURSDAY === 'true') {
      const pst = this._getPSTTime();
      if (pst.dayOfWeek === 4) {
        logger.warn('Signal blocked: Thursday trading disabled');
        return { accepted: false, reason: 'blocked: Thursday trading disabled', blocked: true };
      }
    }

    // Guard: past entry cutoff
    if (this._isPastEntryCutoff()) {
      const pst = this._getPSTTime();
      logger.warn(`Signal blocked: past entry cutoff (${pst.hour}:${String(pst.minute).padStart(2, '0')} PST)`);
      return { accepted: false, reason: `blocked: past entry cutoff (${pst.hour}:${String(pst.minute).padStart(2, '0')} PST)`, blocked: true };
    }

    // Guard: max trades per day
    if (this._tradesToday >= this._maxTradesPerDay) {
      logger.warn(`Signal blocked: max trades per day reached (${this._tradesToday}/${this._maxTradesPerDay})`);
      return { accepted: false, reason: `blocked: max trades per day reached (${this._tradesToday}/${this._maxTradesPerDay})`, blocked: true };
    }

    // Guard: already in position
    if (this.signalHandler.getPosition()) {
      logger.warn('Signal blocked: already in position');
      return { accepted: false, reason: 'blocked: already in position', blocked: true };
    }

    // Reset fill accumulators before new entry
    this.positionHandler.resetFillAccumulators();

    // Execute through signal handler
    const result = await this.signalHandler.handleSignal(signal);

    if (result.executed) {
      this._tradesToday++;
      logger.info(`📊 Trades today: ${this._tradesToday}/${this._maxTradesPerDay}`);

      // Start entry timeout for any RESTING entry order (Limit or Stop).
      // A stop entry that never triggers is not harmless: left working it can
      // fire hours later at a level the setup has long since invalidated.
      // It gets the same timeout-and-cancel treatment as a limit.
      if (signal.orderType === 'Limit' || signal.orderType === 'Stop') {
        const pos = this.signalHandler.getPosition();
        if (pos && (pos._isLimitEntry || pos._isStopEntry) && pos.orderId) {
          if (pos.stopOrderId) {
            logger.info(`${signal.orderType} order already filled & OCO placed — skipping timeout`);
          } else {
            // A stop entry waits on a BREAK, which can take several bars. The
            // 180s limit default is under one 5m bar and would cancel a live
            // setup before it ever triggered, so stops get a longer default.
            const defaultSec = signal.orderType === 'Stop'
              ? (this.config.stopEntryTimeoutSec || 900)
              : (this.config.limitEntryTimeoutSec || 180);
            const timeoutSec = signal.entryTimeoutSec > 0 ? signal.entryTimeoutSec : defaultSec;
            logger.info(`${signal.orderType} entry resting @ order ${pos.orderId} — auto-cancel in ${timeoutSec}s if not triggered`);
            this._startLimitEntryTimeout(pos.orderId, timeoutSec * 1000);

            // The setup is ARMED but not filled. This is the moment worth
            // knowing about — the order is at the broker waiting for the break.
            const symArm = this.contract?.name || this.config.contractSymbol || 'MNQ';
            const pvArm = (CONTRACTS[symArm.substring(0, 3)] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
            await this.notifications.send(NF.setupArmed({
              symbol: symArm,
              side: pos.side,
              entry: pos.entryPrice,
              stop: pos.stopLoss,
              exits: signal.exits || (pos.target != null ? [{ qty: pos.quantity, targetPrice: pos.target }] : null),
              qty: pos.quantity,
              pointValue: pvArm,
              timeoutSec,
              orderType: signal.orderType,
            })).catch(() => {});
          }
        }
      }

      // Start fill watchdog for MARKET orders only.
      //
      // The watchdog declares failure and emergency-closes if an order has not
      // filled within 10s. That is right for a market order and actively
      // destructive for a resting one: a Limit or Stop entry is SUPPOSED to sit
      // unfilled until price reaches it. Verified live on 1 Sep — a stop entry
      // parked 490 points away was emergency-closed 10s after placement, which
      // cleared currentPosition and orphaned a live working order at the
      // broker: flatten could no longer see it ("No open position"), and had it
      // later triggered there would have been no position state to attach the
      // OCO to — a naked position with no stop.
      //
      // Resting entries are covered by _startLimitEntryTimeout above instead.
      const isRestingEntry = signal.orderType === 'Limit' || signal.orderType === 'Stop';
      if (!isRestingEntry && result.position && result.position.orderId && !result.position.stopOrderId) {
        this._startFillWatchdog(result.position.orderId);
      }

      return {
        accepted: true,
        signalId: signal.signalId,
        status: 'submitted',
        orderId: result.orderId,
      };
    }

    return {
      accepted: false,
      reason: result.reason || 'Signal rejected',
      blocked: result.blocked || false,
    };
  }

  // ── Fill handling ─────────────────────────────────────────────────

  async _onFill(fill) {
    // Hardened fill dedup — Tradovate sends fills via both 'fill' and 'props' events
    if (!this._processedFillIds) this._processedFillIds = new Set();
    const fillId = fill.id;
    const compositeKey = `${fill.orderId || ''}_${fill.price || ''}_${fill.qty || fill.quantity || ''}_${fill.timestamp || ''}`;
    const dedupKey = fillId ? String(fillId) : compositeKey;

    if (dedupKey && this._processedFillIds.has(dedupKey)) {
      logger.debug(`Fill dedup: skipping (key=${dedupKey})`);
      return;
    }
    if (dedupKey) {
      this._processedFillIds.add(dedupKey);
      if (this._processedFillIds.size > 200) {
        const first = this._processedFillIds.values().next().value;
        this._processedFillIds.delete(first);
      }
    }

    const result = await this.positionHandler.handleFill(
      fill,
      this.signalHandler.getPosition(),
      this.signalHandler.getTradeId()
    );

    // Partial exit — move to BE only when a TARGET filled.
    // Verified live 2 Sep: a STOP-OUT satisfied this condition, so losing half
    // the position triggered "move the rest to breakeven" — which then placed
    // the remaining stop through the market and removed its real protection.
    if (result.isExit && !result.isFullyClosed && !result.duplicate) {
      const pos = this.signalHandler.getPosition();
      if (result.exitKind === 'stop') {
        logger.warn('🛑 That partial exit was a STOP, not a target — NOT moving stops to breakeven.');
      } else if (pos && pos.moveStopToBEAfterFirstTarget && !pos.firstTargetFilled) {
        logger.info(`🔒 First target filled — moving remaining stops to BE`);
        // The exit fill price is the most recent market print we have; the bot
        // has no quote feed. Pass it so the BE move can refuse to park a stop
        // on the wrong side of the market.
        await this._moveStopsToBreakEven(pos, result.exitPrice).catch(err => {
          logger.error(`BE move failed: ${err.message}`);
        });
      }
    }

    if (result.isFullyClosed) {
      this._clearExitWatchdog();
      this.signalHandler.clearPosition();
    }
  }

  // ── Startup sync ──────────────────────────────────────────────────

  async _startupSync() {
    try {
      const accountId = this.account.id;
      const contractId = this.contract?.id;
      if (!contractId) return;

      const positions = await this.client.getOpenPositions(accountId);
      const myPositions = positions.filter(p => p.contractId === contractId);

      if (myPositions.length > 0) {
        const pos = myPositions[0];
        const side = pos.netPos > 0 ? 'Buy' : 'Sell';
        const qty = Math.abs(pos.netPos);
        const entryPrice = pos.netPrice;

        logger.warn(`[StartupSync] Found existing position: ${side} ${qty} @ ${entryPrice} — re-adopting`);

        const workingOrders = await this.client.getWorkingOrders(accountId);
        const myOrders = workingOrders.filter(o => o.contractId === contractId);

        // Fetch order versions to get orderType, stopPrice, price, orderQty.
        // The /order/list endpoint does NOT return these fields — without
        // orderVersion we cannot classify stops vs targets.
        const versionMap = await this.client.getOrderVersionMap(accountId);

        const exitSide = side === 'Buy' ? 'Sell' : 'Buy';
        // Collect ALL stop and target orders (multi-leg positions have multiple)
        // Classify using orderVersion.orderType, not the order object (which lacks ordType)
        const stopOrders = [];
        const targetOrders = [];
        for (const o of myOrders) {
          if (o.action !== exitSide) continue;
          const v = versionMap[o.id] || {};
          const ot = v.orderType || '';
          if (ot === 'Stop' || ot === 'StopLimit') {
            stopOrders.push({ ...o, _version: v });
          } else if (ot === 'Limit') {
            targetOrders.push({ ...o, _version: v });
          }
        }

        logger.info(`[StartupSync] Working orders: ${myOrders.length} | Stops: ${stopOrders.length} | Targets: ${targetOrders.length}`);

        // Pair stops with targets by OCO linkage.
        // Each stop order's ocoId points to its target's order ID, and vice versa.
        const bracketLegs = [];
        const matchedTargetIds = new Set();
        for (const so of stopOrders) {
          const v = so._version || {};
          // Find the target order that is OCO-linked to this stop
          let matchedTarget = null;
          if (so.ocoId) {
            matchedTarget = targetOrders.find(to => to.id === so.ocoId);
          }
          if (!matchedTarget) {
            // Fallback: match by index
            const idx = stopOrders.indexOf(so);
            matchedTarget = targetOrders[idx] || null;
          }
          if (matchedTarget) matchedTargetIds.add(matchedTarget.id);

          bracketLegs.push({
            orderId: so.id,
            ocoId: matchedTarget ? matchedTarget.id : null,
            qty: v.orderQty || 1,
            targetPrice: matchedTarget ? (matchedTarget._version?.price ?? null) : null,
            stopPrice: v.stopPrice ?? null,
          });
        }
        // Handle orphan targets (no matching stop — shouldn't happen but be safe)
        for (const to of targetOrders) {
          if (!matchedTargetIds.has(to.id)) {
            bracketLegs.push({
              orderId: null,
              ocoId: to.id,
              qty: to._version?.orderQty || 1,
              targetPrice: to._version?.price ?? null,
              stopPrice: null,
            });
          }
        }

        const stopPrice = stopOrders.length > 0 ? (stopOrders[0]._version?.stopPrice ?? null) : null;
        const targetPrice = targetOrders.length > 0 ? (targetOrders[0]._version?.price ?? null) : null;

        const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
        const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
        const risk = stopPrice ? Math.abs(entryPrice - stopPrice) * qty * pv : 0;

        const adoptedPosition = {
          side, quantity: qty, entryPrice,
          stopLoss: stopPrice, target: targetPrice, risk,
          orderId: null,
          stopOrderId: stopOrders.length > 0 ? stopOrders[0].id : null,
          targetOrderId: targetOrders.length > 0 ? targetOrders[0].id : null,
          bracketLegs,
          exits: null,
          moveStopToBEAfterFirstTarget: false,
          firstTargetFilled: false,
          entryTime: new Date(),
          strategyName: 'adopted',
          _adopted: true,
        };

        this.signalHandler.currentPosition = adoptedPosition;

        const stopInfo = stopPrice ? `stop $${stopPrice.toFixed(2)}` : 'NO STOP ⚠️';
        const targetInfo = targetPrice ? `target $${targetPrice.toFixed(2)}` : 'no target';
        const legInfo = bracketLegs.length > 1 ? ` (${bracketLegs.length} legs)` : '';
        logger.success(`[StartupSync] ✓ Re-adopted: ${side} ${qty} @ ${entryPrice} | ${stopInfo} | ${targetInfo}${legInfo}`);

        // Show EVERY target, not just the first — a 2-leg position that reports
        // only T1 hides half the plan.
        const symA = this.contract?.name || this.config.contractSymbol || 'MNQ';
        const pvA = (CONTRACTS[symA.substring(0, 3)] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
        await this.notifications.send(NF.startupAdopted({
          symbol: symA,
          position: this.signalHandler.getPosition() || {
            side, quantity: qty, entryPrice, stopLoss: stopOrders[0]?.stopPrice ?? null, bracketLegs,
          },
          hasStop: stopOrders.length > 0,
          pointValue: pvA,
        })).catch(() => {});

        if (stopOrders.length === 0) {
          logger.error('[StartupSync] ⚠️ DANGER: Position has no stop order!');
          await this.notifications.send(
            `🚨 <b>UNPROTECTED POSITION — ${symA}</b>\n` +
            `${side} ${qty} @ ${entryPrice} has NO STOP at the broker.\n` +
            `Flatten it or set a stop now.`
          ).catch(() => {});
        }
      } else {
        // No position — cancel orphaned orders
        let cancelledCount = 0;
        try {
          const strategies = await this.client.getOrderStrategies(accountId);
          if (Array.isArray(strategies)) {
            const active = strategies.filter(s => s.status === 'ActiveStrategy' || s.status === 'ExecutionSuspended');
            for (const strat of active) {
              try {
                await this.client.interruptOrderStrategy(strat.id);
                cancelledCount++;
              } catch (e) { /* ignore */ }
            }
          }
        } catch (e) { /* ignore */ }

        const workingOrders = await this.client.getWorkingOrders(accountId);
        const myOrders = workingOrders.filter(o => o.contractId === contractId);
        for (const o of myOrders) {
          try { await this.client.cancelOrder(o.id); cancelledCount++; } catch (e) { /* ignore */ }
        }

        if (cancelledCount > 0) {
          logger.info(`[StartupSync] Cancelled ${cancelledCount} orphaned orders/strategies`);
        }
      }
    } catch (err) {
      logger.warn(`[StartupSync] Failed: ${err.message}`);
    }
  }

  // ── Session manager (daily reset + EOD flatten) ───────────────────

  _startSessionManager() {
    const checkSession = async () => {
      if (!this.isRunning) return;

      const pst = this._getPSTTime();
      const mins = pst.hour * 60 + pst.minute;
      const sessionStart = this.config.tradingStartHour * 60 + this.config.tradingStartMinute;
      const sessionEnd = this.config.tradingEndHour * 60 + this.config.tradingEndMinute;

      // Daily reset at 6:29 AM PST (1 min before session)
      if (pst.hour === 6 && pst.minute === 29 && !this._todayResetDone) {
        this._todayResetDone = true;
        this._eodCloseDoneToday = false;
        this._dailyReportSentToday = false;
        this._sessionStartLoggedToday = false;
        this._tradesToday = 0;

        if (this.lossLimits) {
          const result = this.lossLimits.resetDaily();
          if (result.wasHalted) {
            logger.info('[Daily Reset] Cleared halt — trading re-enabled');
          }
        }
        logger.info('🔄 Daily reset — new trading day');
        await this.notifications.send('🔄 New trading day — execution bot reset').catch(() => {});
      }

      // Reset daily flags after midnight PST
      if (pst.hour === 0 && pst.minute < 2) {
        this._todayResetDone = false;
        this._dailyReportSentToday = false;
      }

      // EOD force-close at sessionEnd - 5 min
      if (mins >= sessionEnd - 5 && mins < sessionEnd && !this._eodCloseDoneToday) {
        if (this.signalHandler && this.signalHandler.getPosition()) {
          logger.warn('⏰ EOD approaching — force-closing open position');
          try {
            const pos = this.signalHandler.getPosition();
            const closeAction = pos.side === 'Buy' ? 'Sell' : 'Buy';

            // Cancel bracket orders (all legs for multi-leg positions)
            try {
              await this._cancelAllBracketLegs(pos);
              logger.info(`⏰ EOD: Cancelled bracket orders`);
            } catch (e) {
              logger.warn(`EOD cancel failed: ${e.message}`);
            }

            // Close exactly the broker's current net position. Bot state can
            // still contain the original quantity after a partial exit; using
            // it here can over-close and reverse the account.
            const brokerPositions = await this.client.getOpenPositions(this.account.id);
            const brokerPos = brokerPositions.find(p => p.contractId === this.contract?.id);
            const brokerNetPos = brokerPos ? brokerPos.netPos : 0;
            if (!Number.isFinite(brokerNetPos) || brokerNetPos === 0) {
              logger.warn('EOD: broker is already flat — no market close sent');
              this.signalHandler.clearPosition();
              this.positionHandler.resetFillAccumulators();
              this._eodCloseDoneToday = true;
              return;
            }
            const eodQty = Math.abs(brokerNetPos);
            const eodAction = brokerNetPos > 0 ? 'Sell' : 'Buy';
            const eodOrder = await this.client.placeMarketOrder(
              this.account.id, this.contract.id, eodQty, eodAction
            );
            logger.success(`✓ EOD position closed: ${eodAction} ${eodQty}`);

            // Fetch fill price and record P&L
            let exitPrice = null;
            let eodPnl = 0;
            const eodOrderId = eodOrder?.orderId;
            try {
              if (eodOrderId) {
                await new Promise(r => setTimeout(r, 1500));
                const fills = await this.client.getFillsByOrder(eodOrderId);
                if (Array.isArray(fills) && fills.length > 0) exitPrice = fills[0].price;
              }
            } catch (e) {
              logger.warn(`EOD: Could not get fill price: ${e.message}`);
            }

            if (exitPrice !== null && pos.entryPrice) {
              const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
              const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
              const isLong = pos.side === 'Buy';
              eodPnl = isLong
                ? (exitPrice - pos.entryPrice) * eodQty * pv
                : (pos.entryPrice - exitPrice) * eodQty * pv;

              if (this.lossLimits) {
                this.lossLimits.recordTrade(eodPnl, {
                  symbol: this.contract?.name || 'MNQ',
                  quantity: eodQty,
                  tradeId: pos.orderId,
                });
              }
              if (this.performance) {
                this.performance.recordTrade({
                  id: pos.orderId,
                  symbol: this.contract?.name || 'MNQ',
                  side: pos.side,
                  quantity: eodQty,
                  entryPrice: pos.entryPrice,
                  exitPrice,
                  stopLoss: pos.stopLoss,
                  target: pos.target,
                  pnl: eodPnl,
                  exitReason: 'EOD Close',
                });
              }
            }

            // Clean up state
            this.signalHandler.clearPosition();
            this.positionHandler.resetFillAccumulators();
            this._eodCloseDoneToday = true;

            const pnlStr = exitPrice !== null ? ` | P&L: ${eodPnl >= 0 ? '+' : ''}$${eodPnl.toFixed(2)}` : '';
            const exitStr = exitPrice !== null ? `@ $${exitPrice.toFixed(2)}` : '@ market';
            await this.notifications.send(`⏰ EOD close: ${eodAction} ${eodQty} ${exitStr}${pnlStr}`).catch(() => {});
          } catch (err) {
            // Preserve tracked state after a failed close. Clearing it while
            // the broker may still hold the position would disable later
            // reconciliation and make a live position invisible to the bot.
            logger.error(`EOD close failed: ${err.message}`);
            await this.notifications.error(`EOD close failed: ${err.message} — broker position was not cleared; CHECK AND CLOSE MANUALLY.`).catch(() => {});
          }
        } else {
          this._eodCloseDoneToday = true;
        }
      }

      // Session start log
      if (mins >= sessionStart && !this._sessionStartLoggedToday) {
        this._sessionStartLoggedToday = true;
        logger.info('🔔 Trading session started');
      }

      // EOD daily report
      if (mins >= sessionEnd && !this._dailyReportSentToday) {
        logger.info('🔔 Session ended — generating daily report');
        await this._sendDailyReport('Session ended');
      }
    };

    this._sessionCheckInterval = setInterval(checkSession, 15000);
    checkSession();
  }

  async _sendDailyReport(reason) {
    if (this._dailyReportSentToday) return;
    this._dailyReportSentToday = true;

    try {
      const todayStats = this.performance.getTodayStats();
      const today = new Date().toISOString().split('T')[0];
      const todayTrades = (this.performance.trades || []).filter(t => t.date === today);

      await this.notifications.dailyPerformanceReport?.(todayStats, reason, todayTrades).catch(() => {});

      const fs = require('fs');
      const path = require('path');
      const logDir = path.join('.', 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

      const logEntry = {
        date: today, reason,
        trades: todayStats.trades, wins: todayStats.wins, losses: todayStats.losses,
        pnl: todayStats.pnl, winRate: todayStats.winRate, profitFactor: todayStats.profitFactor,
        tradeDetails: todayTrades.map(t => ({
          side: t.side, entry: t.entryPrice, exit: t.exitPrice,
          pnl: t.pnl, exitReason: t.exitReason, time: t.timestamp,
        })),
      };

      fs.writeFileSync(path.join(logDir, `daily_${today}.json`), JSON.stringify(logEntry, null, 2));
      logger.info(`📊 Day: ${todayStats.trades} trades | ${todayStats.wins}W/${todayStats.losses}L | P&L: $${todayStats.pnl.toFixed(2)} | ${reason}`);
    } catch (err) {
      logger.error(`Daily report failed: ${err.message}`);
    }
  }

  // ── Limit entry timeout ───────────────────────────────────────────

  /**
   * Every order update passes through here so a REJECTION is acted on, not
   * just logged.
   *
   * Why this exists (found live, 2 Sep 2026): placeorder returns HTTP 200 with
   * an orderId, and _assertOrderPlaced checks that response — but Tradovate can
   * reject the order microseconds LATER, asynchronously, over this WebSocket.
   * The observed sequence was:
   *
   *     Order update: PendingNew orderId=634602920589
   *     Order update: Rejected   orderId=634602920589
   *     ✓ Entry order placed (Stop): 634602920589      <-- bot said SUCCESS
   *     Stop entry resting @ order 634602920589
   *
   * The bot then tracked a resting entry that did not exist at the broker, and
   * would have waited forever for a fill that could never come. Silent.
   */
  async _onOrderUpdate(order) {
    this.positionHandler.handleOrderUpdate(order);
    if (!order || order.ordStatus !== 'Rejected') return;

    const rejectedId = order.id || order.orderId;
    const reason = order.rejectReason || order.text || 'no reason given';
    const pos = this.signalHandler?.getPosition();

    // Is this the ENTRY order we believe is working?
    if (pos && pos.orderId === rejectedId && !pos.stopOrderId) {
      logger.error(`❌ ENTRY ORDER REJECTED by broker (orderId=${rejectedId}): ${reason}`);
      logger.error('   No order exists at the broker. Clearing position state — this was NOT a trade.');
      this._clearLimitEntryTimeout();
      this._clearFillWatchdog?.();
      this.signalHandler.clearPosition();
      this.positionHandler.resetFillAccumulators();

      // The signal never became a trade, so it must not consume the daily
      // budget. Without this, a rejected order silently costs one of 3 trades.
      this._refundTradeBudget(rejectedId, 'entry rejected by broker');

      this.notifications.send(
        `❌ <b>ENTRY REJECTED</b>\nBroker rejected the entry order.\nReason: ${reason}\nNo position was opened. Budget refunded.`
      ).catch(() => {});
      return;
    }

    // A rejected stop means the position is unprotected. Halt entries and
    // flatten against broker state immediately; waiting for an operator to see
    // Telegram is not an acceptable protection mechanism.
    const isStopLeg = pos && ((pos.bracketLegs || []).some(l => l.orderId === rejectedId)
      || pos.stopOrderId === rejectedId);
    const isTargetLeg = pos && ((pos.bracketLegs || []).some(l => l.ocoId === rejectedId)
      || pos.targetOrderId === rejectedId);
    if (isStopLeg) {
      logger.error(`🚨 STOP BRACKET REJECTED (orderId=${rejectedId}): ${reason} — halting and flattening`);
      this.lossLimits?.halt('BRACKET_ORDER_REJECTED', `Protective stop rejected: ${reason}`);
      await this.notifications.send(
        `🚨🚨 <b>STOP REJECTED</b>\nBroker rejected the protective stop: ${reason}\nTrading halted. Flattening the broker position now.`
      ).catch(() => {});
      const flattened = await this.flattenAll();
      if (!flattened?.flattened) {
        logger.error(`🚨 Could not flatten after protective-stop rejection: ${flattened?.error || flattened?.reason || 'unknown error'}`);
        await this.notifications.send('🚨🚨 <b>CRITICAL</b>\nProtective stop was rejected and automatic flatten failed. CLOSE THE POSITION MANUALLY NOW.').catch(() => {});
      }
    } else if (isTargetLeg) {
      logger.error(`🚨 TARGET BRACKET REJECTED (orderId=${rejectedId}): ${reason} — stop remains the active protection`);
      await this.notifications.send(
        `⚠️ <b>TARGET REJECTED</b>\nBroker rejected a profit target: ${reason}\nThe stop remains active; check the position and target.`
      ).catch(() => {});
    }
  }

  /**
   * Give back a trade-budget slot for an entry that never became a trade.
   *
   * Keyed by order id and idempotent: a double refund would silently hand out
   * a 4th trade on a 3-trade limit, which is a guardrail being weakened rather
   * than enforced. Rejection, timeout-cancel and manual-cancel can all race for
   * the same entry, so "unlikely to overlap" is not good enough here.
   */
  _refundTradeBudget(orderId, why) {
    if (!this._refundedEntryIds) this._refundedEntryIds = new Set();
    const key = String(orderId ?? 'unknown');
    if (this._refundedEntryIds.has(key)) {
      logger.debug(`Budget already refunded for order ${key} — not refunding twice`);
      return false;
    }
    this._refundedEntryIds.add(key);
    if (this._refundedEntryIds.size > 100) {
      this._refundedEntryIds.delete(this._refundedEntryIds.values().next().value);
    }
    if (this._tradesToday > 0) {
      this._tradesToday--;
      logger.info(`   Trade budget refunded (${why}) — trades today: ${this._tradesToday}/${this._maxTradesPerDay}`);
      return true;
    }
    return false;
  }

  _startLimitEntryTimeout(orderId, timeoutMs) {
    this._clearLimitEntryTimeout();
    logger.info(`⏱ Limit entry timeout: cancel orderId=${orderId} in ${(timeoutMs / 1000).toFixed(0)}s if unfilled`);
    this._limitEntryTimer = setTimeout(async () => {
      this._limitEntryTimer = null;
      try {
        const posNow = this.signalHandler.getPosition();
        if (posNow && posNow.stopOrderId) {
          logger.info('Limit entry already filled & OCO placed — skipping cancel');
          return;
        }
        // Check if filled but WS missed it
        try {
          const fills = await this.client.getFillsByOrder(orderId);
          if (Array.isArray(fills) && fills.length > 0) {
            logger.warn(`⏰ Limit timeout but order FILLED (WS missed) — recovering: ${fills[0].action} ${fills[0].qty || 1} @ ${fills[0].price}`);
            await this._onFill(fills[0]);
            return;
          }
        } catch (e) { logger.warn(`Limit-timeout fill check failed: ${e.message}`); }

        logger.warn(`⏰ Limit entry timeout — cancelling orderId=${orderId}`);
        await this.client.cancelOrder(orderId);
        this.signalHandler.clearPosition();
        // Never filled, so it was never a trade — refund the daily budget.
        // Otherwise a setup that arms and expires costs one of only 3 trades.
        this._refundTradeBudget(orderId, 'entry timed out unfilled');
        logger.info('✓ Limit entry cancelled, ready for new signals');
      } catch (err) {
        logger.error(`❌ Failed to cancel limit entry: ${err.message}`);
      }
    }, timeoutMs);
  }

  _clearLimitEntryTimeout() {
    if (this._limitEntryTimer) {
      clearTimeout(this._limitEntryTimer);
      this._limitEntryTimer = null;
    }
  }

  // ── Fill watchdog ─────────────────────────────────────────────────

  _startFillWatchdog(orderId) {
    this._clearFillWatchdog();
    this._fillWatchdogOrderId = orderId;
    logger.info(`⏱ Fill watchdog: checking orderId=${orderId} in 5s if no WebSocket fill`);
    this._fillWatchdogTimer = setTimeout(async () => {
      this._fillWatchdogTimer = null;
      const pos = this.signalHandler.getPosition();
      if (!pos || pos.stopOrderId) return;
      if (pos.orderId !== orderId) return;

      logger.warn(`⚠️ FILL WATCHDOG: No WS fill for orderId=${orderId} after 5s — polling REST`);
      try {
        const fills = await this.client.getFillsByOrder(orderId);
        if (Array.isArray(fills) && fills.length > 0) {
          const fill = fills[0];
          logger.warn(`⚠️ FILL WATCHDOG: Found fill via REST: ${fill.action} ${fill.qty || 1} @ ${fill.price}`);
          await this.notifications.send(
            `⚠️ <b>FILL WATCHDOG</b>\nWebSocket missed fill for order ${orderId}\nRecovered via REST: ${fill.action} ${fill.qty || 1} @ ${fill.price}`
          ).catch(() => {});
          await this._onFill(fill);
        } else {
          try {
            const order = await this.client.request('GET', `/order/item?id=${orderId}`);
            if (order && order.ordStatus === 'Rejected') {
              logger.error(`🚨 FILL WATCHDOG: Order ${orderId} REJECTED — clearing position`);
              this.signalHandler.clearPosition();
              await this.notifications.send(
                `🚨 <b>ORDER REJECTED</b>\nOrder ${orderId} rejected: ${order.rejectReason || order.text || 'unknown'}`
              ).catch(() => {});
            } else if (pos._isLimitEntry) {
              logger.info(`⏳ FILL WATCHDOG: limit ${orderId} still working — re-polling in 10s`);
              this._fillWatchdogTimer = setTimeout(() => this._startFillWatchdog(orderId), 10000);
            } else {
              logger.warn(`⚠️ FILL WATCHDOG: No fills, status=${order?.ordStatus || 'unknown'} — retry in 5s`);
              this._fillWatchdogTimer = setTimeout(async () => {
                this._fillWatchdogTimer = null;
                const pos2 = this.signalHandler.getPosition();
                if (!pos2 || pos2.stopOrderId || pos2.orderId !== orderId) return;
                logger.error('🚨 FILL WATCHDOG: Still no fill after 10s — emergency close');
                await this.notifications.send(
                  `🚨 <b>FILL WATCHDOG TIMEOUT</b>\nNo fill for order ${orderId} after 10s. Emergency closing...`
                ).catch(() => {});
                try {
                  const positions = await this.client.getOpenPositions(this.account.id);
                  const myPos = positions.find(p => p.contractId === this.contract?.id);
                  if (myPos && myPos.netPos !== 0) {
                    await this.client.liquidatePosition(this.account.id, this.contract.id, myPos.netPos);
                    logger.error('🚨 FILL WATCHDOG: Liquidated naked exchange position');
                  }
                } catch (liqErr) {
                  logger.error(`🚨 FILL WATCHDOG: Liquidation failed: ${liqErr.message}`);
                }
                this.signalHandler.clearPosition();
              }, 5000);
            }
          } catch (orderErr) {
            logger.warn(`FILL WATCHDOG: Could not check order status: ${orderErr.message}`);
          }
        }
      } catch (err) {
        logger.error(`FILL WATCHDOG: REST poll failed: ${err.message}`);
      }
    }, 5000);
  }

  _clearFillWatchdog() {
    if (this._fillWatchdogTimer) {
      clearTimeout(this._fillWatchdogTimer);
      this._fillWatchdogTimer = null;
    }
  }

  // ── Exit fill watchdog ─────────────────────────────────────────────

  /**
   * Start polling the broker for position changes while a position is open.
   * This catches exit fills (OCO legs filling) that the WebSocket may miss.
   * The broker is the source of truth — if netPos drops, an exit fill happened.
   * Also detects full closes (netPos → 0) and reconciles bot state.
   */
  _startExitWatchdog() {
    this._clearExitWatchdog();
    // Per-position, so a later trade with the same qty mismatch is not
    // silently suppressed by the previous trade's dedup key.
    this._lastMismatchKey = null;
    const intervalMs = 5000; // poll every 5 seconds
    logger.info(`⏱ Exit watchdog: polling broker every ${intervalMs/1000}s for position changes`);

    this._exitWatchdogTimer = setInterval(async () => {
      if (this._exitWatchdogTimer === null) return;
      const pos = this.signalHandler?.getPosition();
      if (!pos) {
        this._clearExitWatchdog();
        return;
      }

      try {
        const positions = await this.client.getOpenPositions(this.account.id);
        const contractId = this.contract?.id;
        const brokerPos = positions.find(p => p.contractId === contractId);
        const brokerNetPos = brokerPos ? brokerPos.netPos : 0;
        const botQty = pos.quantity || 0;

        // Detect partial exit: broker has fewer contracts than bot thinks.
        //
        // Only report a given mismatch ONCE. If the recovered fill is deduped
        // (already processed via the WebSocket) nothing updates pos.quantity,
        // so the same mismatch is re-detected every 5s and the log fills with
        // an identical warning forever — observed 2 Sep, ~12 repeats before
        // the position closed. The reconciliation below is still attempted;
        // this only silences the repeat.
        if (Math.abs(brokerNetPos) < botQty && Math.abs(brokerNetPos) > 0) {
          const exitedQty = botQty - Math.abs(brokerNetPos);
          const mismatchKey = `${brokerNetPos}:${botQty}`;
          const alreadySeen = this._lastMismatchKey === mismatchKey;
          this._lastMismatchKey = mismatchKey;
          if (alreadySeen) {
            logger.debug(`Exit watchdog: same mismatch (${mismatchKey}) — already reconciling, not repeating`);
          } else {
          logger.warn(`⚠️ EXIT WATCHDOG: Broker netPos=${brokerNetPos} but bot thinks qty=${botQty} — ${exitedQty} contract(s) exited without WS notification`);

          // Fetch recent fills to find the exit fill
          try {
            const workingOrders = await this.client.getWorkingOrders(this.account.id);
            const myOrders = workingOrders.filter(o => o.contractId === contractId);

            // Check if any bracket legs have been filled/cancelled since last poll
            if (pos.bracketLegs && pos.bracketLegs.length > 0) {
              const stillWorking = new Set(myOrders.map(o => o.id));
              const filledLegs = pos.bracketLegs.filter(leg =>
                !stillWorking.has(leg.orderId) && !stillWorking.has(leg.ocoId)
              );

              if (filledLegs.length > 0) {
                // Process each filled leg as an exit fill
                for (const leg of filledLegs) {
                  // Get fills for this leg's target order
                  try {
                    const fills = await this.client.getFillsByOrder(leg.ocoId);
                    if (Array.isArray(fills) && fills.length > 0) {
                      const fill = fills[fills.length - 1]; // most recent
                      logger.warn(`⚠️ EXIT WATCHDOG: Found exit fill via REST: ${fill.action} ${fill.qty || 1} @ ${fill.price}`);
                      // Update position quantity to match broker
                      pos.quantity = Math.abs(brokerNetPos);
                      // Process the fill through the normal path
                      await this._onFill(fill);
                    }
                  } catch (fillErr) {
                    logger.warn(`EXIT WATCHDOG: Could not fetch fills for leg ${leg.ocoId}: ${fillErr.message}`);
                  }
                }
              }
            }
          } catch (ordersErr) {
            logger.warn(`EXIT WATCHDOG: Could not fetch working orders: ${ordersErr.message}`);
          }
          } // end: first sighting of this mismatch

          // Reconcile the bot's size to the broker's regardless of whether a
          // fill was recovered. Without this the mismatch never clears and the
          // watchdog re-detects it on every 5s tick.
          if (pos.quantity !== Math.abs(brokerNetPos)) {
            logger.info(`Exit watchdog: reconciling bot qty ${pos.quantity} → ${Math.abs(brokerNetPos)} (broker)`);
            pos.quantity = Math.abs(brokerNetPos);
          }
        }

        // Detect full close: broker has 0 but bot thinks it has a position
        if (brokerNetPos === 0 && botQty > 0) {
          logger.warn(`⚠️ EXIT WATCHDOG: Position fully closed at broker but bot still thinks qty=${botQty} — reconciling`);
          // Capture the trade id BEFORE any clearPosition() below nulls it —
          // the close-summary guard is keyed on it.
          const tradeIdAtClose = this.signalHandler?.getTradeId?.();

          // Try to find the exit fill
          try {
            if (pos.bracketLegs && pos.bracketLegs.length > 0) {
              for (const leg of pos.bracketLegs) {
                try {
                  const fills = await this.client.getFillsByOrder(leg.ocoId);
                  if (Array.isArray(fills) && fills.length > 0) {
                    const fill = fills[fills.length - 1];
                    logger.warn(`⚠️ EXIT WATCHDOG: Found final exit fill via REST: ${fill.action} ${fill.qty || 1} @ ${fill.price}`);
                    await this._onFill(fill);
                  }
                } catch (e) { /* ignore */ }
              }
            }
          } catch (e) {
            logger.warn(`EXIT WATCHDOG: Could not fetch exit fills: ${e.message}`);
          }

          // If still not cleared, force-clear the position state
          const stillPos = this.signalHandler?.getPosition();
          if (stillPos && stillPos.quantity > 0) {
            logger.error('🚨 EXIT WATCHDOG: Force-clearing stale position state');
            const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
            const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
            this.signalHandler.clearPosition();
            this.positionHandler.resetFillAccumulators();
            await this.notifications.send(
              `⚠️ <b>Position closed at the broker</b>\n` +
              `The WebSocket missed the fill, so the bot reconciled from the broker.\n` +
              `Check the broker for the exact final P&L.`
            ).catch(() => {});
          }

          // SAFETY NET: guarantee a close summary.
          // The accumulator / watchdog / WebSocket race can skip the normal
          // full-close branch entirely — on 2 Sep not one summary fired all
          // day. If nothing reported this trade, report it from broker fills.
          try {
            if (!this.positionHandler.markClosedReported(tradeIdAtClose)) {
              const baseSymbol2 = (this.contract?.name || 'MNQ').substring(0, 3);
              const pv2 = (CONTRACTS[baseSymbol2] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
              const entry = pos.entryPrice;
              const isLong = pos.side === 'Buy';
              let exitQty = 0, exitValue = 0;
              for (const leg of (pos.bracketLegs || [])) {
                for (const id of [leg.ocoId, leg.orderId]) {
                  if (!id) continue;
                  try {
                    const fs2 = await this.client.getFillsByOrder(id);
                    for (const f of (fs2 || [])) {
                      if (f.action !== pos.side) { exitQty += (f.qty || 1); exitValue += f.price * (f.qty || 1); }
                    }
                  } catch (e) { /* best effort */ }
                }
              }
              if (exitQty > 0 && Number.isFinite(entry)) {
                const avgExit = exitValue / exitQty;
                const ptsMoved = isLong ? avgExit - entry : entry - avgExit;
                const pnl = ptsMoved * exitQty * pv2;
                const riskPts = Math.abs(entry - (pos.stopLoss ?? entry));
                const ls = this.lossLimits?.getStatus?.() || {};
                await this.notifications.send(NF.positionClosed({
                  symbol: this.contract?.name || 'MNQ',
                  position: pos, qty: exitQty, avgExit,
                  pnlUsd: pnl, pnlPts: ptsMoved,
                  rMult: riskPts ? ptsMoved / riskPts : null,
                  reason: 'Reconciled from broker fills',
                  dayTrades: ls.tradesToday, maxTrades: this._maxTradesPerDay,
                  dayPnl: ls.dailyPnL, lossBudgetLeft: ls.dailyLossRemaining,
                })).catch(() => {});
                logger.info(`✓ Close summary sent from broker fills: ${exitQty} @ ${avgExit.toFixed(2)}`);
              }
            }
          } catch (e) {
            logger.warn(`Close-summary safety net failed: ${e.message}`);
          }
          this._clearExitWatchdog();
        }
      } catch (err) {
        logger.debug(`Exit watchdog poll failed: ${err.message}`);
      }
    }, intervalMs);
  }

  _clearExitWatchdog() {
    if (this._exitWatchdogTimer) {
      clearInterval(this._exitWatchdogTimer);
      this._exitWatchdogTimer = null;
    }
  }

  // ── Status / positions / flatten (for webhook + Telegram) ─────────

  getStatus() {
    const lossStatus = this.lossLimits?.getStatus() || {};
    const pos = this.signalHandler?.getPosition();
    return {
      connected: this.isRunning,
      executionOnly: true,
      paused: this._pausedByUser,
      halted: lossStatus.isHalted || false,
      haltReason: lossStatus.haltReason || null,
      tradesToday: this._tradesToday,
      maxTrades: this._maxTradesPerDay,
      dailyPnl: lossStatus.dailyPnL || 0,
      lossLimitRemaining: lossStatus.dailyLossRemaining || 0,
      openPositions: pos ? 1 : 0,
      positionSide: pos?.side || null,
      positionQty: pos?.quantity || 0,
      positionEntry: pos?.entryPrice || null,
      positionStop: pos?.stopLoss || null,
      positionTarget: pos?.target || null,
      marketOpen: this.marketHours?.isMarketOpen() || false,
      pastEntryCutoff: this._isPastEntryCutoff(),
      entryCutoffPST: `${this._lastEntryHourPST}:${String(this._lastEntryMinutePST).padStart(2, '0')}`,
      eodFlattenPST: `${Math.floor((this.config.tradingEndHour * 60 + this.config.tradingEndMinute - 5) / 60)}:${String((this.config.tradingEndHour * 60 + this.config.tradingEndMinute - 5) % 60).padStart(2, '0')}`,
    };
  }

  async getOpenPositions() {
    try {
      const positions = await this.client.getOpenPositions(this.account.id);
      const workingOrders = await this.client.getWorkingOrders(this.account.id);
      const contractId = this.contract?.id;
      const myPositions = positions.filter(p => !contractId || p.contractId === contractId);
      const myOrders = workingOrders.filter(o => !contractId || o.contractId === contractId);

      // Enrich each working order with orderType, stopPrice, price, orderQty.
      // The /order/list and /order/item endpoints do NOT return these fields —
      // they live in orderVersion. Fetch the version map once and match by orderId.
      const versionMap = await this.client.getOrderVersionMap(this.account.id);
      const enrichedOrders = myOrders.map((o) => {
        const v = versionMap[o.id] || {};
        return {
          id: o.id,
          ocoId: o.ocoId || null,
          action: o.action,
          ordStatus: o.ordStatus,
          orderType: v.orderType || null,
          stopPrice: v.stopPrice ?? null,
          price: v.price ?? null,
          orderQty: v.orderQty ?? null,
          contractId: o.contractId,
          accountId: o.accountId,
        };
      });

      // Also include bot's tracked bracket legs if we have a position
      const botPos = this.signalHandler?.getPosition();
      const bracketLegs = (botPos && botPos.bracketLegs)
        ? botPos.bracketLegs.map((leg, i) => ({
            legIndex: i,
            orderId: leg.orderId,
            ocoId: leg.ocoId,
            qty: leg.qty,
            targetPrice: leg.targetPrice,
            stopPrice: botPos.stopLoss,
          }))
        : [];

      return {
        positions: myPositions,
        workingOrders: enrichedOrders,
        bracketLegs,
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  /**
   * Modify a working order (e.g. move stop to a new price).
   * @param {number} orderId - The order ID to modify
   * @param {object} changes - { stopPrice, price, orderQty }
   * @returns {object} { modified: true, orderId } or { modified: false, reason }
   */
  async modifyOrder(orderId, changes) {
    // Capture what this order IS before touching it, so the notification can
    // say "leg 2 of 2 stop, 29166 → 29150" instead of an opaque order number.
    const descBefore = NF.describeOrder(orderId, this.signalHandler?.getPosition());
    const prevStop = descBefore.role === 'stop' ? descBefore.current : null;
    const prevTarget = descBefore.role === 'target' ? descBefore.current : null;
    try {
      if (!orderId) {
        return { modified: false, reason: 'orderId is required' };
      }

      // Fetch the current order to get orderType and orderQty
      const current = await this.client.getOrder(orderId);

      // Refuse to "modify" an order that is no longer live. Verified 2 Sep:
      // modifying an order cancelled 20 minutes earlier returned success, so a
      // stop move on a stale id looked like it worked while nothing changed —
      // the worst possible failure for a stop.
      const liveStatuses = ['Working', 'Accepted', 'PendingNew', 'PendingReplace', 'Suspended'];
      const status = current?.ordStatus;
      if (status && !liveStatuses.includes(status)) {
        const reason = `Order ${orderId} is ${status}, not working — nothing to modify. ` +
          `It was likely filled or cancelled already; re-read positions before moving a stop.`;
        logger.warn(`Modify refused: ${reason}`);
        await this.notifications.send(NF.modifyFailed({
          symbol: this.contract?.name || 'MNQ', desc: descBefore,
          reason: `that order is ${status}, not working`,
          orderStillLive: false, ordStatus: status,
        })).catch(() => {});
        return { modified: false, orderId, reason, staleOrder: true, ordStatus: status };
      }
      // Resolve the order's REAL type. /order/item returns only the order
      // shell — orderType, price, stopPrice and orderQty live in the order
      // VERSION (this client documents that on getOrderVersionMap). The old
      // `current.orderType || 'Stop'` therefore defaulted every order to Stop,
      // so modifying a LIMIT target sent orderType:Stop + price and Tradovate
      // replied "Price should not be specified / Stop Price should be
      // specified". That was misread as "OCO targets cannot be modified"; the
      // real cause is this default. Never guess 'Stop' again.
      let version = null;
      try {
        const vmap = await this.client.getOrderVersionMap(this.account.id);
        version = vmap?.[orderId] || null;
      } catch (e) {
        logger.warn(`Modify: could not read order version for ${orderId} (${e.message}) — inferring type from the change`);
      }
      const inferredType = changes.stopPrice != null ? 'Stop'
        : changes.price != null ? 'Limit'
        : null;
      const orderType = version?.orderType || current.orderType || inferredType;
      if (!orderType) {
        return { modified: false, orderId, reason: 'Could not determine order type — refusing to guess on a live order' };
      }
      const orderQty = changes.orderQty || version?.orderQty || current.orderQty || 1;
      logger.info(`Modify ${orderId}: type=${orderType} qty=${orderQty}${version ? ' (from order version)' : ' (inferred)'}`);

      // Build the modify request
      const modifyArgs = {
        orderType,
        orderQty,
        isAutomated: true,
      };

      if (changes.stopPrice !== undefined && changes.stopPrice !== null) {
        modifyArgs.stopPrice = changes.stopPrice;
      }
      if (changes.price !== undefined && changes.price !== null) {
        modifyArgs.price = changes.price;
      }

      // Get contract tick size for rounding
      const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
      const tickSize = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { tickSize: 0.25 }).tickSize;
      modifyArgs.tickSize = tickSize; // client.modifyOrder strips this before sending

      await this.client.modifyOrder(orderId, modifyArgs);

      // Update tracked bracket legs if we have them
      const pos = this.signalHandler?.getPosition();
      if (pos && pos.bracketLegs) {
        for (let i = 0; i < pos.bracketLegs.length; i++) {
          const leg = pos.bracketLegs[i];
          if (leg.orderId === orderId && changes.stopPrice !== undefined) {
            // Track the leg's OWN stop, not just a single position-level value.
            // Legs can sit at different stops (one at BE, one at the original),
            // and the risk totals in notifications read from these.
            leg.stopPrice = changes.stopPrice;
            if (i === 0 || pos.bracketLegs.length === 1) pos.stopLoss = changes.stopPrice;
            break;
          }
          if (leg.ocoId === orderId && changes.price !== undefined) {
            leg.targetPrice = changes.price;
            if (i === 0 || pos.bracketLegs.length === 1) pos.target = changes.price;
            break;
          }
        }
      }

      logger.info(`✓ Order ${orderId} modified: ${JSON.stringify(changes)}`);

      // Say WHICH order this is and what the risk is now — an order id tells
      // the reader nothing they can act on.
      const sym = this.contract?.name || this.config.contractSymbol || 'MNQ';
      const pv = (CONTRACTS[(sym).substring(0, 3)] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
      const desc = descBefore;
      if (changes.stopPrice != null) {
        await this.notifications.send(NF.stopMoved({
          symbol: sym, position: pos, from: prevStop, to: changes.stopPrice, desc, pointValue: pv,
        })).catch(() => {});
      } else if (changes.price != null) {
        await this.notifications.send(NF.targetMoved({
          symbol: sym, position: pos, from: prevTarget, to: changes.price, desc,
        })).catch(() => {});
      } else {
        await this.notifications.send(NF.orderModified({ symbol: sym, desc, changes })).catch(() => {});
      }

      return { modified: true, orderId, changes };
    } catch (err) {
      logger.error(`Modify order ${orderId} failed: ${err.message}`);
      const sym = this.contract?.name || this.config.contractSymbol || 'MNQ';
      await this.notifications.send(NF.modifyFailed({
        symbol: sym, desc: descBefore, reason: err.message,
      })).catch(() => {});
      return { modified: false, orderId, reason: err.message };
    }
  }

  /**
   * Cancel every working order on the account.
   *
   * Tradovate has no bulk-cancel endpoint — client.cancelAllOrders() lists
   * working orders and cancels them one by one via /order/cancelorder, which
   * is the only way the API supports this.
   *
   * Exists because an order can outlive the bot's memory of it. A resting
   * entry that the bot has forgotten (see the fill-watchdog note in
   * handleSignal) is invisible to flatten — "No open position" — yet still
   * live at the broker. Until now the only cleanup was a restart, because
   * _startupSync cancels orphans on boot. Restarting mid-session is not a
   * recovery plan.
   *
   * SAFETY: refuses while a position is open at the broker, because the
   * working orders on a live position ARE its stop and target — cancelling
   * them leaves the position naked. Use flatten to exit a position; use this
   * to clean up orders when flat. Pass force only to override deliberately.
   */
  async cancelAllWorkingOrders({ force = false } = {}) {
    try {
      let brokerNetPos = null;
      try {
        const positions = await this.client.getOpenPositions(this.account.id);
        const brokerPos = positions.find(p => p.contractId === this.contract?.id);
        brokerNetPos = brokerPos ? brokerPos.netPos : 0;
      } catch (e) {
        logger.warn(`Cancel-all: could not read broker position (${e.message})`);
      }

      if (brokerNetPos !== 0 && !force) {
        const reason = brokerNetPos === null
          ? 'could not confirm the broker is flat — refusing to strip protective orders (use force to override)'
          : `position open at broker (netPos ${brokerNetPos}) — its working orders are the stop and target; cancelling them would leave it naked. Use flatten to exit, or force to override.`;
        logger.warn(`Cancel-all refused: ${reason}`);
        return { cancelled: false, refused: true, reason, netPos: brokerNetPos };
      }

      const result = await this.client.cancelAllOrders(this.account.id);
      logger.warn(`✓ Cancel-all: ${result.cancelled}/${result.total} working orders cancelled (${result.failed} failed)`);

      // Flat and no orders left — any lingering bot position state is stale.
      if (brokerNetPos === 0 && this.signalHandler?.getPosition()) {
        logger.warn('Cancel-all: clearing stale bot position state (broker is flat)');
        this.signalHandler.clearPosition();
        this.positionHandler.resetFillAccumulators();
      }

      if (result.total > 0) {
        await this.notifications.send(
          `🧹 <b>ORDERS CANCELLED</b>\n${result.cancelled}/${result.total} working orders cancelled.`
        ).catch(() => {});
      }

      return { cancelled: true, total: result.total, cancelledCount: result.cancelled, failed: result.failed, netPos: brokerNetPos, forced: force };
    } catch (err) {
      logger.error(`Cancel-all failed: ${err.message}`);
      return { cancelled: false, error: err.message };
    }
  }

  async flattenAll() {
    try {
      const pos = this.signalHandler?.getPosition();
      if (!pos) {
        return { flattened: false, reason: 'No open position' };
      }

      const closeAction = pos.side === 'Buy' ? 'Sell' : 'Buy';

      // A signalled position exists in bot state from the moment the entry is
      // SENT, not from when it fills. With a resting Limit/Stop entry that has
      // not triggered, the broker is still flat — market-"closing" it here
      // would OPEN a reversed position while the entry order kept working.
      // Ask the broker before assuming there is anything to close.
      let brokerNetPos = null;
      try {
        const positions = await this.client.getOpenPositions(this.account.id);
        const brokerPos = positions.find(p => p.contractId === this.contract?.id);
        brokerNetPos = brokerPos ? brokerPos.netPos : 0;
      } catch (e) {
        logger.warn(`Flatten: could not read broker position (${e.message}) — proceeding with bot state`);
      }

      // Treat as unfilled when the broker says flat, or when the read failed
      // but no OCO was ever placed — brackets go on only after an entry fill,
      // so their absence means the entry never filled.
      const neverFilled = !pos.stopOrderId && !(pos.bracketLegs || []).length;
      if (brokerNetPos === 0 || (brokerNetPos === null && neverFilled)) {
        // Flat at the broker: cancel the working entry instead of trading.
        // This is the setup-invalidated path.
        logger.warn('Flatten: broker is flat — cancelling working entry order(s), no market order sent');
        try {
          await this._cancelAllBracketLegs(pos);
        } catch (e) {
          logger.warn(`Flatten: cancel bracket legs failed: ${e.message}`);
        }
        if (pos.orderId) {
          try {
            await this.client.cancelOrder(pos.orderId);
            logger.warn(`✓ Cancelled resting entry order ${pos.orderId}`);
          } catch (e) {
            logger.error(`Flatten: could not cancel entry order ${pos.orderId}: ${e.message}`);
          }
        }
        this.signalHandler.clearPosition();
        this.positionHandler.resetFillAccumulators();
        this._clearLimitEntryTimeout();
        // Cancelled before any fill — not a trade, so refund the daily budget.
        this._refundTradeBudget(pos.orderId, 'setup cancelled before fill');
        await this.notifications.send('📤 <b>ENTRY CANCELLED</b>\nSetup invalidated before fill — broker flat, no position opened').catch(() => {});
        return { flattened: true, cancelledEntry: true, orderId: pos.orderId || null };
      }

      // Cancel bracket orders (all legs for multi-leg positions)
      try {
        await this._cancelAllBracketLegs(pos);
      } catch (e) {
        logger.warn(`Flatten: cancel orders failed: ${e.message}`);
      }

      // Close exactly what the BROKER holds, not what the bot believes.
      // Verified live 2 Sep: after one leg stopped out, the bot still thought
      // qty=2 while the broker had -1. Flatten bought 2 and left a REVERSED
      // long 1. The broker is the source of truth for size and direction.
      const brokerQty = Number.isFinite(brokerNetPos) && brokerNetPos !== 0
        ? Math.abs(brokerNetPos) : pos.quantity;
      const brokerAction = Number.isFinite(brokerNetPos) && brokerNetPos !== 0
        ? (brokerNetPos > 0 ? 'Sell' : 'Buy') : closeAction;
      if (brokerQty !== pos.quantity || brokerAction !== closeAction) {
        logger.warn(`Flatten: bot thought ${closeAction} ${pos.quantity}, broker says netPos=${brokerNetPos} — closing ${brokerAction} ${brokerQty}`);
      }

      const order = await this.client.placeMarketOrder(
        this.account.id, this.contract.id, brokerQty, brokerAction
      );
      logger.warn(`✓ Flattened: ${brokerAction} ${brokerQty}`);

      this.signalHandler.clearPosition();
      this.positionHandler.resetFillAccumulators();

      await this.notifications.send(
        `📤 <b>Flattened — ${this.contract?.name || 'MNQ'}</b>\n` +
        `Closed ${brokerQty} at market (${brokerAction === 'Buy' ? 'bought back a short' : 'sold a long'}).\n` +
        `No position or orders remain.`
      ).catch(() => {});

      return { flattened: true, orderId: order?.orderId, qty: brokerQty, action: brokerAction };
    } catch (err) {
      logger.error(`Flatten failed: ${err.message}`);
      return { flattened: false, error: err.message };
    }
  }

  // ── Time helpers ──────────────────────────────────────────────────

  _getPSTTime(date = new Date()) {
    const fmt = (type) => parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', [type]: 'numeric', hour12: false,
    }).format(date));
    const dayOfWeek = new Date(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date)).getDay();
    return { hour: fmt('hour'), minute: fmt('minute'), dayOfWeek };
  }

  _isPastEntryCutoff() {
    const pst = this._getPSTTime();
    const mins = pst.hour * 60 + pst.minute;
    const cutoff = this._lastEntryHourPST * 60 + this._lastEntryMinutePST;
    return mins >= cutoff;
  }

  // ── Shutdown ──────────────────────────────────────────────────────

  async shutdown() {
    logger.info('Shutting down execution bot...');
    this.isRunning = false;

    if (this._sessionCheckInterval) clearInterval(this._sessionCheckInterval);
    this._clearLimitEntryTimeout();
    this._clearFillWatchdog();
    this._clearExitWatchdog();

    if (this.webhook) await this.webhook.stop();

    // Report whether anything was left running at the broker — "bot offline"
    // is only useful if it says whether you are still exposed.
    let flat = true, workingOrders = 0;
    try {
      const positions = await this.client.getOpenPositions(this.account.id);
      const p = positions.find(x => x.contractId === this.contract?.id);
      flat = !p || p.netPos === 0;
      const orders = await this.client.getWorkingOrders(this.account.id);
      workingOrders = Array.isArray(orders) ? orders.length : 0;
      if (workingOrders > 0) flat = false;
    } catch (e) { /* report what we can */ }

    await this.notifications.send(NF.botOffline({
      reason: 'Shutting down cleanly', flat, workingOrders,
    })).catch(() => {});

    // Drop a marker so the NEXT startup can tell a clean stop from a crash,
    // a taskkill, or the machine sleeping. Without this an unexpected death is
    // completely silent — the bot simply is not there any more.
    try {
      const fs = require('fs');
      const path = require('path');
      fs.writeFileSync(path.join(__dirname, '..', '..', 'data', '.clean_shutdown'),
        new Date().toISOString());
    } catch (e) { /* non-fatal */ }
    if (this.orderWs) this.orderWs.disconnect();
    if (this.telegramCommands) this.telegramCommands.stop();

    logger.info('Bot stopped');
    process.exit(0);
  }
}

module.exports = ExecutionBot;
