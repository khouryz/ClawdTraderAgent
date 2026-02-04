/**
 * Simple Breakout Strategy
 * Buys on breakouts above recent highs, sells on breakdowns below recent lows
 */

const BaseStrategy = require('./base');

class SimpleBreakoutStrategy extends BaseStrategy {
  constructor(config) {
    super('SimpleBreakout', config);
    this.lookbackPeriod = config.lookbackPeriod || 20;
    this.atrMultiplier = config.atrMultiplier || 1.5;
    this.lastHigh = null;
    this.lastLow = null;
    this.atr = null;
  }

  /**
   * Calculate Average True Range (ATR) for volatility
   */
  calculateATR(period = 14) {
    if (this.bars.length < period + 1) return null;

    const trueRanges = [];
    for (let i = 1; i < this.bars.length; i++) {
      const high = this.bars[i].high;
      const low = this.bars[i].low;
      const prevClose = this.bars[i - 1].close;

      const tr = Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      );
      trueRanges.push(tr);
    }

    // Simple average of last 'period' true ranges
    const recentTR = trueRanges.slice(-period);
    return recentTR.reduce((a, b) => a + b, 0) / recentTR.length;
  }

  /**
   * Find recent high/low
   */
  findRecentHighLow() {
    if (this.bars.length < this.lookbackPeriod) {
      return { high: null, low: null };
    }

    const recentBars = this.bars.slice(-this.lookbackPeriod);
    const high = Math.max(...recentBars.map(b => b.high));
    const low = Math.min(...recentBars.map(b => b.low));

    return { high, low };
  }

  /**
   * Main analysis logic
   */
  analyze() {
    if (!this.hasEnoughData()) {
      return;
    }

    const currentPrice = this.getCurrentPrice();
    if (!currentPrice) {
      return;
    }

    // Calculate ATR for stop placement
    this.atr = this.calculateATR();
    if (!this.atr) {
      return;
    }

    // Find recent high/low
    const { high, low } = this.findRecentHighLow();
    if (!high || !low) {
      return;
    }

    this.lastHigh = high;
    this.lastLow = low;

    // Already in a position - don't generate new signals
    if (this.position) {
      return;
    }

    // Breakout above recent high - BUY signal
    if (currentPrice > high) {
      const stopLoss = currentPrice - (this.atr * this.atrMultiplier);
      this.signalBuy(currentPrice, stopLoss);
    }

    // Breakdown below recent low - SELL signal
    if (currentPrice < low) {
      const stopLoss = currentPrice + (this.atr * this.atrMultiplier);
      this.signalSell(currentPrice, stopLoss);
    }
  }

  /**
   * Get strategy status for logging
   */
  getStatus() {
    return {
      name: this.name,
      active: this.isActive,
      barsCount: this.bars.length,
      currentPrice: this.getCurrentPrice(),
      recentHigh: this.lastHigh,
      recentLow: this.lastLow,
      atr: this.atr,
      position: this.position
    };
  }
}

module.exports = SimpleBreakoutStrategy;
