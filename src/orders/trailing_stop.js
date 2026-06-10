/**
 * Trailing Stop Manager
 * Handles dynamic stop-loss adjustment based on price movement
 */

const EventEmitter = require('events');

class TrailingStopManager extends EventEmitter {
  constructor(config = {}) {
    super();
    const base = {
      atrMultiplier: parseFloat(config.atrMultiplier) || 2.0,
      activationR: parseFloat(config.activationR) || 1.0,
      stepSize: parseFloat(config.stepSize) || 0.25,
      fixedTrailAmount: parseFloat(config.fixedTrailAmount) || null,
      ...config,
    };
    // Override booleans after spread to prevent raw config from overriding
    base.enabled = config.enabled === true;
    base.useATR = config.useATR !== false;
    this.config = base;

    this.activeTrails = new Map(); // positionId -> TrailingStopState
    
    // HIGH-7 FIX: Store client reference for actual order modification
    this.client = null;
    this.accountId = null;
  }

  /**
   * HIGH-7 FIX: Set the API client for order modifications
   * @param {Object} client - TradovateClient instance
   * @param {number} accountId - Account ID for order modifications
   */
  setClient(client, accountId) {
    this.client = client;
    this.accountId = accountId;
  }

  /**
   * Initialize trailing stop for a position
   */
  initializeTrail(position) {
    if (!this.config.enabled) {
      return null;
    }

    const trail = {
      positionId: position.id || position.clientId,
      entryPrice: position.entryPrice,
      side: position.side, // 'Buy' or 'Sell'
      quantity: position.quantity,
      initialStop: position.stopLoss,
      currentStop: position.stopLoss,
      highestPrice: position.entryPrice,  // For long positions
      lowestPrice: position.entryPrice,   // For short positions
      targetPrice: position.target,
      atr: position.atr || null,
      riskAmount: Math.abs(position.entryPrice - position.stopLoss),
      isActivated: false,
      activationPrice: null,
      lastUpdatePrice: position.entryPrice,
      createdAt: new Date(),
      updatedAt: new Date(),
      // HIGH-7 FIX: Store stop order ID for exchange modification
      stopOrderId: position.stopOrderId || null
    };

    // Calculate activation price (price at which trailing starts)
    if (position.side === 'Buy') {
      trail.activationPrice = position.entryPrice + (trail.riskAmount * this.config.activationR);
    } else {
      trail.activationPrice = position.entryPrice - (trail.riskAmount * this.config.activationR);
    }

    this.activeTrails.set(trail.positionId, trail);
    this.emit('trailInitialized', trail);

    return trail;
  }

