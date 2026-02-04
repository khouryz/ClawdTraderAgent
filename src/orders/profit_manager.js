/**
 * Profit Manager
 * Handles partial profit taking, time-based exits, and profit target management
 */

const EventEmitter = require('events');

class ProfitManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      // Partial profit taking
      partialProfitEnabled: config.partialProfitEnabled !== false,
      partialProfitPercent: parseFloat(config.partialProfitPercent) || 50,  // Take 50% at first target
      partialProfitR: parseFloat(config.partialProfitR) || 1.0,             // First target at 1R
      
      // Time-based exits
      timeExitEnabled: config.timeExitEnabled || false,
      maxTradeDurationBars: parseInt(config.maxTradeDurationBars) || 20,
      maxTradeDurationMinutes: parseInt(config.maxTradeDurationMinutes) || null,
      
      // Break-even stop
      breakEvenEnabled: config.breakEvenEnabled !== false,
      breakEvenTriggerR: parseFloat(config.breakEvenTriggerR) || 1.0,       // Move stop to BE at 1R
      breakEvenOffset: parseFloat(config.breakEvenOffset) || 0.25,          // Offset above/below entry
      
      ...config
    };

    this.activePositions = new Map(); // positionId -> PositionState
  }

  /**
   * Initialize profit management for a position
   */
  initializePosition(position) {
    const state = {
      positionId: position.id || position.clientId,
      entryPrice: position.entryPrice,
      side: position.side,
      initialQuantity: position.quantity,
      currentQuantity: position.quantity,
      stopLoss: position.stopLoss,
      originalTarget: position.target,
      currentTarget: position.target,
      riskAmount: Math.abs(position.entryPrice - position.stopLoss),
      
      // Partial profit tracking
      partialsTaken: 0,
      partialFills: [],
      partialTargetPrice: null,
      
      // Time tracking
      entryTime: new Date(),
      barsInTrade: 0,
      
      // Break-even tracking
      breakEvenMoved: false,
      
      // P&L tracking
      realizedPnL: 0,
      unrealizedPnL: 0,
      
      createdAt: new Date(),
      updatedAt: new Date()
    };

    // Calculate partial profit target price
    if (this.config.partialProfitEnabled) {
      const partialDistance = state.riskAmount * this.config.partialProfitR;
      if (position.side === 'Buy') {
        state.partialTargetPrice = position.entryPrice + partialDistance;
      } else {
        state.partialTargetPrice = position.entryPrice - partialDistance;
      }
    }

    this.activePositions.set(state.positionId, state);
    this.emit('positionInitialized', state);

    return state;
  }

  /**
   * Update position with current price
   * Returns actions to take (partial exit, time exit, move to break-even, etc.)
   */
  update(positionId, currentPrice, currentBar = null) {
    const state = this.activePositions.get(positionId);
    if (!state) {
      return { actions: [] };
    }

    const actions = [];
    const isLong = state.side === 'Buy';

    // Update bar count
    if (currentBar) {
      state.barsInTrade++;
    }

    // Calculate unrealized P&L
    const priceDiff = isLong 
      ? currentPrice - state.entryPrice 
      : state.entryPrice - currentPrice;
    state.unrealizedPnL = priceDiff * state.currentQuantity;

    // Calculate current R multiple
    const currentR = priceDiff / state.riskAmount;

    // Check for partial profit taking
    if (this.config.partialProfitEnabled && state.partialsTaken === 0) {
      const shouldTakePartial = isLong 
        ? currentPrice >= state.partialTargetPrice
        : currentPrice <= state.partialTargetPrice;

      if (shouldTakePartial) {
        const partialQty = Math.floor(state.currentQuantity * (this.config.partialProfitPercent / 100));
        
        if (partialQty > 0) {
          actions.push({
            type: 'PARTIAL_EXIT',
            quantity: partialQty,
            price: currentPrice,
            reason: `${this.config.partialProfitR}R target reached`,
            rMultiple: currentR
          });

          state.partialsTaken++;
          state.partialFills.push({
            quantity: partialQty,
            price: currentPrice,
            rMultiple: currentR,
            timestamp: new Date()
          });

          // Update realized P&L
          const partialPnL = priceDiff * partialQty;
          state.realizedPnL += partialPnL;
          state.currentQuantity -= partialQty;

          this.emit('partialProfit', {
            positionId,
            quantity: partialQty,
            price: currentPrice,
            pnl: partialPnL,
            rMultiple: currentR
          });
        }
      }
    }

    // Check for break-even move
    if (this.config.breakEvenEnabled && !state.breakEvenMoved) {
      const shouldMoveToBreakEven = currentR >= this.config.breakEvenTriggerR;

      if (shouldMoveToBreakEven) {
        let newStop;
        if (isLong) {
          newStop = state.entryPrice + this.config.breakEvenOffset;
        } else {
          newStop = state.entryPrice - this.config.breakEvenOffset;
        }

        actions.push({
          type: 'MOVE_STOP',
          newStop,
          reason: 'Break-even triggered',
          rMultiple: currentR
        });

        state.stopLoss = newStop;
        state.breakEvenMoved = true;

        this.emit('breakEvenMoved', {
          positionId,
          newStop,
          currentPrice,
          rMultiple: currentR
        });
      }
    }

    // Check for time-based exit
    if (this.config.timeExitEnabled) {
      let shouldTimeExit = false;
      let timeReason = '';

      // Check bar-based duration
      if (this.config.maxTradeDurationBars && state.barsInTrade >= this.config.maxTradeDurationBars) {
        shouldTimeExit = true;
        timeReason = `Max bars (${this.config.maxTradeDurationBars}) reached`;
      }

      // Check minute-based duration
      if (this.config.maxTradeDurationMinutes) {
        const minutesInTrade = (Date.now() - state.entryTime.getTime()) / (1000 * 60);
        if (minutesInTrade >= this.config.maxTradeDurationMinutes) {
          shouldTimeExit = true;
          timeReason = `Max time (${this.config.maxTradeDurationMinutes} min) reached`;
        }
      }

      if (shouldTimeExit && state.currentQuantity > 0) {
        actions.push({
          type: 'TIME_EXIT',
          quantity: state.currentQuantity,
          price: currentPrice,
          reason: timeReason,
          rMultiple: currentR
        });

        this.emit('timeExit', {
          positionId,
          quantity: state.currentQuantity,
          price: currentPrice,
          reason: timeReason,
          rMultiple: currentR
        });
      }
    }

    // Check if target hit
    const targetHit = isLong 
      ? currentPrice >= state.currentTarget
      : currentPrice <= state.currentTarget;

    if (targetHit && state.currentQuantity > 0) {
      actions.push({
        type: 'TARGET_EXIT',
        quantity: state.currentQuantity,
        price: currentPrice,
        reason: 'Profit target reached',
        rMultiple: currentR
      });

      this.emit('targetHit', {
        positionId,
        quantity: state.currentQuantity,
        price: currentPrice,
        rMultiple: currentR
      });
    }

    // Check if stop hit
    const stopHit = isLong 
      ? currentPrice <= state.stopLoss
      : currentPrice >= state.stopLoss;

    if (stopHit && state.currentQuantity > 0) {
      actions.push({
        type: 'STOP_EXIT',
        quantity: state.currentQuantity,
        price: state.stopLoss,
        reason: 'Stop loss hit',
        rMultiple: currentR
      });

      this.emit('stopHit', {
        positionId,
        quantity: state.currentQuantity,
        price: state.stopLoss,
        rMultiple: currentR
      });
    }

    state.updatedAt = new Date();
    return { state, actions, currentR };
  }

  /**
   * Record a fill (partial or full exit)
   */
  recordFill(positionId, quantity, price, isExit = true) {
    const state = this.activePositions.get(positionId);
    if (!state) {
      return null;
    }

    if (isExit) {
      const isLong = state.side === 'Buy';
      const priceDiff = isLong 
        ? price - state.entryPrice 
        : state.entryPrice - price;
      const pnl = priceDiff * quantity;

      state.realizedPnL += pnl;
      state.currentQuantity -= quantity;

      this.emit('fillRecorded', {
        positionId,
        quantity,
        price,
        pnl,
        remainingQuantity: state.currentQuantity
      });

      // Remove position if fully closed
      if (state.currentQuantity <= 0) {
        this.closePosition(positionId);
      }
    }

    return state;
  }

  /**
   * Close and remove a position
   */
  closePosition(positionId) {
    const state = this.activePositions.get(positionId);
    if (state) {
      this.activePositions.delete(positionId);
      this.emit('positionClosed', {
        positionId,
        realizedPnL: state.realizedPnL,
        partialsTaken: state.partialsTaken,
        barsInTrade: state.barsInTrade,
        duration: Date.now() - state.entryTime.getTime()
      });
      return state;
    }
    return null;
  }

  /**
   * Update stop loss for a position
   */
  updateStopLoss(positionId, newStop) {
    const state = this.activePositions.get(positionId);
    if (state) {
      const oldStop = state.stopLoss;
      state.stopLoss = newStop;
      state.updatedAt = new Date();
      
      this.emit('stopUpdated', {
        positionId,
        oldStop,
        newStop
      });
      
      return state;
    }
    return null;
  }

  /**
   * Get position state
   */
  getPosition(positionId) {
    return this.activePositions.get(positionId);
  }

  /**
   * Get all active positions
   */
  getAllPositions() {
    return Array.from(this.activePositions.values());
  }

  /**
   * Get position statistics
   */
  getStats() {
    const positions = this.getAllPositions();
    return {
      activePositions: positions.length,
      totalRealizedPnL: positions.reduce((sum, p) => sum + p.realizedPnL, 0),
      totalUnrealizedPnL: positions.reduce((sum, p) => sum + p.unrealizedPnL, 0),
      positionsWithPartials: positions.filter(p => p.partialsTaken > 0).length,
      positionsAtBreakEven: positions.filter(p => p.breakEvenMoved).length
    };
  }

  /**
   * Format position status for logging
   */
  formatPositionStatus(positionId) {
    const state = this.activePositions.get(positionId);
    if (!state) {
      return 'Position not found';
    }

    const currentR = state.unrealizedPnL / (state.riskAmount * state.initialQuantity);

    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 POSITION STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Side:           ${state.side}
Entry:          $${state.entryPrice.toFixed(2)}
Stop:           $${state.stopLoss.toFixed(2)} ${state.breakEvenMoved ? '(BE)' : ''}
Target:         $${state.currentTarget.toFixed(2)}
Quantity:       ${state.currentQuantity}/${state.initialQuantity}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Unrealized:     $${state.unrealizedPnL.toFixed(2)} (${currentR.toFixed(2)}R)
Realized:       $${state.realizedPnL.toFixed(2)}
Partials:       ${state.partialsTaken}
Bars in Trade:  ${state.barsInTrade}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `;
  }

  /**
   * Clear all positions
   */
  clearAll() {
    this.activePositions.clear();
    this.emit('allPositionsCleared');
  }
}

module.exports = ProfitManager;
