/**
 * Dynamic Position Sizing
 * Adjusts risk based on recent performance
 */

class DynamicSizing {
  constructor(config = {}) {
    this.baseRisk = config.baseRisk || 45;
    this.minRisk = config.minRisk || 25;
    this.maxRisk = config.maxRisk || 75;
    this.recentTrades = [];
    this.lookbackTrades = config.lookbackTrades || 10;
  }

  /**
   * Record a trade result
   */
  recordTrade(isWin, rMultiple = 1) {
    this.recentTrades.push({ isWin, rMultiple, timestamp: Date.now() });
    
    // Keep only recent trades
    if (this.recentTrades.length > this.lookbackTrades) {
      this.recentTrades.shift();
    }
  }

  /**
   * Get current win rate
   */
  getWinRate() {
    if (this.recentTrades.length === 0) return 0.5;
    const wins = this.recentTrades.filter(t => t.isWin).length;
    return wins / this.recentTrades.length;
  }

  /**
   * Get consecutive losses
   */
  getConsecutiveLosses() {
    let count = 0;
    for (let i = this.recentTrades.length - 1; i >= 0; i--) {
      if (!this.recentTrades[i].isWin) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Get consecutive wins
   */
  getConsecutiveWins() {
    let count = 0;
    for (let i = this.recentTrades.length - 1; i >= 0; i--) {
      if (this.recentTrades[i].isWin) {
        count++;
      } else {
        break;
      }
    }
    return count;
  }

  /**
   * Calculate adjusted risk based on performance
   */
  getAdjustedRisk() {
    const winRate = this.getWinRate();
    const consecutiveLosses = this.getConsecutiveLosses();
    const consecutiveWins = this.getConsecutiveWins();

    let adjustedRisk = this.baseRisk;

    // Reduce risk after consecutive losses
    if (consecutiveLosses >= 3) {
      adjustedRisk = this.minRisk; // Drop to minimum
    } else if (consecutiveLosses >= 2) {
      adjustedRisk = this.baseRisk * 0.7; // 30% reduction
    }

    // Increase risk during hot streak (but be careful)
    if (consecutiveWins >= 4 && winRate > 0.6) {
      adjustedRisk = Math.min(this.baseRisk * 1.25, this.maxRisk);
    }

    // Scale based on overall win rate
    if (winRate > 0.65) {
      adjustedRisk *= 1.1; // 10% boost for high win rate
    } else if (winRate < 0.4) {
      adjustedRisk *= 0.8; // 20% reduction for low win rate
    }

    // Clamp to bounds
    return Math.max(this.minRisk, Math.min(this.maxRisk, Math.round(adjustedRisk)));
  }

  /**
   * Get sizing status
   */
  getStatus() {
    return {
      baseRisk: this.baseRisk,
      adjustedRisk: this.getAdjustedRisk(),
      winRate: (this.getWinRate() * 100).toFixed(1) + '%',
      consecutiveLosses: this.getConsecutiveLosses(),
      consecutiveWins: this.getConsecutiveWins(),
      recentTradesCount: this.recentTrades.length
    };
  }

  /**
   * Reset trade history
   */
  reset() {
    this.recentTrades = [];
  }
}

module.exports = DynamicSizing;