  /**
   * Update trailing stop based on current price
   * HIGH-7 FIX: Made async to support actual order modification on exchange
   */
  async updateTrail(positionId, currentPrice, currentATR = null) {
    const trail = this.activeTrails.get(positionId);
    if (!trail) {
      return null;
    }

    // Update ATR if provided
    if (currentATR) {
      trail.atr = currentATR;
    }

    const isLong = trail.side === 'Buy';
    let newStop = trail.currentStop;
    let stopUpdated = false;

    if (isLong) {
      // Long position - trail stop up
      if (currentPrice > trail.highestPrice) {
        trail.highestPrice = currentPrice;
      }

      // Check if trailing should activate
      if (!trail.isActivated && currentPrice >= trail.activationPrice) {
        trail.isActivated = true;
        this.emit('trailActivated', trail, currentPrice);
        console.log(`[TrailingStop] Activated for position ${positionId} at $${currentPrice}`);
      }

      // Calculate new stop if activated
      if (trail.isActivated) {
        if (this.config.useATR && trail.atr) {
          // ATR-based trailing
          newStop = trail.highestPrice - (trail.atr * this.config.atrMultiplier);
        } else if (this.config.fixedTrailAmount) {
          // Fixed amount trailing
          newStop = trail.highestPrice - this.config.fixedTrailAmount;
        } else {
          // Default: trail at initial risk distance
          newStop = trail.highestPrice - trail.riskAmount;
        }

        // Only update if new stop is higher (for longs)
        if (newStop > trail.currentStop) {
          // Apply step size rounding
          const stepDiff = newStop - trail.currentStop;
          if (stepDiff >= this.config.stepSize) {
            newStop = Math.floor(newStop / this.config.stepSize) * this.config.stepSize;
            stopUpdated = true;
          }
        }
      }
    } else {
      // Short position - trail stop down
      if (currentPrice < trail.lowestPrice) {
        trail.lowestPrice = currentPrice;
      }

      // Check if trailing should activate
      if (!trail.isActivated && currentPrice <= trail.activationPrice) {
        trail.isActivated = true;
        this.emit('trailActivated', trail, currentPrice);
        console.log(`[TrailingStop] Activated for position ${positionId} at $${currentPrice}`);
      }

      // Calculate new stop if activated
      if (trail.isActivated) {
        if (this.config.useATR && trail.atr) {
          newStop = trail.lowestPrice + (trail.atr * this.config.atrMultiplier);
        } else if (this.config.fixedTrailAmount) {
          newStop = trail.lowestPrice + this.config.fixedTrailAmount;
        } else {
          newStop = trail.lowestPrice + trail.riskAmount;
        }

        // Only update if new stop is lower (for shorts)
        if (newStop < trail.currentStop) {
          const stepDiff = trail.currentStop - newStop;
          if (stepDiff >= this.config.stepSize) {
            newStop = Math.ceil(newStop / this.config.stepSize) * this.config.stepSize;
            stopUpdated = true;
          }
        }
      }
    }

    // Update trail state
    if (stopUpdated) {
      const oldStop = trail.currentStop;
      trail.currentStop = newStop;
      trail.lastUpdatePrice = currentPrice;
      trail.updatedAt = new Date();

      // HIGH-7 FIX: Actually modify the stop order on the exchange
      await this._modifyStopOrderOnExchange(trail, oldStop, newStop);

      this.emit('stopUpdated', {
        positionId,
        oldStop,
        newStop,
        currentPrice,
        side: trail.side
      });

      console.log(`[TrailingStop] Stop updated: $${oldStop.toFixed(2)} → $${newStop.toFixed(2)} (price: $${currentPrice.toFixed(2)})`);
    }

    return {
      trail,
      stopUpdated,
      newStop: trail.currentStop
    };
  }

  /**
   * Check if stop has been hit
   */
  checkStopHit(positionId, currentPrice) {
    const trail = this.activeTrails.get(positionId);
    if (!trail) {
      return { hit: false };
    }

    const isLong = trail.side === 'Buy';
    let hit = false;

    if (isLong) {
      hit = currentPrice <= trail.currentStop;
    } else {
      hit = currentPrice >= trail.currentStop;
    }

    if (hit) {
      this.emit('stopHit', {
        positionId,
        stopPrice: trail.currentStop,
        currentPrice,
        side: trail.side,
        pnl: this.calculatePnL(trail, trail.currentStop)
      });
    }

    return {
      hit,
      stopPrice: trail.currentStop,
      currentPrice
    };
  }

  /**
   * Calculate P&L for a position
   */
  calculatePnL(trail, exitPrice) {
    const isLong = trail.side === 'Buy';
    const priceDiff = isLong 
      ? exitPrice - trail.entryPrice 
      : trail.entryPrice - exitPrice;
    
    return priceDiff * trail.quantity;
  }

  /**
   * Update trail state after entry fill at a different price than signal.
   * Recalculates entryPrice, stops, riskAmount, and activationPrice.
   * @param {string} positionId
   * @param {Object} fillData - { fillPrice, newStop, newTarget }
   */
  updatePositionFromFill(positionId, fillData) {
    const trail = this.activeTrails.get(positionId);
    if (!trail) return null;
    const { fillPrice, newStop, newTarget } = fillData;
    trail.entryPrice = fillPrice;
    trail.initialStop = newStop;
    trail.currentStop = newStop;
    trail.targetPrice = newTarget;
    trail.highestPrice = fillPrice;
    trail.lowestPrice = fillPrice;
    trail.lastUpdatePrice = fillPrice;
    trail.riskAmount = Math.abs(fillPrice - newStop);
    // Recalculate activation price
    if (trail.side === 'Buy') {
      trail.activationPrice = fillPrice + (trail.riskAmount * this.config.activationR);
    } else {
      trail.activationPrice = fillPrice - (trail.riskAmount * this.config.activationR);
    }
    trail.updatedAt = new Date();
    return trail;
  }

  /**
   * Update the stop order ID for a trail (called after OCO is placed post-fill)
   * @param {string} positionId
   * @param {number} stopOrderId
   */
  updateStopOrderId(positionId, stopOrderId) {
    const trail = this.activeTrails.get(positionId);
    if (!trail) return;
    trail.stopOrderId = stopOrderId;
  }

