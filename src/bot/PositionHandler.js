/**
 * PositionHandler - Manages position lifecycle and fill processing
 * 
 * Responsibilities:
 * - Process fill notifications
 * - Calculate P&L and R-multiples
 * - Determine exit reasons
 * - Record trades in performance tracker
 * - Update loss limits
 * - Send exit notifications
 */

const EventEmitter = require('events');
const logger = require('../utils/logger');

class PositionHandler extends EventEmitter {
  /**
   * @param {Object} dependencies - Injected dependencies
   * @param {Object} dependencies.performance - PerformanceTracker instance
   * @param {Object} dependencies.lossLimits - LossLimitsManager instance
   * @param {Object} dependencies.tradeAnalyzer - TradeAnalyzer instance
   * @param {Object} dependencies.notifications - Notifications instance
   * @param {Object} dependencies.trailingStop - TrailingStopManager instance
   * @param {Object} dependencies.profitManager - ProfitManager instance
   * @param {Object} dependencies.strategy - Strategy instance
   * @param {Object} dependencies.dynamicSizing - DynamicSizing instance
   * @param {Object} config - Bot configuration
   */
  constructor(dependencies, config) {
    super();
    this.performance = dependencies.performance;
    this.lossLimits = dependencies.lossLimits;
    this.tradeAnalyzer = dependencies.tradeAnalyzer;
    this.notifications = dependencies.notifications;
    this.trailingStop = dependencies.trailingStop;
    this.profitManager = dependencies.profitManager;
    this.strategy = dependencies.strategy;
    this.dynamicSizing = dependencies.dynamicSizing;
    this.config = config;
    
    this.contract = null;
    this.dynamicSizingEnabled = config.dynamicSizingEnabled || false;
  }

  /**
   * Set contract for position handling
   * @param {Object} contract - Tradovate contract
   */
  setContract(contract) {
    this.contract = contract;
  }

  /**
   * Handle order update
   * @param {Object} order - Order update from WebSocket
   */
  handleOrderUpdate(order) {
    logger.info(`Order update: ${order.ordStatus} - ${JSON.stringify(order)}`);
    this.emit('orderUpdate', order);
  }

  /**
   * Handle fill notification
   * @param {Object} fill - Fill notification from WebSocket
   * @param {Object} currentPosition - Current position from SignalHandler
   * @param {string} currentTradeId - Current trade ID from SignalHandler
   * @returns {Object} Result with P&L info if exit fill
   */
  async handleFill(fill, currentPosition, currentTradeId) {
    if (!fill) {
      logger.warn('Received null fill notification');
      return { isExit: false };
    }
    
    const stratLabel = currentPosition?.strategyName ? ` [${currentPosition.strategyName}]` : '';
    logger.success(`🎯 FILL${stratLabel}: ${fill.action} ${fill.qty || fill.quantity || 1} @ ${fill.price}`);
    
    // If this is an exit fill, record the trade
    if (currentPosition && fill.action !== currentPosition.side) {
      return await this._processExitFill(fill, currentPosition, currentTradeId);
    }

    return { isExit: false };
  }

