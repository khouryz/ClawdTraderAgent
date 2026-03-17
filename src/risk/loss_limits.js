/**
 * Loss Limits Manager
 * Handles daily, weekly, consecutive loss limits, max drawdown protection,
 * daily profit target, and dynamic trailing profit floor.
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
      dailyProfitTarget: parseFloat(config.dailyProfitTarget) || Infinity,
      profitTiers: this._parseProfitTiers(config.profitTiers),
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
      haltReason: null,
      dailyPeakPnL: 0,
      currentFloor: null,
      highestTierReached: 0
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
          savedState.consecutiveLosses = 0; // Always reset — don't carry across days
          savedState.dailyPeakPnL = 0;
          savedState.currentFloor = null;
          savedState.highestTierReached = 0;
          savedState.lastTradeDate = today;
          
          // Clear daily-scoped halts on new day (includes emergency halts that should auto-resume next session)
          const dailyHaltReasons = ['DAILY_LOSS_LIMIT', 'CONSECUTIVE_LOSSES', 'DAILY_PROFIT_TARGET', 'PROFIT_PROTECTION', 'BRACKET_WATCHDOG_FAILED', 'BRACKET_ORDER_REJECTED', 'POST_FILL_RISK_EXCEEDED'];
          if (dailyHaltReasons.includes(savedState.haltReason)) {
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
   * CRITICAL FIX: Save state synchronously for critical operations
   * Use this for trade recording and halt operations to prevent state loss on crash
   */
  saveStateSync() {
    try {
      FileOps.writeJSONSync(this.stateFilePath, this.state);
    } catch (error) {
      console.error('[LossLimits] Error saving state (sync):', error.message);
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
      this.state.dailyPeakPnL = 0;
      this.state.currentFloor = null;
      this.state.highestTierReached = 0;
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

    // Update daily peak P&L (for profit protection tiers)
    if (this.state.dailyPnL > this.state.dailyPeakPnL) {
      this.state.dailyPeakPnL = this.state.dailyPnL;
    }

    // Update consecutive losses
    // Use ±2pt breakeven threshold — near-BE trades shouldn't count as losses
    const { CONTRACTS } = require('../utils/constants');
    const baseSymbol = (tradeDetails.symbol || 'MNQ').substring(0, 3);
    const beThreshold = ((CONTRACTS[baseSymbol] || CONTRACTS.MNQ || { pointValue: 2 }).pointValue) * 2;
    if (Math.abs(pnl) <= beThreshold) {
      // Breakeven — don't change consecutive losses (neither win nor loss)
    } else if (pnl < 0) {
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

    // CRITICAL FIX: Use synchronous save for trade recording to prevent state loss on crash
    this.saveStateSync();

    return this.state;
  }

  /**
   * Check all limits (profit target, profit protection, loss limits) and halt if necessary.
   * Order matters: profit target → tier ratchet → floor breach → loss limits.
   */
  checkLimits() {
    // ── 1. Daily profit target ──
    if (this.state.dailyPnL >= this.config.dailyProfitTarget) {
      this.halt('DAILY_PROFIT_TARGET',
        `Daily profit target hit: +$${this.state.dailyPnL.toFixed(2)} (target: $${this.config.dailyProfitTarget})`);
      return;
    }

    // ── 2. Update profit tier / floor (ratchet UP only) ──
    const tiers = this.config.profitTiers; // sorted ascending by peak
    for (let i = tiers.length - 1; i >= 0; i--) {
      if (this.state.dailyPeakPnL >= tiers[i].peak && tiers[i].peak > this.state.highestTierReached) {
        this.state.highestTierReached = tiers[i].peak;
        this.state.currentFloor = tiers[i].floor;
        break;
      }
    }

    // ── 3. Check profit floor breach ──
    if (this.state.currentFloor !== null && this.state.dailyPnL < this.state.currentFloor) {
      this.halt('PROFIT_PROTECTION',
        `Profit protection: P&L $${this.state.dailyPnL.toFixed(2)} dropped below floor $${this.state.currentFloor.toFixed(2)} ` +
        `(peak was $${this.state.dailyPeakPnL.toFixed(2)}, tier $${this.state.highestTierReached})`);
      return;
    }

    // ── 4. Daily loss limit ──
    if (this.state.dailyPnL < 0 && Math.abs(this.state.dailyPnL) >= this.config.dailyLossLimit) {
      this.halt('DAILY_LOSS_LIMIT', 
        `Daily loss limit reached: -$${Math.abs(this.state.dailyPnL).toFixed(2)} (limit: $${this.config.dailyLossLimit})`);
      return;
    }

    // ── 5. Weekly loss limit ──
    if (this.state.weeklyPnL < 0 && Math.abs(this.state.weeklyPnL) >= this.config.weeklyLossLimit) {
      this.halt('WEEKLY_LOSS_LIMIT', 
        `Weekly loss limit reached: -$${Math.abs(this.state.weeklyPnL).toFixed(2)} (limit: $${this.config.weeklyLossLimit})`);
      return;
    }

    // ── 6. Consecutive losses ──
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
    if (this.state.isHalted) {
      return; // Already halted — first halt wins, don't overwrite
    }

    this.state.isHalted = true;
    this.state.haltReason = reason;
    // CRITICAL FIX: Use synchronous save for halt to ensure state persists
    this.saveStateSync();

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
      case 'DAILY_PROFIT_TARGET':
        return `Daily profit target of $${this.config.dailyProfitTarget} reached! Trading will resume tomorrow.`;
      case 'PROFIT_PROTECTION':
        return `Profit protection floor breached (floor: $${this.state.currentFloor}, peak: $${this.state.dailyPeakPnL.toFixed(2)}). Trading will resume tomorrow.`;
      case 'DAILY_LOSS_LIMIT':
        return `Daily loss limit of $${this.config.dailyLossLimit} reached. Trading will resume tomorrow.`;
      case 'WEEKLY_LOSS_LIMIT':
        return `Weekly loss limit of $${this.config.weeklyLossLimit} reached. Trading will resume next week.`;
      case 'CONSECUTIVE_LOSSES':
        return `${this.config.maxConsecutiveLosses} consecutive losses reached. Trading halted for the day.`;
      case 'MAX_DRAWDOWN':
        return `Max drawdown of ${this.config.maxDrawdownPercent}% reached. Manual resume required.`;
      case 'BRACKET_WATCHDOG_FAILED':
        return 'Bracket watchdog detected unprotected position — emergency closed. Resumes tomorrow.';
      case 'BRACKET_ORDER_REJECTED':
        return 'Bracket order was rejected by exchange — emergency closed. Resumes tomorrow.';
      case 'POST_FILL_RISK_EXCEEDED':
        return 'Post-fill risk exceeded safe limits — emergency closed. Resumes tomorrow.';
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
      drawdownRemaining: this.config.maxDrawdownPercent - this.state.currentDrawdownPercent,
      profitTargetRemaining: this.config.dailyProfitTarget === Infinity ? Infinity : this.config.dailyProfitTarget - this.state.dailyPnL,
      dailyPeakPnL: this.state.dailyPeakPnL,
      currentFloor: this.state.currentFloor,
      highestTierReached: this.state.highestTierReached
    };
  }

  /**
   * Get daily P&L
   * @returns {number} Daily P&L value
   */
  getDailyPnL() {
    return this.state.dailyPnL;
  }

  /**
   * Get weekly P&L
   * @returns {number} Weekly P&L value
   */
  getWeeklyPnL() {
    return this.state.weeklyPnL;
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
      haltReason: null,
      dailyPeakPnL: 0,
      currentFloor: null,
      highestTierReached: 0
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
    const targetStr = this.config.dailyProfitTarget === Infinity ? '∞' : `$${this.config.dailyProfitTarget}`;
    const floorStr = status.currentFloor !== null ? `$${status.currentFloor}` : 'none';
    return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 RISK LIMITS STATUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Daily P&L:        $${status.dailyPnL.toFixed(2)} (target: ${targetStr}, limit: -$${status.limits.dailyLossLimit})
Peak P&L:         $${status.dailyPeakPnL.toFixed(2)} (floor: ${floorStr})
Weekly P&L:       $${status.weeklyPnL.toFixed(2)} (limit: -$${status.limits.weeklyLossLimit})
Consecutive L:    ${status.consecutiveLosses}/${status.limits.maxConsecutiveLosses}
Drawdown:         ${status.currentDrawdownPercent.toFixed(2)}% (max: ${status.limits.maxDrawdownPercent}%)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Status:           ${status.isHalted ? '🛑 HALTED - ' + status.haltReason : '✅ ACTIVE'}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `;
  }

  /**
   * Reset daily counters and clear daily-scoped halts.
   * Called by InstrumentRunner.dailyReset() and TradovateBot's 6:29 AM reset.
   * Needed because lossLimits state persists and the new-day check in loadState()
   * only runs on construction (bot restart), not when the bot runs continuously.
   * @returns {{ wasHalted: boolean }} Whether the bot was halted before reset
   */
  resetDaily() {
    const wasHalted = this.state.isHalted;
    const priorReason = this.state.haltReason;

    this.state.dailyPnL = 0;
    this.state.tradesToday = 0;
    this.state.consecutiveLosses = 0;
    this.state.dailyPeakPnL = 0;
    this.state.currentFloor = null;
    this.state.highestTierReached = 0;
    this.state.lastTradeDate = this.getDateString(new Date());

    // Clear daily-scoped halts (includes emergency halts that should auto-resume next session)
    const dailyHaltReasons = ['DAILY_LOSS_LIMIT', 'CONSECUTIVE_LOSSES', 'DAILY_PROFIT_TARGET', 'PROFIT_PROTECTION', 'BRACKET_WATCHDOG_FAILED', 'BRACKET_ORDER_REJECTED', 'POST_FILL_RISK_EXCEEDED'];
    if (dailyHaltReasons.includes(this.state.haltReason)) {
      this.state.isHalted = false;
      this.state.haltReason = null;
    }

    this.saveStateSync();
    console.log(`[LossLimits] Daily reset (wasHalted=${wasHalted}, reason=${priorReason})`);
    return { wasHalted, priorReason };
  }

  /**
   * Parse profit tiers from string format "100:50,200:150,300:250"
   * into sorted array [{ peak: 100, floor: 50 }, { peak: 200, floor: 150 }, ...]
   * @private
   */
  _parseProfitTiers(tiersInput) {
    if (!tiersInput) return [];
    // Already parsed (e.g., passed as array from config)
    if (Array.isArray(tiersInput)) return tiersInput;
    try {
      return String(tiersInput).split(',').map(pair => {
        const [peak, floor] = pair.trim().split(':').map(Number);
        if (isNaN(peak) || isNaN(floor)) throw new Error(`Invalid tier: ${pair}`);
        return { peak, floor };
      }).sort((a, b) => a.peak - b.peak);
    } catch (err) {
      console.error(`[LossLimits] Failed to parse profitTiers "${tiersInput}": ${err.message}. Using empty.`);
      return [];
    }
  }
}

module.exports = LossLimitsManager;
