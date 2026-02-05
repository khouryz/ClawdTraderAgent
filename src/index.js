#!/usr/bin/env node

/**
 * Tradovate Trading Bot
 * Main entry point - Designed for Clawdbot cron job execution
 * 
 * Commands:
 *   node src/index.js              - Start continuous trading mode
 *   node src/index.js --status     - Get current status (JSON output)
 *   node src/index.js --check      - Check for trade signals once
 *   node src/index.js --balance    - Get account balance
 *   node src/index.js --positions  - Get open positions
 *   node src/index.js --report     - Get performance report
 */

require('dotenv').config();
const TradovateAuth = require('./api/auth');
const TradovateClient = require('./api/client');
const TradovateWebSocket = require('./api/websocket');
const RiskManager = require('./risk/manager');
const LossLimitsManager = require('./risk/loss_limits');
const EnhancedBreakoutStrategy = require('./strategies/enhanced_breakout');
const SessionFilter = require('./filters/session_filter');
const { OrderManager } = require('./orders/order_manager');
const TrailingStopManager = require('./orders/trailing_stop');
const ProfitManager = require('./orders/profit_manager');
const PerformanceTracker = require('./analytics/performance');
const logger = require('./utils/logger');
const ConfigValidator = require('./utils/config_validator');
const { ErrorHandler } = require('./utils/error_handler');

class TradovateBot {
  constructor() {
    this.config = this.loadConfig();
    this.auth = null;
    this.client = null;
    this.marketWs = null;
    this.orderWs = null;
    this.riskManager = null;
    this.lossLimits = null;
    this.sessionFilter = null;
    this.orderManager = null;
    this.trailingStop = null;
    this.profitManager = null;
    this.performance = null;
    this.strategy = null;
    this.account = null;
    this.contract = null;
    this.isRunning = false;
    this.currentPosition = null;
  }

