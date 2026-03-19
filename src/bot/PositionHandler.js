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
const { CONTRACTS } = require('../utils/constants');

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
    // Only log status changes, not every field update
    if (order && order.ordStatus) {
      logger.info(`Order update: ${order.ordStatus} orderId=${order.id || order.orderId}`);
    }
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

    // Entry fill: same side as position — update entryPrice to actual fill price
    if (currentPosition && fill.action === currentPosition.side) {
      const signalPrice = currentPosition.entryPrice;
      const fillPrice = fill.price;
      const slippage = fillPrice - signalPrice;

      // Stop stays at the original structural level (e.g. pullback bar low + buffer).
      // It doesn't move with slippage — the market structure hasn't changed.
      const newStop = currentPosition.stopLoss; // structural level — unchanged
      const isLong = currentPosition.side === 'Buy';
      const profitTargetR = currentPosition.profitTargetR || 5;

      // For limit_structural entries, the strategy pre-computes the correct target
      // using the ORIGINAL stop distance (5m bar close to stop), not fill-to-stop.
      // The limit entry is closer to the stop, so recalculating from fill-to-stop
      // would compress the target by ~30%. Use the signal's target when available.
      let newTarget;
      if (currentPosition.target && currentPosition._isLimitEntry) {
        // Limit entry: keep signal's pre-computed target (uses original structural stop distance)
        newTarget = currentPosition.target;
      } else {
        // Market entry: recalculate target from fill price to account for slippage
        const newStopDist = Math.abs(fillPrice - newStop);
        newTarget = isLong
          ? fillPrice + (newStopDist * profitTargetR)
          : fillPrice - (newStopDist * profitTargetR);
      }

      // Round target to valid tick increment (e.g. 0.25 for MNQ)
      // Tradovate rejects orders with non-tick-aligned prices
      const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
      const tickSize = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { tickSize: 0.25 }).tickSize;
      newTarget = PositionHandler.roundToTick(newTarget, tickSize, isLong ? 'floor' : 'ceil');

      if (signalPrice !== fillPrice) {
        const origStopDist = Math.abs(signalPrice - newStop);
        const newStopDist = Math.abs(fillPrice - newStop);
        logger.info(`📝 Entry fill adjustment: signal=$${signalPrice.toFixed(2)} → fill=$${fillPrice.toFixed(2)} (slippage: ${slippage >= 0 ? '+' : ''}${slippage.toFixed(2)}pt)`);
        logger.info(`   Stop: $${newStop.toFixed(2)} (structural, unchanged) | Target: $${newTarget.toFixed(2)} (${currentPosition._isLimitEntry ? 'original structural' : profitTargetR + 'R from fill'})`);
        if (newStopDist > origStopDist * 1.1) {
          logger.warn(`⚠️ Adverse slippage widened stop distance: ${origStopDist.toFixed(1)}pt → ${newStopDist.toFixed(1)}pt (+${((newStopDist/origStopDist - 1)*100).toFixed(0)}% more risk)`);
        }
      }

      currentPosition.entryPrice = fillPrice;
      currentPosition.signalPrice = signalPrice;
      currentPosition.target = newTarget;
      // stopLoss already at structural level — no change needed

      // ═══════════════════════════════════════════════════════════════
      //  LAYER 2: POST-FILL RISK CHECK
      //  If actual risk (fill-to-stop × contracts × pointValue) exceeds
      //  150% of maxRiskPerTrade, flag for emergency close.
      //  This catches slippage that occurs DURING execution (between
      //  the pre-order guard check and the fill).
      // ═══════════════════════════════════════════════════════════════
      const contractSpecs = CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 };
      const pointValue = contractSpecs.pointValue;
      const maxRisk = currentPosition._maxRiskPerTrade || 60;
      const fillQtyEntry = fill.qty || fill.quantity || currentPosition.quantity || 1;
      const actualRisk = Math.abs(fillPrice - newStop) * fillQtyEntry * pointValue;
      if (actualRisk > maxRisk * 1.5) {
        logger.error(`🚨 POST-FILL RISK CHECK: Actual risk $${actualRisk.toFixed(2)} exceeds 150% of max $${maxRisk} — flagging emergency close`);
        this.emit('entryFilled', {
          fillPrice,
          signalPrice,
          slippage,
          newStop,
          newTarget,
          position: currentPosition
        });
        this.emit('postFillRiskExceeded', {
          fillPrice,
          actualRisk,
          maxRisk,
          position: currentPosition
        });
        return { isExit: false, emergencyClose: true };
      }

      this.emit('entryFilled', {
        fillPrice,
        signalPrice,
        slippage,
        newStop,
        newTarget,
        position: currentPosition
      });
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

    // Check if position is fully closed
    const isFullyClosed = fillQty >= currentPosition.quantity;

    // ═══════════════════════════════════════════════════════════════
    //  IMPORTANT: Clear position SYNCHRONOUSLY before any awaits.
    //  _processExitFill is async — it awaits Telegram notifications
    //  and trade analytics below. During those awaits, the WebSocket
    //  delivers a netPos=0 position update which calls
    //  handlePositionUpdate(). If strategy.position is still non-null
    //  at that point, the guard fails and we get duplicate "Position
    //  closed" / "Cooldown started" messages. By clearing here first,
    //  handlePositionUpdate sees null and correctly skips.
    // ═══════════════════════════════════════════════════════════════
    if (isFullyClosed) {
      // Notify strategy of trade result (for AI context on next signal)
      // Treat P&L within 1 tick as breakeven to account for slippage
      if (typeof this.strategy.onTradeResult === 'function') {
        const beThreshold = (contractSpecs.pointValue || 2) * 2 * fillQty;
        const tradeResult = Math.abs(pnl) <= beThreshold ? 'breakeven' : pnl > 0 ? 'win' : 'loss';
        this.strategy.onTradeResult(tradeResult);
      }

      // Clean up managers
      this.strategy.setPosition(null);
      // Use entry orderId (not exit fill.orderId) to match the IDs used during initialization
      const entryOrderId = currentPosition.orderId || fill.orderId;
      this.trailingStop.removeTrail(entryOrderId);
      this.profitManager.closePosition(entryOrderId);
    }

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
    this.lossLimits.recordTrade(pnl, { symbol: this.contract?.name || 'MNQ' });

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

    // Emit positionClosed AFTER notification is sent so that
    // _emergencyCloseAndHalt's wait-for-positionClosed fires after the
    // exit notification has been delivered to Telegram.
    if (isFullyClosed) {
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
      // Emergency close tagged by _emergencyCloseAndHalt
      if (currentPosition._emergencyCloseReason) {
        return `Emergency Close (${currentPosition._emergencyCloseReason})`;
      }

      const exitPrice = fill.price;
      const stopLoss = currentPosition.stopLoss;
      const target = currentPosition.target;
      const isLong = currentPosition.side === 'Buy';
      
      // Check if hit stop loss (within 0.5 points tolerance)
      // Guard against null/undefined stopLoss (e.g. adopted positions with no stop order)
      if (stopLoss != null) {
        const hitStop = isLong ? exitPrice <= stopLoss + 0.5 : exitPrice >= stopLoss - 0.5;
        if (hitStop) {
          // Distinguish BE stop from regular stop loss
          return currentPosition.breakEvenMoved ? 'Breakeven Stop' : 'Stop Loss';
        }
      }
      
      // Check if hit target (within 0.5 points tolerance)
      // Guard against null/undefined target (e.g. adopted positions with no target order)
      if (target != null) {
        if (isLong && exitPrice >= target - 0.5) return 'Take Profit';
        if (!isLong && exitPrice <= target + 0.5) return 'Take Profit';
      }
      
      // Check if trailing stop (exited in profit but not at target)
      if (pnl > 0) return 'Trailing Stop';
    }
    
    return 'Manual/Unknown';
  }

  /**
   * Handle position update from WebSocket
   * @param {Object} position - Position update
   */
  handlePositionUpdate(position) {
    // Only log meaningful position changes, not every update
    if (position && position.netPos !== undefined) {
      logger.info(`Position update: netPos=${position.netPos} contractId=${position.contractId}`);
    }
    
    // Only clear strategy position if this update is for our contract AND netPos is 0
    // Without the contract check, unrelated position updates could clear our active trade
    // Also skip if strategy.position is already null (fill handler already cleared it),
    // otherwise we get duplicate 'Position closed' / 'Cooldown started' messages.
    if (position && position.netPos === 0 && this.contract && position.contractId === this.contract.id) {
      if (this.strategy.position !== null) {
        this.strategy.setPosition(null);
      }
      this.emit('positionCleared');
    }
  }
  /**
   * Round a price to the nearest valid tick increment.
   * For targets: round toward the entry (floor for long, ceil for short)
   * to avoid overshooting and getting rejected.
   * @param {number} price - Raw price
   * @param {number} tickSize - Tick increment (e.g. 0.25)
   * @param {'floor'|'ceil'|'round'} mode - Rounding direction
   * @returns {number} Tick-aligned price
   */
  static roundToTick(price, tickSize = 0.25, mode = 'round') {
    const ticks = price / tickSize;
    let aligned;
    if (mode === 'floor') {
      aligned = Math.floor(ticks) * tickSize;
    } else if (mode === 'ceil') {
      aligned = Math.ceil(ticks) * tickSize;
    } else {
      aligned = Math.round(ticks) * tickSize;
    }
    // Fix floating point: round to same decimal places as tickSize
    const decimals = (tickSize.toString().split('.')[1] || '').length;
    return parseFloat(aligned.toFixed(decimals));
  }
}

module.exports = PositionHandler;
