/**
 * TradovateBot - Core trading bot class
 * 
 * Orchestrates all components:
 * - Authentication and API client
 * - WebSocket connections
 * - Strategy execution
 * - Signal and position handling
 * - Risk management
 */

const TradovateAuth = require('../api/auth');
const TradovateClient = require('../api/client');
const TradovateWebSocket = require('../api/websocket');
const DatabentoPriceProvider = require('../data/DatabentoPriceProvider');
const RiskManager = require('../risk/manager');
const LossLimitsManager = require('../risk/loss_limits');
const OpeningRangeBreakoutStrategy = require('../strategies/opening_range_breakout');
const MNQMomentumStrategy = require('../strategies/mnq_momentum_strategy');
const MNQMomentumStrategyV2 = require('../strategies/mnq_momentum_strategy_v2');
const VWAPEngine = require('../indicators/VWAPEngine');
const SessionFilter = require('../filters/session_filter');
const { OrderManager } = require('../orders/order_manager');
const TrailingStopManager = require('../orders/trailing_stop');
const ProfitManager = require('../orders/profit_manager');
const PerformanceTracker = require('../analytics/performance');
const TradeAnalyzer = require('../analytics/trade_analyzer');
const logger = require('../utils/logger');
const ConfigValidator = require('../utils/config_validator');
const MarketHours = require('../utils/market_hours');
const Notifications = require('../utils/notifications');
const DynamicSizing = require('../utils/dynamic_sizing');
const SignalHandler = require('./SignalHandler');
const PositionHandler = require('./PositionHandler');

class TradovateBot {
  constructor() {
    this.config = this.loadConfig();
    
    // Core components (initialized in initializeCore)
    this.auth = null;
    this.client = null;
    this.account = null;
    this.contract = null;
    
    // Data & Execution
    this.priceProvider = null;  // Databento for market data
    this.orderWs = null;        // Tradovate WebSocket for order execution only
    
    // Managers (initialized in initialize)
    this.riskManager = null;
    this.lossLimits = null;
    this.sessionFilter = null;
    this.orderManager = null;
    this.trailingStop = null;
    this.profitManager = null;
    this.performance = null;
    this.strategy = null;
    
    // Handlers
    this.signalHandler = null;
    this.positionHandler = null;
    
    // Utilities (initialized immediately)
    this.marketHours = new MarketHours(this.config.timezone);
    this.notifications = new Notifications();
    this.tradeAnalyzer = new TradeAnalyzer({ dataDir: './data' });
    this.notifications.setTradeAnalyzer(this.tradeAnalyzer);
    this.dynamicSizing = new DynamicSizing({
      baseRisk: (this.config.riskPerTrade.min + this.config.riskPerTrade.max) / 2,
      minRisk: parseFloat(process.env.DYNAMIC_SIZING_MIN_RISK) || 25,
      maxRisk: parseFloat(process.env.DYNAMIC_SIZING_MAX_RISK) || 75
    });
    this.dynamicSizingEnabled = process.env.DYNAMIC_SIZING_ENABLED === 'true';
    
    // State
    this.isRunning = false;

    // Session management (PST-based)
    this._dailyResetInterval = null;
    this._sessionCheckInterval = null;
    this._todayResetDone = false;       // Has today's daily reset been performed?
    this._orLoggedToday = false;        // Have we logged OR establishment today?
    this._eodCloseDoneToday = false;    // Have we done EOD close today?
    this._dailyReportSentToday = false; // Have we sent today's daily report?
    this._sessionStartLoggedToday = false; // Fix 3: Dedup session start log
    this._lastEntryHourPST = parseInt(process.env.LAST_ENTRY_HOUR) || 11;
    this._lastEntryMinutePST = parseInt(process.env.LAST_ENTRY_MINUTE) || 0;

    // Fix 2: Bar watchdog — detect silent data stalls during session
    this._barWatchdogTimer = null;
    this._lastBarReceivedAt = null;

    // Enhancement 1: Periodic position sync heartbeat (every 60s during session)
    this._positionSyncInterval = null;

    // Enhancement 3: Proactive gap backfill timer (every 5min during session)
    this._gapBackfillInterval = null;
  }

  /**
   * Load and validate configuration from environment variables
   * @returns {Object} Validated and sanitized configuration
   */
  loadConfig() {
    const rawConfig = {
      env: process.env.TRADOVATE_ENV,
      username: process.env.TRADOVATE_USERNAME,
      password: process.env.TRADOVATE_PASSWORD,
      cid: process.env.TRADOVATE_CID ? parseInt(process.env.TRADOVATE_CID) : null,
      secret: process.env.TRADOVATE_SECRET,
      contractSymbol: process.env.CONTRACT_SYMBOL,
      autoRollover: process.env.AUTO_ROLLOVER === 'true',
      riskPerTrade: {
        min: process.env.RISK_PER_TRADE_MIN,
        max: process.env.RISK_PER_TRADE_MAX
      },
      profitTargetR: process.env.PROFIT_TARGET_R,
      dailyLossLimit: process.env.DAILY_LOSS_LIMIT,
      weeklyLossLimit: process.env.WEEKLY_LOSS_LIMIT,
      maxConsecutiveLosses: process.env.MAX_CONSECUTIVE_LOSSES,
      maxDrawdownPercent: process.env.MAX_DRAWDOWN_PERCENT,
      strategy: process.env.STRATEGY,
      lookbackPeriod: process.env.LOOKBACK_PERIOD,
      atrMultiplier: process.env.ATR_MULTIPLIER,
      trendEMAPeriod: process.env.TREND_EMA_PERIOD,
      useTrendFilter: process.env.USE_TREND_FILTER !== 'false',
      useVolumeFilter: process.env.USE_VOLUME_FILTER !== 'false',
      useRSIFilter: process.env.USE_RSI_FILTER !== 'false',
      tradingStartHour: process.env.TRADING_START_HOUR,
      tradingStartMinute: process.env.TRADING_START_MINUTE,
      tradingEndHour: process.env.TRADING_END_HOUR,
      tradingEndMinute: process.env.TRADING_END_MINUTE,
      avoidLunch: process.env.AVOID_LUNCH !== 'false',
      timezone: process.env.TIMEZONE,
      trailingStopEnabled: process.env.TRAILING_STOP_ENABLED === 'true',
      trailingStopATRMultiplier: process.env.TRAILING_STOP_ATR_MULTIPLIER,
      moveStopToBE: process.env.MOVE_STOP_TO_BE === 'true',
      beActivationR: parseFloat(process.env.BE_ACTIVATION_R) || 2.5,
      partialProfitEnabled: process.env.PARTIAL_PROFIT_ENABLED === 'true',
      partialProfitPercent: process.env.PARTIAL_PROFIT_PERCENT,
      partialProfitR: process.env.PARTIAL_PROFIT_R,
      // AI Confirmation settings
      aiConfirmationEnabled: process.env.AI_CONFIRMATION_ENABLED === 'true',
      aiProvider: process.env.AI_PROVIDER || 'anthropic',
      aiApiKey: process.env.AI_API_KEY || '',
      aiModel: process.env.AI_MODEL || null,
      aiConfidenceThreshold: parseInt(process.env.AI_CONFIDENCE_THRESHOLD) || 70,
      aiTimeout: parseInt(process.env.AI_TIMEOUT) || 5000,
      aiDefaultAction: process.env.AI_DEFAULT_ACTION || 'confirm',
      // Databento settings (market data provider)
      databentoApiKey: process.env.DATABENTO_API_KEY || '',
      databentoSymbol: process.env.DATABENTO_SYMBOL || null,
      databentoSchema: process.env.DATABENTO_SCHEMA || 'trades',
      databentoDataset: process.env.DATABENTO_DATASET || 'GLBX.MDP3',
      pythonPath: process.env.PYTHON_PATH || 'python'
    };

    // Validate configuration
    const validation = ConfigValidator.validate(rawConfig);
    if (!validation.valid) {
      validation.errors.forEach(err => logger.error(`Config error: ${err}`));
      throw new Error('Invalid configuration. Check .env file.');
    }
    
    // Log warnings
    validation.warnings.forEach(warn => logger.warn(`Config warning: ${warn}`));

    // Return sanitized config with defaults
    return ConfigValidator.sanitize(rawConfig);
  }

