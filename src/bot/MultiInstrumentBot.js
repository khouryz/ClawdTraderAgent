/**
 * MultiInstrumentBot - Orchestrator for N instruments
 * 
 * Manages shared resources:
 * - Tradovate auth, client, account
 * - Order WebSocket (single connection, routes events by contractId)
 * - Notifications, MarketHours, TradeAnalyzer
 * 
 * Creates one InstrumentRunner per instrument, each with its own:
 * - Databento price stream
 * - Strategy, SignalHandler, PositionHandler
 * - Risk/loss limits, profit manager
 * 
 * Session lifecycle (daily reset, EOD close, reports) is managed centrally.
 */

const TradovateAuth = require('../api/auth');
const TradovateClient = require('../api/client');
const TradovateWebSocket = require('../api/websocket');
const MarketHours = require('../utils/market_hours');
const Notifications = require('../utils/notifications');
const TradeAnalyzer = require('../analytics/trade_analyzer');
const ConfigValidator = require('../utils/config_validator');
const logger = require('../utils/logger');
const InstrumentRunner = require('./InstrumentRunner');
const SharedPriceProvider = require('../data/SharedPriceProvider');

class MultiInstrumentBot {
  constructor() {
    // Load global config from .env
    this.globalConfig = this._loadGlobalConfig();

    // Shared components
    this.auth = null;
    this.client = null;
    this.account = null;
    this.orderWs = null;
    this.marketHours = new MarketHours(this.globalConfig.timezone);
    this.notifications = new Notifications();
    this.tradeAnalyzer = new TradeAnalyzer({ dataDir: './data' });
    this.notifications.setTradeAnalyzer(this.tradeAnalyzer);

    // Shared Databento price stream (single session for all instruments)
    this.sharedPriceProvider = null;

    // Instrument runners keyed by baseSymbol (e.g. 'MES', 'M2K', 'MNQ')
    this.runners = new Map();

    // Contract ID → runner mapping for order/fill routing
    this._contractIdToRunner = new Map();

    // State
    this.isRunning = false;
    this._sessionCheckInterval = null;
    this._positionSyncInterval = null;
    this._todayResetDone = false;
    this._eodCloseDoneToday = false;
    this._dailyReportSentToday = false;
    this._sessionStartLoggedToday = false;
  }

  /**
   * Load global configuration from environment variables
   * @private
   */
  _loadGlobalConfig() {
    return {
      env: process.env.TRADOVATE_ENV || 'demo',
      username: process.env.TRADOVATE_USERNAME,
      password: process.env.TRADOVATE_PASSWORD,
      cid: process.env.TRADOVATE_CID ? parseInt(process.env.TRADOVATE_CID) : null,
      secret: process.env.TRADOVATE_SECRET,
      timezone: process.env.TIMEZONE || 'America/Los_Angeles',
      tradingStartHour: parseInt(process.env.TRADING_START_HOUR) || 6,
      tradingStartMinute: parseInt(process.env.TRADING_START_MINUTE) || 30,
      tradingEndHour: parseInt(process.env.TRADING_END_HOUR) || 13,
      tradingEndMinute: parseInt(process.env.TRADING_END_MINUTE) || 0,
      avoidLunch: process.env.AVOID_LUNCH !== 'false',
      // AI settings
      aiConfirmationEnabled: process.env.AI_CONFIRMATION_ENABLED === 'true',
      aiProvider: process.env.AI_PROVIDER || 'anthropic',
      aiApiKey: process.env.AI_API_KEY || '',
      aiModel: process.env.AI_MODEL || null,
      aiConfidenceThreshold: parseInt(process.env.AI_CONFIDENCE_THRESHOLD) || 70,
      aiTimeout: parseInt(process.env.AI_TIMEOUT) || 5000,
      aiDefaultAction: process.env.AI_DEFAULT_ACTION || 'confirm',
      // Databento
      databentoApiKey: process.env.DATABENTO_API_KEY || '',
      databentoDataset: process.env.DATABENTO_DATASET || 'GLBX.MDP3',
      pythonPath: process.env.PYTHON_PATH || 'python',
    };
  }

