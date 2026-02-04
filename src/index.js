#!/usr/bin/env node

/**
 * Tradovate Trading Bot
 * Main entry point
 */

require('dotenv').config();
const TradovateAuth = require('./api/auth');
const TradovateClient = require('./api/client');
const TradovateWebSocket = require('./api/websocket');
const RiskManager = require('./risk/manager');
const SimpleBreakoutStrategy = require('./strategies/simple_breakout');
const logger = require('./utils/logger');

class TradovateBot {
  constructor() {
    this.config = this.loadConfig();
    this.auth = null;
    this.client = null;
    this.marketWs = null;
    this.orderWs = null;
    this.riskManager = null;
    this.strategy = null;
    this.account = null;
    this.contract = null;
    this.isRunning = false;
  }

  /**
   * Load configuration from environment variables
   */
  loadConfig() {
    const config = {
      env: process.env.TRADOVATE_ENV || 'demo',
      username: process.env.TRADOVATE_USERNAME,
      password: process.env.TRADOVATE_PASSWORD,
      contractSymbol: process.env.CONTRACT_SYMBOL || 'MESM5',
      riskPerTrade: {
        min: parseFloat(process.env.RISK_PER_TRADE_MIN) || 30,
        max: parseFloat(process.env.RISK_PER_TRADE_MAX) || 60
      },
      profitTargetR: parseFloat(process.env.PROFIT_TARGET_R) || 2,
      strategy: process.env.STRATEGY || 'simple_breakout'
    };

    // Validate required config
    if (!config.username || !config.password) {
      throw new Error('Missing TRADOVATE_USERNAME or TRADOVATE_PASSWORD in .env file');
    }

    return config;
  }

  /**
   * Initialize the bot
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
      logger.info(`✓ Account: ${this.account.name} (ID: ${this.account.id})`);

      // 4. Find contract
      this.contract = await this.client.findContract(this.config.contractSymbol);
      logger.info(`✓ Contract: ${this.contract.name} (ID: ${this.contract.id})`);

      // 5. Initialize risk manager
      this.riskManager = new RiskManager(this.config);
      logger.info('✓ Risk Manager initialized');

      // 6. Initialize strategy
      this.strategy = new SimpleBreakoutStrategy({
        lookbackPeriod: 20,
        atrMultiplier: 1.5
      });

      // Listen for trading signals
      this.strategy.on('signal', (signal) => this.handleSignal(signal));

      await this.strategy.initialize();
      logger.info('✓ Strategy initialized');

      // 7. Connect WebSockets
      this.marketWs = new TradovateWebSocket(this.auth, 'market');
      this.orderWs = new TradovateWebSocket(this.auth, 'order');

      this.marketWs.on('quote', (quote) => this.handleQuote(quote));
      this.marketWs.on('error', (error) => logger.error(`Market WS error: ${error.message}`));
      
      this.orderWs.on('order', (order) => this.handleOrderUpdate(order));
      this.orderWs.on('fill', (fill) => this.handleFill(fill));
      this.orderWs.on('position', (position) => this.handlePosition(position));

      await this.marketWs.connect();
      await this.orderWs.connect();

      logger.info('✓ WebSockets connected');

      // 8. Subscribe to market data
      this.marketWs.subscribeQuote(this.contract.id);
      logger.info(`✓ Subscribed to ${this.contract.name} quotes`);

      // 9. Get initial bars for strategy
      const bars = await this.client.getBars(this.contract.id, 100);
      if (bars && bars.bars) {
        bars.bars.forEach(bar => this.strategy.onBar(bar));
        logger.info(`✓ Loaded ${bars.bars.length} historical bars`);
      }

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
      
      // Update strategy position
      this.strategy.setPosition({
        side: action,
        quantity: position.contracts,
        price: signal.price,
        stopLoss: position.stopPrice,
        target: position.targetPrice
      });

    } catch (error) {
      logger.error(`Failed to execute trade: ${error.message}`);
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
   * Start the bot
   */
  async start() {
    await this.initialize();

    // Handle graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }
}

// Start the bot if run directly
if (require.main === module) {
  const bot = new TradovateBot();
  bot.start().catch(error => {
    logger.error(`Fatal error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = TradovateBot;
