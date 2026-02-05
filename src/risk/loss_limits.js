/**
 * Loss Limits Manager
 * Handles daily, weekly, consecutive loss limits and max drawdown protection
 */

const EventEmitter = require('events');
const FileOps = require('../utils/file_ops');
const { FILES } = require('../utils/constants');

class LossLimitsManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = {
      dailyLossLimit: parseFloat(config.dailyLossLimit) || 150,
      weeklyLossLimit: parseFloat(config.weeklyLossLimit) || 300,
      maxConsecutiveLosses: parseInt(config.maxConsecutiveLosses) || 3,
      maxDrawdownPercent: parseFloat(config.maxDrawdownPercent) || 10,
      dataDir: config.dataDir || FILES.DATA_DIR
    };

    this.state = {
      dailyPnL: 0,
      weeklyPnL: 0,
      consecutiveLosses: 0,
      peakEquity: 0,
      currentEquity: 0,
      currentDrawdownPercent: 0,
      tradesToday: 0,
      tradesThisWeek: 0,
      lastTradeDate: null,
      lastTradeWeek: null,
      isHalted: false,
      haltReason: null
    };

    this.stateFilePath = `${this.config.dataDir}/${FILES.LOSS_LIMITS_STATE}`;
    FileOps.ensureDirSync(this.config.dataDir);
    this.loadState();
  }

  /**
   * Load persisted state from file
   */
  loadState() {
    try {
      const savedState = FileOps.readJSONSync(this.stateFilePath, null);
      if (savedState) {
        
        // Check if we need to reset daily/weekly counters
        const now = new Date();
        const today = this.getDateString(now);
        const thisWeek = this.getWeekString(now);

        // Reset daily if new day
        if (savedState.lastTradeDate !== today) {
          savedState.dailyPnL = 0;
          savedState.tradesToday = 0;
          savedState.lastTradeDate = today;
          
          // Also reset halt if it was daily-based
          if (savedState.haltReason === 'DAILY_LOSS_LIMIT') {
            savedState.isHalted = false;
            savedState.haltReason = null;
          }
        }

        // Reset weekly if new week
        if (savedState.lastTradeWeek !== thisWeek) {
          savedState.weeklyPnL = 0;
          savedState.tradesThisWeek = 0;
          savedState.lastTradeWeek = thisWeek;
          
          // Also reset halt if it was weekly-based
          if (savedState.haltReason === 'WEEKLY_LOSS_LIMIT') {
            savedState.isHalted = false;
            savedState.haltReason = null;
          }
        }

        this.state = { ...this.state, ...savedState };
        console.log('[LossLimits] State loaded from file');
      }
    } catch (error) {
      console.error('[LossLimits] Error loading state:', error.message);
    }
  }

  /**
   * Save state to file (async for non-blocking)
   */
  async saveState() {
    try {
      await FileOps.writeJSON(this.stateFilePath, this.state);
    } catch (error) {
      console.error('[LossLimits] Error saving state:', error.message);
    }
  }

  /**
   * Get date string for comparison (YYYY-MM-DD)
   */
  getDateString(date) {
    return date.toISOString().split('T')[0];
  }

  /**
   * Get week string for comparison (YYYY-WXX)
   */
  getWeekString(date) {
    const year = date.getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const days = Math.floor((date - startOfYear) / (24 * 60 * 60 * 1000));
    const weekNumber = Math.ceil((days + startOfYear.getDay() + 1) / 7);
    return `${year}-W${weekNumber.toString().padStart(2, '0')}`;
  }

  /**
   * Update equity for drawdown tracking
   */
  updateEquity(currentEquity) {
    this.state.currentEquity = currentEquity;
    
    // Update peak equity
    if (currentEquity > this.state.peakEquity) {
      this.state.peakEquity = currentEquity;
    }

    // Calculate current drawdown
    if (this.state.peakEquity > 0) {
      this.state.currentDrawdownPercent = 
        ((this.state.peakEquity - currentEquity) / this.state.peakEquity) * 100;
    }

    // Check max drawdown
    if (this.state.currentDrawdownPercent >= this.config.maxDrawdownPercent) {
      this.halt('MAX_DRAWDOWN', 
        `Max drawdown reached: ${this.state.currentDrawdownPercent.toFixed(2)}% (limit: ${this.config.maxDrawdownPercent}%)`);
    }

    this.saveState();
  }

  /**
   * Record a completed trade
   * @param {number} pnl - Profit/loss from the trade (positive = profit, negative = loss)
   * @param {Object} tradeDetails - Optional trade details for logging
   */
  recordTrade(pnl, tradeDetails = {}) {
    const now = new Date();
    const today = this.getDateString(now);
    const thisWeek = this.getWeekString(now);

    // Reset counters if new day/week
    if (this.state.lastTradeDate !== today) {
      this.state.dailyPnL = 0;
      this.state.tradesToday = 0;
      this.state.lastTradeDate = today;
    }

    if (this.state.lastTradeWeek !== thisWeek) {
      this.state.weeklyPnL = 0;
      this.state.tradesThisWeek = 0;
      this.state.lastTradeWeek = thisWeek;
    }

    // Update P&L
    this.state.dailyPnL += pnl;
    this.state.weeklyPnL += pnl;
    this.state.tradesToday++;
    this.state.tradesThisWeek++;

    // Update consecutive losses
    if (pnl < 0) {
      this.state.consecutiveLosses++;
    } else {
      this.state.consecutiveLosses = 0;
    }

    // Emit trade recorded event
    this.emit('tradeRecorded', {
      pnl,
      dailyPnL: this.state.dailyPnL,
      weeklyPnL: this.state.weeklyPnL,
      consecutiveLosses: this.state.consecutiveLosses,
      ...tradeDetails
    });

    // Check limits
    this.checkLimits();

    // Save state
    this.saveState();

    return this.state;
  }

  /**
   * Check all loss limits and halt if necessary
   */
  checkLimits() {
    // Check daily loss limit
    if (Math.abs(this.state.dailyPnL) >= this.config.dailyLossLimit && this.state.dailyPnL < 0) {
      this.halt('DAILY_LOSS_LIMIT', 
        `Daily loss limit reached: $${Math.abs(this.state.dailyPnL).toFixed(2)} (limit: $${this.config.dailyLossLimit})`);
      return;
    }

    // Check weekly loss limit
    if (Math.abs(this.state.weeklyPnL) >= this.config.weeklyLossLimit && this.state.weeklyPnL < 0) {
      this.halt('WEEKLY_LOSS_LIMIT', 
        `Weekly loss limit reached: $${Math.abs(this.state.weeklyPnL).toFixed(2)} (limit: $${this.config.weeklyLossLimit})`);
      return;
    }

    // Check consecutive losses
    if (this.state.consecutiveLosses >= this.config.maxConsecutiveLosses) {
      this.halt('CONSECUTIVE_LOSSES', 
        `Max consecutive losses reached: ${this.state.consecutiveLosses} (limit: ${this.config.maxConsecutiveLosses})`);
      return;
    }
  }

  /**
   * Halt trading
   */
  halt(reason, message) {
    if (this.state.isHalted && this.state.haltReason === reason) {
      return; // Already halted for this reason
    }

    this.state.isHalted = true;
    this.state.haltReason = reason;
    this.saveState();

    console.error(`[LossLimits] 🛑 TRADING HALTED: ${message}`);
    this.emit('halt', { reason, message });
  }

  /**
   * Resume trading (manual override)
   */
  resume() {
    if (!this.state.isHalted) {
      return false;
    }

    console.log('[LossLimits] Trading resumed manually');
    this.state.isHalted = false;
    this.state.haltReason = null;
    
    // Reset consecutive losses on manual resume
    this.state.consecutiveLosses = 0;
    
    this.saveState();
    this.emit('resumed');
    return true;
  }

  /**
   * Check if trading is allowed
   */
  canTrade() {
    if (this.state.isHalted) {
      return {
        allowed: false,
        reason: this.state.haltReason,
        message: this.getHaltMessage()
      };
    }

    return { allowed: true };
  }

  /**
   * Get human-readable halt message
   */
  getHaltMessage() {
    switch (this.state.haltReason) {
      case 'DAILY_LOSS_LIMIT':
        return `Daily loss limit of $${this.config.dailyLossLimit} reached. Trading will resume tomorrow.`;
      case 'WEEKLY_LOSS_LIMIT':
        return `Weekly loss limit of $${this.config.weeklyLossLimit} reached. Trading will resume next week.`;
      case 'CONSECUTIVE_LOSSES':
        return `${this.config.maxConsecutiveLosses} consecutive losses reached. Manual resume required.`;
      case 'MAX_DRAWDOWN':
        return `Max drawdown of ${this.config.maxDrawdownPercent}% reached. Manual resume required.`;
      default:
        return 'Trading is halted. Manual resume required.';
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      ...this.state,
      limits: this.config,
      dailyLossRemaining: this.config.dailyLossLimit - Math.abs(Math.min(0, this.state.dailyPnL)),
      weeklyLossRemaining: this.config.weeklyLossLimit - Math.abs(Math.min(0, this.state.weeklyPnL)),
      consecutiveLossesRemaining: this.config.maxConsecutiveLosses - this.state.consecutiveLosses,
      drawdownRemaining: this.config.maxDrawdownPercent - this.state.currentDrawdownPercent
    };
  }

  /**
   * Reset all counters (use with caution)
   */
  reset() {
    this.state = {
      dailyPnL: 0,
      weeklyPnL: 0,
      consecutiveLosses: 0,
      peakEquity: this.state.currentEquity || 0,
      currentEquity: this.state.currentEquity || 0,
      currentDrawdownPercent: 0,
      tradesToday: 0,
      tradesThisWeek: 0,
      lastTradeDate: this.getDateString(new Date()),
      lastTradeWeek: this.getWeekString(new Date()),
      isHalted: false,
      haltReason: null
    };
    this.saveState();
    console.log('[LossLimits] State reset');
    this.emit('reset');
  }

  /**
   * Format status for logging
   */
  formatStatus() {
    const status = this.getStatus();
    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 LOSS LIMITS STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Daily P&L:        $${status.dailyPnL.toFixed(2)} (limit: -$${status.limits.dailyLossLimit})
Weekly P&L:       $${status.weeklyPnL.toFixed(2)} (limit: -$${status.limits.weeklyLossLimit})
Consecutive L:    ${status.consecutiveLosses}/${status.limits.maxConsecutiveLosses}
Drawdown:         ${status.currentDrawdownPercent.toFixed(2)}% (max: ${status.limits.maxDrawdownPercent}%)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:           ${status.isHalted ? '🛑 HALTED - ' + status.haltReason : '✅ ACTIVE'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `;
  }
}

module.exports = LossLimitsManager;
