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
    this._lastEntryHourPST = parseInt(process.env.LAST_ENTRY_HOUR) || 11;
    this._lastEntryMinutePST = parseInt(process.env.LAST_ENTRY_MINUTE) || 0;

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
      this.signalHandler.clearPosition();
    });

    // Entry filled → place OCO bracket with fill-adjusted prices
    this.positionHandler.on('entryFilled', async (fillData) => {
      this._clearLimitEntryTimeout();
      this._clearFillWatchdog();
      const { fillPrice, signalPrice, slippage, newStop, newTarget, position } = fillData;

      // 1. Update SignalHandler's position
      this.signalHandler.updatePositionFromFill(fillData);

      // 2. Place OCO bracket
      const ocoParams = position._ocoParams;
      if (ocoParams) {
        let ocoPlaced = false;
        for (let attempt = 1; attempt <= 2 && !ocoPlaced; attempt++) {
          try {
            if (attempt > 1) {
              logger.warn(`Retrying OCO placement (attempt ${attempt})...`);
              await new Promise(r => setTimeout(r, 2000));
            }
            logger.trade(`Placing OCO: ${ocoParams.exitAction} Stop @ ${newStop.toFixed(2)} | Limit @ ${newTarget.toFixed(2)}`);
            const oco = await this.client.placeOCO(
              ocoParams.accountSpec,
              ocoParams.accountId,
              ocoParams.contractName,
              ocoParams.contracts,
              ocoParams.exitAction,
              newStop,
              newTarget
            );
            position.stopOrderId = oco.orderId;
            position.targetOrderId = oco.ocoId;
            ocoPlaced = true;
            logger.success(`✓ OCO placed: stopOrderId=${oco.orderId}, targetOrderId=${oco.ocoId}`);
            if (slippage !== 0) {
              logger.info(`✓ Bracket reflects fill adjustment (slippage: ${slippage >= 0 ? '+' : ''}${slippage.toFixed(2)}pt)`);
            }
          } catch (err) {
            logger.error(`❌ OCO placement attempt ${attempt} failed: ${err.message}`);
          }
        }

        // EMERGENCY: naked position if OCO failed
        if (!ocoPlaced) {
          logger.error('🚨 EMERGENCY: OCO failed after retries — closing naked position');
          await this.notifications.send(
            '🚨 <b>EMERGENCY</b>\nOCO bracket FAILED. Closing naked position.'
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
        delete position._ocoParams;
      }

      // 3. Send entry notification with real fill price
      const nd = position._notificationData;
      if (nd) {
        const patchedSignal = { ...nd.signal, price: fillPrice };
        const patchedPosition = {
          ...nd.position,
          stopPrice: newStop,
          targetPrice: newTarget,
          totalRisk: position.risk || nd.position.totalRisk,
        };
        try {
          await this.notifications.tradeEntryDetailed?.({
            signal: patchedSignal,
            position: patchedPosition,
            slippage: slippage !== 0 ? slippage : undefined,
            signalPrice: slippage !== 0 ? signalPrice : undefined,
          }).catch(() => {});
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
        const orderIdsToCancel = [position.stopOrderId, position.targetOrderId].filter(Boolean);
        for (const oid of orderIdsToCancel) {
          try { await this.client.cancelOrder(oid); } catch (e) { /* may not exist */ }
        }
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

    this.orderWs.on('reconnected', async () => {
      logger.info('[WS] Reconnected — syncing position state');
      try {
        // Re-adopt any position that may have changed during disconnect
        await this._startupSync();
      } catch (err) {
        logger.warn(`[WS] Reconnect sync failed: ${err.message}`);
      }
    });

    this.orderWs.on('maxReconnectAttemptsReached', async () => {
      logger.error('🚨 WebSocket max reconnect attempts reached — halting');
      this.lossLimits.halt('WEBSOCKET_DEAD', 'Order WebSocket dead — cannot monitor fills');
      await this.notifications.send('🚨 <b>WEBSOCKET DEAD</b>\nMax reconnect attempts reached. Trading halted.').catch(() => {});
    });

    logger.info('✓ Order WebSocket connected');
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

      // Start limit entry timeout if limit order
      if (signal.orderType === 'Limit') {
        const pos = this.signalHandler.getPosition();
        if (pos && pos._isLimitEntry && pos.orderId) {
          if (pos.stopOrderId) {
            logger.info('Limit order already filled & OCO placed — skipping timeout');
          } else {
            this._startLimitEntryTimeout(pos.orderId, (this.config.limitEntryTimeoutSec || 180) * 1000);
          }
        }
      }

      // Start fill watchdog for market orders
      if (result.position && result.position.orderId && !result.position.stopOrderId) {
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

    if (result.isFullyClosed) {
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

        const exitSide = side === 'Buy' ? 'Sell' : 'Buy';
        let stopOrder = null;
        let targetOrder = null;
        for (const o of myOrders) {
          if (o.action === exitSide && (o.ordType === 'Stop' || o.ordType === 'StopLimit')) stopOrder = o;
          else if (o.action === exitSide && o.ordType === 'Limit') targetOrder = o;
        }

        const stopPrice = stopOrder ? (stopOrder.stopPrice || stopOrder.price) : null;
        const targetPrice = targetOrder ? targetOrder.price : null;

        const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
        const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
        const risk = stopPrice ? Math.abs(entryPrice - stopPrice) * qty * pv : 0;

        const adoptedPosition = {
          side, quantity: qty, entryPrice,
          stopLoss: stopPrice, target: targetPrice, risk,
          orderId: null,
          stopOrderId: stopOrder ? stopOrder.id : null,
          targetOrderId: targetOrder ? targetOrder.id : null,
          entryTime: new Date(),
          strategyName: 'adopted',
          _adopted: true,
        };

        this.signalHandler.currentPosition = adoptedPosition;

        const stopInfo = stopPrice ? `stop $${stopPrice.toFixed(2)}` : 'NO STOP ⚠️';
        const targetInfo = targetPrice ? `target $${targetPrice.toFixed(2)}` : 'no target';
        logger.success(`[StartupSync] ✓ Re-adopted: ${side} ${qty} @ ${entryPrice} | ${stopInfo} | ${targetInfo}`);

        await this.notifications.send(
          `🔄 <b>STARTUP SYNC</b>\nRe-adopted: ${side} ${qty} @ ${entryPrice}\n${stopInfo} | ${targetInfo}\nBracket preserved.`
        ).catch(() => {});

        if (!stopOrder) {
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

            // Cancel bracket orders
            try {
              const cancelResult = await this.client.cancelAllOrders(this.account.id);
              logger.info(`⏰ EOD: Cancelled ${cancelResult.cancelled}/${cancelResult.total} bracket orders`);
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
    };
  }

  async getOpenPositions() {
    try {
      const positions = await this.client.getOpenPositions(this.account.id);
      const workingOrders = await this.client.getWorkingOrders(this.account.id);
      const contractId = this.contract?.id;
      return {
        positions: positions.filter(p => !contractId || p.contractId === contractId),
        workingOrders: workingOrders.filter(o => !contractId || o.contractId === contractId),
      };
    } catch (err) {
      return { error: err.message };
    }
  }

  async flattenAll() {
    try {
      const pos = this.signalHandler?.getPosition();
      if (!pos) {
        return { flattened: false, reason: 'No open position' };
      }

      const closeAction = pos.side === 'Buy' ? 'Sell' : 'Buy';

      // Cancel bracket orders
      try {
        await this.client.cancelAllOrders(this.account.id);
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

    if (this.webhook) await this.webhook.stop();
    await this.notifications.botStopped?.('Graceful shutdown').catch(() => {});
    if (this.orderWs) this.orderWs.disconnect();
    if (this.telegramCommands) this.telegramCommands.stop();

    logger.info('Bot stopped');
    process.exit(0);
  }
}

module.exports = ExecutionBot;
