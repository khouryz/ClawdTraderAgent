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
          await this.notifications.tradeEntryDetailed?.({
            signal: patchedSignal,
            position: patchedPosition,
            slippage: slippage !== 0 ? slippage : undefined,
            signalPrice: slippage !== 0 ? signalPrice : undefined,
            targets,
            moveStopToBEAfterFirstTarget: position.moveStopToBEAfterFirstTarget || false,
          }).catch(() => {});
          logger.info('✓ Entry notification sent');

          // Also send a dedicated targets notification for multi-leg positions
          if (targets.length > 1) {
            const targetLines = targets.map(t => `  T${t.leg}: ${t.qty} @ ${t.targetPrice.toFixed(2)}`).join('\n');
            await this.notifications.send(
              `🎯 <b>EXIT TARGETS</b>\n${targetLines}\nStop: ${newStop.toFixed(2)}` +
              (position.moveStopToBEAfterFirstTarget ? '\n🔒 Stop → BE after T1 fills' : '')
            ).catch(() => {});
          }
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

    this.orderWs.on('order', (order) => this.positionHandler.handleOrderUpdate(order));
    this.orderWs.on('fill', (fill) => this._onFill(fill));
    this.orderWs.on('position', (position) => this.positionHandler.handlePositionUpdate(position));

    // Props events — Tradovate wraps fills/orders/positions in props
    this.orderWs.on('props', (data) => {
      if (!data || !data.entityType || !data.entity) return;
      const entity = data.entity;
      if (data.entityType === 'fill' && data.eventType === 'Created') {
        this._onFill(entity);
      } else if (data.entityType === 'order') {
        this.positionHandler.handleOrderUpdate(entity);
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
  async _placeMultiLegOCO(ocoParams, position, newStop, fillPrice) {
    const legs = ocoParams.exits;
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
      await this.client.placeMarketOrder(ocoParams.accountId, this.contract.id, ocoParams.contracts, ocoParams.exitAction);
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
  async _moveStopsToBreakEven(position) {
    if (!position.bracketLegs || position.bracketLegs.length === 0) return;
    if (position.firstTargetFilled) return; // already done
    position.firstTargetFilled = true;

    const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
    const tickSize = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { tickSize: 0.25 }).tickSize;
    const entryPrice = position.entryPrice;
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

    // Partial exit (target leg filled) — trigger BE move if requested
    if (result.isExit && !result.isFullyClosed && !result.duplicate) {
      const pos = this.signalHandler.getPosition();
      if (pos && pos.moveStopToBEAfterFirstTarget && !pos.firstTargetFilled) {
        logger.info(`🔒 First target filled — moving remaining stops to BE`);
        await this._moveStopsToBreakEven(pos).catch(err => {
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

        await this.notifications.send(
          `🔄 <b>STARTUP SYNC</b>\nRe-adopted: ${side} ${qty} @ ${entryPrice}\n${stopInfo} | ${targetInfo}${legInfo}\nBracket preserved.`
        ).catch(() => {});

        if (stopOrders.length === 0) {
          logger.error('[StartupSync] ⚠️ DANGER: Position has no stop order!');
          await this.notifications.send(
            '🚨 <b>STARTUP SYNC — NO STOP!</b>\nPosition has no stop. Manual intervention needed!'
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
          this._eodCloseDoneToday = true;
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

            // Flatten via market order
            const eodOrder = await this.client.placeMarketOrder(
              this.account.id, this.contract.id, pos.quantity, closeAction
            );
            logger.success('✓ EOD position closed');

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
                ? (exitPrice - pos.entryPrice) * (pos.quantity || 1) * pv
                : (pos.entryPrice - exitPrice) * (pos.quantity || 1) * pv;

              if (this.lossLimits) {
                this.lossLimits.recordTrade(eodPnl, {
                  symbol: this.contract?.name || 'MNQ',
                  quantity: pos.quantity || 1,
                  tradeId: pos.orderId,
                });
              }
              if (this.performance) {
                this.performance.recordTrade({
                  id: pos.orderId,
                  symbol: this.contract?.name || 'MNQ',
                  side: pos.side,
                  quantity: pos.quantity || 1,
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

            const pnlStr = exitPrice !== null ? ` | P&L: ${eodPnl >= 0 ? '+' : ''}$${eodPnl.toFixed(2)}` : '';
            const exitStr = exitPrice !== null ? `@ $${exitPrice.toFixed(2)}` : '@ market';
            await this.notifications.send(`⏰ EOD close: ${closeAction} ${pos.quantity} ${exitStr}${pnlStr}`).catch(() => {});
          } catch (err) {
            logger.error(`EOD close failed: ${err.message}`);
            await this.notifications.error(`EOD close failed: ${err.message}`).catch(() => {});
            this.signalHandler.clearPosition();
            this.positionHandler.resetFillAccumulators();
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

        // Detect partial exit: broker has fewer contracts than bot thinks
        if (Math.abs(brokerNetPos) < botQty && Math.abs(brokerNetPos) > 0) {
          const exitedQty = botQty - Math.abs(brokerNetPos);
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
        }

        // Detect full close: broker has 0 but bot thinks it has a position
        if (brokerNetPos === 0 && botQty > 0) {
          logger.warn(`⚠️ EXIT WATCHDOG: Position fully closed at broker but bot still thinks qty=${botQty} — reconciling`);

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
            // Record a manual close P&L if we can get the entry price
            const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
            const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
            // Estimate P&L from broker position if available
            this.signalHandler.clearPosition();
            this.positionHandler.resetFillAccumulators();
            await this.notifications.send(
              `⚠️ <b>EXIT WATCHDOG</b>\nPosition closed at broker but WebSocket missed the fill.\nBot state reconciled. Check broker for final P&L.`
            ).catch(() => {});
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
    try {
      if (!orderId) {
        return { modified: false, reason: 'orderId is required' };
      }

      // Fetch the current order to get orderType and orderQty
      const current = await this.client.getOrder(orderId);
      const orderType = current.orderType || 'Stop';
      const orderQty = changes.orderQty || current.orderQty || 1;

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
        for (const leg of pos.bracketLegs) {
          if (leg.orderId === orderId && changes.stopPrice !== undefined) {
            // Update the bot's view of the stop price
            pos.stopLoss = changes.stopPrice;
            break;
          }
        }
      }

      logger.info(`✓ Order ${orderId} modified: ${JSON.stringify(changes)}`);
      await this.notifications.send(
        `🔧 <b>ORDER MODIFIED</b>\nOrder #${orderId}\n` +
        (changes.stopPrice ? `New stop: ${changes.stopPrice.toFixed(2)}\n` : '') +
        (changes.price ? `New price: ${changes.price.toFixed(2)}\n` : '') +
        (changes.orderQty ? `Qty: ${changes.orderQty}\n` : '')
      ).catch(() => {});

      return { modified: true, orderId, changes };
    } catch (err) {
      logger.error(`Modify order ${orderId} failed: ${err.message}`);
      await this.notifications.send(
        `⚠️ <b>MODIFY FAILED</b>\nOrder #${orderId}\nReason: ${err.message}`
      ).catch(() => {});
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
        await this.notifications.send('📤 <b>ENTRY CANCELLED</b>\nSetup invalidated before fill — broker flat, no position opened').catch(() => {});
        return { flattened: true, cancelledEntry: true, orderId: pos.orderId || null };
      }

      // Cancel bracket orders (all legs for multi-leg positions)
      try {
        await this._cancelAllBracketLegs(pos);
      } catch (e) {
        logger.warn(`Flatten: cancel orders failed: ${e.message}`);
      }

      // Close via market order
      const order = await this.client.placeMarketOrder(
        this.account.id, this.contract.id, pos.quantity, closeAction
      );
      logger.warn(`✓ Flattened: ${closeAction} ${pos.quantity}`);

      this.signalHandler.clearPosition();
      this.positionHandler.resetFillAccumulators();

      await this.notifications.send(`📤 <b>FLATTEN</b>\nClosed ${pos.side} ${pos.quantity} @ market`).catch(() => {});

      return { flattened: true, orderId: order?.orderId };
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
    // Notify before disconnecting
    await this.notifications.send('🔴 <b>BOT OFFLINE</b>\nExecution bot shutting down. No new signals will be processed.').catch(() => {});
    if (this.orderWs) this.orderWs.disconnect();
    if (this.telegramCommands) this.telegramCommands.stop();

    logger.info('Bot stopped');
    process.exit(0);
  }
}

module.exports = ExecutionBot;
