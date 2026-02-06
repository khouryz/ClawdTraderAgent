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
const RiskManager = require('../risk/manager');
const LossLimitsManager = require('../risk/loss_limits');
const EnhancedBreakoutStrategy = require('../strategies/enhanced_breakout');
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
    
    // WebSockets
    this.marketWs = null;
    this.orderWs = null;
    
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
      aiDefaultAction: process.env.AI_DEFAULT_ACTION || 'confirm'
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

      // Connect WebSockets
      await this._connectWebSockets();

      // Load initial data
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
    this.lossLimits.on('halt', (data) => {
      logger.error(`🛑 TRADING HALTED: ${data.message}`);
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

    // Profit manager
    this.profitManager = new ProfitManager({
      partialProfitEnabled: this.config.partialProfitEnabled,
      partialProfitPercent: this.config.partialProfitPercent,
      partialProfitR: this.config.partialProfitR
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
    this.strategy = new EnhancedBreakoutStrategy({
      lookbackPeriod: this.config.lookbackPeriod,
      atrMultiplier: this.config.atrMultiplier,
      trendEMAPeriod: this.config.trendEMAPeriod,
      useTrendFilter: this.config.useTrendFilter,
      useVolumeFilter: this.config.useVolumeFilter,
      useRSIFilter: this.config.useRSIFilter,
      sessionFilter: this.sessionFilter
    });

    // Strategy will emit signals to signal handler
    this.strategy.on('signal', (signal) => this._onSignal(signal));
    this.strategy.initialize();
    logger.info('✓ Strategy initialized');
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
    
    logger.info('✓ Position Handler initialized');
  }

  /**
   * Connect WebSocket connections
   * @private
   */
  async _connectWebSockets() {
    this.marketWs = new TradovateWebSocket(this.auth, 'market');
    this.orderWs = new TradovateWebSocket(this.auth, 'order');

    // Market WebSocket events
    this.marketWs.on('quote', (quote) => {
      console.log('[DEBUG] Quote received:', JSON.stringify(quote).substring(0, 100));
      this._onQuote(quote);
    });
    this.marketWs.on('error', (error) => logger.error(`Market WS error: ${error.message}`));
    this.marketWs.on('maxReconnectAttemptsReached', () => {
      logger.error('Market WebSocket max reconnect attempts reached');
    });
    
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

    await this.marketWs.connect();
    await this.orderWs.connect();
    logger.info('✓ WebSockets connected');

    // Wait for authorization before subscribing
    await new Promise((resolve) => {
      if (this.marketWs.isAuthorized) {
        resolve();
      } else {
        this.marketWs.once('authorized', resolve);
        // Timeout after 5 seconds
        setTimeout(resolve, 5000);
      }
    });

    // Sync user data on order socket first (per Tradovate example)
    this.orderWs.synchronize(this.account.id);
    
    // Subscribe to market data using contract name (per Tradovate example)
    console.log('[DEBUG] Contract object:', JSON.stringify(this.contract));
    this.marketWs.subscribeQuote(this.contract.name);
    logger.info(`✓ Subscribed to ${this.contract.name} quotes`);
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
   * Load initial historical data
   * @private
   */
  async _loadInitialData() {
    const response = await this.client.getChartBars(this.contract.id, 100);
    if (response && response.bars && Array.isArray(response.bars)) {
      response.bars.forEach(bar => this.strategy.onBar(bar));
      logger.info(`✓ Loaded ${response.bars.length} historical bars`);
    } else {
      logger.warn('No bar data received from Tradovate');
    }

    // Update equity for loss limits
    const balance = await this.client.getCashBalance(this.account.id);
    this.lossLimits.updateEquity(balance.cashBalance);
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
   * @private
   */
  async _onSignal(signal) {
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

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('Shutting down bot...');
    this.isRunning = false;

    // Send shutdown notification
    await this.notifications.botStopped('Graceful shutdown');

    if (this.strategy) {
      this.strategy.stop();
    }

    if (this.marketWs) {
      this.marketWs.disconnect();
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

    // Handle graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }
}

module.exports = TradovateBot;