  /**
   * Remove trailing stop for a position
   */
  removeTrail(positionId) {
    const trail = this.activeTrails.get(positionId);
    if (trail) {
      this.activeTrails.delete(positionId);
      this.emit('trailRemoved', trail);
      return true;
    }
    return false;
  }

  /**
   * Get trail status for a position
   */
  getTrail(positionId) {
    return this.activeTrails.get(positionId);
  }

  /**
   * Get all active trails
   */
  getAllTrails() {
    return Array.from(this.activeTrails.values());
  }

  /**
   * Get trail statistics
   */
  getStats() {
    const trails = this.getAllTrails();
    return {
      total: trails.length,
      activated: trails.filter(t => t.isActivated).length,
      pending: trails.filter(t => !t.isActivated).length
    };
  }

  /**
   * Format trail status for logging
   */
  formatTrailStatus(positionId) {
    const trail = this.activeTrails.get(positionId);
    if (!trail) {
      return 'No trailing stop active';
    }

    const isLong = trail.side === 'Buy';
    const extremePrice = isLong ? trail.highestPrice : trail.lowestPrice;

    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 TRAILING STOP STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Position:      ${trail.side} ${trail.quantity}
Entry:         $${trail.entryPrice.toFixed(2)}
Initial Stop:  $${trail.initialStop.toFixed(2)}
Current Stop:  $${trail.currentStop.toFixed(2)}
${isLong ? 'Highest' : 'Lowest'}:      $${extremePrice.toFixed(2)}
Activated:     ${trail.isActivated ? '✅ Yes' : '⏳ No (needs $' + trail.activationPrice.toFixed(2) + ')'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `;
  }

  /**
   * Clear all trails
   */
  clearAll() {
    this.activeTrails.clear();
    this.emit('allTrailsCleared');
  }

  /**
   * HIGH-7 FIX: Actually modify the stop order on the exchange
   * HIGH-3 FIX: Retry once on failure, revert internal state if both attempts fail,
   * and emit a failure event with enough info for the caller to send alerts.
   * @private
   */
  async _modifyStopOrderOnExchange(trail, oldStop, newStop) {
    if (!this.client) {
      console.warn('[TrailingStop] No client set - cannot modify stop order on exchange');
      trail.currentStop = oldStop; // Revert — exchange didn't move
      return false;
    }

    if (!trail.stopOrderId) {
      console.warn('[TrailingStop] No stop order ID - cannot modify stop order');
      trail.currentStop = oldStop; // Revert — exchange didn't move
      return false;
    }

    // Try up to 2 attempts
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) {
          await new Promise(r => setTimeout(r, 1000)); // 1s delay before retry
        }

        // Tradovate /order/modifyorder is a full replace — it REQUIRES orderType
        // and orderQty alongside the new price (same payload as the BE-stop move).
        await this.client.modifyOrder(trail.stopOrderId, {
          orderType: 'Stop',
          stopPrice: newStop,
          orderQty: trail.quantity || 1,
        });
        
        console.log(`[TrailingStop] ✓ Exchange stop order ${trail.stopOrderId} modified: $${oldStop.toFixed(2)} → $${newStop.toFixed(2)}`);
        
        this.emit('exchangeStopModified', {
          positionId: trail.positionId,
          stopOrderId: trail.stopOrderId,
          oldStop,
          newStop
        });
        
        return true;
      } catch (error) {
        console.error(`[TrailingStop] Attempt ${attempt}/2 failed to modify stop order on exchange: ${error.message}`);

        if (attempt === 2) {
          // Both attempts failed — REVERT internal state so bot knows stop is still at old level
          console.error(`[TrailingStop] ❌ BOTH attempts failed — reverting internal stop from $${newStop.toFixed(2)} back to $${oldStop.toFixed(2)}`);
          trail.currentStop = oldStop;
          trail.lastUpdatePrice = null; // Allow re-attempt on next price update
          
          this.emit('exchangeStopModifyFailed', {
            positionId: trail.positionId,
            stopOrderId: trail.stopOrderId,
            oldStop,
            newStop,
            error: error.message,
            isRejection: !!error.isOrderRejection
          });
          
          return false;
        }
      }
    }

    return false;
  }
}

module.exports = TrailingStopManager;