  /**
   * Parse instrument configurations from environment variables.
   * 
   * Format in .env:
   *   INSTRUMENTS=MNQ,MES,M2K
   *   
   *   # MNQ config
   *   MNQ_SYMBOL=MNQH6
   *   MNQ_STRATEGY=mnq_momentum_v2
   *   MNQ_DATABENTO_SYMBOL=MNQ.FUT
   *   MNQ_LAST_ENTRY_HOUR=11
   *   MNQ_RISK_PER_TRADE_MIN=25
   *   MNQ_RISK_PER_TRADE_MAX=60
   *   MNQ_DAILY_LOSS_LIMIT=150
   *   MNQ_PB_MIN_IMPULSE=15
   *   MNQ_PB_RETRACE_MIN=0.25
   *   ... etc
   *   
   *   # MES config
   *   MES_SYMBOL=MESH6
   *   MES_STRATEGY=opening_range_breakout
   *   MES_USE_TREND_FILTER=false
   *   ... etc
   * 
   * @returns {Array<Object>} Array of instrument configs
   */
  _parseInstrumentConfigs() {
    const instrumentList = (process.env.INSTRUMENTS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (instrumentList.length === 0) {
      throw new Error('INSTRUMENTS env var not set. Example: INSTRUMENTS=MNQ,MES,M2K');
    }

    const configs = [];
    for (const baseSymbol of instrumentList) {
      const prefix = baseSymbol.toUpperCase();
      const env = (key, fallback) => process.env[`${prefix}_${key}`] !== undefined 
        ? process.env[`${prefix}_${key}`] 
        : fallback;

      const strategyName = (env('STRATEGY', 'opening_range_breakout')).toLowerCase();

      // Build strategy params from prefixed env vars
      const strategyParams = {};

      if (strategyName === 'mnq_momentum_v2' || strategyName === 'mnq_momentum') {
        // MNQ Momentum V2 params
        strategyParams.emaxEnabled = env('EMAX_ENABLED', 'false') === 'true';
        strategyParams.emaxEmaFast = parseInt(env('EMAX_EMA_FAST', '9'));
        strategyParams.emaxEmaSlow = parseInt(env('EMAX_EMA_SLOW', '21'));
        strategyParams.emaxMinBarRange = parseFloat(env('EMAX_MIN_BAR_RANGE', '5'));
        strategyParams.emaxMinBodyRatio = parseFloat(env('EMAX_MIN_BODY_RATIO', '0.5'));
        strategyParams.emaxMaxTime = parseInt(env('EMAX_MAX_TIME', '480'));
        strategyParams.emaxUseZLEMA = env('EMAX_USE_ZLEMA', 'false') === 'true';
        strategyParams.pbMinImpulse = parseFloat(env('PB_MIN_IMPULSE', '15'));
        strategyParams.pbMinImpBodyRatio = parseFloat(env('PB_MIN_IMP_BODY_RATIO', '0.15'));
        strategyParams.pbRetraceMin = parseFloat(env('PB_RETRACE_MIN', '0.10'));
        strategyParams.pbRetraceMax = parseFloat(env('PB_RETRACE_MAX', '0.85'));
        strategyParams.pbMaxTime = parseInt(env('PB_MAX_TIME', '570'));
        strategyParams.vrEnabled = env('VR_ENABLED', 'true') !== 'false';
        strategyParams.vrMinTime = parseInt(env('VR_MIN_TIME', '510'));
        strategyParams.vrMaxTime = parseInt(env('VR_MAX_TIME', '660'));
        strategyParams.vrMinSigma = parseFloat(env('VR_MIN_SIGMA', '1.3'));
        strategyParams.vrEntrySigmaMax = parseFloat(env('VR_ENTRY_SIGMA_MAX', '1.0'));
        strategyParams.vrStopBeyondBand = parseFloat(env('VR_STOP_BEYOND_BAND', '3'));
        strategyParams.vrTargetMode = env('VR_TARGET_MODE', 'fixed');
        strategyParams.vrTargetR = parseFloat(env('VR_TARGET_R', '4'));
        strategyParams.vrMinBarVolRatio = parseFloat(env('VR_MIN_BAR_VOL_RATIO', '0.8'));
        strategyParams.vrMaxStopPoints = parseInt(env('VR_MAX_STOP_POINTS', '20'));
        strategyParams.vrMinStopPoints = parseInt(env('VR_MIN_STOP_POINTS', '4'));
        strategyParams.vrCooldownBars = parseInt(env('VR_COOLDOWN_BARS', '10'));
        strategyParams.maxStopPoints = parseInt(env('MAX_STOP_POINTS', '35'));
        strategyParams.minStopPoints = parseInt(env('MIN_STOP_POINTS', '5'));
        strategyParams.stopBuffer = parseFloat(env('STOP_BUFFER', '2'));
        strategyParams.profitTargetR = parseFloat(env('PROFIT_TARGET_R', '2.5'));
        strategyParams.minTargetPoints = parseFloat(env('MIN_TARGET_POINTS', '20'));
        strategyParams.minConfluence = parseInt(env('MIN_CONFLUENCE', '0'));
        strategyParams.volumeAvgPeriod = parseInt(env('VOLUME_AVG_PERIOD', '20'));
        strategyParams.momentumBars = parseInt(env('MOMENTUM_BARS', '5'));
        strategyParams.priorLevelTolerance = parseFloat(env('PRIOR_LEVEL_TOLERANCE', '5'));
        strategyParams.moveStopToBE = env('MOVE_STOP_TO_BE', 'false') === 'true';
        strategyParams.beActivationR = parseFloat(env('BE_ACTIVATION_R', '1.2'));
        strategyParams.partialProfitEnabled = env('PARTIAL_PROFIT_ENABLED', 'false') === 'true';
        strategyParams.partialProfitR = parseFloat(env('PARTIAL_PROFIT_R', '2'));
        strategyParams.maxLossesPerDay = parseInt(env('MAX_LOSSES_PER_DAY', '3'));
        strategyParams.volumeFilterEnabled = env('VOLUME_FILTER_ENABLED', 'false') === 'true';
        strategyParams.volumeFilterMin = parseFloat(env('VOLUME_FILTER_MIN', '0.9'));
        strategyParams.volumeFilterPeriod = parseInt(env('VOLUME_FILTER_PERIOD', '20'));
        // PB Entry Timing Improvements
        strategyParams.pbEntryMode = env('PB_ENTRY_MODE', 'limit_structural');          // 'immediate', 'confirm1m', 'limit'
        strategyParams.pbConfirmBars = parseInt(env('PB_CONFIRM_BARS', '5'));
        strategyParams.pbLimitRetracePct = parseFloat(env('PB_LIMIT_RETRACE_PCT', '0.6'));
        strategyParams.pbLimitTimeoutBars = parseInt(env('PB_LIMIT_TIMEOUT_BARS', '5'));
        strategyParams.pbTrendFilterEnabled = env('PB_TREND_FILTER', 'false') === 'true';
      } else if (strategyName === 'liquidity_orb') {
        // Liquidity ORB params
        strategyParams.orStartMinPST = parseInt(env('OR_START_MIN_PST', '300'));
        strategyParams.orDurationMin = parseInt(env('OR_DURATION_MIN', '15'));
        strategyParams.brtEnabled = env('BRT_ENABLED', 'true') !== 'false';
        strategyParams.brtWaitMinPST = parseInt(env('BRT_WAIT_MIN_PST', '390'));
        strategyParams.brtMaxTimePST = parseInt(env('BRT_MAX_TIME_PST', '600'));
        strategyParams.brtStopPoints = parseFloat(env('BRT_STOP_POINTS', '5'));
        strategyParams.brtTargetPoints = parseFloat(env('BRT_TARGET_POINTS', '15'));
        strategyParams.brtRetestTolerance = parseFloat(env('BRT_RETEST_TOLERANCE', '1.5'));
        strategyParams.brtMinBodyRatio = parseFloat(env('BRT_MIN_BODY_RATIO', '0.3'));
        strategyParams.bounceEnabled = env('BOUNCE_ENABLED', 'true') !== 'false';
        strategyParams.bounceStopPoints = parseFloat(env('BOUNCE_STOP_POINTS', '7'));
        strategyParams.bounceTargetPoints = parseFloat(env('BOUNCE_TARGET_POINTS', '20'));
        strategyParams.bounceConfirmBars = parseInt(env('BOUNCE_CONFIRM_BARS', '5'));
        strategyParams.bounceMaxTimePST = parseInt(env('BOUNCE_MAX_TIME_PST', '660'));
        strategyParams.rejectionEnabled = env('REJECTION_ENABLED', 'true') !== 'false';
        strategyParams.rejectionStopPoints = parseFloat(env('REJECTION_STOP_POINTS', '6'));
        strategyParams.rejectionTargetPoints = parseFloat(env('REJECTION_TARGET_POINTS', '30'));
        strategyParams.rejectionMinTouches = parseInt(env('REJECTION_MIN_TOUCHES', '2'));
        strategyParams.rejectionMaxTimePST = parseInt(env('REJECTION_MAX_TIME_PST', '660'));
        strategyParams.maxTradesPerDay = parseInt(env('MAX_TRADES_PER_DAY', '3'));
        strategyParams.levelTolerance = parseFloat(env('LEVEL_TOLERANCE', '1.5'));
        strategyParams.minBarsSinceOR = parseInt(env('MIN_BARS_SINCE_OR', '5'));
      } else {
        // ORB params
        strategyParams.orPeriodMinutes = parseInt(env('OR_PERIOD_MINUTES', '15'));
        strategyParams.orBuffer = parseFloat(env('OR_BUFFER', '0.5'));
        strategyParams.stopBuffer = parseFloat(env('STOP_BUFFER', '0.5'));
        strategyParams.maxStopPoints = parseInt(env('MAX_STOP_POINTS', '15'));
        strategyParams.minOrRange = parseInt(env('MIN_OR_RANGE', '2'));
        strategyParams.maxOrRange = parseInt(env('MAX_OR_RANGE', '12'));
        strategyParams.minBodyRatio = parseFloat(env('MIN_BODY_RATIO', '0.3'));
        strategyParams.profitTargetR = parseFloat(env('PROFIT_TARGET_R', '2'));
        strategyParams.useTrendFilter = env('USE_TREND_FILTER', 'true') === 'true';
        strategyParams.useVolumeFilter = env('USE_VOLUME_FILTER', 'true') !== 'false';
        strategyParams.volumeAvgPeriod = parseInt(env('VOLUME_AVG_PERIOD', '10'));
        strategyParams.volumeMinRatio = parseFloat(env('VOLUME_MIN_RATIO', '1.0'));
        strategyParams.useRSIFilter = env('USE_RSI_FILTER', 'false') === 'true';
        strategyParams.useADXFilter = env('USE_ADX_FILTER', 'false') === 'true';
        strategyParams.allowShorts = env('ALLOW_SHORTS', 'true') !== 'false';
        strategyParams.trailingStopEnabled = env('TRAILING_STOP_ENABLED', 'false') === 'true';
        strategyParams.trailActivationR = parseFloat(env('TRAIL_ACTIVATION_R', '2.0'));
        strategyParams.trailDistancePoints = parseFloat(env('TRAIL_DISTANCE_POINTS', '8'));
        strategyParams.moveStopToBE = env('MOVE_STOP_TO_BE', 'false') === 'true';
        strategyParams.beActivationR = parseFloat(env('BE_ACTIVATION_R', '1.2'));
      }

      configs.push({
        baseSymbol: baseSymbol.toUpperCase(),
        symbol: env('SYMBOL', `${baseSymbol}H6`),
        strategy: strategyName,
        strategyParams,
        databentoSymbol: env('DATABENTO_SYMBOL', `${baseSymbol}.FUT`),
        autoRollover: env('AUTO_ROLLOVER', 'true') !== 'false',
        lastEntryHour: parseInt(env('LAST_ENTRY_HOUR', '11')),
        lastEntryMinute: parseInt(env('LAST_ENTRY_MINUTE', '0')),
        riskParams: {
          riskPerTrade: {
            min: parseFloat(env('RISK_PER_TRADE_MIN', '25')),
            max: parseFloat(env('RISK_PER_TRADE_MAX', '60')),
          },
          maxContracts: parseInt(env('MAX_CONTRACTS', '1')),
          dailyLossLimit: parseFloat(env('DAILY_LOSS_LIMIT', '150')),
          weeklyLossLimit: parseFloat(env('WEEKLY_LOSS_LIMIT', '500')),
          maxConsecutiveLosses: parseInt(env('MAX_CONSECUTIVE_LOSSES', '3')),
          maxDrawdownPercent: parseFloat(env('MAX_DRAWDOWN_PERCENT', '5')),
        },
      });
    }

    return configs;
  }

  /**
   * Initialize shared resources and all instrument runners
   */
  async initialize() {
    this._logStartupBanner();

    // ── Shared: Auth + Client + Account ──
    this.auth = new TradovateAuth(this.globalConfig);
    await this.auth.authenticate();
    this.client = new TradovateClient(this.auth);

    const accounts = await this.client.getAccounts();
    if (accounts.length === 0) throw new Error('No accounts found');
    this.account = accounts[0];
    logger.info(`✓ Account: ${this.account.name} (ID: ${this.account.id})`);

    // ── Shared: Order WebSocket ──
    await this._connectOrderWebSocket();

    // ── Parse instrument configs ──
    const instrumentConfigs = this._parseInstrumentConfigs();
    logger.info(`✓ ${instrumentConfigs.length} instrument(s) configured: ${instrumentConfigs.map(c => c.baseSymbol).join(', ')}`);

    // ── Shared: Databento price stream (single session for all instruments) ──
    const allSymbols = instrumentConfigs.map(c => c.databentoSymbol || `${c.baseSymbol}.FUT`);
    this.sharedPriceProvider = new SharedPriceProvider({
      apiKey: this.globalConfig.databentoApiKey,
      symbols: allSymbols,
      schema: 'ohlcv-1m',
      dataset: this.globalConfig.databentoDataset || 'GLBX.MDP3',
      pythonPath: this.globalConfig.pythonPath || 'python',
    });

    await this.sharedPriceProvider.startLiveStream();
    logger.info(`✓ Shared Databento stream: ${allSymbols.join(', ')}`);

    // Handle shared stream disconnect/reconnect for all runners
    this.sharedPriceProvider.on('disconnected', ({ code }) => {
      logger.warn(`[Databento:SHARED] Disconnected (code: ${code})`);
      this.notifications.send(
        `⚠️ <b>DATABENTO DISCONNECTED</b>\nAll instruments affected. Reconnecting...`
      ).catch(() => {});
    });

    this.sharedPriceProvider.on('reconnected', async (data) => {
      logger.info(`[Databento:SHARED] Reconnected — syncing all instruments`);
      this.notifications.send(
        `✅ <b>DATABENTO RECONNECTED</b>\nAll streams restored.`
      ).catch(() => {});
    });

    this.sharedPriceProvider.on('maxReconnectAttemptsReached', () => {
      logger.error(`[Databento:SHARED] Max reconnect attempts — ALL INSTRUMENTS BLIND`);
      this.notifications.send(
        `🚨 <b>DATABENTO DEAD</b>\nAll reconnect attempts exhausted. No market data for any instrument!`
      ).catch(() => {});
    });

    // ── Initialize each instrument runner ──
    const shared = {
      client: this.client,
      account: this.account,
      orderWs: this.orderWs,
      notifications: this.notifications,
      marketHours: this.marketHours,
      tradeAnalyzer: this.tradeAnalyzer,
      globalConfig: this.globalConfig,
      sharedPriceProvider: this.sharedPriceProvider,
    };

    for (const ic of instrumentConfigs) {
      logger.info(`\n${'─'.repeat(60)}`);
      logger.info(`  Initializing ${ic.baseSymbol} (${ic.strategy})`);
      logger.info(`${'─'.repeat(60)}`);

      const runner = new InstrumentRunner(ic, shared);
      await runner.initialize();

      this.runners.set(ic.baseSymbol, runner);

      // Map contract ID for order/fill routing
      const contractId = runner.getContractId();
      if (contractId) {
        this._contractIdToRunner.set(contractId, runner);
        logger.info(`  Routing: contractId ${contractId} → ${ic.baseSymbol}`);
      }

      // Listen for halt events
      runner.on('halt', (data) => {
        logger.error(`${data.instrument} HALTED: ${data.message}`);
      });
    }

    this.isRunning = true;
    logger.success('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.success(`✅ MultiInstrumentBot LIVE — ${this.runners.size} instrument(s)`);
    logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    await this.notifications.send(
      `🤖 <b>MULTI-INSTRUMENT BOT STARTED</b>\n` +
      `Instruments: ${[...this.runners.keys()].join(', ')}\n` +
      `Account: ${this.account.name}`
    ).catch(() => {});
  }

  /**
   * Connect shared Tradovate order WebSocket
   * Routes order/fill/position events to the correct InstrumentRunner by contractId
   * @private
   */
  async _connectOrderWebSocket() {
    this.orderWs = new TradovateWebSocket(this.auth, 'order');

    // Route order events by contractId
    this.orderWs.on('order', (order) => {
      const runner = this._contractIdToRunner.get(order.contractId);
      if (runner) {
        runner.handleOrderUpdate(order);
      } else {
        logger.debug(`[OrderWs] Order for unknown contractId ${order.contractId}`);
      }
    });

    // Route fill events by contractId
    this.orderWs.on('fill', (fill) => {
      const runner = this._contractIdToRunner.get(fill.contractId);
      if (runner) {
        runner.handleFill(fill);
      } else {
        logger.debug(`[OrderWs] Fill for unknown contractId ${fill.contractId}`);
      }
    });

    // Route position events by contractId
    this.orderWs.on('position', (position) => {
      const runner = this._contractIdToRunner.get(position.contractId);
      if (runner) {
        runner.handlePositionUpdate(position);
      } else {
        logger.debug(`[OrderWs] Position for unknown contractId ${position.contractId}`);
      }
    });

    // Route props events — Tradovate sends fills/orders/positions wrapped in props
    this.orderWs.on('props', (data) => {
      if (!data || !data.entityType || !data.entity) return;
      const entity = data.entity;
      if (data.entityType === 'fill' && data.eventType === 'Created') {
        const runner = this._contractIdToRunner.get(entity.contractId);
        if (runner) {
          runner.handleFill(entity);
        }
      } else if (data.entityType === 'order') {
        const runner = this._contractIdToRunner.get(entity.contractId);
        if (runner) {
          runner.handleOrderUpdate(entity);
        }
      } else if (data.entityType === 'position') {
        const runner = this._contractIdToRunner.get(entity.contractId);
        if (runner) {
          runner.handlePositionUpdate(entity);
        }
      }
    });

    // Reconnect handling
    this.orderWs.on('reconnected', async (data) => {
      if (data.requiresPositionSync) {
        logger.warn('[OrderWs] Reconnected — syncing all instrument positions');
        for (const runner of this.runners.values()) {
          await runner.syncPosition();
        }
      }
    });

    await this.orderWs.connect();

    // Wait for authorization
    await new Promise((resolve) => {
      if (this.orderWs.isAuthorized) {
        resolve();
      } else {
        this.orderWs.once('authorized', resolve);
        setTimeout(resolve, 5000);
      }
    });

    this.orderWs.synchronize(this.account.id);
    logger.info('✓ Tradovate order WebSocket connected (shared)');
  }

  /**
   * Start the bot in continuous mode
   */
  async start() {
    await this.initialize();

    // Start session lifecycle manager
    this._startSessionManager();

    // Start position sync heartbeat
    this._startPositionSyncHeartbeat();

    // Check if starting mid-session
    const pst = this._getPSTTime();
    const mins = pst.hour * 60 + pst.minute;
    const sessionStart = this.globalConfig.tradingStartHour * 60 + this.globalConfig.tradingStartMinute;
    const sessionEnd = this.globalConfig.tradingEndHour * 60 + this.globalConfig.tradingEndMinute;

    if (mins >= sessionStart && mins < sessionEnd) {
      logger.info('⚡ Started mid-session — daily reset already done');
      this._todayResetDone = true;
    } else if (mins < sessionStart) {
      logger.info(`⏳ Waiting for session start at ${this.globalConfig.tradingStartHour}:${String(this.globalConfig.tradingStartMinute).padStart(2, '0')} PST`);
    } else {
      logger.info('📴 Session ended for today — will trade tomorrow');
    }

    // Graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    // Log schedule
    logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.success('📅 DAILY SCHEDULE (PST):');
    logger.success('   6:29 AM  — Daily reset (all instruments)');
    logger.success('   6:30 AM  — Session start');
    for (const [sym, runner] of this.runners) {
      const strat = runner.instrumentConfig.strategy;
      logger.success(`   ${sym}: ${strat}`);
    }
    logger.success('  12:55 PM  — EOD force-close (all instruments)');
    logger.success('   1:00 PM  — Session end, daily report');
    logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  /**
   * Session lifecycle manager (runs every 15s)
   * @private
   */
  _startSessionManager() {
    const checkSession = async () => {
      if (!this.isRunning) return;

      const pst = this._getPSTTime();
      const mins = pst.hour * 60 + pst.minute;
      const sessionStart = this.globalConfig.tradingStartHour * 60 + this.globalConfig.tradingStartMinute;
      const sessionEnd = this.globalConfig.tradingEndHour * 60 + this.globalConfig.tradingEndMinute;

      // ── Daily Reset at 6:29 AM PST ──
      if (pst.hour === 6 && pst.minute === 29 && !this._todayResetDone) {
        this._todayResetDone = true;
        this._eodCloseDoneToday = false;
        this._dailyReportSentToday = false;
        this._sessionStartLoggedToday = false;

        for (const [sym, runner] of this.runners) {
          runner.dailyReset();
        }
        logger.info('🔄 Daily reset — all instruments');
        await this.notifications.send('🔄 New trading day — all instruments reset').catch(() => {});
      }

      // ── Reset flags after midnight ──
      if (pst.hour === 0 && pst.minute < 2) {
        this._todayResetDone = false;
        this._dailyReportSentToday = false;
      }

      // ── EOD Force-Close at 12:55 PM PST ──
      if (mins >= sessionEnd - 5 && mins < sessionEnd && !this._eodCloseDoneToday) {
        this._eodCloseDoneToday = true;
        for (const [sym, runner] of this.runners) {
          await runner.eodClose();
        }
      }

      // ── Session start log ──
      if (mins >= sessionStart && !this._sessionStartLoggedToday) {
        this._sessionStartLoggedToday = true;
        logger.info('🔔 Trading session started (6:30 AM PST)');
      }

      // ── EOD Daily Report ──
      if (mins >= sessionEnd && !this._dailyReportSentToday) {
        logger.info('🔔 Session ended — generating daily report');
        await this._sendDailyReport('Session ended (1:00 PM PST)');
      }
    };

    this._sessionCheckInterval = setInterval(checkSession, 15000);
    checkSession();
  }

  /**
   * Position sync heartbeat (every 60s during session)
   * @private
   */
  _startPositionSyncHeartbeat() {
    this._positionSyncInterval = setInterval(async () => {
      if (!this.isRunning) return;
      if (!this._isInSession()) return;

      for (const runner of this.runners.values()) {
        await runner.syncPosition();
      }
    }, 60000);
    logger.info('✓ Position sync heartbeat started (60s, all instruments)');
  }

  /**
   * Send combined daily report for all instruments
   * @private
   */
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
        const be = stats.breakeven || 0;
        lines.push(`${sym}: ${stats.trades || 0}t ${stats.wins || 0}W/${stats.losses || 0}L/${be}BE ${pnlStr}`);
      }

      const totalPnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
      const wr = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(0) : '0';

      const msg = `📊 <b>DAILY REPORT</b> (${today})\n` +
        `Reason: ${reason}\n\n` +
        lines.join('\n') + '\n\n' +
        `<b>TOTAL: ${totalTrades}t ${totalWins}W/${totalLosses}L/${totalBE}BE ${totalPnlStr} (${wr}% WR)</b>`;

      await this.notifications.send(msg).catch(() => {});

      // Log to file
      const fs = require('fs');
      const path = require('path');
      const logDir = path.join('.', 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

      const logEntry = {
        date: today,
        reason,
        totalTrades, totalWins, totalLosses, totalBE, totalPnl,
        instruments: {},
      };
      for (const [sym, runner] of this.runners) {
        logEntry.instruments[sym] = runner.getTodayStats();
      }

      const logFile = path.join(logDir, `daily_multi_${today}.json`);
      fs.writeFileSync(logFile, JSON.stringify(logEntry, null, 2));
      logger.info(`📋 Daily report saved to ${logFile}`);
      logger.info(`📊 Day: ${totalTrades}t | ${totalWins}W/${totalLosses}L | P&L: ${totalPnlStr} | ${reason}`);

    } catch (err) {
      logger.error(`Failed to send daily report: ${err.message}`);
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('Shutting down MultiInstrumentBot...');
    this.isRunning = false;

    if (this._sessionCheckInterval) clearInterval(this._sessionCheckInterval);
    if (this._positionSyncInterval) clearInterval(this._positionSyncInterval);

    // Shutdown all runners
    for (const [sym, runner] of this.runners) {
      await runner.shutdown();
    }

    await this.notifications.send('🛑 <b>MULTI-INSTRUMENT BOT STOPPED</b>').catch(() => {});

    if (this.sharedPriceProvider) this.sharedPriceProvider.stop();
    if (this.orderWs) this.orderWs.disconnect();

    logger.info('MultiInstrumentBot stopped');
    process.exit(0);
  }

  // ═══════════════════════════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════════════════════════

  _getPSTTime(date = new Date()) {
    const fmt = (type) => parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', [type]: 'numeric', hour12: false
    }).format(date));
    return { hour: fmt('hour'), minute: fmt('minute') };
  }

  _isInSession() {
    const pst = this._getPSTTime();
    const mins = pst.hour * 60 + pst.minute;
    const sessionStart = this.globalConfig.tradingStartHour * 60 + this.globalConfig.tradingStartMinute;
    const sessionEnd = this.globalConfig.tradingEndHour * 60 + this.globalConfig.tradingEndMinute;
    return mins >= sessionStart && mins < sessionEnd;
  }

  _logStartupBanner() {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('🤖 Multi-Instrument Trading Bot Starting...');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`Environment: ${this.globalConfig.env.toUpperCase()}`);
    logger.info(`Instruments: ${process.env.INSTRUMENTS || 'none'}`);
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
}

module.exports = MultiInstrumentBot;
