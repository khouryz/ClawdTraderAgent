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

    // Slippage guard: tick price getter wired by InstrumentRunner/TradovateBot
    this._getTickPrice = null;
    this._maxEntrySlippagePts = config.maxEntrySlippagePts || 5;

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
    // Remove orphaned singleContractProfitLock listener if trade closed without triggering it
    if (this._singleContractProfitLockHandler && this.profitManager) {
      this.profitManager.removeListener('singleContractProfitLock', this._singleContractProfitLockHandler);
      this._singleContractProfitLockHandler = null;
    }
  }

  /**
   * Update position after entry fill with actual fill price and recalculated stop/target.
   * Called by InstrumentRunner when the entry fill arrives at a different price than signal.
   * @param {Object} fillData - { fillPrice, signalPrice, slippage, newStop, newTarget }
   */
  updatePositionFromFill(fillData) {
    if (!this.currentPosition) return;
    const { fillPrice, signalPrice, newStop, newTarget } = fillData;
    this.currentPosition.entryPrice = fillPrice;
    this.currentPosition.signalPrice = signalPrice;
    // Stop stays at structural level (newStop === original stop from signal)
    this.currentPosition.stopLoss = newStop;
    this.currentPosition.target = newTarget;
    // Update risk based on actual fill-to-stop distance (may be wider with adverse slippage)
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
   * Set tick price getter for slippage guard.
   * Called by InstrumentRunner/TradovateBot after initialization.
   * @param {Function} fn - Returns { price, receivedAt, ageMs } or null
   */
  setTickPriceGetter(fn) {
    this._getTickPrice = fn;
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

      // For limit_structural entries, the strategy pre-computes targetPrice using the
      // original structural stop distance (5m bar close to stop), not limit-to-stop.
      // RiskManager recalculates from limit entry → stop, which compresses the target.
      // Override with the signal's structural target when available.
      if (signal.orderType === 'Limit' && signal.targetPrice) {
        position.targetPrice = signal.targetPrice;
      }

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

      // ═══════════════════════════════════════════════════════════════
      //  LAYER 1: PRE-ORDER SLIPPAGE GUARD
      //  Check real-time tick price vs signal price BEFORE placing order.
      //  Rejects if market has moved too far from the signal price.
      //  Fail-open: if no tick data available, proceed with order.
      // ═══════════════════════════════════════════════════════════════
      const action = signal.type === 'buy' ? 'Buy' : 'Sell';
      const exitAction = signal.type === 'buy' ? 'Sell' : 'Buy';

      if (signal.orderType !== 'Limit' && this._getTickPrice) {
        const tick = this._getTickPrice();
        if (tick && tick.price !== null && tick.ageMs !== null && tick.ageMs < 5000) {
          const isLong = signal.type === 'buy';
          // Adverse slippage: for buys, tick above signal; for sells, tick below signal
          const adverseSlippage = isLong
            ? tick.price - signal.price
            : signal.price - tick.price;
          if (adverseSlippage > this._maxEntrySlippagePts) {
            logger.warn(`🛡️ SLIPPAGE GUARD: Rejecting ${signal.type.toUpperCase()} — tick $${tick.price.toFixed(2)} is ${adverseSlippage.toFixed(1)}pt adverse from signal $${signal.price.toFixed(2)} (max: ${this._maxEntrySlippagePts}pt)`);
            await this.notifications.send(
              `🛡️ <b>SLIPPAGE GUARD</b>\n` +
              `${signal.strategy || ''} ${signal.type.toUpperCase()} rejected\n` +
              `Signal: $${signal.price.toFixed(2)}\n` +
              `Market: $${tick.price.toFixed(2)}\n` +
              `Slippage: ${adverseSlippage.toFixed(1)}pt > ${this._maxEntrySlippagePts}pt max`
            ).catch(() => {});
            return { executed: false, reason: `Slippage guard: ${adverseSlippage.toFixed(1)}pt adverse > ${this._maxEntrySlippagePts}pt max` };
          }
          logger.info(`✅ Slippage check: tick $${tick.price.toFixed(2)} vs signal $${signal.price.toFixed(2)} (${adverseSlippage.toFixed(1)}pt adverse, max ${this._maxEntrySlippagePts}pt)`);
        } else {
          logger.info(`ℹ️ Slippage guard: No recent tick (age=${tick ? tick.ageMs + 'ms' : 'none'}) — proceeding (fail-open)`);
        }
      }

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
        profitTargetR: position.riskRewardRatio || 5,
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
        // Layer 2 post-fill risk check: max allowed risk per trade
        _maxRiskPerTrade: this.config.riskPerTrade?.max || 60,
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

      // CRITICAL: Set _isLimitEntry and _ocoParams BEFORE placing the order.
      // The fill can arrive via WebSocket props routing DURING the await on
      // placeLimitOrder/placeMarketOrder. The entryFilled handler needs _ocoParams
      // to place the OCO bracket and _isLimitEntry for target calculation.
      // Without this, a fast fill leaves the position naked (no stop/target).
      this.currentPosition._isLimitEntry = signal.orderType === 'Limit';
      this.currentPosition._ocoParams = {
        accountSpec: this.account.name || this.account.id.toString(),
        accountId: this.account.id,
        contractName: this.contract.name,
        contracts: position.contracts,
        exitAction,
        signalStopPrice: position.stopPrice,
        signalTargetPrice: position.targetPrice,
      };

      let entryOrder;
      if (signal.orderType === 'Limit') {
        // Limit entry: place at the signal's limit price (from limit_structural mode)
        logger.trade(`Placing ${action} LIMIT entry @ $${signal.price.toFixed(2)} for ${position.contracts} contracts...`);
        entryOrder = await this.client.placeLimitOrder(
          this.account.id,
          this.contract.id,
          position.contracts,
          action,
          signal.price
        );
      } else {
        // Market entry (default)
        logger.trade(`Placing ${action} MARKET entry for ${position.contracts} contracts...`);
        entryOrder = await this.client.placeMarketOrder(
          this.account.id,
          this.contract.id,
          position.contracts,
          action
        );
      }

      this.currentPosition.orderId = entryOrder.orderId;
      logger.success(`✓ Entry order placed (${signal.orderType || 'Market'}): ${entryOrder.orderId || 'pending'}`);

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

      // Initialize trailing stop if enabled (stopOrderId is null here;
      // it gets updated by InstrumentRunner after OCO is placed post-fill)
      if (this.config.trailingStopEnabled) {
        this.trailingStop.initializeTrail({
          id: entryOrder.orderId,
          ...this.currentPosition,
          atr: this.strategy.atr,
          stopOrderId: null
        });
      }

      // Initialize profit manager
      this.profitManager.initializePosition({
        id: entryOrder.orderId,
        ...this.currentPosition
      });

      // Listen for single contract profit lock events
      // Store reference so clearPosition can remove it if trade closes without triggering
      this._singleContractProfitLockHandler = async (data) => {
        await this.notifications.singleContractProfitLock(data);
      };
      this.profitManager.once('singleContractProfitLock', this._singleContractProfitLockHandler);

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

      // CRITICAL: Clear currentPosition if it was set before the error.
      // currentPosition is set BEFORE placeLimitOrder/placeMarketOrder (line ~274)
      // so the fill handler can detect entry fills. If the order placement throws,
      // currentPosition is left stale — the bot thinks it has a position that
      // doesn't exist on exchange, and signalFired stays true forever.
      if (this.currentPosition) {
        logger.warn(`Clearing stale position state after order placement failure`);
        this.currentPosition = null;
        this.currentTradeId = null;
      }
      
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
