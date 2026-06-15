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
const TelegramCommandHandler = require('../utils/TelegramCommandHandler');
const ContractRollReminder = require('../utils/contract_roll_reminder');

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
    this._pausedByUser = false;
    this.telegramCommands = null;
    this._sessionCheckInterval = null;
    this._positionSyncInterval = null;
    this._todayResetDone = false;
    this._eodCloseDoneToday = false;
    this._dailyReportSentToday = false;
    this._sessionStartLoggedToday = false;

    // HIGH-6 FIX: Account-level max simultaneous positions (across all instruments)
    this.maxSimultaneousPositions = parseInt(process.env.MAX_SIMULTANEOUS_POSITIONS) || 2;
  }

  /**
   * HIGH-6 FIX: Check if a new position can be opened across all instruments.
   * Returns { allowed, openCount, maxAllowed } so runners can gate new entries.
   * Called by InstrumentRunner before placing an entry order.
   */
  canOpenNewPosition() {
    let openCount = 0;
    for (const runner of this.runners.values()) {
      if (runner.hasPosition()) {
        openCount++;
      }
    }
    return {
      allowed: openCount < this.maxSimultaneousPositions,
      openCount,
      maxAllowed: this.maxSimultaneousPositions
    };
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
      // Note: trade ticks no longer subscribed. Slippage guard + real-time BE
      // now use the 1s bar close (matches backtester exactly).
      // Post-reconnect cooldown (suppress signals after Databento reconnects with dropped bars)
      postReconnectCooldownMins: parseInt(process.env.POST_RECONNECT_COOLDOWN_MINS) || 10,
      postReconnectMinDroppedBars: parseInt(process.env.POST_RECONNECT_MIN_DROPPED_BARS) || 3,
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
        // Per-strategy confluence overrides — leave unset to fall back to shared MIN_CONFLUENCE
        if (env('PB_MIN_CONFLUENCE', '') !== '')   strategyParams.pbMinConfluence   = parseInt(env('PB_MIN_CONFLUENCE', '0'));
        if (env('PB3M_MIN_CONFLUENCE', '') !== '') strategyParams.pb3mMinConfluence = parseInt(env('PB3M_MIN_CONFLUENCE', '0'));
        if (env('PB2M_MIN_CONFLUENCE', '') !== '') strategyParams.pb2mMinConfluence = parseInt(env('PB2M_MIN_CONFLUENCE', '0'));
        if (env('VR_MIN_CONFLUENCE', '') !== '')   strategyParams.vrMinConfluence   = parseInt(env('VR_MIN_CONFLUENCE', '0'));
        if (env('EMAX_MIN_CONFLUENCE', '') !== '') strategyParams.emaxMinConfluence = parseInt(env('EMAX_MIN_CONFLUENCE', '0'));
        strategyParams.volumeAvgPeriod = parseInt(env('VOLUME_AVG_PERIOD', '20'));
        strategyParams.momentumBars = parseInt(env('MOMENTUM_BARS', '3'));
        strategyParams.priorLevelTolerance = parseFloat(env('PRIOR_LEVEL_TOLERANCE', '5'));
        strategyParams.moveStopToBE = env('MOVE_STOP_TO_BE', 'false') === 'true';
        strategyParams.beActivationR = parseFloat(env('BE_ACTIVATION_R', '1.2'));
        strategyParams.beSteps = ConfigValidator.parseBeStopSteps(env('BE_STOP_STEPS', ''));
        strategyParams.partialProfitEnabled = env('PARTIAL_PROFIT_ENABLED', 'false') === 'true';
        strategyParams.partialProfitR = parseFloat(env('PARTIAL_PROFIT_R', '2'));
        strategyParams.maxLossesPerDay = parseInt(env('MAX_LOSSES_PER_DAY', '') || env('MAX_CONSECUTIVE_LOSSES', '3'));
        strategyParams.volumeFilterEnabled = env('VOLUME_FILTER_ENABLED', 'false') === 'true';
        strategyParams.volumeFilterMin = parseFloat(env('VOLUME_FILTER_MIN', '0.9'));
        strategyParams.volumeFilterPeriod = parseInt(env('VOLUME_FILTER_PERIOD', '20'));
        // PB 5m additional params
        strategyParams.pbMaxImpulse = parseFloat(env('PB_MAX_IMPULSE', 'Infinity'));
        strategyParams.pbLookbackBars = parseInt(env('PB_LOOKBACK_BARS', '1'));
        // PB 3m sub-strategy
        strategyParams.pb3mEnabled = env('PB3M_ENABLED', 'false') === 'true';
        strategyParams.pb3mMinImpulse = parseFloat(env('PB3M_MIN_IMPULSE', '10'));
        strategyParams.pb3mMaxImpulse = parseFloat(env('PB3M_MAX_IMPULSE', '30'));
        strategyParams.pb3mLookbackBars = parseInt(env('PB3M_LOOKBACK_BARS', '1'));
        strategyParams.pb3mMaxTime = parseInt(env('PB3M_MAX_TIME', '570'));
        strategyParams.pb3mRetraceMin = parseFloat(env('PB3M_RETRACE_MIN', '0.10'));
        strategyParams.pb3mRetraceMax = parseFloat(env('PB3M_RETRACE_MAX', '0.85'));
        strategyParams.pb3mMinImpBodyRatio = parseFloat(env('PB3M_MIN_IMP_BODY_RATIO', '0.15'));
        strategyParams.pb3mMaxStopPoints = parseInt(env('PB3M_MAX_STOP_POINTS', '25'));
        strategyParams.pb3mMinStopPoints = parseInt(env('PB3M_MIN_STOP_POINTS', '3'));
        strategyParams.pb3mMinTargetPoints = parseInt(env('PB3M_MIN_TARGET_POINTS', '15'));
        // PB 2m sub-strategy
        strategyParams.pb2mEnabled = env('PB2M_ENABLED', 'false') === 'true';
        strategyParams.pb2mMinImpulse = parseFloat(env('PB2M_MIN_IMPULSE', '8'));
        strategyParams.pb2mMaxImpulse = parseFloat(env('PB2M_MAX_IMPULSE', '25'));
        strategyParams.pb2mLookbackBars = parseInt(env('PB2M_LOOKBACK_BARS', '1'));
        strategyParams.pb2mMaxTime = parseInt(env('PB2M_MAX_TIME', '570'));
        strategyParams.pb2mRetraceMin = parseFloat(env('PB2M_RETRACE_MIN', '0.10'));
        strategyParams.pb2mRetraceMax = parseFloat(env('PB2M_RETRACE_MAX', '0.85'));
        strategyParams.pb2mMinImpBodyRatio = parseFloat(env('PB2M_MIN_IMP_BODY_RATIO', '0.15'));
        strategyParams.pb2mMaxStopPoints = parseInt(env('PB2M_MAX_STOP_POINTS', '20'));
        strategyParams.pb2mMinStopPoints = parseInt(env('PB2M_MIN_STOP_POINTS', '2'));
        strategyParams.pb2mMinTargetPoints = parseInt(env('PB2M_MIN_TARGET_POINTS', '10'));
        // Slippage guard (global default + per-strategy overrides)
        strategyParams.maxEntrySlippagePts = parseFloat(env('MAX_ENTRY_SLIPPAGE_PTS', '5'));
        strategyParams.slippageByStrategy = {
          PB:   parseFloat(env('PB_MAX_ENTRY_SLIPPAGE_PTS',   String(strategyParams.maxEntrySlippagePts))),
          PB3m: parseFloat(env('PB3M_MAX_ENTRY_SLIPPAGE_PTS', String(strategyParams.maxEntrySlippagePts))),
          PB2m: parseFloat(env('PB2M_MAX_ENTRY_SLIPPAGE_PTS', String(strategyParams.maxEntrySlippagePts))),
          VR:   parseFloat(env('VR_MAX_ENTRY_SLIPPAGE_PTS',   String(strategyParams.maxEntrySlippagePts))),
          EMAX: parseFloat(env('EMAX_MAX_ENTRY_SLIPPAGE_PTS', String(strategyParams.maxEntrySlippagePts))),
        };
        strategyParams.deferredEntryWindowSec = parseInt(env('DEFERRED_ENTRY_WINDOW_SEC', '60'));
        // PB Entry Timing Improvements
        strategyParams.pbEntryMode = 'immediate';  // V2.11: always market entry for PB 5m
        strategyParams.pbConfirmBars = parseInt(env('PB_CONFIRM_BARS', '5'));
        strategyParams.pbLimitRetracePct = parseFloat(env('PB_LIMIT_RETRACE_PCT', '0.6'));
        strategyParams.pbLimitTimeoutBars = parseInt(env('PB_LIMIT_TIMEOUT_BARS', '5'));
        strategyParams.pbTrendFilterEnabled = env('PB_TREND_FILTER', 'false') === 'true';
        // Entry order type (per-instrument). MNQ stays 'Market' (default); MES can opt
        // into 'Limit' for a marketable limit at signal ± ENTRY_LIMIT_BUFFER_TICKS,
        // cancelled after LIMIT_ENTRY_TIMEOUT_SEC if unfilled.
        strategyParams.entryOrderType = env('ENTRY_ORDER_TYPE', 'Market');
        strategyParams.entryLimitBufferTicks = parseInt(env('ENTRY_LIMIT_BUFFER_TICKS', '1'));
        strategyParams.limitEntryTimeoutSec = parseInt(env('LIMIT_ENTRY_TIMEOUT_SEC', '180'));
        // Tick-triggered entry (intra-bar evaluation via real-time trade prints)
        strategyParams.pbTickEntry = env('PB_TICK_ENTRY', 'false') === 'true';
        strategyParams.pb3mTickEntry = env('PB3M_TICK_ENTRY', 'false') === 'true';
        strategyParams.pb2mTickEntry = env('PB2M_TICK_ENTRY', 'false') === 'true';
        // Zone-exit bounce + consecutive tick confirmation (V2.12b)
        strategyParams.zoneExitMargin = parseFloat(env('ZONE_EXIT_MARGIN', '0.10'));
        strategyParams.consecTicksRequired = parseInt(env('CONSEC_TICKS_REQUIRED', '3'));
        // Post-trade cooldown (1m bars to wait after a trade closes before next signal)
        strategyParams.cooldownBars = parseInt(env('COOLDOWN_BARS', '6'));
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
        strategyParams.beSteps = ConfigValidator.parseBeStopSteps(env('BE_STOP_STEPS', ''));
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
        // SKIP_HOURS: comma-separated PT windows (e.g. "7:00-7:14,9:15-9:29") to veto signals.
        // Pre-parsed here so InstrumentRunner just consumes ranges; raw string kept for diagnostics.
        skipHours: env('SKIP_HOURS', ''),
        skipHourRanges: ConfigValidator.parseSkipHours(env('SKIP_HOURS', '')),
        riskParams: {
          riskPerTrade: {
            min: parseFloat(env('RISK_PER_TRADE_MIN', '25')),
            max: parseFloat(env('RISK_PER_TRADE_MAX', '90')),
          },
          maxContracts: parseInt(env('MAX_CONTRACTS', '1')),
          dailyLossLimit: parseFloat(env('DAILY_LOSS_LIMIT', '200')),
          weeklyLossLimit: parseFloat(env('WEEKLY_LOSS_LIMIT', '500')),
          maxConsecutiveLosses: parseInt(env('MAX_CONSECUTIVE_LOSSES', '3')),
          maxDrawdownPercent: parseFloat(env('MAX_DRAWDOWN_PERCENT', '5')),
          dailyProfitTarget: parseFloat(env('DAILY_PROFIT_TARGET', 'Infinity')),
          profitTiers: env('DAILY_PROFIT_TIERS', ''),
        },
      });
    }

    return configs;
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
   * Initialize shared resources and all instrument runners
   */
  async initialize() {
    this._logStartupBanner();

    // ── Shared: Auth + Client + Account ──
    this.auth = new TradovateAuth(this.globalConfig);
    await this._authenticateWithRetry();
    this.client = new TradovateClient(this.auth);

    const accounts = await this.client.getAccounts();
    if (accounts.length === 0) throw new Error('No accounts found');

    // Select account: prefer TRADOVATE_ACCOUNT_NAME or TRADOVATE_ACCOUNT_ID from .env,
    // otherwise fall back to the first active account.
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
      // Default: pick first active account, warn if multiple
      const active = accounts.filter(a => a.active !== false);
      this.account = active[0] || accounts[0];
      if (accounts.length > 1) {
        const available = accounts.map(a => `${a.name} (ID: ${a.id})`).join(', ');
        logger.warn(`⚠️ Multiple accounts found: ${available}`);
        logger.warn(`⚠️ Using "${this.account.name}" — set TRADOVATE_ACCOUNT_NAME in .env to choose explicitly`);
      }
    }
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
      const downtimeMs = data.downtimeMs || 0;
      const downtimeSec = (downtimeMs / 1000).toFixed(1);
      const estimatedDroppedBars = Math.floor(downtimeMs / 60000);
      logger.info(`[Databento:SHARED] Reconnected after ${downtimeSec}s (~${estimatedDroppedBars} bars dropped) — syncing all instruments`);
      this.notifications.send(
        `✅ <b>DATABENTO RECONNECTED</b>\n` +
        `Downtime: ${downtimeSec}s (${data.attempts || '?'} attempts)\n` +
        `Est. bars dropped: ~${estimatedDroppedBars}`
      ).catch(() => {});

      // Trigger post-reconnect cooldown on all runners (each runner evaluates threshold independently)
      for (const runner of this.runners.values()) {
        runner.startReconnectCooldown(estimatedDroppedBars, downtimeMs);
      }
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
      bot: this, // HIGH-6 FIX: Expose MultiInstrumentBot for account-level position guard
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

      // Listen for halt events — send daily report immediately (prevents duplicate at EOD)
      runner.on('halt', async (data) => {
        logger.error(`${data.instrument} HALTED: ${data.message}`);
        await this._sendDailyReport(`${data.instrument} halted: ${data.message}`);
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

    // Start Telegram command handler
    this.telegramCommands = new TelegramCommandHandler(this, this.notifications);
    this.telegramCommands.start();

    // Start contract roll reminders for each instrument
    this._rollReminders = [];
    for (const [sym, runner] of this.runners) {
      const contract = runner.contract;
      if (contract && contract.name) {
        const reminder = new ContractRollReminder({
          notifications: this.notifications,
          contractName: contract.name,
          expirationDate: contract.expirationDate,
          baseSymbol: sym,
        });
        await reminder.start();
        this._rollReminders.push(reminder);
      }
    }
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
      // BUG-8 FIX: Re-authorize and re-sync user data after reconnect.
      // Without this, the WebSocket is connected but won't deliver order/fill/position events.
      try {
        await new Promise((resolve) => {
          if (this.orderWs.isAuthorized) {
            resolve();
          } else {
            this.orderWs.once('authorized', resolve);
            setTimeout(resolve, 5000);
          }
        });
        this.orderWs.synchronize(this.account.id);
        logger.info('[OrderWs] Re-synchronized after reconnect');
      } catch (syncErr) {
        logger.error(`[OrderWs] Re-sync after reconnect failed: ${syncErr.message}`);
      }

      if (data.requiresPositionSync) {
        logger.warn('[OrderWs] Reconnected — syncing all instrument positions');
        for (const runner of this.runners.values()) {
          await runner.syncPosition();
        }
      }
    });

    // HIGH-5 FIX: If WebSocket exhausts all reconnect attempts, halt trading on ALL instruments.
    // Without this, the bot keeps placing orders via REST but never receives fill/order events,
    // leading to naked positions that the bot can never detect or close.
    this.orderWs.on('maxReconnectAttemptsReached', async (data) => {
      logger.error(`[OrderWs] 🚨 CRITICAL: WebSocket exhausted all ${data.attempts} reconnect attempts — HALTING ALL TRADING`);
      for (const [symbol, runner] of this.runners.entries()) {
        try {
          // Halt each runner's loss limits so no new trades are placed
          if (runner.lossLimits) {
            runner.lossLimits.halt('WEBSOCKET_DEAD', 'Order WebSocket connection lost — cannot receive fills or order updates');
          }
          logger.error(`[OrderWs] Halted trading for ${symbol}`);
        } catch (err) {
          logger.error(`[OrderWs] Failed to halt ${symbol}: ${err.message}`);
        }
      }
      // Send critical alert
      const notifications = this.runners.values().next().value?.shared?.notifications;
      if (notifications) {
        await notifications.send(
          `🚨 <b>CRITICAL: ORDER WEBSOCKET DEAD</b>\n` +
          `All ${data.attempts} reconnect attempts exhausted.\n` +
          `⛔ ALL TRADING HALTED — bot cannot receive fill/order events.\n` +
          `Manual intervention required — restart the bot.`
        ).catch(() => {});
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

    if (this.telegramCommands) {
      this.telegramCommands.stop();
    }

    if (this._rollReminders) {
      for (const reminder of this._rollReminders) {
        reminder.stop();
      }
    }

    logger.info('MultiInstrumentBot stopped');
    process.exit(0);
  }

  /**
   * Get aggregated status from all instruments for Telegram commands
   */
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
      instrumentStats.push({
        symbol,
        pnl: stats.pnl,
        trades: stats.trades,
        isHalted: llStatus.isHalted,
        haltReason: llStatus.haltReason
      });
    }
    
    return { 
      account: this.account,
      balance, 
      positions, 
      totalPnl, 
      totalTrades, 
      instrumentStats, 
      paused: this._pausedByUser 
    };
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