  /**
   * Initialize core components (auth, client, account, contract)
   * Used for both full trading mode and CLI commands
   * @returns {Object} Account and contract info
   */
  async initializeCore() {
    // 1. Authenticate
    this.auth = new TradovateAuth(this.config);
    await this.auth.authenticate();

    // 2. Initialize API client
    this.client = new TradovateClient(this.auth);

    // 3. Get account
    const accounts = await this.client.getAccounts();
    if (accounts.length === 0) {
      throw new Error('No accounts found');
    }
    this.account = accounts[0];

    // 4. Find contract (with auto-rollover if enabled)
    if (this.config.autoRollover) {
      const baseSymbol = this.config.contractSymbol.substring(0, 3);
      this.contract = await this.client.getFrontMonthContract(baseSymbol);
    } else {
      this.contract = await this.client.findContract(this.config.contractSymbol);
    }

    return { account: this.account, contract: this.contract };
  }

  /**
   * Initialize all components for full trading mode
   */
  async initialize() {
    try {
      this._logStartupBanner();

      // Initialize core
      await this.initializeCore();
      logger.info(`✓ Account: ${this.account.name} (ID: ${this.account.id})`);
      logger.info(`✓ Contract: ${this.contract.name} (ID: ${this.contract.id})`);

      // Initialize managers
      this._initializeManagers();

      // Initialize strategy
      this._initializeStrategy();

      // Initialize handlers
      this._initializeHandlers();

      // Connect order WebSocket (Tradovate) and price provider (Databento)
      await this._connectOrderWebSocket();
      await this._connectPriceProvider();

      // Load initial data: fetches prior day → sets prior day levels → fetches today → warms EMAs
      // _loadInitialData handles VWAP engine reset internally (after feeding prior day bars)
      await this._loadInitialData();

      this.isRunning = true;
      logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.success('✅ Bot is now LIVE and monitoring the market');
      logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // Send Telegram notification
      await this.notifications.botStarted();

    } catch (error) {
      logger.error(`Initialization failed: ${error.message}`);
      await this.notifications.error(`Initialization failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Log startup banner
   * @private
   */
  _logStartupBanner() {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('🤖 Tradovate Trading Bot Starting...');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info(`Environment: ${this.config.env.toUpperCase()}`);
    logger.info(`Contract: ${this.config.contractSymbol}`);
    logger.info(`Risk: $${this.config.riskPerTrade.min}-$${this.config.riskPerTrade.max} per trade`);
    logger.info(`Strategy: ${this.config.strategy}`);
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }

  /**
   * Initialize all manager components
   * @private
   */
  _initializeManagers() {
    // Risk manager
    this.riskManager = new RiskManager(this.config);
    logger.info('✓ Risk Manager initialized');

    // Loss limits
    this.lossLimits = new LossLimitsManager(this.config);
    this.lossLimits.on('halt', async (data) => {
      logger.error(`🛑 TRADING HALTED: ${data.message}`);
      // Deactivate strategy for the day (no more signals)
      if (this.strategy) this.strategy.isActive = false;
      // Send daily report
      await this._sendDailyReport(data.message);
    });
    logger.info('✓ Loss Limits Manager initialized');

    // Session filter
    this.sessionFilter = new SessionFilter(this.config);
    logger.info('✓ Session Filter initialized');

    // Order manager
    this.orderManager = new OrderManager(this.client);
    // MED-7 FIX: Enable automatic cleanup to prevent memory leaks
    this.orderManager.startAutoCleanup();
    logger.info('✓ Order Manager initialized');

    // Trailing stop manager
    this.trailingStop = new TrailingStopManager({
      enabled: this.config.trailingStopEnabled,
      atrMultiplier: this.config.trailingStopATRMultiplier
    });
    // HIGH-7 FIX: Set client for actual exchange order modifications
    this.trailingStop.setClient(this.client, this.account.id);
    logger.info('✓ Trailing Stop Manager initialized');

    // Profit manager (includes breakeven stop management)
    this.profitManager = new ProfitManager({
      partialProfitEnabled: this.config.partialProfitEnabled,
      partialProfitPercent: this.config.partialProfitPercent,
      partialProfitR: this.config.partialProfitR,
      breakEvenEnabled: this.config.moveStopToBE,
      breakEvenTriggerR: this.config.beActivationR,
      breakEvenOffset: 1.0, // BE + 1pt in our favor
    });
    logger.info('✓ Profit Manager initialized');

    // Performance tracker
    this.performance = new PerformanceTracker();
    logger.info('✓ Performance Tracker initialized');
  }

  /**
   * Initialize trading strategy
   * @private
   */
  _initializeStrategy() {
    const strategyName = (process.env.STRATEGY || 'opening_range_breakout').toLowerCase();

    if (strategyName === 'mnq_momentum_v2' || strategyName === 'mnq_momentum') {
      // ── MNQ Momentum Strategy V2 (EMAX + Pullback + VWAP Mean Reversion) ──
      // Create shared VWAP engine (strategy reads it, bot feeds it)
      this.vwapEngine = new VWAPEngine();

      this.strategy = new MNQMomentumStrategyV2({
        // EMAX parameters (disabled by default — PF 0.80-0.89 across all timeframes)
        emaxEnabled: process.env.EMAX_ENABLED === 'true', // Default: false
        emaxEmaFast: parseInt(process.env.EMAX_EMA_FAST) || 9,
        emaxEmaSlow: parseInt(process.env.EMAX_EMA_SLOW) || 21,
        emaxMinBarRange: parseFloat(process.env.EMAX_MIN_BAR_RANGE) || 5,
        emaxMinBodyRatio: parseFloat(process.env.EMAX_MIN_BODY_RATIO) || 0.5,
        emaxMaxTime: parseInt(process.env.EMAX_MAX_TIME) || 480,
        emaxUseZLEMA: process.env.EMAX_USE_ZLEMA === 'true', // Default: false (EMA outperforms ZLEMA)
        // PB parameters
        pbMinImpulse: parseFloat(process.env.PB_MIN_IMPULSE) || 20,
        pbMinImpBodyRatio: parseFloat(process.env.PB_MIN_IMP_BODY_RATIO) || 0.5,
        pbRetraceMin: parseFloat(process.env.PB_RETRACE_MIN) || 0.2,
        pbRetraceMax: parseFloat(process.env.PB_RETRACE_MAX) || 0.6,
        pbMaxTime: parseInt(process.env.PB_MAX_TIME) || 510,
        // VR (VWAP Mean Reversion) parameters
        vrEnabled: process.env.VR_ENABLED !== 'false', // Default: true
        vrMinTime: parseInt(process.env.VR_MIN_TIME) || 510,
        vrMaxTime: parseInt(process.env.VR_MAX_TIME) || 750,
        vrMinSigma: parseFloat(process.env.VR_MIN_SIGMA) || 1.5,
        vrEntrySigmaMax: parseFloat(process.env.VR_ENTRY_SIGMA_MAX) || 1.0,
        vrStopBeyondBand: parseFloat(process.env.VR_STOP_BEYOND_BAND) || 3,
        vrTargetMode: process.env.VR_TARGET_MODE || 'fixed',
        vrTargetR: parseFloat(process.env.VR_TARGET_R) || 4,
        vrMinBarVolRatio: parseFloat(process.env.VR_MIN_BAR_VOL_RATIO) || 0.8,
        vrMaxStopPoints: parseInt(process.env.VR_MAX_STOP_POINTS) || 20,
        vrMinStopPoints: parseInt(process.env.VR_MIN_STOP_POINTS) || 4,
        vrCooldownBars: parseInt(process.env.VR_COOLDOWN_BARS) || 10,
        // Shared parameters
        maxStopPoints: parseInt(process.env.MAX_STOP_POINTS) || 25,
        minStopPoints: parseInt(process.env.MIN_STOP_POINTS) || 5,
        stopBuffer: parseFloat(process.env.STOP_BUFFER) || 2,
        profitTargetR: parseFloat(process.env.PROFIT_TARGET_R) || 5,
        minTargetPoints: parseFloat(process.env.MIN_TARGET_POINTS) || 60,
        // Partial profit
        partialProfitEnabled: process.env.VR_PARTIAL_PROFIT_ENABLED === 'true',
        partialProfitR: parseFloat(process.env.VR_PARTIAL_PROFIT_R) || 2,
        moveStopToBE: process.env.VR_MOVE_STOP_TO_BE === 'true',
        // Confluence (3 is backtest-proven optimal)
        minConfluence: process.env.MIN_CONFLUENCE !== undefined ? parseInt(process.env.MIN_CONFLUENCE) : 3,
        volumeAvgPeriod: parseInt(process.env.VOLUME_AVG_PERIOD) || 20,
        momentumBars: parseInt(process.env.MOMENTUM_BARS) || 5,
        priorLevelTolerance: parseFloat(process.env.PRIOR_LEVEL_TOLERANCE) || 5,
        // VWAP engine (shared)
        vwapEngine: this.vwapEngine,
        // Session filter
        sessionFilter: this.sessionFilter,
        minBars: 1,
      });

      const emaxOn = process.env.EMAX_ENABLED === 'true';
      const vrOn = process.env.VR_ENABLED !== 'false';
      const subs = [emaxOn ? 'EMAX' : null, 'PB', vrOn ? 'VR' : null].filter(Boolean).join(' + ');
      logger.info(`✓ MNQ Momentum Strategy V2 initialized (${subs})`);
      if (emaxOn) {
        const useZL = process.env.EMAX_USE_ZLEMA === 'true' ? 'ZLEMA' : 'EMA';
        logger.info(`  EMAX: ${useZL}${process.env.EMAX_EMA_FAST || 9}/${process.env.EMAX_EMA_SLOW || 21} cross on 2m bars, cutoff 8:00 AM`);
      } else {
        logger.info(`  EMAX: DISABLED`);
      }
      const pbCutoff = parseInt(process.env.PB_MAX_TIME) || 510;
      const pbH = Math.floor(pbCutoff/60), pbM = pbCutoff%60;
      const retrMin = parseFloat(process.env.PB_RETRACE_MIN) || 0.2, retrMax = parseFloat(process.env.PB_RETRACE_MAX) || 0.6;
      logger.info(`  PB: impulse>=${process.env.PB_MIN_IMPULSE || 20}pt, retrace ${(retrMin*100).toFixed(0)}-${(retrMax*100).toFixed(0)}%, cutoff ${pbH}:${String(pbM).padStart(2,'0')} AM`);
      if (vrOn) {
        const vrTgt = process.env.VR_TARGET_MODE === 'fixed' ? `${process.env.VR_TARGET_R || 4}R` : 'VWAP';
        const vrStart = parseInt(process.env.VR_MIN_TIME) || 510;
        const vrEnd = parseInt(process.env.VR_MAX_TIME) || 660;
        const vsH = Math.floor(vrStart/60), vsM = vrStart%60;
        const veH = Math.floor(vrEnd/60), veM = vrEnd%60;
        logger.info(`  VR: VWAP mean reversion ±${process.env.VR_MIN_SIGMA || 1.5}σ, target=${vrTgt}, ${vsH}:${String(vsM).padStart(2,'0')}-${veH}:${String(veM).padStart(2,'0')} AM`);
      }
      logger.info(`  Confluence: min ${process.env.MIN_CONFLUENCE || 0} factors | Partial: 2R+BE`);
      logger.info(`  Stop: max ${process.env.MAX_STOP_POINTS || 25}pt | Target: ${process.env.PROFIT_TARGET_R || 4}R`);

    } else {
      // ── ORB Strategy (default, for MES) ──
      this.strategy = new OpeningRangeBreakoutStrategy({
        orPeriodMinutes: parseInt(process.env.OR_PERIOD_MINUTES) || 15,
        orBuffer: parseFloat(process.env.OR_BUFFER) || 0.5,
        stopBuffer: parseFloat(process.env.STOP_BUFFER) || 1.0,
        maxStopPoints: parseInt(process.env.MAX_STOP_POINTS) || 8,
        minOrRange: parseInt(process.env.MIN_OR_RANGE) || 6,
        maxOrRange: parseInt(process.env.MAX_OR_RANGE) || 10,
        minBodyRatio: parseFloat(process.env.MIN_BODY_RATIO) || 0.3,
        profitTargetR: parseFloat(process.env.PROFIT_TARGET_R) || 2,
        useTrailingStop: process.env.TRAILING_STOP_ENABLED === 'true',
        trailActivationR: parseFloat(process.env.TRAIL_ACTIVATION_R) || 2.0,
        trailDistancePoints: parseFloat(process.env.TRAIL_DISTANCE_POINTS) || 8,
        emaFastPeriod: parseInt(process.env.EMA_FAST_PERIOD) || 9,
        emaSlowPeriod: parseInt(process.env.EMA_SLOW_PERIOD) || 21,
        useTrendFilter: process.env.USE_TREND_FILTER === 'true',
        useVolumeFilter: process.env.USE_VOLUME_FILTER !== 'false',
        volumeAvgPeriod: parseInt(process.env.VOLUME_AVG_PERIOD) || 10,
        volumeMinRatio: parseFloat(process.env.VOLUME_MIN_RATIO) || 1.0,
        useRSIFilter: process.env.USE_RSI_FILTER === 'true',
        rsiPeriod: parseInt(process.env.RSI_PERIOD) || 14,
        rsiOverbought: parseInt(process.env.RSI_OVERBOUGHT) || 75,
        rsiOversold: parseInt(process.env.RSI_OVERSOLD) || 25,
        useADXFilter: process.env.USE_ADX_FILTER === 'true',
        adxPeriod: parseInt(process.env.ADX_PERIOD) || 14,
        adxMinTrend: parseInt(process.env.ADX_MIN_TREND) || 20,
        signalCooldownBars: parseInt(process.env.SIGNAL_COOLDOWN_BARS) || 3,
        allowShorts: process.env.ALLOW_SHORTS !== 'false',
        sessionFilter: this.sessionFilter,
        minBars: 1,
      });

      logger.info('✓ ORB Strategy initialized (Opening Range Breakout)');
      logger.info(`  Stop: OR level + ${process.env.STOP_BUFFER || 1.0} pt buffer (max ${process.env.MAX_STOP_POINTS || 12} pts) | Target: ${process.env.PROFIT_TARGET_R || 2}R | Trail: ${process.env.TRAIL_ACTIVATION_R || 2.0}R`);
    }

    // Strategy will emit signals to signal handler
    this.strategy.on('signal', (signal) => this._onSignal(signal));
    this.strategy.initialize();
  }

  /**
   * Initialize signal and position handlers
   * @private
   */
  _initializeHandlers() {
    // Signal handler
    this.signalHandler = new SignalHandler({
      client: this.client,
      riskManager: this.riskManager,
      lossLimits: this.lossLimits,
      sessionFilter: this.sessionFilter,
      marketHours: this.marketHours,
      tradeAnalyzer: this.tradeAnalyzer,
      notifications: this.notifications,
      trailingStop: this.trailingStop,
      profitManager: this.profitManager,
      strategy: this.strategy
    }, this.config);
    
    this.signalHandler.setContext(this.account, this.contract);
    logger.info('✓ Signal Handler initialized');

    // Position handler
    this.positionHandler = new PositionHandler({
      performance: this.performance,
      lossLimits: this.lossLimits,
      tradeAnalyzer: this.tradeAnalyzer,
      notifications: this.notifications,
      trailingStop: this.trailingStop,
      profitManager: this.profitManager,
      strategy: this.strategy,
      dynamicSizing: this.dynamicSizing
    }, { ...this.config, dynamicSizingEnabled: this.dynamicSizingEnabled });
    
    this.positionHandler.setContract(this.contract);
    
    // Listen for position closed events
    this.positionHandler.on('positionClosed', () => {
      this.signalHandler.clearPosition();
    });

    // When entry fill arrives at a different price than signal, update everything
    this.positionHandler.on('entryFilled', async (fillData) => {
      const { fillPrice, signalPrice, slippage, newStop, newTarget, position } = fillData;

      // 1. Update SignalHandler's currentPosition
      this.signalHandler.updatePositionFromFill(fillData);

      // 2. Update ProfitManager internal state
      const posId = position.orderId || position.id || position.clientId || 'active';
      if (this.profitManager) {
        this.profitManager.updatePositionFromFill(posId, { fillPrice, newStop, newTarget });
      }

      // 3. Update TrailingStop internal state
      if (this.trailingStop) {
        this.trailingStop.updatePositionFromFill(posId, { fillPrice, newStop, newTarget });
      }

      // 4. Modify bracket orders on exchange if slippage occurred
      if (slippage !== 0 && position.stopOrderId) {
        try {
          await this.client.modifyOrder(position.stopOrderId, {
            orderType: 'Stop',
            stopPrice: newStop,
            orderQty: position.quantity || 1,
          });
          logger.info(`✓ Stop order adjusted: $${newStop.toFixed(2)} (slippage: ${slippage >= 0 ? '+' : ''}${slippage.toFixed(2)}pt)`);
        } catch (err) {
          logger.error(`Failed to adjust stop order after fill: ${err.message}`);
        }
      }
      if (slippage !== 0 && position.targetOrderId) {
        try {
          await this.client.modifyOrder(position.targetOrderId, {
            orderType: 'Limit',
            price: newTarget,
            orderQty: position.quantity || 1,
          });
          logger.info(`✓ Target order adjusted: $${newTarget.toFixed(2)}`);
        } catch (err) {
          logger.error(`Failed to adjust target order after fill: ${err.message}`);
        }
      }

      // 5. Send the single entry notification NOW (after fill) with real prices
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
          await this.notifications.tradeEntryDetailed({
            signal: patchedSignal,
            position: patchedPosition,
            marketStructure: nd.marketStructure,
            filterResults: nd.filterResults,
            aiDecision: nd.aiDecision,
            slippage: slippage !== 0 ? slippage : undefined,
            signalPrice: slippage !== 0 ? signalPrice : undefined,
          });
          logger.info('✓ Entry notification sent');
        } catch (notifErr) {
          logger.error(`❌ Entry notification FAILED: ${notifErr.message}`);
        }
        delete position._notificationData;
      }
    });
    
    logger.info('✓ Position Handler initialized');
  }

  /**
   * Connect Tradovate order WebSocket (execution only)
   * @private
   */
  async _connectOrderWebSocket() {
    this.orderWs = new TradovateWebSocket(this.auth, 'order');

    // Order WebSocket events
    this.orderWs.on('order', (order) => this.positionHandler.handleOrderUpdate(order));
    this.orderWs.on('fill', (fill) => this._onFill(fill));
    this.orderWs.on('position', (position) => this.positionHandler.handlePositionUpdate(position));
    
    // HIGH-4 FIX: Sync position state after order WebSocket reconnects
    this.orderWs.on('reconnected', async (data) => {
      if (data.requiresPositionSync) {
        logger.warn('Order WebSocket reconnected - syncing position state...');
        await this._syncPositionState();
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

    // Sync user data on order socket
    this.orderWs.synchronize(this.account.id);
    logger.info('✓ Tradovate order WebSocket connected');
  }

  /**
   * Connect Databento price provider for market data
   * Uses ohlcv-1m schema so the ORB strategy receives proper 1-minute bars
   * @private
   */
  async _connectPriceProvider() {
    // Map contract symbol to Databento parent symbol
    const baseSymbol = this.config.contractSymbol.substring(0, 3);
    const databentoSymbol = this.config.databentoSymbol || `${baseSymbol}.FUT`;

    // Strategy requires 1-minute OHLCV bars (aggregated into 2m/5m internally)
    this.priceProvider = new DatabentoPriceProvider({
      apiKey: this.config.databentoApiKey,
      symbol: databentoSymbol,
      schema: 'ohlcv-1m',  // CRITICAL: Strategy needs 1-min bars, not raw trades
      dataset: this.config.databentoDataset || 'GLBX.MDP3',
      pythonPath: this.config.pythonPath || 'python',
    });

    // Wire up price events — filter bars through session gate
    this.priceProvider.on('quote', (quote) => this._onQuote(quote));
    this.priceProvider.on('bar', (bar) => this._onBar(bar));
    this.priceProvider.on('trade', (trade) => this.emit('trade', trade));
    this.priceProvider.on('error', (error) => logger.error(`[Databento] Error: ${error.message}`));

    // Fix 4: Telegram notification on disconnect
    this.priceProvider.on('disconnected', ({ code }) => {
      logger.warn(`[Databento] Stream disconnected (code: ${code})`);
      this.notifications.send(
        `⚠️ <b>DATABENTO DISCONNECTED</b>\nStream lost (code: ${code}). Attempting reconnect...`
      ).catch(() => {});
    });

    // Fix 1 + Fix 4: Gap recovery and Telegram notification on reconnect
    this.priceProvider.on('reconnected', async (data) => {
      const downtimeSec = (data.downtimeMs / 1000).toFixed(1);
      logger.info(`[Databento] Reconnected — recovering gap bars since ${data.lastBarTs}`);

      let recoveredBars = 0;
      if (data.lastBarTs) {
        try {
          // Fetch bars from last known bar to now (Databento has ~20min delay for historical)
          // Use a 1-minute buffer before the last bar to ensure overlap for dedup
          const gapStart = new Date(new Date(data.lastBarTs).getTime() - 60000).toISOString();
          const gapEnd = new Date(Date.now() - 20 * 60 * 1000).toISOString();

          // Only fetch if the gap window makes sense (start < end)
          if (new Date(gapStart) < new Date(gapEnd)) {
            const gapBars = await this.priceProvider.getHistoricalBars(gapStart, gapEnd, 'ohlcv-1m', 100);
            if (gapBars && gapBars.length > 0) {
              // Build a set of timestamps already in the strategy's bar array to avoid duplicates
              const existingTs = new Set((this.strategy.bars || []).map(b => b.timestamp));
              this._warmingUp = true; // Suppress signals during gap recovery
              try {
                for (const bar of gapBars) {
                  if (existingTs.has(bar.timestamp)) continue; // Skip bars we already have
                  if (!this._isInSession(bar.timestamp)) continue; // Session filter
                  this.strategy.onBar(bar);
                  recoveredBars++;
                }
              } finally {
                this._warmingUp = false;
              }
              // Reset signalFired if it triggered during gap recovery
              if (this.strategy.signalFired && !this.strategy.position) {
                this.strategy.signalFired = false;
              }
              logger.info(`[Databento] Gap recovery: ${recoveredBars} bars recovered (${gapBars.length} fetched, ${gapBars.length - recoveredBars} dupes/filtered)`);
            } else {
              logger.info('[Databento] Gap recovery: no bars available (Databento ~20min delay)');
            }
          } else {
            logger.info('[Databento] Gap recovery: window too short, skipping');
          }
        } catch (err) {
          logger.warn(`[Databento] Gap recovery failed: ${err.message}`);
        }
      }

      // Fix 4: Telegram notification on reconnect
      this.notifications.send(
        `✅ <b>DATABENTO RECONNECTED</b>\n` +
        `Downtime: ${downtimeSec}s (${data.attempts} attempts)\n` +
        `Gap recovery: ${recoveredBars} bars recovered`
      ).catch(() => {});
    });

    // Fix 6: Critical Telegram alert when all reconnect attempts exhausted
    this.priceProvider.on('maxReconnectAttemptsReached', () => {
      logger.error('[Databento] Max reconnect attempts reached — BOT IS BLIND');
      this.notifications.send(
        `🚨 <b>CRITICAL: DATABENTO DEAD</b>\n` +
        `All reconnect attempts exhausted.\n` +
        `Bot has NO market data — no signals will fire.\n` +
        `Manual intervention required!`
      ).catch(() => {});
    });

    await this.priceProvider.startLiveStream();
    logger.info(`✓ Databento price stream connected: ${databentoSymbol} (ohlcv-1m)`);
  }

  /**
   * HIGH-4 FIX: Sync position state from exchange after WebSocket reconnect
   * This prevents stale state issues where bot thinks position exists but exchange closed it
   * @private
   */
  async _syncPositionState() {
    try {
      const positions = await this.client.getOpenPositions(this.account.id);
      const hasOpenPosition = positions.length > 0;
      const botHasPosition = this.signalHandler.getPosition() !== null;
      
      if (botHasPosition && !hasOpenPosition) {
        // Bot thinks we have position but exchange doesn't - clear local state
        logger.warn('Position sync: Bot had position but exchange does not. Clearing local state.');
        this.signalHandler.clearPosition();
        this.strategy.setPosition(null);
      } else if (!botHasPosition && hasOpenPosition) {
        // Exchange has position but bot doesn't know - log warning (manual intervention may be needed)
        logger.error('Position sync: Exchange has open position but bot does not track it!');
        logger.error(`Exchange positions: ${JSON.stringify(positions)}`);
        await this.notifications.error('Position sync mismatch: Exchange has position bot does not track');
      } else {
        logger.info('Position sync: State is consistent');
      }
    } catch (error) {
      logger.error(`Position sync failed: ${error.message}`);
    }
  }

  /**
   * Enhancement 1: Start periodic position sync heartbeat.
   * Runs every 60s during session to detect state drift between bot and exchange.
   * Catches: flaky WebSocket, manual exchange intervention, bracket fills during
   * micro-disconnects, PM2 restarts that lose in-memory state.
   * @private
   */
  _startPositionSyncHeartbeat() {
    if (this._positionSyncInterval) return; // Already running

    this._positionSyncInterval = setInterval(async () => {
      if (!this.isRunning || !this.client || !this.account) return;

      // Only sync during session hours
      if (!this._isInSession(new Date().toISOString())) return;

      try {
        const positions = await this.client.getOpenPositions(this.account.id);
        const hasOpenPosition = positions.length > 0;
        const botHasPosition = this.signalHandler.getPosition() !== null;

        if (botHasPosition && !hasOpenPosition) {
          // CRITICAL: Bot thinks we have a position but exchange doesn't
          // This blocks all new signals — must clear immediately
          logger.warn('[PositionSync] MISMATCH: Bot has position but exchange does not — clearing local state');
          const pos = this.signalHandler.getPosition();
          const entryOrderId = pos?.orderId;
          this.signalHandler.clearPosition();
          this.strategy.setPosition(null);
          if (entryOrderId) {
            this.profitManager.closePosition(entryOrderId);
            this.trailingStop.removeTrail(entryOrderId);
          }
          await this.notifications.send(
            `⚠️ <b>POSITION SYNC FIX</b>\nBot had stale position — cleared.\nNew signals are now unblocked.`
          ).catch(() => {});
        } else if (!botHasPosition && hasOpenPosition) {
          // Exchange has position bot doesn't track — dangerous, alert immediately
          const pos = positions[0];
          logger.error(`[PositionSync] MISMATCH: Exchange has position (${pos.netPos} @ ${pos.netPrice}) but bot does not track it!`);
          await this.notifications.send(
            `🚨 <b>POSITION SYNC ALERT</b>\nExchange has open position bot doesn't track!\n` +
            `NetPos: ${pos.netPos} @ ${pos.netPrice}\nManual intervention may be needed.`
          ).catch(() => {});
        }
        // If consistent, no log needed (would spam every 60s)
      } catch (error) {
        // Silently ignore — transient API errors shouldn't crash the bot
        logger.debug(`[PositionSync] Heartbeat failed: ${error.message}`);
      }
    }, 60000); // Every 60 seconds

    logger.info('✓ Position sync heartbeat started (60s interval)');
  }

  /**
   * Enhancement 1: Stop position sync heartbeat.
   * @private
   */
  _stopPositionSyncHeartbeat() {
    if (this._positionSyncInterval) {
      clearInterval(this._positionSyncInterval);
      this._positionSyncInterval = null;
    }
  }

  /**
   * Enhancement 3: Start proactive gap backfill timer.
   * Runs every 5 minutes during session. Scans strategy.bars for timestamp gaps.
   * If missing bars are >20 minutes old (Databento historical API delay), fetches
   * and injects them. Combined with clock-aligned bars, injected bars slot into
   * the correct 5m bucket automatically.
   * @private
   */
  _startGapBackfill() {
    if (this._gapBackfillInterval) return; // Already running

    this._gapBackfillInterval = setInterval(async () => {
      if (!this.isRunning || !this.priceProvider || !this.strategy) return;

      // Only backfill during session hours
      if (!this._isInSession(new Date().toISOString())) return;

      try {
        const allBars = this.strategy.bars || [];
        if (allBars.length < 2) return;

        // Filter to TODAY's bars only — strategy.bars contains prior-day bars
        // stitched in for RSI/ATR warmup, and the overnight gap would be a false positive.
        const todayStr = new Date().toISOString().split('T')[0];
        const todayBars = allBars.filter(b => b.timestamp && b.timestamp.startsWith(todayStr));
        if (todayBars.length < 2) return;

        // Scan for gaps in today's session bars
        const gaps = [];
        for (let i = 1; i < todayBars.length; i++) {
          const prev = new Date(todayBars[i - 1].timestamp).getTime();
          const curr = new Date(todayBars[i].timestamp).getTime();
          const gapMin = Math.round((curr - prev) / 60000);
          if (gapMin > 1) {
            // Only backfill gaps where the missing bars are >20min old
            const gapAge = Date.now() - curr;
            if (gapAge > 20 * 60 * 1000) {
              gaps.push({
                start: new Date(prev + 60000).toISOString(), // First missing bar
                end: todayBars[i].timestamp,                   // Bar after the gap
                dropped: gapMin - 1,
              });
            }
          }
        }

        if (gaps.length === 0) return;

        logger.info(`[GapBackfill] Found ${gaps.length} gap(s) in today's session bars, attempting recovery...`);

        const existingTs = new Set(allBars.map(b => b.timestamp));
        let totalRecovered = 0;

        for (const gap of gaps) {
          try {
            const gapBars = await this.priceProvider.getHistoricalBars(
              gap.start, gap.end, 'ohlcv-1m', 50
            );
            if (!gapBars || gapBars.length === 0) continue;

            // IMPORTANT: Do NOT feed recovered bars through strategy.onBar() —
            // they are out of chronological order and would corrupt the clock-aligned
            // 5m bar builder (which assumes bars arrive in time order).
            // Instead, stitch them directly into strategy.bars for RSI/ATR/volume
            // context. The 5m bars are already correctly aligned by the clock-based
            // bucketing, so the missing 1m bars within a 5m bucket just mean that
            // bucket has fewer constituent bars (acceptable).
            for (const bar of gapBars) {
              if (existingTs.has(bar.timestamp)) continue;
              if (!this._isInSession(bar.timestamp)) continue;
              this.strategy.bars.push(bar);
              existingTs.add(bar.timestamp);
              totalRecovered++;
            }

            // Re-sort strategy.bars by timestamp to maintain chronological order
            if (totalRecovered > 0) {
              this.strategy.bars.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
              if (this.strategy.bars.length > 500) {
                this.strategy.bars.splice(0, this.strategy.bars.length - 500);
              }
            }
          } catch (err) {
            logger.debug(`[GapBackfill] Failed to recover gap at ${gap.start}: ${err.message}`);
          }
        }

        if (totalRecovered > 0) {
          logger.info(`[GapBackfill] Recovered ${totalRecovered} bar(s) from ${gaps.length} gap(s) (stitched into bars array)`);
          await this.notifications.send(
            `🔧 <b>GAP BACKFILL</b>\nRecovered ${totalRecovered} missing bar(s) from ${gaps.length} gap(s)`
          ).catch(() => {});
        }
      } catch (error) {
        logger.debug(`[GapBackfill] Scan failed: ${error.message}`);
      }
    }, 5 * 60 * 1000); // Every 5 minutes

    logger.info('✓ Gap backfill timer started (5min interval)');
  }

  /**
   * Enhancement 3: Stop gap backfill timer.
   * @private
   */
  _stopGapBackfill() {
    if (this._gapBackfillInterval) {
      clearInterval(this._gapBackfillInterval);
      this._gapBackfillInterval = null;
    }
  }

  /**
   * Load initial historical data from Databento — ROBUST for any startup scenario.
   * 
   * Handles:
   * - Starting before session, mid-session, or after session
   * - Monday startup → fetches Friday's data for prior day levels
   * - Bot restarts mid-day (re-warms VWAP + EMAs from today's bars so far)
   * - Machine reboots, manual starts at random times
   * - Databento API availability delay (~20 min)
   * 
   * Strategy:
   * 1. Determine the PRIOR trading day (skip weekends)
   * 2. Fetch prior day's full session → feed to VWAP engine as "prior day"
   * 3. Call vwapEngine.resetDay() to save those as prior day levels
   * 4. Fetch TODAY's session bars so far → feed to strategy (warms EMAs + current VWAP)
   * 
   * @private
   */
  async _loadInitialData() {
    const sessionStartMins = this.config.tradingStartHour * 60 + this.config.tradingStartMinute;
    const sessionEndMins = this.config.tradingEndHour * 60 + this.config.tradingEndMinute;

    try {
      // ── Step 1: Determine prior trading day ──
      // Get "today" in PST. If it's a weekend or before session on Monday, go back further.
      const nowPST = this._getPSTTime();
      const now = new Date();

      // Build a PST date string for "today"
      const pstDateStr = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
      }).format(now);
      // Parse MM/DD/YYYY → Date
      const [mm, dd, yyyy] = pstDateStr.split('/');
      const todayPST = new Date(`${yyyy}-${mm}-${dd}T00:00:00-08:00`);

      // Find the previous trading day (skip weekends)
      let priorDay = new Date(todayPST);
      priorDay.setDate(priorDay.getDate() - 1); // Go back 1 day
      // Skip weekends: Sunday(0) → Friday, Saturday(6) → Friday
      while (priorDay.getDay() === 0 || priorDay.getDay() === 6) {
        priorDay.setDate(priorDay.getDate() - 1);
      }

      // Prior day session window in UTC (DST-safe)
      // We create Date objects using the LA timezone formatter to get correct UTC offsets
      // PST = UTC-8, PDT = UTC-7. Intl handles this automatically.
      const priorDayStr = priorDay.toISOString().split('T')[0];
      const priorSessionStart = new Date(new Date(`${priorDayStr}T${String(this.config.tradingStartHour).padStart(2,'0')}:${String(this.config.tradingStartMinute).padStart(2,'0')}:00`).toLocaleString('en-US', {timeZone: 'America/Los_Angeles'}) + ' UTC').toISOString();
      // Simpler approach: fetch a wide UTC window, then filter by PST time in the loop below
      const priorSessionStartUTC = `${priorDayStr}T13:00:00Z`; // 5 AM PST/6 AM PDT — always before session
      const priorSessionEndUTC = `${priorDayStr}T22:00:00Z`;   // 2 PM PST/3 PM PDT — always after session

      logger.info(`[Historical] Prior trading day: ${priorDayStr} (${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][priorDay.getDay()]})`);

      // ── Step 2: Fetch prior day's session bars ──
      let priorDayBars = 0;
      try {
        const priorBars = await this.priceProvider.getHistoricalBars(
          priorSessionStartUTC,
          priorSessionEndUTC,
          'ohlcv-1m',
          500
        );

        if (priorBars && priorBars.length > 0) {
          // Feed prior day bars to VWAP engine to build prior day levels
          // AND stitch into strategy.bars for RSI/ATR/volume warmup
          const priorSessionBars = [];
          for (const bar of priorBars) {
            const pst = this._getPSTTime(new Date(bar.timestamp));
            const mins = pst.hour * 60 + pst.minute;
            if (mins >= sessionStartMins && mins < sessionEndMins) {
              this.vwapEngine.onBar(bar);
              priorSessionBars.push(bar);
              priorDayBars++;
            }
          }

          // Stitch prior day bars into strategy.bars directly (NOT via onBar,
          // which would build 2m/5m bars and fire signals). This gives the
          // strategy full RSI/ATR/volume context from the first live bar.
          if (this.strategy && this.strategy.bars) {
            for (const bar of priorSessionBars) {
              this.strategy.bars.push(bar);
              if (this.strategy.bars.length > 500) this.strategy.bars.shift();
            }
            logger.info(`[Historical] Prior day: ${priorDayBars} bars stitched into strategy.bars (RSI/ATR/volume warmup)`);
          }

          logger.info(`[Historical] Prior day: ${priorDayBars} session bars loaded → VWAP=${this.vwapEngine.vwap?.toFixed(1)}, HOD=${this.vwapEngine.sessionHigh}, LOD=${this.vwapEngine.sessionLow}`);
        } else {
          logger.warn(`[Historical] No prior day bars received (${priorDayStr} may be a holiday)`);
        }
      } catch (err) {
        logger.warn(`[Historical] Failed to fetch prior day data: ${err.message}`);
      }

      // ── Step 3: Reset VWAP engine → saves prior day as "prior day levels" ──
      // This moves sessionHigh/Low/Close/VWAP → priorDayHigh/Low/Close/VWAP
      this.vwapEngine.resetDay();

      if (priorDayBars > 0) {
        logger.info(`[Historical] Prior day levels set: HOD=${this.vwapEngine.priorDayHigh}, LOD=${this.vwapEngine.priorDayLow}, Close=${this.vwapEngine.priorDayClose}, VWAP=${this.vwapEngine.priorDayVWAP?.toFixed(1)}, POC=${this.vwapEngine.priorDayPOC}`);
      }

      // ── Step 4: Fetch TODAY's session bars (for EMA warmup + current VWAP) ──
      // Only if we're during or after today's session
      const todayStr = `${yyyy}-${mm}-${dd}`;
      // DST-safe: fetch wide UTC window, _isInSession filters by PST time
      const todaySessionStart = `${todayStr.replace(/\//g, '-')}T13:00:00Z`; // Wide window (5AM PST / 6AM PDT)
      const nowMins = nowPST.hour * 60 + nowPST.minute;

      // Only fetch today's bars if session has started (or we're past it)
      if (nowMins >= sessionStartMins) {
        // Databento historical data is ~15-20 min delayed.
        // Try with 20-min offset first, fall back to 30/45-min if Databento rejects.
        let todayBars = null;
        for (const offsetMin of [20, 30, 45]) {
          try {
            const endTime = new Date(Date.now() - offsetMin * 60 * 1000).toISOString();
            todayBars = await this.priceProvider.getHistoricalBars(
              todaySessionStart,
              endTime,
              'ohlcv-1m',
              500
            );
            break; // success
          } catch (err) {
            if (offsetMin < 45) {
              logger.warn(`[Historical] Today fetch (end=now-${offsetMin}m) failed, retrying with larger offset...`);
            } else {
              logger.warn(`[Historical] Failed to fetch today's data: ${err.message}`);
            }
          }
        }

        if (todayBars && todayBars.length > 0) {
          let todaySessionBars = 0;
          this._warmingUp = true; // Suppress signals during historical replay
          try {
            for (const bar of todayBars) {
              const pst = this._getPSTTime(new Date(bar.timestamp));
              const mins = pst.hour * 60 + pst.minute;
              if (mins >= sessionStartMins && mins < sessionEndMins) {
                this.strategy.onBar(bar);
                todaySessionBars++;
              }
            }
          } finally {
            this._warmingUp = false;
          }
          // Reset signalFired — a signal may have fired during warmup replay
          // which would block the first real live trade
          if (this.strategy.signalFired && !this.strategy.position) {
            this.strategy.signalFired = false;
          }
          logger.info(`[Historical] Today: ${todaySessionBars} session bars loaded → VWAP=${this.vwapEngine.vwap?.toFixed(1)}, 2m=${this.strategy.twoMinBars?.length || 0}, 5m=${this.strategy.fiveMinBars?.length || 0}`);
        } else {
          logger.info('[Historical] No today bars yet (session may not have started or Databento delay)');
        }
      } else {
        logger.info(`[Historical] Session hasn't started yet (${nowPST.hour}:${String(nowPST.minute).padStart(2, '0')} PST < ${this.config.tradingStartHour}:${String(this.config.tradingStartMinute).padStart(2, '0')}). Prior day levels are set, waiting for live bars.`);
      }

    } catch (error) {
      logger.warn(`[Historical] Data load failed: ${error.message}`);
      logger.warn('[Historical] Bot will start without historical context - strategy needs live bars to warm up');
    }

    // Update equity for loss limits (still from Tradovate)
    try {
      const balance = await this.client.getCashBalance(this.account.id);
      this.lossLimits.updateEquity(balance.cashBalance);
    } catch (err) {
      logger.warn(`Failed to get account balance: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  SESSION-AWARE EVENT HANDLERS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get current time in PST
   * @private
   */
  _getPSTTime(date = new Date()) {
    const fmt = (type) => parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', [type]: 'numeric', hour12: false
    }).format(date));
    const dayOfWeek = new Date(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date)).getDay();
    return { hour: fmt('hour'), minute: fmt('minute'), dayOfWeek };
  }

  /**
   * Check if a timestamp is within the trading session (6:30 AM - 1:00 PM PST)
   * @private
   */
  _isInSession(timestamp) {
    const pst = this._getPSTTime(new Date(timestamp));
    const mins = pst.hour * 60 + pst.minute;
    const sessionStart = this.config.tradingStartHour * 60 + this.config.tradingStartMinute;
    const sessionEnd = this.config.tradingEndHour * 60 + this.config.tradingEndMinute;
    return mins >= sessionStart && mins < sessionEnd;
  }

  /**
   * Check if we're past the last-entry cutoff (11:00 AM PST)
   * @private
   */
  _isPastEntryCutoff() {
    const pst = this._getPSTTime();
    const mins = pst.hour * 60 + pst.minute;
    const cutoff = this._lastEntryHourPST * 60 + this._lastEntryMinutePST;
    return mins >= cutoff;
  }

  /**
   * Handle incoming 1-min bar from Databento
   * CRITICAL: Only feed session bars (6:30 AM - 1:00 PM PST) to the strategy
   * Pre-market and post-market bars are ignored to prevent OR corruption
   * @private
   */
  _onBar(bar) {
    // Only feed session bars to the strategy
    if (!this._isInSession(bar.timestamp)) {
      return; // Silently drop pre/post-market bars
    }

    // ── Gap detection: warn if bars were dropped from the live stream ──
    if (this._lastSessionBarTs) {
      const prev = new Date(this._lastSessionBarTs).getTime();
      const curr = new Date(bar.timestamp).getTime();
      const gapMin = Math.round((curr - prev) / 60000);
      if (gapMin > 1) {
        const dropped = gapMin - 1;
        logger.warn(`[GAP] ${dropped} bar(s) dropped: ${this._lastSessionBarTs} → ${bar.timestamp} (${gapMin}min gap)`);
        if (dropped >= 2 && this.notifications) {
          this.notifications.send(`⚠️ ${dropped} bars dropped at ${bar.timestamp} — clock-aligned bars will compensate`).catch(() => {});
        }
      }
    }
    this._lastSessionBarTs = bar.timestamp;

    // Reset bar watchdog timer — bar arrived, stream is healthy
    this._lastBarReceivedAt = Date.now();
    this._resetBarWatchdog();

    // Feed to strategy (builds multi-TF bars, generates signals)
    this.strategy.onBar(bar);

    // Active trade management: check if BE stop should trigger
    if (this.strategy.position && this.profitManager) {
      const pos = this.strategy.position;
      // CRITICAL: Must match the ID used in SignalHandler.initializePosition()
      // SignalHandler passes { id: order.orderId, ...currentPosition }
      const posId = pos.orderId || pos.id || pos.clientId || 'active';
      const isLong = pos.side === 'Buy';
      const beCheckPrice = isLong ? bar.high : bar.low;
      const { actions } = this.profitManager.update(posId, beCheckPrice, bar);
      for (const action of actions) {
        if (action.type === 'MOVE_STOP') {
          logger.success(`🔒 BE Stop: Moving stop to $${action.newStop.toFixed(2)} (${action.reason}, ${action.rMultiple.toFixed(1)}R)`);

          // Update currentPosition.stopLoss so exit reason detection uses the moved stop
          pos.stopLoss = action.newStop;
          pos.breakEvenMoved = true;
          const shPos = this.signalHandler?.getPosition();
          if (shPos) {
            shPos.stopLoss = action.newStop;
            shPos.breakEvenMoved = true;
          }

          // Modify the stop order on the exchange via Tradovate API
          if (this.client && pos.stopOrderId) {
            this.client.modifyOrder(pos.stopOrderId, {
              orderType: 'Stop',
              stopPrice: action.newStop,
              orderQty: pos.quantity || 1,
            }).catch(err => {
              logger.error(`Failed to modify stop order: ${err.message}`);
            });
          }
          // Notify via Telegram
          this.notifications.send(
            `🔒 <b>STOP MOVED</b>\n` +
            `${pos.side} @ $${pos.entryPrice?.toFixed(2) || '?'}\n` +
            `Stop: $${action.newStop.toFixed(2)} (${action.reason})\n` +
            `Unrealized: ${action.rMultiple.toFixed(1)}R`
          ).catch(() => {});
        }
      }
    }

    // Log OR establishment once per day (ORB strategy only)
    if (this.strategy.orEstablished !== undefined && this.strategy.orEstablished && !this._orLoggedToday) {
      this._orLoggedToday = true;
      const orRange = (this.strategy.orHigh - this.strategy.orLow).toFixed(2);
      logger.success(`📊 Opening Range established: $${this.strategy.orLow.toFixed(2)} - $${this.strategy.orHigh.toFixed(2)} (${orRange} pts)`);
      this.notifications.send(`📊 OR: $${this.strategy.orLow.toFixed(2)} - $${this.strategy.orHigh.toFixed(2)} (${orRange} pts)`).catch(() => {});
    }
  }

  /**
   * Fix 2: Reset the bar watchdog timer.
   * If no session bar arrives within 90 seconds, something is wrong.
   * @private
   */
  _resetBarWatchdog() {
    if (this._barWatchdogTimer) clearTimeout(this._barWatchdogTimer);
    this._barWatchdogTimer = setTimeout(() => {
      // Only alert if we're in session and the bot is running
      if (!this.isRunning) return;
      if (!this._isInSession(new Date().toISOString())) return;

      const silenceSec = this._lastBarReceivedAt
        ? ((Date.now() - this._lastBarReceivedAt) / 1000).toFixed(0)
        : '?';
      logger.warn(`[Watchdog] No bar received for 90s (last bar ${silenceSec}s ago). Stream may be stalled.`);
      this.notifications.send(
        `⚠️ <b>BAR WATCHDOG</b>\nNo bar received for 90s.\nStream may be stalled — monitoring...`
      ).catch(() => {});

      // Don't keep re-alerting every 90s — set a longer 5-min timer for the next alert
      this._barWatchdogTimer = setTimeout(() => {
        if (!this.isRunning) return;
        if (!this._isInSession(new Date().toISOString())) return;
        const silenceSec2 = this._lastBarReceivedAt
          ? ((Date.now() - this._lastBarReceivedAt) / 1000).toFixed(0)
          : '?';
        logger.error(`[Watchdog] Still no bar after 5+ minutes (${silenceSec2}s). Stream is likely dead.`);
        this.notifications.send(
          `🚨 <b>BAR WATCHDOG CRITICAL</b>\nNo bar for 5+ minutes (${silenceSec2}s).\nStream appears dead — check server!`
        ).catch(() => {});
      }, 5 * 60 * 1000 - 90000); // 5 min total minus the initial 90s
    }, 90000);
  }

  /**
   * Fix 2: Stop the bar watchdog timer (called on shutdown and outside session)
   * @private
   */
  _stopBarWatchdog() {
    if (this._barWatchdogTimer) {
      clearTimeout(this._barWatchdogTimer);
      this._barWatchdogTimer = null;
    }
  }

  /**
   * Handle incoming quote
   * @private
   */
  _onQuote(quote) {
    this.strategy.onQuote(quote);
  }

  /**
   * Handle trading signal from strategy
   * Enforces last-entry cutoff before passing to signal handler
   * @private
   */
  async _onSignal(signal) {
    // Block signals during historical warmup — only trade on live data
    if (this._warmingUp) {
      return;
    }

    // Block Thursday trading (0W/5L = -$255 in 3-month backtest)
    if (process.env.DISABLE_THURSDAY === 'true') {
      const pst = this._getPSTTime();
      if (pst.dayOfWeek === 4) { // Thursday
        logger.warn(`Signal blocked: Thursday trading disabled (DISABLE_THURSDAY=true)`);
        return;
      }
    }

    // Block new entries after cutoff time
    // VR strategy has its own time window (vrMaxTime), so the bot-level cutoff
    // is the latest possible entry time across all sub-strategies.
    // EMAX/PB have their own cutoffs built into the strategy code.
    if (this._isPastEntryCutoff()) {
      const pst = this._getPSTTime();
      logger.warn(`Signal blocked: Past entry cutoff (${pst.hour}:${String(pst.minute).padStart(2, '0')} PST > ${this._lastEntryHourPST}:${String(this._lastEntryMinutePST).padStart(2, '0')})`);
      return;
    }

    // Log signal with strategy name and confluence score
    if (signal.strategy && signal.confluenceScore !== undefined) {
      logger.info(`📊 ${signal.strategy} signal: ${signal.type.toUpperCase()} | Confluence: ${signal.confluenceScore}`);
    }

    await this.signalHandler.handleSignal(signal);
  }

  /**
   * Handle fill notification
   * @private
   */
  async _onFill(fill) {
    const result = await this.positionHandler.handleFill(
      fill,
      this.signalHandler.getPosition(),
      this.signalHandler.getTradeId()
    );

    if (result.isFullyClosed) {
      this.signalHandler.clearPosition();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  SESSION LIFECYCLE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Start the session check loop (runs every 15 seconds)
   * Handles: daily reset, OR logging, EOD force-close, session state
   * @private
   */
  _startSessionManager() {
    const checkSession = async () => {
      if (!this.isRunning) return;

      const pst = this._getPSTTime();
      const mins = pst.hour * 60 + pst.minute;
      const sessionStart = this.config.tradingStartHour * 60 + this.config.tradingStartMinute; // 390 (6:30)
      const sessionEnd = this.config.tradingEndHour * 60 + this.config.tradingEndMinute;       // 780 (13:00)

      // ── Daily Reset at 6:29 AM PST (1 min before session) ──
      if (pst.hour === 6 && pst.minute === 29 && !this._todayResetDone) {
        this._todayResetDone = true;
        this._orLoggedToday = false;
        this._eodCloseDoneToday = false;
        this._dailyReportSentToday = false;
        this._sessionStartLoggedToday = false;
        this._lastSessionBarTs = null; // Reset gap tracker for new session
        this.strategy.resetDay();
        logger.info(`🔄 Daily ${this.strategy.name} strategy reset — new trading day`);
        await this.notifications.send(`🔄 New trading day — ${this.strategy.name} strategy reset`).catch(() => {});
      }

      // ── Reset the daily flags after midnight PST ──
      if (pst.hour === 0 && pst.minute < 2) {
        this._todayResetDone = false;
        this._dailyReportSentToday = false;
      }

      // ── EOD Force-Close at 12:55 PM PST (5 min before session end) ──
      if (mins >= sessionEnd - 5 && mins < sessionEnd && !this._eodCloseDoneToday) {
        if (this.signalHandler && this.signalHandler.getPosition()) {
          this._eodCloseDoneToday = true;
          logger.warn('⏰ EOD approaching — force-closing open position');
          try {
            const pos = this.signalHandler.getPosition();
            const closeAction = pos.side === 'Buy' ? 'Sell' : 'Buy';

            // Step 1: Cancel all working orders (stop + target brackets)
            try {
              const cancelResult = await this.client.cancelAllOrders(this.account.id);
              logger.info(`⏰ EOD: Cancelled ${cancelResult.cancelled}/${cancelResult.total} bracket orders`);
            } catch (cancelErr) {
              logger.warn(`EOD cancel orders failed: ${cancelErr.message}`);
            }

            // Step 2: Flatten position via market order
            await this.client.placeMarketOrder(
              this.account.id,
              this.contract.id,
              pos.quantity,
              closeAction
            );
            logger.success('✓ EOD position closed');

            // Step 3: Clean up local state so next day isn't blocked
            const entryOrderId = pos.orderId;
            this.strategy.setPosition(null);
            this.signalHandler.clearPosition();
            if (entryOrderId) {
              this.profitManager.closePosition(entryOrderId);
              this.trailingStop.removeTrail(entryOrderId);
            }

            await this.notifications.send(`⏰ EOD close: ${closeAction} ${pos.quantity} @ market`).catch(() => {});
          } catch (err) {
            logger.error(`EOD close failed: ${err.message}`);
            await this.notifications.error(`EOD close failed: ${err.message}`).catch(() => {});
            // Even on error, clean up local state to prevent blocking next day
            this.strategy.setPosition(null);
            this.signalHandler.clearPosition();
          }
        } else {
          this._eodCloseDoneToday = true; // No position to close
        }
      }

      // ── Session boundary logging (Fix 3: log once per day, not every 15s) ──
      if (mins >= sessionStart && !this._sessionStartLoggedToday) {
        this._sessionStartLoggedToday = true;
        logger.info('🔔 Trading session started (6:30 AM PST)');
      }

      // ── EOD Daily Report (ALWAYS fires at session end, win/loss/no trades) ──
      if (mins >= sessionEnd && !this._dailyReportSentToday) {
        logger.info('🔔 Trading session ended — generating daily report');
        await this._sendDailyReport('Session ended (1:00 PM PST)');
      }
    };

    // Run every 15 seconds
    this._sessionCheckInterval = setInterval(checkSession, 15000);
    // Also run immediately
    checkSession();
  }

  /**
   * Send daily performance report via Telegram and log to file
   * Called on halt (3 consecutive losses) AND at EOD (always, win/loss/no trades)
   * @param {string} reason - Why the report is being generated
   * @private
   */
  async _sendDailyReport(reason) {
    if (this._dailyReportSentToday) return; // Prevent duplicate reports
    this._dailyReportSentToday = true;

    try {
      const todayStats = this.performance.getTodayStats();
      const today = new Date().toISOString().split('T')[0];

      // Get today's trades from the performance tracker
      const todayTrades = (this.performance.trades || []).filter(t => t.date === today);

      // Send Telegram report
      await this.notifications.dailyPerformanceReport(todayStats, reason, todayTrades);

      // Log to file
      const fs = require('fs');
      const path = require('path');
      const logDir = path.join('.', 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

      const logEntry = {
        date: today,
        reason,
        trades: todayStats.trades,
        wins: todayStats.wins,
        losses: todayStats.losses,
        pnl: todayStats.pnl,
        winRate: todayStats.winRate,
        profitFactor: todayStats.profitFactor,
        tradeDetails: todayTrades.map(t => ({
          side: t.side, entry: t.entryPrice, exit: t.exitPrice,
          pnl: t.pnl, exitReason: t.exitReason, time: t.timestamp
        }))
      };

      const logFile = path.join(logDir, `daily_${today}.json`);
      fs.writeFileSync(logFile, JSON.stringify(logEntry, null, 2));
      logger.info(`📋 Daily report saved to ${logFile}`);
      logger.info(`📊 Day: ${todayStats.trades} trades | ${todayStats.wins}W/${todayStats.losses}L | P&L: $${todayStats.pnl.toFixed(2)} | Reason: ${reason}`);

    } catch (err) {
      logger.error(`Failed to send daily report: ${err.message}`);
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('Shutting down bot...');
    this.isRunning = false;

    // Clear intervals and timers
    if (this._sessionCheckInterval) clearInterval(this._sessionCheckInterval);
    if (this._dailyResetInterval) clearInterval(this._dailyResetInterval);
    this._stopBarWatchdog();
    this._stopPositionSyncHeartbeat();
    this._stopGapBackfill();

    // Send shutdown notification
    await this.notifications.botStopped('Graceful shutdown');

    if (this.strategy) {
      this.strategy.stop();
    }

    if (this.priceProvider) {
      this.priceProvider.stop();
    }

    if (this.orderWs) {
      this.orderWs.disconnect();
    }

    logger.info('Bot stopped');
    process.exit(0);
  }

  /**
   * Start the bot in continuous mode
   */
  async start() {
    await this.initialize();

    // Start session lifecycle manager
    this._startSessionManager();

    // Enhancement 1: Start position sync heartbeat (detects state drift every 60s)
    this._startPositionSyncHeartbeat();

    // Enhancement 3: Start proactive gap backfill (recovers dropped bars every 5min)
    this._startGapBackfill();

    // If starting mid-session, do an immediate daily reset
    const pst = this._getPSTTime();
    const mins = pst.hour * 60 + pst.minute;
    const sessionStart = this.config.tradingStartHour * 60 + this.config.tradingStartMinute;
    const sessionEnd = this.config.tradingEndHour * 60 + this.config.tradingEndMinute;

    if (mins >= sessionStart && mins < sessionEnd) {
      logger.info('⚡ Bot started mid-session — daily reset already done before data load');
      this._todayResetDone = true;
    } else if (mins < sessionStart) {
      logger.info(`⏳ Waiting for session start at ${this.config.tradingStartHour}:${String(this.config.tradingStartMinute).padStart(2, '0')} PST`);
    } else {
      logger.info('📴 Session already ended for today — will trade tomorrow');
    }

    // Handle graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());

    logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    const stratName = (process.env.STRATEGY || 'opening_range_breakout').toLowerCase();
    logger.success('📅 DAILY SCHEDULE (PST):');
    logger.success(`   6:29 AM  — Daily reset`);
    logger.success(`   6:30 AM  — Session start`);
    if (stratName === 'mnq_momentum_v2' || stratName === 'mnq_momentum') {
      const emaxMax = parseInt(process.env.EMAX_MAX_TIME) || 480;
      const pbMax = parseInt(process.env.PB_MAX_TIME) || 510;
      const vrMin = parseInt(process.env.VR_MIN_TIME) || 510;
      const lastH = parseInt(process.env.LAST_ENTRY_HOUR) || 11;
      const lastM = parseInt(process.env.LAST_ENTRY_MINUTE) || 0;
      const fmt = (m) => { const h = Math.floor(m/60); const mm = m%60; return `${h > 12 ? h-12 : h}:${String(mm).padStart(2,'0')} ${h >= 12 ? 'PM' : 'AM'}`; };
      logger.success(`   ${fmt(emaxMax)}  — EMAX signal cutoff`);
      logger.success(`   ${fmt(pbMax)}  — PB signal cutoff`);
      if (process.env.VR_ENABLED !== 'false') {
        logger.success(`   ${fmt(vrMin)}  — VR (VWAP Mean Reversion) window opens`);
        logger.success(`  ${lastH > 12 ? lastH-12 : lastH}:${String(lastM).padStart(2,'0')} ${lastH >= 12 ? 'PM' : 'AM'}  — VR window closes (last entry)`);
      }
    } else {
      logger.success(`   6:45 AM  — OR established, start trading`);
    }
    logger.success(`  12:55 PM  — EOD force-close any open position`);
    logger.success(`   1:00 PM  — Session end, daily report`);
    logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
}

module.exports = TradovateBot;
