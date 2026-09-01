/**
 * PositionHandler — execution-only position lifecycle and fill processing
 *
 * Processes fill notifications, calculates P&L and R-multiples, determines exit
 * reasons, records trades in performance tracker + loss limits, and sends exit
 * notifications.
 *
 * Stripped from the original: no strategy, no trailing stop, no profit manager,
 * no trade analyzer, no dynamic sizing. Pure fill → P&L → record → notify.
 */

const EventEmitter = require('events');
const logger = require('../utils/logger');
const { CONTRACTS } = require('../utils/constants');

class PositionHandler extends EventEmitter {
  /**
   * @param {Object} deps - { performance, lossLimits, notifications }
   * @param {Object} config - Bot configuration
   */
  constructor(deps, config) {
    super();
    this.performance = deps.performance;
    this.lossLimits = deps.lossLimits;
    this.notifications = deps.notifications;
    this.config = config;

    this.contract = null;

    // Partial fill accumulators (entry + exit)
    this._entryFillAccum = { qty: 0, totalValue: 0, emitted: false };
    this._exitFillAccum = { qty: 0, totalValue: 0 };
    // Re-entrancy guard: set true once a position is fully closed
    this._exitClosed = false;
  }

  setContract(contract) {
    this.contract = contract;
  }

  /**
   * Reset partial fill accumulators before placing a new entry order.
   */
  resetFillAccumulators() {
    this._entryFillAccum = { qty: 0, totalValue: 0, emitted: false };
    this._exitFillAccum = { qty: 0, totalValue: 0 };
    this._exitClosed = false;
  }

  /**
   * Handle order update from WebSocket.
   */
  handleOrderUpdate(order) {
    if (order && order.ordStatus) {
      logger.info(`Order update: ${order.ordStatus} orderId=${order.id || order.orderId}`);
    }
    this.emit('orderUpdate', order);
  }