  /**
   * Load and validate configuration from environment variables
   */
  loadConfig() {
    const rawConfig = {
      env: process.env.TRADOVATE_ENV,
      username: process.env.TRADOVATE_USERNAME,
      password: process.env.TRADOVATE_PASSWORD,
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
      partialProfitR: process.env.PARTIAL_PROFIT_R
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
   * Initialize the bot (core components only)
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
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info('🤖 Tradovate Trading Bot Starting...');
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.info(`Environment: ${this.config.env.toUpperCase()}`);
      logger.info(`Contract: ${this.config.contractSymbol}`);
      logger.info(`Risk: $${this.config.riskPerTrade.min}-$${this.config.riskPerTrade.max} per trade`);
      logger.info(`Strategy: ${this.config.strategy}`);
      logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

      // Initialize core
      await this.initializeCore();
      logger.info(`✓ Account: ${this.account.name} (ID: ${this.account.id})`);
      logger.info(`✓ Contract: ${this.contract.name} (ID: ${this.contract.id})`);

      // 5. Initialize risk manager
      this.riskManager = new RiskManager(this.config);
      logger.info('✓ Risk Manager initialized');

      // 6. Initialize loss limits
      this.lossLimits = new LossLimitsManager(this.config);
      this.lossLimits.on('halt', (data) => {
        logger.error(`🛑 TRADING HALTED: ${data.message}`);
      });
      logger.info('✓ Loss Limits Manager initialized');

      // 7. Initialize session filter
      this.sessionFilter = new SessionFilter(this.config);
      logger.info('✓ Session Filter initialized');

      // 8. Initialize order manager
      this.orderManager = new OrderManager(this.client);
      this.orderManager.on('orderFill', (order, fill) => this.handleFill(fill));
      logger.info('✓ Order Manager initialized');

      // 9. Initialize trailing stop manager
      this.trailingStop = new TrailingStopManager({
        enabled: this.config.trailingStopEnabled,
        atrMultiplier: this.config.trailingStopATRMultiplier
      });
      logger.info('✓ Trailing Stop Manager initialized');

      // 10. Initialize profit manager
      this.profitManager = new ProfitManager({
        partialProfitEnabled: this.config.partialProfitEnabled,
        partialProfitPercent: this.config.partialProfitPercent,
        partialProfitR: this.config.partialProfitR
      });
      logger.info('✓ Profit Manager initialized');

      // 11. Initialize performance tracker
      this.performance = new PerformanceTracker();
      logger.info('✓ Performance Tracker initialized');

      // 12. Initialize strategy
      this.strategy = new EnhancedBreakoutStrategy({
        lookbackPeriod: this.config.lookbackPeriod,
        atrMultiplier: this.config.atrMultiplier,
        trendEMAPeriod: this.config.trendEMAPeriod,
        useTrendFilter: this.config.useTrendFilter,
        useVolumeFilter: this.config.useVolumeFilter,
        useRSIFilter: this.config.useRSIFilter,
        sessionFilter: this.sessionFilter
      });

      // Listen for trading signals
      this.strategy.on('signal', (signal) => this.handleSignal(signal));
      await this.strategy.initialize();
      logger.info('✓ Strategy initialized');

      // 13. Connect WebSockets
      this.marketWs = new TradovateWebSocket(this.auth, 'market');
      this.orderWs = new TradovateWebSocket(this.auth, 'order');

      this.marketWs.on('quote', (quote) => this.handleQuote(quote));
      this.marketWs.on('error', (error) => logger.error(`Market WS error: ${error.message}`));
      this.marketWs.on('maxReconnectAttemptsReached', () => {
        logger.error('Market WebSocket max reconnect attempts reached');
      });
      
      this.orderWs.on('order', (order) => this.handleOrderUpdate(order));
      this.orderWs.on('fill', (fill) => this.handleFill(fill));
      this.orderWs.on('position', (position) => this.handlePosition(position));

      await this.marketWs.connect();
      await this.orderWs.connect();
      logger.info('✓ WebSockets connected');

      // 14. Subscribe to market data
      this.marketWs.subscribeQuote(this.contract.id);
      logger.info(`✓ Subscribed to ${this.contract.name} quotes`);

      // 15. Get initial bars for strategy
      const response = await this.client.getChartBars(this.contract.id, 100);
      if (response && response.bars && Array.isArray(response.bars)) {
        response.bars.forEach(bar => this.strategy.onBar(bar));
        logger.info(`✓ Loaded ${response.bars.length} historical bars`);
      } else {
        logger.warn('No bar data received from Tradovate');
      }

      // 16. Update equity for loss limits
      const balance = await this.client.getCashBalance(this.account.id);
      this.lossLimits.updateEquity(balance.cashBalance);

      this.isRunning = true;
      logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      logger.success('✅ Bot is now LIVE and monitoring the market');
      logger.success('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    } catch (error) {
      logger.error(`Initialization failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Handle incoming quote data
   */
  handleQuote(quote) {
    this.strategy.onQuote(quote);
  }

  /**
   * Handle trading signals from strategy
   */
  async handleSignal(signal) {
    try {
      logger.trade(`📊 Signal received: ${signal.type.toUpperCase()} at $${signal.price}`);

      // Check loss limits
      const canTrade = this.lossLimits.canTrade();
      if (!canTrade.allowed) {
        logger.warn(`Trade blocked by loss limits: ${canTrade.reason}`);
        return;
      }

      // Check session filter
      const sessionCheck = this.sessionFilter.canTrade();
      if (!sessionCheck.allowed) {
        logger.warn(`Trade blocked by session filter: ${sessionCheck.reason}`);
        return;
      }

      // Get account balance
      const balance = await this.client.getCashBalance(this.account.id);
      const accountBalance = balance.cashBalance;

      // Get contract specs
      const specs = this.riskManager.getContractSpecs(this.config.contractSymbol);

      // Calculate position size
      const position = this.riskManager.calculatePositionSize(
        accountBalance,
        signal.price,
        signal.stopLoss,
        specs.tickSize,
        specs.tickValue
      );

      // Validate trade
      const validation = this.riskManager.validateTrade(position);
      if (!validation.valid) {
        logger.warn(`Trade rejected: ${validation.reason}`);
        return;
      }

      // Log trade summary
      logger.trade(this.riskManager.formatTradeSummary(position));

      // Place bracket order
      const action = signal.type === 'buy' ? 'Buy' : 'Sell';
      logger.trade(`Placing ${action} order for ${position.contracts} contracts...`);

      const order = await this.client.placeBracketOrder(
        this.account.id,
        this.contract.id,
        position.contracts,
        action,
        position.stopPrice,
        position.targetPrice
      );

      logger.success(`✓ Order placed: ${order.orderId || 'pending'}`);
      
      // Store current position info
      this.currentPosition = {
        side: action,
        quantity: position.contracts,
        entryPrice: signal.price,
        stopLoss: position.stopPrice,
        target: position.targetPrice,
        risk: position.totalRisk,
        orderId: order.orderId,
        entryTime: new Date()
      };

      // Update strategy position
      this.strategy.setPosition(this.currentPosition);

      // Initialize trailing stop if enabled
      if (this.config.trailingStopEnabled) {
        this.trailingStop.initializeTrail({
          id: order.orderId,
          ...this.currentPosition,
          atr: this.strategy.atr
        });
      }

      // Initialize profit manager
      this.profitManager.initializePosition({
        id: order.orderId,
        ...this.currentPosition
      });

    } catch (error) {
      const errorInfo = ErrorHandler.handle(error, { component: 'TradovateBot', action: 'handleSignal' });
      logger.error(`Trade failed: ${errorInfo.message}`);
      
      if (errorInfo.recovery.action === 'HALT') {
        logger.error(`Halting trading: ${errorInfo.recovery.message}`);
        this.lossLimits.halt(errorInfo.code);
      }
    }
  }

  /**
   * Handle order updates
   */
  handleOrderUpdate(order) {
    logger.info(`Order update: ${order.ordStatus} - ${JSON.stringify(order)}`);
  }

  /**
   * Handle fill notifications
   */
  handleFill(fill) {
    logger.success(`🎯 FILL: ${fill.action} ${fill.qty} @ ${fill.price}`);
    
    // If this is an exit fill, record the trade
    if (this.currentPosition && fill.action !== this.currentPosition.side) {
      const pnl = this.currentPosition.side === 'Buy'
        ? (fill.price - this.currentPosition.entryPrice) * fill.qty
        : (this.currentPosition.entryPrice - fill.price) * fill.qty;

      // Record trade in performance tracker
      this.performance.recordTrade({
        symbol: this.contract.name,
        side: this.currentPosition.side,
        quantity: fill.qty,
        entryPrice: this.currentPosition.entryPrice,
        exitPrice: fill.price,
        stopLoss: this.currentPosition.stopLoss,
        target: this.currentPosition.target,
        pnl,
        exitReason: fill.reason || 'Unknown'
      });

      // Record in loss limits
      this.lossLimits.recordTrade(pnl);

      // Clear position if fully closed
      if (fill.qty >= this.currentPosition.quantity) {
        this.currentPosition = null;
        this.strategy.setPosition(null);
        this.trailingStop.removeTrail(fill.orderId);
        this.profitManager.closePosition(fill.orderId);
      }
    }
  }

  /**
   * Handle position updates
   */
  handlePosition(position) {
    logger.info(`Position: ${JSON.stringify(position)}`);
    
    // If position is closed, clear strategy position
    if (!position || position.netPos === 0) {
      this.strategy.setPosition(null);
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('Shutting down bot...');
    this.isRunning = false;

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

  // ============================================
  // Clawdbot Command Methods (JSON output)
  // ============================================

  /**
   * Get current status (for Clawdbot)
   */
  async getStatus() {
    await this.initializeCore();
    
    const [tradingState, sessionStatus] = await Promise.all([
      this.client.getTradingState(this.account.id),
      new SessionFilter(this.config).getStatus()
    ]);

    const lossLimits = new LossLimitsManager(this.config);
    
    return {
      timestamp: new Date().toISOString(),
      environment: this.config.env,
      account: tradingState.account,
      balance: tradingState.balance,
      positions: tradingState.positions,
      orders: tradingState.orders,
      session: sessionStatus,
      lossLimits: lossLimits.getStatus(),
      contract: {
        symbol: this.contract.name,
        id: this.contract.id
      }
    };
  }

  /**
   * Get account balance (for Clawdbot)
   */
  async getBalance() {
    await this.initializeCore();
    const balance = await this.client.getCashBalance(this.account.id);
    return {
      timestamp: new Date().toISOString(),
      accountId: this.account.id,
      accountName: this.account.name,
      cashBalance: balance.cashBalance,
      realizedPnL: balance.realizedPnL || 0,
      openPnL: balance.openPnL || 0
    };
  }

  /**
   * Get open positions (for Clawdbot)
   */
  async getPositions() {
    await this.initializeCore();
    const positions = await this.client.getOpenPositions(this.account.id);
    return {
      timestamp: new Date().toISOString(),
      accountId: this.account.id,
      positions: positions,
      count: positions.length
    };
  }

  /**
   * Get performance report (for Clawdbot)
   */
  async getReport() {
    await this.initializeCore();
    const performance = new PerformanceTracker();
    const balance = await this.client.getCashBalance(this.account.id);
    
    return {
      timestamp: new Date().toISOString(),
      accountBalance: balance.cashBalance,
      ...performance.generateReport()
    };
  }

  /**
   * Check for trade signal once (for Clawdbot cron)
   */
  async checkSignal() {
    await this.initializeCore();
    
    // Initialize components needed for signal check
    this.sessionFilter = new SessionFilter(this.config);
    this.lossLimits = new LossLimitsManager(this.config);
    
    // Check if we can trade
    const sessionCheck = this.sessionFilter.canTrade();
    const lossCheck = this.lossLimits.canTrade();
    
    if (!sessionCheck.allowed) {
      return { canTrade: false, reason: sessionCheck.reason };
    }
    
    if (!lossCheck.allowed) {
      return { canTrade: false, reason: lossCheck.reason };
    }

    // Get current positions
    const positions = await this.client.getOpenPositions(this.account.id);
    if (positions.length > 0) {
      return { canTrade: false, reason: 'Already in position', positions };
    }

    // Get bars and check for signal
    const bars = await this.client.getChartBars(this.contract.id, 100);
    
    this.strategy = new EnhancedBreakoutStrategy({
      lookbackPeriod: this.config.lookbackPeriod,
      atrMultiplier: this.config.atrMultiplier,
      trendEMAPeriod: this.config.trendEMAPeriod,
      useTrendFilter: this.config.useTrendFilter,
      useVolumeFilter: this.config.useVolumeFilter,
      useRSIFilter: this.config.useRSIFilter,
      sessionFilter: this.sessionFilter
    });

    if (bars && bars.bars) {
      bars.bars.forEach(bar => this.strategy.onBar(bar));
    }

    return {
      canTrade: true,
      session: sessionCheck,
      strategyStatus: this.strategy.getStatus(),
      barsLoaded: bars?.bars?.length || 0
    };
  }
}

// CLI Command Handler
async function main() {
  const args = process.argv.slice(2);
  const bot = new TradovateBot();

  try {
    if (args.includes('--status')) {
      const status = await bot.getStatus();
      console.log(JSON.stringify(status, null, 2));
    } else if (args.includes('--balance')) {
      const balance = await bot.getBalance();
      console.log(JSON.stringify(balance, null, 2));
    } else if (args.includes('--positions')) {
      const positions = await bot.getPositions();
      console.log(JSON.stringify(positions, null, 2));
    } else if (args.includes('--report')) {
      const report = await bot.getReport();
      console.log(JSON.stringify(report, null, 2));
    } else if (args.includes('--check')) {
      const signal = await bot.checkSignal();
      console.log(JSON.stringify(signal, null, 2));
    } else {
      // Default: start continuous trading mode
      await bot.start();
    }
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  }
}

// Start if run directly
if (require.main === module) {
  main();
}

module.exports = TradovateBot;
