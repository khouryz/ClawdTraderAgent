/**
 * SignalHandler - Processes trading signals and executes trades
 * 
 * Responsibilities:
 * - Validate signals against filters (market hours, session, loss limits)
 * - Calculate position size
 * - Place bracket orders
 * - Record trades in learning system
 * - Send notifications
 */

const EventEmitter = require('events');
const logger = require('../utils/logger');
const { ErrorHandler } = require('../utils/error_handler');

class SignalHandler extends EventEmitter {
  /**
   * @param {Object} dependencies - Injected dependencies
   * @param {Object} dependencies.client - TradovateClient instance
   * @param {Object} dependencies.riskManager - RiskManager instance
   * @param {Object} dependencies.lossLimits - LossLimitsManager instance
   * @param {Object} dependencies.sessionFilter - SessionFilter instance
   * @param {Object} dependencies.marketHours - MarketHours instance
   * @param {Object} dependencies.tradeAnalyzer - TradeAnalyzer instance
   * @param {Object} dependencies.notifications - Notifications instance
   * @param {Object} dependencies.trailingStop - TrailingStopManager instance
   * @param {Object} dependencies.profitManager - ProfitManager instance
   * @param {Object} dependencies.strategy - Strategy instance
   * @param {Object} config - Bot configuration
   */
  constructor(dependencies, config) {
    super();
    this.client = dependencies.client;
    this.riskManager = dependencies.riskManager;
    this.lossLimits = dependencies.lossLimits;
    this.sessionFilter = dependencies.sessionFilter;
    this.marketHours = dependencies.marketHours;
    this.tradeAnalyzer = dependencies.tradeAnalyzer;
    this.notifications = dependencies.notifications;
    this.trailingStop = dependencies.trailingStop;
    this.profitManager = dependencies.profitManager;
    this.strategy = dependencies.strategy;
    this.config = config;
    
    this.account = null;
    this.contract = null;
    this.currentPosition = null;
    this.currentTradeId = null;
  }

  /**
   * Set account and contract for trading
   * @param {Object} account - Tradovate account
   * @param {Object} contract - Tradovate contract
   */
  setContext(account, contract) {
    this.account = account;
    this.contract = contract;
  }

  /**
   * Get current position
   * @returns {Object|null} Current position or null
   */
  getPosition() {
    return this.currentPosition;
  }

  /**
   * Get current trade ID
   * @returns {string|null} Current trade ID or null
   */
  getTradeId() {
    return this.currentTradeId;
  }

  /**
   * Clear current position
   */
  clearPosition() {
    this.currentPosition = null;
    this.currentTradeId = null;
  }

  /**
   * Handle incoming trading signal
   * @param {Object} signal - Trading signal from strategy
   * @param {string} signal.type - 'buy' or 'sell'
   * @param {number} signal.price - Entry price
   * @param {number} signal.stopLoss - Stop loss price
   * @param {Array} signal.filterResults - Filter results for learning
   */
  async handleSignal(signal) {
    try {
      logger.trade(`📊 Signal received: ${signal.type.toUpperCase()} at $${signal.price}`);

      // Validate signal
      const validation = this._validateSignal();
      if (!validation.valid) {
        logger.warn(`Trade blocked: ${validation.reason}`);
        return { executed: false, reason: validation.reason };
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
      const tradeValidation = this.riskManager.validateTrade(position);
      if (!tradeValidation.valid) {
        logger.warn(`Trade rejected: ${tradeValidation.reason}`);
        return { executed: false, reason: tradeValidation.reason };
      }

      // Log trade summary
      logger.trade(this.riskManager.formatTradeSummary(position));

      // Capture market structure for learning system
      const strategyState = this.strategy.getStatus();
      const marketStructure = this.tradeAnalyzer.captureMarketStructure(
        strategyState, 
        this.strategy.currentQuote
      );

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

      // Generate AI explanation for the trade
      const explanation = this.tradeAnalyzer.generateTradeExplanation(
        signal, 
        marketStructure, 
        position,
        signal.filterResults
      );

      // Record trade entry in learning system
      const tradeRecord = await this.tradeAnalyzer.recordTradeEntry({
        symbol: this.contract.name,
        side: action,
        contracts: position.contracts,
        entryPrice: signal.price,
        stopLoss: position.stopPrice,
        takeProfit: position.targetPrice,
        riskAmount: position.totalRisk,
        marketStructure,
        filterResults: signal.filterResults,
        explanation
      });
      this.currentTradeId = tradeRecord.id;

      // Send detailed trade entry notification via Telegram
      await this.notifications.tradeEntryDetailed({
        signal,
        position,
        marketStructure,
        filterResults: signal.filterResults
      });

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

      // Listen for single contract profit lock events
      this.profitManager.once('singleContractProfitLock', async (data) => {
        await this.notifications.singleContractProfitLock(data);
      });

      this.emit('tradeEntered', {
        position: this.currentPosition,
        tradeId: this.currentTradeId
      });

      return { 
        executed: true, 
        position: this.currentPosition,
        tradeId: this.currentTradeId
      };

    } catch (error) {
      const errorInfo = ErrorHandler.handle(error, { 
        component: 'SignalHandler', 
        action: 'handleSignal' 
      });
      logger.error(`Trade failed: ${errorInfo.message}`);
      
      if (errorInfo.recovery.action === 'HALT') {
        logger.error(`Halting trading: ${errorInfo.recovery.message}`);
        this.lossLimits.halt(errorInfo.code);
        await this.notifications.tradingHalted(errorInfo.recovery.message);
        this.emit('tradingHalted', errorInfo);
      }
      
      // Send error notification
      await this.notifications.error(errorInfo.message);
      
      return { executed: false, error: errorInfo };
    }
  }

  /**
   * Validate signal against all filters
   * @returns {{valid: boolean, reason?: string}}
   */
  _validateSignal() {
    // Check market hours
    const marketStatus = this.marketHours.getStatus();
    if (!marketStatus.isOpen) {
      return { valid: false, reason: marketStatus.message };
    }

    // Check loss limits
    const canTrade = this.lossLimits.canTrade();
    if (!canTrade.allowed) {
      return { valid: false, reason: canTrade.reason };
    }

    // Check session filter
    const sessionCheck = this.sessionFilter.canTrade();
    if (!sessionCheck.allowed) {
      return { valid: false, reason: sessionCheck.reason };
    }

    return { valid: true };
  }
}

module.exports = SignalHandler;
