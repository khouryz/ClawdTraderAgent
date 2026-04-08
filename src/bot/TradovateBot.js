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
const TelegramCommandHandler = require('../utils/TelegramCommandHandler');

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
    this.telegramCommands = null;
    
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
    this._pausedByUser = false;

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

    // Post-reconnect cooldown: timestamp-based, RESETS (never compounds) on each reconnect
    this._reconnectCooldownUntil = null;
    this._reconnectCooldownTimer = null;
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
      maxContracts: parseInt(process.env.MAX_CONTRACTS || '10'),
      profitTargetR: process.env.PROFIT_TARGET_R,
      dailyLossLimit: process.env.DAILY_LOSS_LIMIT,
      weeklyLossLimit: process.env.WEEKLY_LOSS_LIMIT,
      maxConsecutiveLosses: process.env.MAX_CONSECUTIVE_LOSSES,
      maxDrawdownPercent: process.env.MAX_DRAWDOWN_PERCENT,
      dailyProfitTarget: process.env.DAILY_PROFIT_TARGET,
      profitTiers: process.env.DAILY_PROFIT_TIERS || '',
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
      beActivationR: parseFloat(process.env.BE_ACTIVATION_R) || 1.2,
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
   * Authenticate with retry loop to prevent app crashes
   * @private
   */
  async _authenticateWithRetry(maxRetries = 5) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[Auth] Authentication attempt ${attempt}/${maxRetries}`);
        await this.auth.authenticate();
        console.log('[Auth] ✓ Authentication successful');
        return; // Success - exit retry loop
      } catch (error) {
        console.error(`[Auth] ✗ Authentication attempt ${attempt} failed:`, error.message);
        
        if (attempt === maxRetries) {
          console.error('[Auth] ✗ All authentication attempts failed - waiting 5 minutes before final retry...');
          await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000)); // 5 minutes
          // One final attempt
          try {
            await this.auth.authenticate();
            console.log('[Auth] ✓ Final authentication successful');
            return;
          } catch (finalError) {
            console.error('[Auth] ✗ Final authentication failed - keeping process alive, will retry later...');
            // Don't throw - let the process continue and retry later
            return;
          }
        }
        
        // Wait before next attempt (exponential backoff)
        const delay = Math.min(30000 * Math.pow(2, attempt - 1), 120000); // 30s, 60s, 120s max
        console.log(`[Auth] Waiting ${delay/1000}s before next attempt...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  /**
   * Initialize core components (auth, client, account, contract)
   * Used for both full trading mode and CLI commands
   * @returns {Object} Account and contract info
   */
  async initializeCore() {
    // 1. Authenticate with retry loop
    this.auth = new TradovateAuth(this.config);
    await this._authenticateWithRetry();

    // 2. Initialize API client
    this.client = new TradovateClient(this.auth);

    // 3. Get account
    const accounts = await this.client.getAccounts();
    if (accounts.length === 0) {
      throw new Error('No accounts found');
    }

    // Select account: prefer TRADOVATE_ACCOUNT_NAME or TRADOVATE_ACCOUNT_ID from .env
    const preferredName = process.env.TRADOVATE_ACCOUNT_NAME;
    const preferredId = process.env.TRADOVATE_ACCOUNT_ID ? parseInt(process.env.TRADOVATE_ACCOUNT_ID) : null;
    if (preferredName) {
      this.account = accounts.find(a => a.name === preferredName);
      if (!this.account) {
        const available = accounts.map(a => `${a.name} (ID: ${a.id})`).join(', ');
        throw new Error(`Account "${preferredName}" not found. Available: ${available}`);
      }
    } else if (preferredId) {
      this.account = accounts.find(a => a.id === preferredId);
      if (!this.account) {
        const available = accounts.map(a => `${a.name} (ID: ${a.id})`).join(', ');
        throw new Error(`Account ID ${preferredId} not found. Available: ${available}`);
      }
    } else {
      const active = accounts.filter(a => a.active !== false);
      this.account = active[0] || accounts[0];
      if (accounts.length > 1) {
        const available = accounts.map(a => `${a.name} (ID: ${a.id})`).join(', ');
        logger.warn(`⚠️ Multiple accounts found: ${available}`);
        logger.warn(`⚠️ Using "${this.account.name}" — set TRADOVATE_ACCOUNT_NAME in .env to choose explicitly`);
      }
    }

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

      // Startup sync: cancel orphaned orders and detect leftover positions
      await this._startupSync();

      // Load initial data: fetches prior day → sets prior day levels → fetches today → warms EMAs
      // _loadInitialData handles VWAP engine reset internally (after feeding prior day bars)
      await this._loadInitialData();

      this.isRunning = true;
      logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.success('✅ Bot is now LIVE and monitoring the market');
      logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // Send Telegram notification
      await this.notifications.botStarted();

      // Start Telegram command handler
      this.telegramCommands = new TelegramCommandHandler(this, this.notifications);
      this.telegramCommands.start();

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
      // Telegram notification — context-aware for profit vs loss halts
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
        `${emoji} <b>${title}</b>\n` +
        `${data.message}\n\n` +
        `Daily P&L: ${pnlStr}\n` +
        `${details}\n` +
        `Trades today: ${s.tradesToday}\n\n` +
        `<i>Bot will resume tomorrow 6:30 AM PST.</i>`
      ).catch(() => {});
      // Send daily report (also prevents duplicate EOD report via _dailyReportSentToday flag)
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
        emaxUseZLEMA: process.env.EMAX_USE_ZLEMA === 'true',
        // PB 5m parameters
        pbMinImpulse: parseFloat(process.env.PB_MIN_IMPULSE) || 15,
        pbMaxImpulse: parseFloat(process.env.PB_MAX_IMPULSE) || Infinity,
        pbMinImpBodyRatio: parseFloat(process.env.PB_MIN_IMP_BODY_RATIO) || 0.15,
        pbRetraceMin: parseFloat(process.env.PB_RETRACE_MIN) || 0.10,
        pbRetraceMax: parseFloat(process.env.PB_RETRACE_MAX) || 0.85,
        pbMaxTime: parseInt(process.env.PB_MAX_TIME) || 570,
        pbLookbackBars: parseInt(process.env.PB_LOOKBACK_BARS) || 1,
        // PB 3m sub-strategy
        pb3mEnabled: process.env.PB3M_ENABLED === 'true',
        pb3mMinImpulse: parseFloat(process.env.PB3M_MIN_IMPULSE) || 10,
        pb3mMaxImpulse: parseFloat(process.env.PB3M_MAX_IMPULSE) || 30,
        pb3mLookbackBars: parseInt(process.env.PB3M_LOOKBACK_BARS) || 1,
        pb3mMaxTime: parseInt(process.env.PB3M_MAX_TIME) || 570,
        pb3mRetraceMin: parseFloat(process.env.PB3M_RETRACE_MIN) || 0.10,
        pb3mRetraceMax: parseFloat(process.env.PB3M_RETRACE_MAX) || 0.85,
        pb3mMinImpBodyRatio: parseFloat(process.env.PB3M_MIN_IMP_BODY_RATIO) || 0.15,
        pb3mMaxStopPoints: parseInt(process.env.PB3M_MAX_STOP_POINTS) || 25,
        pb3mMinStopPoints: parseInt(process.env.PB3M_MIN_STOP_POINTS) || 3,
        pb3mMinTargetPoints: parseInt(process.env.PB3M_MIN_TARGET_POINTS) || 15,
        // PB 2m sub-strategy
        pb2mEnabled: process.env.PB2M_ENABLED === 'true',
        pb2mMinImpulse: parseFloat(process.env.PB2M_MIN_IMPULSE) || 8,
        pb2mMaxImpulse: parseFloat(process.env.PB2M_MAX_IMPULSE) || 25,
        pb2mLookbackBars: parseInt(process.env.PB2M_LOOKBACK_BARS) || 1,
        pb2mMaxTime: parseInt(process.env.PB2M_MAX_TIME) || 570,
        pb2mRetraceMin: parseFloat(process.env.PB2M_RETRACE_MIN) || 0.10,
        pb2mRetraceMax: parseFloat(process.env.PB2M_RETRACE_MAX) || 0.85,
        pb2mMinImpBodyRatio: parseFloat(process.env.PB2M_MIN_IMP_BODY_RATIO) || 0.15,
        pb2mMaxStopPoints: parseInt(process.env.PB2M_MAX_STOP_POINTS) || 20,
        pb2mMinStopPoints: parseInt(process.env.PB2M_MIN_STOP_POINTS) || 2,
        pb2mMinTargetPoints: parseInt(process.env.PB2M_MIN_TARGET_POINTS) || 10,
        // PB Entry Timing (V2.11 — always market, tick-triggered)
        pbEntryMode: 'immediate',
        pbTrendFilterEnabled: process.env.PB_TREND_FILTER === 'true',
        // Tick-triggered entry
        pbTickEntry: process.env.PB_TICK_ENTRY === 'true',
        pb3mTickEntry: process.env.PB3M_TICK_ENTRY === 'true',
        pb2mTickEntry: process.env.PB2M_TICK_ENTRY === 'true',
        // Post-trade cooldown
        cooldownBars: parseInt(process.env.COOLDOWN_BARS) || 6,
        // VR (VWAP Mean Reversion) parameters
        vrEnabled: process.env.VR_ENABLED !== 'false',
        vrMinTime: parseInt(process.env.VR_MIN_TIME) || 510,
        vrMaxTime: parseInt(process.env.VR_MAX_TIME) || 660,
        vrMinSigma: parseFloat(process.env.VR_MIN_SIGMA) || 1.3,
        vrEntrySigmaMax: parseFloat(process.env.VR_ENTRY_SIGMA_MAX) || 1.0,
        vrStopBeyondBand: parseFloat(process.env.VR_STOP_BEYOND_BAND) || 3,
        vrTargetMode: process.env.VR_TARGET_MODE || 'fixed',
        vrTargetR: parseFloat(process.env.VR_TARGET_R) || 4,
        vrMinBarVolRatio: parseFloat(process.env.VR_MIN_BAR_VOL_RATIO) || 0.8,
        vrMaxStopPoints: parseInt(process.env.VR_MAX_STOP_POINTS) || 20,
        vrMinStopPoints: parseInt(process.env.VR_MIN_STOP_POINTS) || 4,
        vrCooldownBars: parseInt(process.env.VR_COOLDOWN_BARS) || 10,
        // Shared parameters
        maxStopPoints: parseInt(process.env.MAX_STOP_POINTS) || 35,
        minStopPoints: parseInt(process.env.MIN_STOP_POINTS) || 5,
        stopBuffer: parseFloat(process.env.STOP_BUFFER) || 2,
        profitTargetR: parseFloat(process.env.PROFIT_TARGET_R) || 2.5,
        minTargetPoints: parseFloat(process.env.MIN_TARGET_POINTS) || 20,
        maxLossesPerDay: parseInt(process.env.MAX_LOSSES_PER_DAY) || 3,
        // Partial profit
        partialProfitEnabled: process.env.VR_PARTIAL_PROFIT_ENABLED === 'true',
        partialProfitR: parseFloat(process.env.VR_PARTIAL_PROFIT_R) || 2,
        moveStopToBE: process.env.MOVE_STOP_TO_BE === 'true',
        beActivationR: parseFloat(process.env.BE_ACTIVATION_R) || 1.2,
        // Confluence (0 = disabled per V2.9 frequency sweep)
        minConfluence: process.env.MIN_CONFLUENCE !== undefined ? parseInt(process.env.MIN_CONFLUENCE) : 0,
        volumeAvgPeriod: parseInt(process.env.VOLUME_AVG_PERIOD) || 20,
        momentumBars: parseInt(process.env.MOMENTUM_BARS) || 5,
        priorLevelTolerance: parseFloat(process.env.PRIOR_LEVEL_TOLERANCE) || 5,
        // Volume filter
        volumeFilterEnabled: process.env.VOLUME_FILTER_ENABLED === 'true',
        volumeFilterMin: parseFloat(process.env.VOLUME_FILTER_MIN) || 0.9,
        volumeFilterPeriod: parseInt(process.env.VOLUME_FILTER_PERIOD) || 20,
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
      const pbCutoff = parseInt(process.env.PB_MAX_TIME) || 570;
      const pbH = Math.floor(pbCutoff/60), pbM = pbCutoff%60;
      const retrMin = parseFloat(process.env.PB_RETRACE_MIN) || 0.10, retrMax = parseFloat(process.env.PB_RETRACE_MAX) || 0.85;
      logger.info(`  PB: impulse>=${process.env.PB_MIN_IMPULSE || 15}pt, retrace ${(retrMin*100).toFixed(0)}-${(retrMax*100).toFixed(0)}%, cutoff ${pbH}:${String(pbM).padStart(2,'0')} AM`);
      if (vrOn) {
        const vrTgt = process.env.VR_TARGET_MODE === 'fixed' ? `${process.env.VR_TARGET_R || 4}R` : 'VWAP';
        const vrStart = parseInt(process.env.VR_MIN_TIME) || 510;
        const vrEnd = parseInt(process.env.VR_MAX_TIME) || 660;
        const vsH = Math.floor(vrStart/60), vsM = vrStart%60;
        const veH = Math.floor(vrEnd/60), veM = vrEnd%60;
        logger.info(`  VR: VWAP mean reversion ±${process.env.VR_MIN_SIGMA || 1.5}σ, target=${vrTgt}, ${vsH}:${String(vsM).padStart(2,'0')}-${veH}:${String(veM).padStart(2,'0')} AM`);
      }
      logger.info(`  Confluence: min ${process.env.MIN_CONFLUENCE || 0} factors | Partial: 2R+BE`);
      logger.info(`  Stop: max ${process.env.MAX_STOP_POINTS || 35}pt | Target: ${process.env.PROFIT_TARGET_R || 2.5}R`);

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

    // Wire tick price getter for slippage guard (from DatabentoPriceProvider)
    this.signalHandler.setTickPriceGetter(() => {
      if (this.priceProvider && typeof this.priceProvider.getLastTickPrice === 'function') {
        return this.priceProvider.getLastTickPrice();
      }
      return null;
    });

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
      this._clearLimitEntryTimeout();
      this.signalHandler.clearPosition();
    });

    // When entry fill arrives, place OCO bracket with fill-adjusted prices
    // and send the entry notification with real prices.
    this.positionHandler.on('entryFilled', async (fillData) => {
      this._clearLimitEntryTimeout();
      this._clearFillWatchdog(); // WebSocket fill arrived — no need to poll REST
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

      // 4. Place OCO bracket NOW with fill-adjusted prices (not signal prices).
      //    This eliminates the race condition where modifyOrder failed on orders
      //    still in PendingNew state, leaving stop/target at wrong signal prices.
      const ocoParams = position._ocoParams;
      if (ocoParams) {
        // Attempt OCO placement with one retry. If both fail, emergency-close the position.
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

            const stopOrderId = oco.orderId;
            const targetOrderId = oco.ocoId;
            position.stopOrderId = stopOrderId;
            position.targetOrderId = targetOrderId;
            ocoPlaced = true;
            logger.success(`✓ OCO placed: stopOrderId=${stopOrderId}, targetOrderId=${targetOrderId}`);

            if (slippage !== 0) {
              logger.info(`✓ Bracket reflects fill adjustment (slippage: ${slippage >= 0 ? '+' : ''}${slippage.toFixed(2)}pt)`);
            }

            // Update trailing stop with the actual stopOrderId
            if (this.trailingStop) {
              this.trailingStop.updateStopOrderId(posId, stopOrderId);
            }
          } catch (err) {
            logger.error(`❌ OCO placement attempt ${attempt} failed: ${err.message}`);
          }
        }

        // EMERGENCY: If OCO could not be placed after retries, the position is NAKED.
        // Close it immediately to prevent unlimited losses.
        if (!ocoPlaced) {
          logger.error(`🚨 EMERGENCY: OCO placement failed after retries — closing naked position`);
          await this.notifications.send(
            `🚨 <b>EMERGENCY</b>\n` +
            `OCO bracket FAILED after fill. Closing naked position to prevent unlimited loss.`
          ).catch(() => {});
          try {
            await this.client.placeMarketOrder(
              ocoParams.accountId,
              this.contract.id,
              ocoParams.contracts,
              ocoParams.exitAction
            );
            logger.warn(`Emergency close executed`);
          } catch (closeErr) {
            logger.error(`❌ EMERGENCY CLOSE ALSO FAILED: ${closeErr.message} — MANUAL INTERVENTION REQUIRED`);
            await this.notifications.send(
              `🚨🚨 <b>CRITICAL</b>\n` +
              `OCO failed AND emergency close failed!\n` +
              `NAKED POSITION ON EXCHANGE — CLOSE MANUALLY NOW!`
            ).catch(() => {});
          }
        }
        delete position._ocoParams;
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

    // Layer 2: Post-fill risk check — emergency close if actual risk is too high
    this.positionHandler.on('postFillRiskExceeded', async (data) => {
      const { fillPrice, actualRisk, maxRisk, position } = data;
      logger.error(`🚨 POST-FILL RISK EXCEEDED: actual $${actualRisk.toFixed(2)} > 150% of max $${maxRisk}`);

      await this.notifications.send(
        `🚨 <b>POST-FILL RISK EXCEEDED</b>\n` +
        `Fill: $${fillPrice.toFixed(2)}\n` +
        `Actual risk: $${actualRisk.toFixed(2)} (max: $${maxRisk})\n` +
        `Emergency closing position...`
      ).catch(() => {});

      try {
        const closeAction = position.side === 'Buy' ? 'Sell' : 'Buy';
        const qty = position.quantity || 1;

        // Cancel any bracket orders first
        const orderIdsToCancel = [position.stopOrderId, position.targetOrderId].filter(Boolean);
        for (const oid of orderIdsToCancel) {
          try { await this.client.cancelOrder(oid); } catch (e) { /* may not exist yet */ }
        }

        // Close position
        await this.client.placeMarketOrder(
          this.account.id,
          this.contract.id,
          qty,
          closeAction
        );
        logger.warn(`✓ Emergency close executed (post-fill risk exceeded)`);
      } catch (closeErr) {
        logger.error(`❌ EMERGENCY CLOSE FAILED: ${closeErr.message} — MANUAL INTERVENTION REQUIRED`);
        await this.notifications.send(
          `🚨🚨 <b>CRITICAL</b>\n` +
          `Post-fill risk exceeded AND emergency close failed!\n` +
          `CLOSE MANUALLY NOW!`
        ).catch(() => {});
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

    // CRITICAL: Route props events — Tradovate sends fills/orders/positions wrapped in props.
    // Without this, fills can arrive ONLY via props and be missed entirely, leaving the bot
    // unaware that a limit order filled (same pattern as MultiInstrumentBot).
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

    // HIGH-4 FIX: Sync position state after order WebSocket reconnects
    this.orderWs.on('reconnected', async (data) => {
      // BUG-8 FIX: Re-sync user data after reconnect so WS delivers order/fill/position events.
      try {
        await new Promise((resolve) => {
          if (this.orderWs.isAuthorized) resolve();
          else { this.orderWs.once('authorized', resolve); setTimeout(resolve, 5000); }
        });
        this.orderWs.synchronize(this.account.id);
        logger.info('Order WebSocket re-synchronized after reconnect');
      } catch (syncErr) {
        logger.error(`Order WebSocket re-sync failed: ${syncErr.message}`);
      }

      if (data.requiresPositionSync) {
        logger.warn('Order WebSocket reconnected - syncing position state...');
        await this._syncPositionState();
      }
    });

    // HIGH-5 FIX: If WebSocket exhausts all reconnect attempts, halt trading.
    // Without this, the bot keeps placing orders via REST but never receives fill/order events.
    this.orderWs.on('maxReconnectAttemptsReached', async (data) => {
      logger.error(`🚨 CRITICAL: Order WebSocket exhausted all ${data.attempts} reconnect attempts — HALTING TRADING`);
      if (this.lossLimits) {
        this.lossLimits.halt('WEBSOCKET_DEAD', 'Order WebSocket connection lost — cannot receive fills or order updates');
      }
      await this.notifications.send(
        `🚨 <b>CRITICAL: ORDER WEBSOCKET DEAD</b>\n` +
        `All ${data.attempts} reconnect attempts exhausted.\n` +
        `⛔ TRADING HALTED — bot cannot receive fill/order events.\n` +
        `Manual intervention required — restart the bot.`
      ).catch(() => {});
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
    // Forward ticks to strategy for intra-bar evaluation
    this.priceProvider.on('tick', (tick) => {
      if (this.strategy && typeof this.strategy.onTick === 'function') {
        this.strategy.onTick(tick);
      }
    });
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
      const estimatedDroppedBars = Math.floor((data.downtimeMs || 0) / 60000);
      this.notifications.send(
        `✅ <b>DATABENTO RECONNECTED</b>\n` +
        `Downtime: ${downtimeSec}s (${data.attempts} attempts)\n` +
        `Est. bars dropped: ~${estimatedDroppedBars}\n` +
        `Gap recovery: ${recoveredBars} bars recovered`
      ).catch(() => {});

      // Trigger post-reconnect cooldown (evaluates threshold internally)
      this._startReconnectCooldown(estimatedDroppedBars, data.downtimeMs || 0);
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
   * Start post-reconnect cooldown — RESETS timer on each call (never compounds).
   * Suppresses new signal execution for N minutes while indicators rebuild on fresh data.
   * Bars, ticks, and existing position management continue normally.
   * @param {number} droppedBars - Estimated number of bars dropped during the disconnect
   * @param {number} downtimeMs - Duration of the disconnect in milliseconds
   * @private
   */
  _startReconnectCooldown(droppedBars, downtimeMs = 0) {
    const cooldownMins = parseInt(process.env.POST_RECONNECT_COOLDOWN_MINS) || 10;
    const minDropped = parseInt(process.env.POST_RECONNECT_MIN_DROPPED_BARS) || 3;

    // Only apply cooldown if enough bars were dropped to affect indicator reliability
    if (droppedBars < minDropped) {
      logger.info(`[RECONNECT] ${droppedBars} bar(s) dropped (< ${minDropped} threshold) — no cooldown needed`);
      return;
    }

    // RESET (not add) — always cooldownMins from NOW, regardless of any existing cooldown
    const cooldownMs = cooldownMins * 60 * 1000;
    this._reconnectCooldownUntil = Date.now() + cooldownMs;

    // Clear any existing expiry timer to prevent stale expiry logs
    if (this._reconnectCooldownTimer) {
      clearTimeout(this._reconnectCooldownTimer);
      this._reconnectCooldownTimer = null;
    }

    const downtimeSec = (downtimeMs / 1000).toFixed(1);
    logger.warn(`[RECONNECT COOLDOWN] 🕐 ${cooldownMins}min cooldown started — ${droppedBars} bars dropped, ${downtimeSec}s downtime`);

    // Telegram notification: cooldown started
    if (this.notifications) {
      this.notifications.send(
        `🕐 <b>RECONNECT COOLDOWN</b>\n` +
        `Signals suppressed for ${cooldownMins} minutes.\n` +
        `Bars dropped: ${droppedBars} | Downtime: ${downtimeSec}s\n` +
        `Indicators rebuilding on fresh data.\n` +
        `Bars, ticks, and existing positions unaffected.`
      ).catch(() => {});
    }

    // Schedule expiry log + Telegram notification
    this._reconnectCooldownTimer = setTimeout(() => {
      this._reconnectCooldownUntil = null;
      this._reconnectCooldownTimer = null;
      logger.info(`[RECONNECT COOLDOWN] ✅ Cooldown expired — ready for new signals`);
      if (this.notifications) {
        this.notifications.send(
          `✅ <b>COOLDOWN EXPIRED</b>\n` +
          `Post-reconnect cooldown complete. Signals re-enabled.`
        ).catch(() => {});
      }
    }, cooldownMs);
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
      const botPosition = this.signalHandler.getPosition();
      const botHasPosition = botPosition !== null;
      
      if (botHasPosition && !hasOpenPosition) {
        // ── GUARD: Don't clear if entry order is still pending ──
        const hasPendingEntry = botPosition && !botPosition.stopOrderId && botPosition._isLimitEntry;
        if (hasPendingEntry) {
          logger.info('Position sync: Bot has pending limit entry — skipping clear');
          return;
        }

        // Bot thinks we have position but exchange doesn't - clear local state
        logger.warn('Position sync: Bot had position but exchange does not. Clearing local state.');
        const entryOrderId = botPosition?.orderId;
        this.signalHandler.clearPosition();
        this.positionHandler.resetFillAccumulators();
        this.strategy.setPosition(null);
        if (entryOrderId) {
          if (this.profitManager) this.profitManager.closePosition(entryOrderId);
          if (this.trailingStop) this.trailingStop.removeTrail(entryOrderId);
        }
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
        const botPosition = this.signalHandler.getPosition();
        const botHasPosition = botPosition !== null;

        if (botHasPosition && !hasOpenPosition) {
          // ── GUARD: Don't clear if entry order is still pending ──
          const hasPendingEntry = botPosition && !botPosition.stopOrderId && botPosition._isLimitEntry;
          if (hasPendingEntry) {
            logger.info(`[PositionSync] Bot has pending limit entry (orderId=${botPosition.orderId}) — skipping clear`);
            return;
          }

          // Also check for working entry orders on the exchange as a safety net
          try {
            const workingOrders = await this.client.getWorkingOrders(this.account.id);
            const myEntryOrders = workingOrders.filter(o =>
              o.contractId === this.contract?.id &&
              o.action === botPosition.side &&
              (o.ordType === 'Limit' || o.ordType === 'Market')
            );
            if (myEntryOrders.length > 0) {
              logger.info(`[PositionSync] ${myEntryOrders.length} working entry order(s) found — skipping clear`);
              return;
            }
          } catch (ordErr) {
            logger.debug(`[PositionSync] Working orders check failed: ${ordErr.message}`);
          }

          logger.warn('[PositionSync] MISMATCH: Bot has position but exchange does not — clearing local state');
          const pos = botPosition;
          const entryOrderId = pos?.orderId;
          this.signalHandler.clearPosition();
          this.positionHandler.resetFillAccumulators();
          this.strategy.setPosition(null);
          if (entryOrderId) {
            this.profitManager.closePosition(entryOrderId);
            this.trailingStop.removeTrail(entryOrderId);
          }
          await this.notifications.send(
            `⚠️ <b>POSITION SYNC FIX</b>\nBot had stale position — cleared.\nNew signals are now unblocked.`
          ).catch(() => {});
        } else if (!botHasPosition && hasOpenPosition) {
          // ── Exchange has position bot doesn't track — re-adopt ──
          const pos = positions[0];
          const side = pos.netPos > 0 ? 'Buy' : 'Sell';
          const qty = Math.abs(pos.netPos);
          const entryPrice = pos.netPrice;

          logger.error(`[PositionSync] Exchange has position (${pos.netPos} @ ${pos.netPrice}) bot doesn't track — re-adopting`);

          let stopOrder = null;
          let targetOrder = null;
          try {
            const workingOrders = await this.client.getWorkingOrders(this.account.id);
            const myOrders = workingOrders.filter(o => o.contractId === this.contract?.id);
            const exitSide = side === 'Buy' ? 'Sell' : 'Buy';
            for (const o of myOrders) {
              if (o.action === exitSide && (o.ordType === 'Stop' || o.ordType === 'StopLimit')) {
                stopOrder = o;
              } else if (o.action === exitSide && (o.ordType === 'Limit')) {
                targetOrder = o;
              }
            }
          } catch (ordErr) {
            logger.warn(`[PositionSync] Could not fetch working orders for re-adopt: ${ordErr.message}`);
          }

          const stopPrice = stopOrder ? (stopOrder.stopPrice || stopOrder.price) : null;
          const targetPrice = targetOrder ? targetOrder.price : null;

          const { CONTRACTS } = require('../utils/constants');
          const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
          const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
          const risk = stopPrice ? Math.abs(entryPrice - stopPrice) * qty * pv : 0;

          const adoptedPosition = {
            side,
            quantity: qty,
            entryPrice,
            stopLoss: stopPrice,
            target: targetPrice,
            risk,
            orderId: null,
            stopOrderId: stopOrder ? stopOrder.id : null,
            targetOrderId: targetOrder ? targetOrder.id : null,
            entryTime: new Date(),
            strategyName: 'adopted',
            _adopted: true,
          };

          this.signalHandler.currentPosition = adoptedPosition;
          this.strategy.setPosition(adoptedPosition);
          this.positionHandler.resetFillAccumulators(); // BUG-6 FIX: Clean slate for re-adopted position

          if (this.config.trailingStopEnabled && stopOrder) {
            this.trailingStop.initializeTrail({
              id: stopOrder.id,
              ...adoptedPosition,
              atr: this.strategy.atr || 10,
              stopOrderId: stopOrder.id
            });
          }

          this.profitManager.initializePosition({
            id: stopOrder?.id || 'adopted',
            ...adoptedPosition
          });

          const stopInfo = stopPrice ? `stop $${stopPrice.toFixed(2)}` : 'NO STOP';
          const targetInfo = targetPrice ? `target $${targetPrice.toFixed(2)}` : 'no target';
          logger.success(`[PositionSync] ✓ Re-adopted: ${side} ${qty} @ ${entryPrice} | ${stopInfo} | ${targetInfo}`);

          await this.notifications.send(
            `� <b>POSITION RE-ADOPTED</b>\n` +
            `${side} ${qty} @ ${entryPrice}\n` +
            `${stopInfo} | ${targetInfo}\n` +
            `Bot is now tracking this position.`
          ).catch(() => {});

          if (!stopOrder) {
            logger.error(`[PositionSync] ⚠️ Re-adopted position has NO stop order!`);
            await this.notifications.send(
              `🚨 <b>RE-ADOPTED — NO STOP!</b>\n` +
              `Position ${side} ${qty} @ ${entryPrice} has no stop.\nManual intervention needed!`
            ).catch(() => {});
          }
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
  async _startupSync() {
    try {
      const accountId = this.account.id;
      const contractId = this.contract?.id;
      if (!contractId) return;

      // 1. Check for open positions FIRST — before touching any orders
      const positions = await this.client.getOpenPositions(accountId);
      const myPositions = positions.filter(p => p.contractId === contractId);

      if (myPositions.length > 0) {
        // ── POSITION EXISTS: re-adopt it, keep bracket orders intact ──
        const pos = myPositions[0];
        const side = pos.netPos > 0 ? 'Buy' : 'Sell';
        const qty = Math.abs(pos.netPos);
        const entryPrice = pos.netPrice;

        logger.warn(`[StartupSync] Found existing position: ${side} ${qty} @ ${entryPrice} — re-adopting`);

        // Find bracket orders (stop + target) for this contract
        const workingOrders = await this.client.getWorkingOrders(accountId);
        const myOrders = workingOrders.filter(o => o.contractId === contractId);

        const exitSide = side === 'Buy' ? 'Sell' : 'Buy';
        let stopOrder = null;
        let targetOrder = null;
        for (const o of myOrders) {
          if (o.action === exitSide && (o.ordType === 'Stop' || o.ordType === 'StopLimit')) {
            stopOrder = o;
          } else if (o.action === exitSide && (o.ordType === 'Limit')) {
            targetOrder = o;
          }
        }

        const stopPrice = stopOrder ? (stopOrder.stopPrice || stopOrder.price) : null;
        const targetPrice = targetOrder ? targetOrder.price : null;

        const { CONTRACTS } = require('../utils/constants');
        const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
        const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
        const risk = stopPrice ? Math.abs(entryPrice - stopPrice) * qty * pv : 0;

        const adoptedPosition = {
          side,
          quantity: qty,
          entryPrice,
          stopLoss: stopPrice,
          target: targetPrice,
          risk,
          orderId: null,
          stopOrderId: stopOrder ? stopOrder.id : null,
          targetOrderId: targetOrder ? targetOrder.id : null,
          entryTime: new Date(),
          strategyName: 'adopted',
          _adopted: true,
        };

        this.signalHandler.currentPosition = adoptedPosition;
        this.strategy.setPosition(adoptedPosition);

        if (this.config.trailingStopEnabled && stopOrder) {
          this.trailingStop.initializeTrail({
            id: stopOrder.id,
            ...adoptedPosition,
            atr: this.strategy.atr || 10,
            stopOrderId: stopOrder.id
          });
        }

        this.profitManager.initializePosition({
          id: stopOrder?.id || 'adopted',
          ...adoptedPosition
        });

        const stopInfo = stopPrice ? `stop $${stopPrice.toFixed(2)}` : 'NO STOP ⚠️';
        const targetInfo = targetPrice ? `target $${targetPrice.toFixed(2)}` : 'no target';
        logger.success(`[StartupSync] ✓ Re-adopted position: ${side} ${qty} @ ${entryPrice} | ${stopInfo} | ${targetInfo}`);

        await this.notifications.send(
          `🔄 <b>STARTUP SYNC</b>\n` +
          `Re-adopted position: ${side} ${qty} @ ${entryPrice}\n` +
          `${stopInfo} | ${targetInfo}\n` +
          `Bracket orders preserved.`
        ).catch(() => {});

        if (!stopOrder) {
          logger.error(`[StartupSync] ⚠️ DANGER: Position has no stop order!`);
          await this.notifications.send(
            `🚨 <b>STARTUP SYNC — NO STOP!</b>\n` +
            `Position ${side} ${qty} @ ${entryPrice} has NO stop order.\n` +
            `Manual intervention needed!`
          ).catch(() => {});
        }

      } else {
        // ── NO POSITION: safe to cancel any orphaned orders/strategies ──
        let cancelledCount = 0;

        try {
          const strategies = await this.client.getOrderStrategies(accountId);
          if (Array.isArray(strategies)) {
            const activeStrategies = strategies.filter(s =>
              s.status === 'ActiveStrategy' || s.status === 'ExecutionSuspended'
            );
            for (const strat of activeStrategies) {
              try {
                await this.client.interruptOrderStrategy(strat.id);
                logger.info(`[StartupSync] Interrupted order strategy ${strat.id}`);
                cancelledCount++;
              } catch (err) {
                logger.debug(`[StartupSync] Interrupt strategy ${strat.id}: ${err.message}`);
              }
            }
          }
        } catch (err) {
          logger.debug(`[StartupSync] Order strategies check: ${err.message}`);
        }

        const workingOrders = await this.client.getWorkingOrders(accountId);
        const myOrders = workingOrders.filter(o => o.contractId === contractId);
        if (myOrders.length > 0) {
          logger.warn(`[StartupSync] Cancelling ${myOrders.length} orphaned order(s) from previous session`);
          for (const order of myOrders) {
            try {
              await this.client.cancelOrder(order.id);
              logger.info(`[StartupSync] Cancelled order ${order.id}`);
              cancelledCount++;
            } catch (cancelErr) {
              logger.debug(`[StartupSync] Cancel order ${order.id}: ${cancelErr.message}`);
            }
          }
        }

        if (cancelledCount > 0) {
          logger.info(`[StartupSync] ✓ ${cancelledCount} orphaned order(s)/strategies cancelled, no open position — clean start`);
        } else {
          logger.info(`[StartupSync] ✓ No orphaned orders or positions — clean start`);
        }
      }
    } catch (err) {
      logger.warn(`[StartupSync] Failed: ${err.message}`);
    }
  }

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
          // Reset signalFired and clear stale armed setups from replay.
          // A bar-close signal during replay sets signalFired=true and arms tick
          // entries that will never trigger (price has moved on). Clear everything
          // so the first live bar starts with a clean slate.
          if (this.strategy.signalFired && !this.strategy.position) {
            this.strategy.signalFired = false;
          }
          if (typeof this.strategy._disarmAll === 'function') {
            this.strategy._disarmAll();
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
    // CRITICAL: Skip if entry hasn't filled yet (no stopOrderId = OCO not placed).
    // Without this guard, ProfitManager treats the phantom position as real and
    // sends bogus "STOP MOVED" notifications for trades that don't exist on exchange.
    if (this.strategy.position && this.profitManager && this.strategy.position.stopOrderId) {
      const pos = this.strategy.position;
      // CRITICAL: Must match the ID used in SignalHandler.initializePosition()
      // SignalHandler passes { id: order.orderId, ...currentPosition }
      const posId = pos.orderId || pos.id || pos.clientId || 'active';
      const isLong = pos.side === 'Buy';
      const beCheckPrice = isLong ? bar.high : bar.low;
      const { actions } = this.profitManager.update(posId, beCheckPrice, bar);
      for (const action of actions) {
        if (action.type === 'MOVE_STOP') {
          // HIGH-4 FIX: Await the modifyOrder call, retry once, revert + alert on failure.
          const oldStop = pos.stopLoss;
          this._modifyStopWithRetry(pos, action.newStop, action.reason, oldStop);
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
   * HIGH-4 FIX: Modify stop order with retry, revert on failure, alert.
   * Called from _onBar for BE stop moves and profit-lock moves.
   * Runs async but handles its own errors — does NOT block bar processing.
   * @private
   */
  async _modifyStopWithRetry(pos, newStop, reason, oldStop) {
    // Optimistically update internal state so exit reason detection uses the new stop
    pos.stopLoss = newStop;
    pos.breakEvenMoved = true;
    const shPos = this.signalHandler?.getPosition();
    if (shPos) {
      shPos.stopLoss = newStop;
      shPos.breakEvenMoved = true;
    }

    logger.info(`🔒 BE Stop → requesting $${newStop.toFixed(2)} (${reason})...`);

    let success = false;
    for (let attempt = 1; attempt <= 2 && !success; attempt++) {
      try {
        if (attempt > 1) {
          logger.warn(`Retrying stop modification (attempt ${attempt})...`);
          await new Promise(r => setTimeout(r, 1000));
        }
        await this.client.modifyOrder(pos.stopOrderId, {
          orderType: 'Stop',
          stopPrice: newStop,
          orderQty: pos.quantity || 1,
        });

        // Verify the modification actually took effect on the exchange.
        // Tradovate can return HTTP 200 but silently keep the old stop price.
        await new Promise(r => setTimeout(r, 300));
        try {
          const order = await this.client.getOrder(pos.stopOrderId);
          if (order && order.ordStatus === 'Working') {
            const exchangeStop = order.stopPrice ?? order.price;
            if (exchangeStop !== undefined && Math.abs(exchangeStop - newStop) > 0.5) {
              logger.error(`⚠️ Stop modification SILENT REJECT: requested $${newStop.toFixed(2)} but exchange has $${exchangeStop.toFixed(2)}`);
              continue; // retry
            }
          } else if (order && (order.ordStatus === 'Filled' || order.ordStatus === 'Cancelled')) {
            logger.warn(`Stop order ${pos.stopOrderId} is ${order.ordStatus} — position may have closed during modification`);
            return; // position gone, nothing to revert
          }
        } catch (verifyErr) {
          logger.warn(`Could not verify stop modification: ${verifyErr.message} — assuming success`);
        }

        success = true;
        logger.success(`✓ Stop order ${pos.stopOrderId} modified to $${newStop.toFixed(2)} (verified)`);
      } catch (err) {
        logger.error(`❌ Stop modification attempt ${attempt}/2 failed: ${err.message}`);
      }
    }

    if (success) {
      this.notifications.send(
        `🔒 <b>STOP MOVED</b>\n` +
        `${pos.side} @ $${pos.entryPrice?.toFixed(2) || '?'}\n` +
        `Stop: $${newStop.toFixed(2)} (${reason})`
      ).catch(() => {});
    } else {
      // REVERT internal state — exchange stop is still at oldStop
      logger.error(`🚨 STOP MODIFICATION FAILED after 2 attempts — reverting internal stop to $${oldStop.toFixed(2)}`);
      pos.stopLoss = oldStop;
      pos.breakEvenMoved = false;
      if (shPos) {
        shPos.stopLoss = oldStop;
        shPos.breakEvenMoved = false;
      }

      await this.notifications.send(
        `🚨 <b>STOP MOVE FAILED</b>\n` +
        `Could not move stop to $${newStop.toFixed(2)} (${reason})\n` +
        `Stop remains at $${oldStop.toFixed(2)}\n` +
        `Monitor position manually!`
      ).catch(() => {});
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

    // User pause check
    if (this._pausedByUser) {
      logger.warn('Signal blocked: Trading paused by user');
      if (this.strategy) this.strategy.onSignalRejected();
      return;
    }

    // Post-reconnect cooldown: block signals while indicators rebuild on fresh data
    if (this._reconnectCooldownUntil && Date.now() < this._reconnectCooldownUntil) {
      const remainMin = ((this._reconnectCooldownUntil - Date.now()) / 60000).toFixed(1);
      logger.warn(`Signal blocked: post-reconnect cooldown (${remainMin}min remaining)`);
      if (this.strategy) this.strategy.onSignalRejected();
      return;
    }

    // Block Thursday trading (0W/5L = -$255 in 3-month backtest)
    if (process.env.DISABLE_THURSDAY === 'true') {
      const pst = this._getPSTTime();
      if (pst.dayOfWeek === 4) { // Thursday
        logger.warn(`Signal blocked: Thursday trading disabled (DISABLE_THURSDAY=true)`);
        if (this.strategy) this.strategy.onSignalRejected();
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
      if (this.strategy) this.strategy.onSignalRejected();
      return;
    }

    // Log signal with strategy name and confluence score
    if (signal.strategy && signal.confluenceScore !== undefined) {
      logger.info(`📊 ${signal.strategy} signal: ${signal.type.toUpperCase()} | Confluence: ${signal.confluenceScore}`);
    }

    // CRITICAL-2 FIX: Reset partial fill accumulators before placing a new entry order
    this.positionHandler.resetFillAccumulators();

    const result = await this.signalHandler.handleSignal(signal);

    // NOTE: onSignalRejected() is already called by SignalHandler.handleSignal() in its
    // finally block when no position was opened. Do NOT call it again here — double-calling
    // causes _tradeCountToday to be decremented twice, drifting trade numbers down all day.

    // Start limit entry timeout if a limit order was placed AND not already filled.
    // CRITICAL: The fill can arrive via WebSocket props routing DURING the await on
    // handleSignal (specifically during placeLimitOrder). If it did, the entryFilled
    // handler already placed the OCO and set stopOrderId. Starting a timeout now
    // would nuke a live, properly-bracketed position 5 minutes later.
    if (result && result.executed && signal.orderType === 'Limit') {
      const pos = this.signalHandler.getPosition();
      if (pos && pos._isLimitEntry && pos.orderId) {
        if (pos.stopOrderId) {
          logger.info(`Limit order already filled & OCO placed — skipping timeout`);
        } else {
          this._startLimitEntryTimeout(pos.orderId, 5 * 60 * 1000); // 5 minutes
        }
      }
    }

    // FILL WATCHDOG: For market orders (and limit orders that may have filled instantly),
    // start a watchdog that polls the REST API if the WebSocket fill doesn't arrive.
    // This catches the case where the exchange fills the order but the WebSocket
    // never delivers the fill notification — leaving the position NAKED with no OCO.
    if (result && result.executed) {
      const pos = this.signalHandler.getPosition();
      if (pos && pos.orderId && !pos.stopOrderId) {
        this._startFillWatchdog(pos.orderId);
      }
    }
  }

  /**
   * Handle fill notification
   * @private
   */
  async _onFill(fill) {
    // CRITICAL-3 FIX: Hardened fill deduplication (mirrors InstrumentRunner).
    // Tradovate sends fills via BOTH 'fill' event and 'props' event.
    // Dedup on fill.id (unique per fill), NOT fill.orderId (shared across partials).
    if (!this._processedFillIds) this._processedFillIds = new Set();
    const fillId = fill.id;
    const compositeKey = `${fill.orderId || ''}_${fill.price || ''}_${fill.qty || fill.quantity || ''}_${fill.timestamp || ''}`;
    const dedupKey = fillId ? String(fillId) : compositeKey;

    if (dedupKey && this._processedFillIds.has(dedupKey)) {
      logger.debug(`Fill dedup: skipping already-processed fill (key=${dedupKey})`);
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
        // Reset daily loss limits, profit tracking, and clear daily-scoped halts.
        // Without this, a halt from yesterday would leave strategy.isActive=false permanently.
        if (this.lossLimits) {
          const result = this.lossLimits.resetDaily();
          if (result.wasHalted && this.strategy) {
            this.strategy.isActive = true;
          }
        }
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
            const eodOrder = await this.client.placeMarketOrder(
              this.account.id,
              this.contract.id,
              pos.quantity,
              closeAction
            );
            logger.success('✓ EOD position closed');

            // HIGH-2 FIX: Fetch fill price and record in PerformanceTracker + LossLimits
            let exitPrice = null;
            let eodPnl = 0;
            const eodOrderId = eodOrder?.orderId;
            try {
              if (eodOrderId) {
                await new Promise(r => setTimeout(r, 1500));
                const fills = await this.client.getFillsByOrder(eodOrderId);
                if (Array.isArray(fills) && fills.length > 0) {
                  exitPrice = fills[0].price;
                }
              }
            } catch (fillErr) {
              logger.warn(`EOD: Could not get fill price: ${fillErr.message}`);
            }

            if (exitPrice !== null && pos.entryPrice) {
              const { CONTRACTS } = require('../utils/constants');
              const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
              const pv = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue;
              const isLong = pos.side === 'Buy';
              eodPnl = isLong
                ? (exitPrice - pos.entryPrice) * (pos.quantity || 1) * pv
                : (pos.entryPrice - exitPrice) * (pos.quantity || 1) * pv;

              if (this.lossLimits) {
                this.lossLimits.recordTrade(eodPnl, { symbol: this.contract?.name || 'MNQ', quantity: pos.quantity || 1 });
              }
              if (this.performance) {
                this.performance.recordTrade({
                  symbol: this.contract?.name || 'MNQ',
                  side: pos.side,
                  quantity: pos.quantity || 1,
                  entryPrice: pos.entryPrice,
                  exitPrice,
                  stopLoss: pos.stopLoss,
                  target: pos.target,
                  pnl: eodPnl,
                  exitReason: 'EOD Close'
                });
              }
            }

            // Step 3: Clean up local state so next day isn't blocked
            const entryOrderId = pos.orderId;
            this.strategy.setPosition(null);
            this.signalHandler.clearPosition();
            this.positionHandler.resetFillAccumulators(); // BUG-2 FIX: Prevent stale accumulators
            if (entryOrderId) {
              this.profitManager.closePosition(entryOrderId);
              this.trailingStop.removeTrail(entryOrderId);
            }

            const pnlStr = exitPrice !== null ? ` | P&L: ${eodPnl >= 0 ? '+' : ''}$${eodPnl.toFixed(2)}` : '';
            const exitStr = exitPrice !== null ? `@ $${exitPrice.toFixed(2)}` : '@ market';
            await this.notifications.send(`⏰ EOD close: ${closeAction} ${pos.quantity} ${exitStr}${pnlStr}`).catch(() => {});
          } catch (err) {
            logger.error(`EOD close failed: ${err.message}`);
            await this.notifications.error(`EOD close failed: ${err.message}`).catch(() => {});
            // Even on error, clean up local state to prevent blocking next day
            this.strategy.setPosition(null);
            this.signalHandler.clearPosition();
            this.positionHandler.resetFillAccumulators(); // BUG-2 FIX: error path
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

  // ── Limit Entry Timeout ──

  _startLimitEntryTimeout(orderId, timeoutMs) {
    this._clearLimitEntryTimeout();
    logger.info(`⏱ Limit entry timeout: cancel orderId=${orderId} in ${(timeoutMs / 1000).toFixed(0)}s if unfilled`);
    this._limitEntryTimer = setTimeout(async () => {
      this._limitEntryTimer = null;
      try {
        logger.warn(`⏰ Limit entry timeout — cancelling orderId=${orderId}`);
        await this.client.cancelOrder(orderId);
        this.signalHandler.clearPosition();
        if (this.strategy) {
          this.strategy.setPosition(null);
          this.strategy.onSignalRejected();
        }
        // Clean up ProfitManager + TrailingStop for the phantom position
        if (this.profitManager) this.profitManager.closePosition(orderId);
        if (this.trailingStop) this.trailingStop.removeTrail(orderId);
        logger.info(`✓ Limit entry cancelled, ready for new signals`);
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

  // ════════════════════════════════════════════════════════════════════
  //  FILL WATCHDOG: Detects when a market order was filled on the
  //  exchange but the WebSocket fill notification was never delivered.
  // ════════════════════════════════════════════════════════════════════

  _startFillWatchdog(orderId) {
    this._clearFillWatchdog();
    this._fillWatchdogOrderId = orderId;
    logger.info(`⏱ Fill watchdog: checking orderId=${orderId} in 5s if no WebSocket fill`);
    this._fillWatchdogTimer = setTimeout(async () => {
      this._fillWatchdogTimer = null;
      const pos = this.signalHandler.getPosition();
      if (!pos || pos.stopOrderId) return;
      if (pos.orderId !== orderId) return;

      logger.warn(`⚠️ FILL WATCHDOG: No WebSocket fill received for orderId=${orderId} after 5s — polling REST API`);
      try {
        const fills = await this.client.getFillsByOrder(orderId);
        if (Array.isArray(fills) && fills.length > 0) {
          const fill = fills[0];
          logger.warn(`⚠️ FILL WATCHDOG: Found fill via REST: ${fill.action} ${fill.qty || 1} @ ${fill.price} — injecting into handleFill`);
          await this.notifications.send(
            `⚠️ <b>FILL WATCHDOG</b>\nWebSocket missed fill for order ${orderId}\nRecovered via REST: ${fill.action} ${fill.qty || 1} @ ${fill.price}\nPlacing OCO bracket now...`
          ).catch(() => {});
          await this._onFill(fill);
        } else {
          try {
            const order = await this.client.request('GET', `/order/item?id=${orderId}`);
            if (order && order.ordStatus === 'Rejected') {
              logger.error(`🚨 FILL WATCHDOG: Order ${orderId} was REJECTED — clearing position`);
              this.signalHandler.clearPosition();
              this.strategy.setPosition(null);
              await this.notifications.send(
                `🚨 <b>ORDER REJECTED</b>\nOrder ${orderId} rejected: ${order.rejectReason || order.text || 'unknown'}\nPosition state cleared.`
              ).catch(() => {});
            } else {
              logger.warn(`⚠️ FILL WATCHDOG: No fills, order status=${order?.ordStatus || 'unknown'} — retry in 5s`);
              this._fillWatchdogTimer = setTimeout(async () => {
                this._fillWatchdogTimer = null;
                const pos2 = this.signalHandler.getPosition();
                if (!pos2 || pos2.stopOrderId || pos2.orderId !== orderId) return;
                logger.error(`🚨 FILL WATCHDOG: Still no fill after 10s — emergency close`);
                await this.notifications.send(
                  `🚨 <b>FILL WATCHDOG TIMEOUT</b>\nNo fill for order ${orderId} after 10s.\nEmergency closing any exchange position...`
                ).catch(() => {});
                try {
                  const positions = await this.client.getOpenPositions(this.account.id);
                  const myPos = positions.find(p => p.contractId === this.contract?.id);
                  if (myPos && myPos.netPos !== 0) {
                    await this.client.liquidatePosition(this.account.id, this.contract.id, myPos.netPos);
                    logger.error(`🚨 FILL WATCHDOG: Liquidated naked exchange position`);
                  }
                } catch (liqErr) {
                  logger.error(`🚨 FILL WATCHDOG: Liquidation failed: ${liqErr.message}`);
                }
                this.signalHandler.clearPosition();
                this.strategy.setPosition(null);
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
    this._clearLimitEntryTimeout();
    this._clearFillWatchdog();

    // Clear reconnect cooldown timer to prevent stale callbacks after shutdown
    if (this._reconnectCooldownTimer) {
      clearTimeout(this._reconnectCooldownTimer);
      this._reconnectCooldownTimer = null;
      this._reconnectCooldownUntil = null;
    }

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

    if (this.telegramCommands) {
      this.telegramCommands.stop();
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

  /**
   * Get current bot status for Telegram commands
   */
  async getStatus() {
    const balance = await this.client.getCashBalance(this.account.id);
    const positions = await this.client.getOpenPositions(this.account.id);
    const llStatus = this.lossLimits.getStatus();
    const todayStats = this.performance.getTodayStats();
    
    return { 
      account: this.account,
      balance, 
      positions, 
      ...llStatus, 
      ...todayStats, 
      paused: this._pausedByUser 
    };
  }
}

module.exports = TradovateBot;