  /**
   * Handle fill notification from WebSocket.
   * @param {Object} fill - Fill notification
   * @param {Object} currentPosition - Current position from SignalHandler
   * @param {string} currentTradeId - Current trade ID
   * @returns {Object} Result with P&L info if exit fill
   */
  async handleFill(fill, currentPosition, currentTradeId) {
    if (!fill) {
      logger.warn('Received null fill notification');
      return { isExit: false };
    }

    const stratLabel = currentPosition?.strategyName ? ` [${currentPosition.strategyName}]` : '';
    logger.success(`🎯 FILL${stratLabel}: ${fill.action} ${fill.qty || fill.quantity || 1} @ ${fill.price}`);

    // Exit fill: opposite side of position
    if (currentPosition && fill.action !== currentPosition.side) {
      return await this._processExitFill(fill, currentPosition, currentTradeId);
    }

    // Entry fill: same side as position
    if (currentPosition && fill.action === currentPosition.side) {
      // Adopted positions (re-adopted at startup) — don't recompute bracket
      if (currentPosition._adopted) {
        logger.warn(`📝 Same-side fill on adopted position — not recomputing bracket: ${fill.qty || fill.quantity || 1} @ $${fill.price}`);
        return { isExit: false, adoptedFill: true };
      }

      this._exitClosed = false;

      const fillQtyEntry = fill.qty || fill.quantity || 1;
      const expectedQty = currentPosition.quantity || 1;

      // Accumulate partial fills
      this._entryFillAccum.qty += fillQtyEntry;
      this._entryFillAccum.totalValue += fill.price * fillQtyEntry;

      const cumulativeQty = this._entryFillAccum.qty;
      const avgFillPrice = this._entryFillAccum.totalValue / cumulativeQty;

      // Partial fill — wait for more
      if (cumulativeQty < expectedQty) {
        logger.info(`📝 Partial entry fill: ${fillQtyEntry} @ $${fill.price.toFixed(2)} (${cumulativeQty}/${expectedQty}, avg $${avgFillPrice.toFixed(2)})`);
        return { isExit: false, isPartialEntry: true };
      }

      // All contracts filled
      if (this._entryFillAccum.emitted) {
        logger.info(`📝 Extra entry fill ignored (already emitted): ${fillQtyEntry} @ $${fill.price.toFixed(2)}`);
        return { isExit: false };
      }
      this._entryFillAccum.emitted = true;

      const fillPrice = avgFillPrice;
      const signalPrice = currentPosition.entryPrice;
      const slippage = fillPrice - signalPrice;

      // Stop stays at structural level. Adjust only if favorable slippage
      // pushed fill past/near the stop.
      let newStop = currentPosition.stopLoss;
      const isLong = currentPosition.side === 'Buy';
      const profitTargetR = currentPosition.profitTargetR || 5;

      const baseSymbol = (this.contract?.name || 'MNQ').substring(0, 3);
      const tickSize = (CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { tickSize: 0.25 }).tickSize;
      const minStopDistance = this.config.minStopPoints || 4;
      const currentStopDist = Math.abs(fillPrice - newStop);
      const stopOnWrongSide = isLong
        ? newStop >= fillPrice
        : newStop <= fillPrice;
      const stopTooClose = currentStopDist < minStopDistance;

      if (stopOnWrongSide || stopTooClose) {
        const adjustedStop = isLong
          ? fillPrice - minStopDistance
          : fillPrice + minStopDistance;
        newStop = PositionHandler.roundToTick(adjustedStop, tickSize, isLong ? 'floor' : 'ceil');
        const reason = stopOnWrongSide ? 'past structural stop' : `too close (${currentStopDist.toFixed(1)}pt)`;
        logger.warn(`⚠️ Favorable slippage pushed fill ${reason} — adjusting stop: $${currentPosition.stopLoss.toFixed(2)} → $${newStop.toFixed(2)}`);
      }

      // Recompute target from actual fill for true R:R
      const newStopDist = Math.abs(fillPrice - newStop);
      let newTarget = isLong
        ? fillPrice + (newStopDist * profitTargetR)
        : fillPrice - (newStopDist * profitTargetR);
      newTarget = PositionHandler.roundToTick(newTarget, tickSize, isLong ? 'floor' : 'ceil');

      if (signalPrice !== fillPrice) {
        logger.info(`📝 Entry fill: signal=$${signalPrice.toFixed(2)} → fill=$${fillPrice.toFixed(2)} (${cumulativeQty} contracts, slippage: ${slippage >= 0 ? '+' : ''}${slippage.toFixed(2)}pt)`);
        logger.info(`   Stop: $${newStop.toFixed(2)} | Target: $${newTarget.toFixed(2)} (${profitTargetR}R from fill)`);
      }

      currentPosition.entryPrice = fillPrice;
      currentPosition.signalPrice = signalPrice;
      currentPosition.target = newTarget;
      currentPosition.stopLoss = newStop;

      // Post-fill risk check
      const contractSpecs = CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 };
      const pointValue = contractSpecs.pointValue;
      const maxRisk = currentPosition._maxRiskPerTrade || 60;
      const actualRisk = Math.abs(fillPrice - newStop) * expectedQty * pointValue;
      if (actualRisk > maxRisk * 1.5) {
        logger.error(`🚨 POST-FILL RISK: Actual risk $${actualRisk.toFixed(2)} exceeds 150% of max $${maxRisk} — emergency close`);
        this.emit('entryFilled', {
          fillPrice, signalPrice, slippage, newStop, newTarget,
          position: currentPosition,
        });
        this.emit('postFillRiskExceeded', {
          fillPrice, actualRisk, maxRisk, position: currentPosition,
        });
        return { isExit: false, emergencyClose: true };
      }

      this.emit('entryFilled', {
        fillPrice, signalPrice, slippage, newStop, newTarget,
        position: currentPosition,
      });
    }

