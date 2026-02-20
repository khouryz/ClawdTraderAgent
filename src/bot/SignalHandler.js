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
const AIConfirmation = require('../ai/AIConfirmation');

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
    
    // CRITICAL FIX: Position lock to prevent race conditions on rapid signals
    this._processingSignal = false;

    // Initialize AI Confirmation if enabled
    this.aiConfirmation = new AIConfirmation({
      enabled: config.aiConfirmationEnabled || false,
      provider: config.aiProvider || 'anthropic',
      apiKey: config.aiApiKey || '',
      model: config.aiModel || null,
      confidenceThreshold: config.aiConfidenceThreshold || 70,
      timeout: config.aiTimeout || 5000,
      defaultAction: config.aiDefaultAction || 'confirm'
    });

    if (this.aiConfirmation.isEnabled()) {
      logger.info(`✓ AI Confirmation enabled (${config.aiProvider || 'anthropic'})`);
    }
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
    // Also release the processing lock in case it was held
    this._processingSignal = false;
  }

  /**
   * Update position after entry fill with actual fill price and recalculated stop/target.
   * Called by InstrumentRunner when the entry fill arrives at a different price than signal.
   * @param {Object} fillData - { fillPrice, signalPrice, slippage, newStop, newTarget }
   */
  updatePositionFromFill(fillData) {
    if (!this.currentPosition) return;
    const { fillPrice, signalPrice, slippage, newStop, newTarget } = fillData;
    this.currentPosition.entryPrice = fillPrice;
    this.currentPosition.signalPrice = signalPrice;
    this.currentPosition.stopLoss = newStop;
    this.currentPosition.target = newTarget;
    // Update risk based on new stop distance
    const { CONTRACTS } = require('../utils/constants');
    const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
    const contractSpecs = CONTRACTS[baseSymbol] || CONTRACTS.MNQ;
    const pointValue = contractSpecs.pointValue || 2;
    this.currentPosition.risk = Math.abs(fillPrice - newStop) * (this.currentPosition.quantity || 1) * pointValue;
    // Also update strategy's position reference
    if (this.strategy && this.strategy.position) {
      this.strategy.position.entryPrice = fillPrice;
      this.strategy.position.signalPrice = signalPrice;
      this.strategy.position.stopLoss = newStop;
      this.strategy.position.target = newTarget;
    }
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
    // CRITICAL FIX: Position lock to prevent race conditions
    // If already processing a signal or already in position, reject immediately
    if (this._processingSignal) {
      logger.warn('Signal rejected: Already processing another signal');
      return { executed: false, reason: 'Already processing signal' };
    }
    
    if (this.currentPosition) {
      logger.warn('Signal rejected: Already in position');
      return { executed: false, reason: 'Already in position' };
    }
    
    // Acquire lock
    this._processingSignal = true;
    
    try {
      // Validate signal first before accessing properties
      if (!signal || !signal.type || signal.price === undefined) {
        logger.warn('Invalid signal received: missing required fields');
        return { executed: false, reason: 'Invalid signal' };
      }

      logger.trade(`📊 Signal received: ${signal.type.toUpperCase()} at $${signal.price}`);

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

      // AI Confirmation (if enabled)
      let aiDecision = null;
      if (this.aiConfirmation.isEnabled()) {
        logger.info('🤖 Requesting AI confirmation...');
        
        aiDecision = await this.aiConfirmation.analyzeSignal({
          signal,
          marketStructure,
          position,
          filterResults: signal.filterResults,
          recentBars: this.strategy.bars || [],
          indicators: {
            atr: strategyState.atr,
            rsi: strategyState.rsi,
            ema: strategyState.ema,
            sma: strategyState.sma,
            volumeRatio: strategyState.volumeRatio,
            bollingerBands: strategyState.bollingerBands,
            macd: strategyState.macd
          },
          accountInfo: {
            balance: accountBalance,
            dailyPnL: typeof this.lossLimits?.getDailyPnL === 'function' ? this.lossLimits.getDailyPnL() : 0
          },
          sessionInfo: this.sessionFilter.getStatus()
        });

        // Check if AI rejected the trade
        if (!this.aiConfirmation.shouldExecute(aiDecision)) {
          logger.warn(`🤖 AI REJECTED trade (score: ${aiDecision.score}/10): ${aiDecision.reasoning}`);
          logger.info(`   Confidence: ${aiDecision.confidence}%, Risk: ${aiDecision.riskAssessment}, Factors: ${(aiDecision.keyFactors || []).join(', ')}`);
          
          // Send notification about AI rejection
          await this.notifications.aiTradeRejected({
            signal,
            aiDecision,
            position,
            marketStructure
          });

          return { 
            executed: false, 
            reason: `AI rejected: ${aiDecision.reasoning}`,
            aiDecision 
          };
        }

        logger.success(`🤖 AI CONFIRMED trade (score: ${aiDecision.score}/10, ${aiDecision.confidence}% confidence)`);
        logger.info(`   Reasoning: ${aiDecision.reasoning}`);
      }

      // Place market entry + OCO (stop + target) as separate orders
      // This gives us explicit stopOrderId for BE stop modification
      const action = signal.type === 'buy' ? 'Buy' : 'Sell';
      const exitAction = signal.type === 'buy' ? 'Sell' : 'Buy';
      logger.trade(`Placing ${action} market entry for ${position.contracts} contracts...`);

      // CRITICAL: Set currentPosition BEFORE placing the market order.
      // The fill can arrive via WebSocket within milliseconds of the order,
      // and handleFill() needs currentPosition to exist so it can detect
      // entry vs exit fills and emit the entryFilled event.
      this.currentPosition = {
        side: action,
        quantity: position.contracts,
        entryPrice: signal.price,
        stopLoss: position.stopPrice,
        target: position.targetPrice,
        risk: position.totalRisk,
        orderId: null,        // updated after market order
        stopOrderId: null,    // updated after OCO
        targetOrderId: null,  // updated after OCO
        entryTime: new Date(),
        // V2 metadata
        strategyName: signal.strategy || 'unknown',
        confluenceScore: signal.confluenceScore || null,
        vwapState: signal.vwapState || null,
        partialProfitEnabled: signal.partialProfitEnabled === true,
        partialProfitR: signal.partialProfitR || null,
        moveStopToBE: signal.moveStopToBE === true,
      };

      // Stash notification data on position — notification is sent AFTER fill arrives
      // so we can show the actual fill price, not the signal price
      this.currentPosition._notificationData = {
        signal,
        position,
        marketStructure,
        filterResults: signal.filterResults,
        aiDecision
      };

      const entryOrder = await this.client.placeMarketOrder(
        this.account.id,
        this.contract.id,
        position.contracts,
        action
      );

      this.currentPosition.orderId = entryOrder.orderId;
      logger.success(`✓ Entry order placed: ${entryOrder.orderId || 'pending'}`);

      // Place OCO: Stop + Limit target with absolute prices
      // Returns { orderId: stopId, ocoId: targetId }
      logger.trade(`Placing OCO: ${exitAction} Stop @ ${position.stopPrice.toFixed(2)} | Limit @ ${position.targetPrice.toFixed(2)}`);
      const oco = await this.client.placeOCO(
        this.account.name || this.account.id.toString(),
        this.account.id,
        this.contract.name,
        position.contracts,
        exitAction,
        position.stopPrice,
        position.targetPrice
      );

      const stopOrderId = oco.orderId;
      const targetOrderId = oco.ocoId;
      this.currentPosition.stopOrderId = stopOrderId;
      this.currentPosition.targetOrderId = targetOrderId;
      logger.success(`✓ OCO placed: stopOrderId=${stopOrderId}, targetOrderId=${targetOrderId}`);

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

      // Update strategy position
      this.strategy.setPosition(this.currentPosition);

      // Initialize trailing stop if enabled
      if (this.config.trailingStopEnabled) {
        this.trailingStop.initializeTrail({
          id: entryOrder.orderId,
          ...this.currentPosition,
          atr: this.strategy.atr,
          stopOrderId: stopOrderId
        });
      }

      // Initialize profit manager
      this.profitManager.initializePosition({
        id: entryOrder.orderId,
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
    } finally {
      // CRITICAL FIX: Always release the lock
      this._processingSignal = false;
      // If no position was opened (signal rejected/failed), reset strategy's signalFired
      // so it can generate new signals. Without this, signalFired stays true forever.
      if (!this.currentPosition && this.strategy && typeof this.strategy.onSignalRejected === 'function') {
        this.strategy.onSignalRejected();
      }
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
