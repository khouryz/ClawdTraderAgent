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
    this._slippageByStrategy = config.slippageByStrategy || {};

    // Deferred entry: monitor 1s bar stream when adverse slippage exceeds threshold.
    // Evaluated event-driven (one check per bar1s) via feedDeferredTick().
    this._deferredEntryWindowMs = (config.deferredEntryWindowSec || 60) * 1000;
    this._pendingDeferredEntry = null;

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
        // Resolve per-strategy threshold, fall back to global default
        const maxSlippage = (signal.strategy && this._slippageByStrategy[signal.strategy] !== undefined)
          ? this._slippageByStrategy[signal.strategy]
          : this._maxEntrySlippagePts;
        const tick = this._getTickPrice();
        if (tick && tick.price !== null && tick.ageMs !== null && tick.ageMs < 5000) {
          const isLong = signal.type === 'buy';
          // Adverse slippage: for buys, tick above signal; for sells, tick below signal
          const adverseSlippage = isLong
            ? tick.price - signal.price
            : signal.price - tick.price;
          // Absolute divergence: detect cross-contract or stale data issues
          // If tick is more than 2x the max slippage away in ANY direction, reject
          const absDivergence = Math.abs(tick.price - signal.price);
          const absDivergenceMax = Math.max(maxSlippage * 2, 10); // at least 10pt
          if (absDivergence > absDivergenceMax) {
            logger.error(`🛡️ SLIPPAGE GUARD: Rejecting ${signal.strategy || ''} ${signal.type.toUpperCase()} — PRICE DIVERGENCE: tick $${tick.price.toFixed(2)} vs signal $${signal.price.toFixed(2)} (${absDivergence.toFixed(1)}pt apart, max ${absDivergenceMax}pt) — possible contract roll or stale data`);
            return { executed: false, reason: `Slippage guard: price divergence ${absDivergence.toFixed(1)}pt > ${absDivergenceMax}pt (possible contract roll)` };
          }
          if (adverseSlippage > maxSlippage && !signal.stopTriggered) {
            // Brooks stop-entry (stopTriggered) is a stop-MARKET firing on the break:
            // the harness fills it immediately at the break with no deferral, so skip the
            // deferred-entry path here for exact parity. The absolute-divergence reject
            // above still applies (contract-roll / stale-data safety).
            logger.warn(`🛡️ SLIPPAGE GUARD: ${signal.strategy || ''} ${signal.type.toUpperCase()} — tick $${tick.price.toFixed(2)} is ${adverseSlippage.toFixed(1)}pt adverse from signal $${signal.price.toFixed(2)} (max: ${maxSlippage}pt) — entering deferred entry mode`);
            const deferResult = await this._awaitDeferredEntry(signal, maxSlippage, tick);
            if (!deferResult.success) {
              return { executed: false, reason: deferResult.reason };
            }
            logger.success(`✅ Deferred entry triggered: price returned within ${maxSlippage}pt threshold after ${deferResult.elapsedSec.toFixed(0)}s (tick $${deferResult.tickPrice.toFixed(2)})`);
          } else {
            logger.info(`✅ Slippage check [${signal.strategy || 'default'}${signal.tickTriggered ? ' TICK-ENTRY' : ''}]: tick $${tick.price.toFixed(2)} vs signal $${signal.price.toFixed(2)} (${adverseSlippage.toFixed(1)}pt adverse, max ${maxSlippage}pt)`);
          }
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
        instrument: signal.instrument || null,   // tag so exit notif / journals show MNQ vs MES
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
        // Marketable-limit entry (e.g. MES): place the limit a small buffer BEYOND
        // the signal price so it crosses and fills immediately up to the buffer —
        // capping worst-case slippage at limitBufferTicks while never paying more.
        //   buy  → signal + buffer (fills at <= signal + buffer)
        //   sell → signal - buffer (fills at >= signal - buffer)
        // Stop/target stay at the strategy's structural prices (overridden above),
        // and currentPosition.entryPrice stays the signal price so post-fill
        // slippage is measured accurately against the signal.
        const bufferTicks = signal.limitBufferTicks || 0;
        const rawLimit = action === 'Buy'
          ? signal.price + bufferTicks * specs.tickSize
          : signal.price - bufferTicks * specs.tickSize;
        // Align to the contract tick. Float math on a 0.10-tick instrument (M2K) can
        // leave dust (e.g. 2980.9 - 0.1 = 2980.8000000000002) that the exchange rejects;
        // 0.25-tick (MNQ/MES) is exact so this is a no-op there.
        const limitPrice = parseFloat((Math.round(rawLimit / specs.tickSize) * specs.tickSize).toFixed(2));
        const bufLabel = bufferTicks > 0 ? ` (signal $${signal.price.toFixed(2)} ${action === 'Buy' ? '+' : '-'}${bufferTicks} tick)` : '';
        logger.trade(`Placing ${action} LIMIT entry @ $${limitPrice.toFixed(2)}${bufLabel} for ${position.contracts} contracts...`);
        entryOrder = await this.client.placeLimitOrder(
          this.account.id,
          this.contract.id,
          position.contracts,
          action,
          limitPrice
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

      // CRITICAL: If the order was REJECTED by the exchange (e.g. account locked,
      // insufficient margin, daily loss limit hit), halt trading immediately.
      // The exchange rejected us for a reason — continuing will just produce more rejections.
      if (error.isOrderRejection) {
        logger.error(`🚨 ORDER REJECTED BY EXCHANGE — halting trading`);
        this.lossLimits.halt('ORDER_REJECTED', `Order rejected: ${error.message}`);
        await this.notifications.send(
          `🚨 <b>ORDER REJECTED BY EXCHANGE</b>\n` +
          `${error.message}\n` +
          `Trading halted — manual review needed.`
        ).catch(() => {});
        this.emit('tradingHalted', { reason: 'ORDER_REJECTED', message: error.message });
      } else if (errorInfo.recovery.action === 'HALT') {
        logger.error(`Halting trading: ${errorInfo.recovery.message}`);
        this.lossLimits.halt(errorInfo.code, errorInfo.recovery.message || `Halted: ${errorInfo.code}`);
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

  /**
   * Monitor the 1s bar stream for up to the configured window (default 60s)
   * waiting for price to return within the adverse slippage threshold. Resolves
   * when a 1s bar's low/high re-enters range or the window expires. Driven
   * event-style by feedDeferredTick() — one evaluation per bar, no polling.
   */
  async _awaitDeferredEntry(signal, maxSlippage, initialTick) {
    const isLong = signal.type === 'buy';
    const tag = signal.strategy || 'default';
    // Same divergence bound as the upfront guard — a glitch wick or spiky 1s
    // low/high can't trigger a fill far from the signal price.
    const divMax = Math.max(maxSlippage * 2, 10);
    const startMs = Date.now();

    logger.info(`⏳ Deferred entry [${tag}]: monitoring 1s bars for up to ${this._deferredEntryWindowMs / 1000}s — waiting for price within ${maxSlippage}pt of signal $${signal.price.toFixed(2)}`);

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this._pendingDeferredEntry = null;
        resolve(result);
      };

      // Evaluate one 1s bar: fill if its low (long) / high (short) returned to range.
      const evaluate = (bar) => {
        // Abort if a position was taken or processing was cancelled
        if (this.currentPosition || !this._processingSignal) {
          return settle({ success: false, reason: 'Deferred entry cancelled: position state changed' });
        }
        if (!bar || bar.close === undefined) return;
        const checkPrice = isLong ? (bar.low ?? bar.close) : (bar.high ?? bar.close);
        const adverseSlippage = isLong ? checkPrice - signal.price : signal.price - checkPrice;
        if (Math.abs(checkPrice - signal.price) <= divMax && adverseSlippage <= maxSlippage) {
          settle({ success: true, tickPrice: checkPrice, elapsedSec: (Date.now() - startMs) / 1000 });
        }
      };

      // Evaluated once per 1s bar by feedDeferredTick() — exact parity with the
      // backtester's scanDeferredEntry (every bar checked, no timer sampling).
      this._pendingDeferredEntry = { settle, onBar: evaluate };

      // Re-check the trigger bar's low/high immediately. The upfront guard only
      // tested its close; the backtester's scanDeferredEntry re-examines the same
      // execution bar via low/high, so live must too (else it waits an extra bar).
      if (initialTick) {
        evaluate({ low: initialTick.low, high: initialTick.high, close: initialTick.price });
      }

      // Arm the deadline timer only if the trigger bar didn't already fill.
      if (!settled) {
        timer = setTimeout(() => {
          logger.warn(`⏳ Deferred entry [${tag}]: TIMEOUT — price did not return within ${maxSlippage}pt of signal $${signal.price.toFixed(2)} within ${this._deferredEntryWindowMs / 1000}s`);
          settle({ success: false, reason: `Deferred entry timeout: price did not return within ${maxSlippage}pt in ${this._deferredEntryWindowMs / 1000}s` });
        }, this._deferredEntryWindowMs);
      }
    });
  }

  /**
   * Feed a 1s bar into a pending deferred entry, if one is active.
   * Called by InstrumentRunner on every bar1s event so the deferred entry
   * evaluates every bar exactly once (parity with the backtester).
   */
  feedDeferredTick(bar1s) {
    if (this._pendingDeferredEntry && typeof this._pendingDeferredEntry.onBar === 'function') {
      this._pendingDeferredEntry.onBar(bar1s);
    }
  }

  cancelDeferredEntry() {
    if (this._pendingDeferredEntry && typeof this._pendingDeferredEntry.settle === 'function') {
      logger.info('⏳ Deferred entry cancelled externally');
      this._processingSignal = false;
      this._pendingDeferredEntry.settle({ success: false, reason: 'Deferred entry cancelled externally' });
    }
  }
}

module.exports = SignalHandler;