    return { isExit: false };
  }

  /**
   * Process an exit fill — compute P&L, record trade, notify.
   * @private
   */
  async _processExitFill(fill, currentPosition, currentTradeId) {
    const baseSymbol = (this.contract?.name || 'MES').substring(0, 3);
    const contractSpecs = CONTRACTS[baseSymbol] || CONTRACTS.MES;
    const pointValue = contractSpecs.pointValue;
    const fillQty = fill.qty || fill.quantity || 1;
    const expectedQty = currentPosition.quantity || 1;

    // Accumulate exit partial fills
    this._exitFillAccum.qty += fillQty;
    this._exitFillAccum.totalValue += fill.price * fillQty;

    const cumulativeExitQty = this._exitFillAccum.qty;
    const isFullyClosed = cumulativeExitQty >= expectedQty;

    if (!isFullyClosed) {
      const avgExitSoFar = this._exitFillAccum.totalValue / cumulativeExitQty;
      logger.info(`📝 Partial exit: ${fillQty} @ $${fill.price.toFixed(2)} (${cumulativeExitQty}/${expectedQty}, avg $${avgExitSoFar.toFixed(2)})`);
      const partialPnl = currentPosition.side === 'Buy'
        ? (fill.price - currentPosition.entryPrice) * fillQty * pointValue
        : (currentPosition.entryPrice - fill.price) * fillQty * pointValue;
      logger.info(`   Partial P&L: $${partialPnl.toFixed(2)}`);
      return { isExit: true, isFullyClosed: false, pnl: partialPnl, exitPrice: fill.price };
    }

    // Duplicate exit guard
    if (this._exitClosed) {
      logger.warn(`⚠️ Extra exit fill ignored — position already closed: ${fillQty} @ $${fill.price != null ? fill.price.toFixed(2) : '?'}`);
      return { isExit: true, isFullyClosed: true, duplicate: true, pnl: 0, exitPrice: fill.price };
    }
    this._exitClosed = true;

    // Final P&L using volume-weighted average exit price
    const avgExitPrice = this._exitFillAccum.totalValue / cumulativeExitQty;
    const totalPnl = currentPosition.side === 'Buy'
      ? (avgExitPrice - currentPosition.entryPrice) * expectedQty * pointValue
      : (currentPosition.entryPrice - avgExitPrice) * expectedQty * pointValue;

    const riskAmount = currentPosition.risk ||
      Math.abs(currentPosition.entryPrice - currentPosition.stopLoss) * expectedQty * pointValue;
    const rMultiple = riskAmount > 0 ? totalPnl / riskAmount : 0;

    const exitReason = this._determineExitReason(fill, totalPnl, currentPosition);

    // Reset accumulators
    this._entryFillAccum = { qty: 0, totalValue: 0, emitted: false };
    this._exitFillAccum = { qty: 0, totalValue: 0 };

    // Record in performance tracker (idempotent by entry orderId)
    const entryOrderId = currentPosition.orderId || fill.orderId;
    this.performance.recordTrade({
      id: entryOrderId,
      symbol: this.contract?.name || 'MNQ',
      side: currentPosition.side,
      quantity: expectedQty,
      entryPrice: currentPosition.entryPrice,
      exitPrice: avgExitPrice,
      stopLoss: currentPosition.stopLoss,
      target: currentPosition.target,
      pnl: totalPnl,
      exitReason,
    });

    // Record in loss limits (idempotent by tradeId)
    this.lossLimits.recordTrade(totalPnl, {
      symbol: this.contract?.name || 'MNQ',
      quantity: expectedQty,
      tradeId: entryOrderId,
    });

    // Send exit notification
    await this.notifications.tradeExitDetailed?.({
      trade: currentPosition,
      pnl: totalPnl,
      rMultiple,
      exitPrice: avgExitPrice,
      exitReason,
    }).catch(() => {});

    this.emit('positionClosed', {
      pnl: totalPnl,
      rMultiple,
      exitReason,
      exitPrice: avgExitPrice,
    });

    return {
      isExit: true,
      isFullyClosed: true,
      pnl: totalPnl,
      rMultiple,
      exitReason,
      exitPrice: avgExitPrice,
    };
  }

  /**
   * Determine exit reason based on fill data and P&L.
   * @private
   */
  _determineExitReason(fill, pnl, currentPosition) {
    if (fill.reason) return fill.reason;

    if (currentPosition) {
      if (currentPosition._emergencyCloseReason) {
        return `Emergency Close (${currentPosition._emergencyCloseReason})`;
      }

      const exitPrice = fill.price;
      const stopLoss = currentPosition.stopLoss;
      const target = currentPosition.target;
      const isLong = currentPosition.side === 'Buy';

      if (stopLoss != null) {
        const hitStop = isLong ? exitPrice <= stopLoss + 0.5 : exitPrice >= stopLoss - 0.5;
        if (hitStop) {
          if (currentPosition.breakEvenMoved && Math.abs(pnl) <= 2 * (currentPosition.quantity || 1)) {
            return 'Breakeven Stop';
          }
          return 'Stop Loss';
        }
      }

      if (target != null) {
        if (isLong && exitPrice >= target - 0.5) return 'Take Profit';
        if (!isLong && exitPrice <= target + 0.5) return 'Take Profit';
      }

      return 'Manual Close';
    }

    return 'Manual/Unknown';
  }

  /**
   * Handle position update from WebSocket.
   */
  handlePositionUpdate(position) {
    if (position && position.netPos !== undefined) {
      logger.info(`Position update: netPos=${position.netPos} contractId=${position.contractId}`);
    }
    if (position && position.netPos === 0 && this.contract && position.contractId === this.contract.id) {
      this.emit('positionCleared');
    }
  }

  /**
   * Round a price to the nearest valid tick increment.
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
    const decimals = (tickSize.toString().split('.')[1] || '').length;
    return parseFloat(aligned.toFixed(decimals));
  }
}

module.exports = PositionHandler;