  /**
   * Process an exit fill
   * @private
   */
  async _processExitFill(fill, currentPosition, currentTradeId) {
    // CRITICAL FIX: Use pointValue (not tickValue) for P&L calculation.
    // pointValue = dollar value per 1 point of price movement.
    // MNQ: tickSize=0.25, tickValue=$0.50, pointValue=$2.00
    // MES: tickSize=0.25, tickValue=$1.25, pointValue=$5.00
    const { CONTRACTS } = require('../utils/constants');
    const baseSymbol = (this.contract?.name || 'MES').substring(0, 3);
    const contractSpecs = CONTRACTS[baseSymbol] || CONTRACTS.MES;
    const pointValue = contractSpecs.pointValue;
    const fillQty = fill.qty || fill.quantity || 1;
    const pnl = currentPosition.side === 'Buy'
      ? (fill.price - currentPosition.entryPrice) * fillQty * pointValue
      : (currentPosition.entryPrice - fill.price) * fillQty * pointValue;

    // Calculate R multiple (riskAmount should already be in dollars from SignalHandler)
    const riskAmount = currentPosition.risk || 
      Math.abs(currentPosition.entryPrice - currentPosition.stopLoss) * fillQty * pointValue;
    const rMultiple = riskAmount > 0 ? pnl / riskAmount : 0;

    // Determine exit reason
    const exitReason = this._determineExitReason(fill, pnl, currentPosition);

    // Record trade in performance tracker
    this.performance.recordTrade({
      symbol: this.contract?.name || 'MES',
      side: currentPosition.side,
      quantity: fillQty,
      entryPrice: currentPosition.entryPrice,
      exitPrice: fill.price,
      stopLoss: currentPosition.stopLoss,
      target: currentPosition.target,
      pnl,
      exitReason
    });

    // Record in loss limits
    this.lossLimits.recordTrade(pnl);

    // Record trade exit in learning system and get post-analysis
    let postAnalysis = null;
    if (currentTradeId) {
      const completedTrade = await this.tradeAnalyzer.recordTradeExit(currentTradeId, {
        exitPrice: fill.price,
        exitReason,
        pnl,
        rMultiple
      });
      postAnalysis = completedTrade?.postAnalysis;
    }

    // Send detailed trade exit notification via Telegram
    await this.notifications.tradeExitDetailed({
      trade: currentPosition,
      pnl,
      rMultiple,
      exitPrice: fill.price,
      exitReason,
      postAnalysis
    });

    // Record in dynamic sizing
    if (this.dynamicSizingEnabled && this.dynamicSizing) {
      this.dynamicSizing.recordTrade(pnl >= 0, rMultiple);
    }

    // Check if we should send feedback summary (every 10 trades)
    const feedback = this.tradeAnalyzer.getFeedbackSummary();
    if (feedback.totalTrades > 0 && feedback.totalTrades % 10 === 0) {
      await this.notifications.feedbackSummary(feedback);
    }

    // Check if position is fully closed
    const isFullyClosed = fillQty >= currentPosition.quantity;
    
    if (isFullyClosed) {
      // Clean up managers
      this.strategy.setPosition(null);
      this.trailingStop.removeTrail(fill.orderId);
      this.profitManager.closePosition(fill.orderId);
      
      this.emit('positionClosed', {
        pnl,
        rMultiple,
        exitReason,
        exitPrice: fill.price
      });
    }

    return {
      isExit: true,
      isFullyClosed,
      pnl,
      rMultiple,
      exitReason,
      exitPrice: fill.price,
      postAnalysis
    };
  }

  /**
   * Determine exit reason based on fill data and P&L
   * @private
   */
  _determineExitReason(fill, pnl, currentPosition) {
    if (fill.reason) return fill.reason;
    
    if (currentPosition) {
      const exitPrice = fill.price;
      const stopLoss = currentPosition.stopLoss;
      const target = currentPosition.target;
      const isLong = currentPosition.side === 'Buy';
      
      // Check if hit stop loss (within 0.5 points tolerance)
      if (isLong && exitPrice <= stopLoss + 0.5) return 'Stop Loss';
      if (!isLong && exitPrice >= stopLoss - 0.5) return 'Stop Loss';
      
      // Check if hit target (within 0.5 points tolerance)
      if (isLong && exitPrice >= target - 0.5) return 'Take Profit';
      if (!isLong && exitPrice <= target + 0.5) return 'Take Profit';
      
      // Check if trailing stop
      if (pnl > 0) return 'Trailing Stop';
    }
    
    return 'Manual/Unknown';
  }

  /**
   * Handle position update from WebSocket
   * @param {Object} position - Position update
   */
  handlePositionUpdate(position) {
    logger.info(`Position: ${JSON.stringify(position)}`);
    
    // If position is closed, clear strategy position
    if (!position || position.netPos === 0) {
      this.strategy.setPosition(null);
      this.emit('positionCleared');
    }
  }
}

module.exports = PositionHandler;
