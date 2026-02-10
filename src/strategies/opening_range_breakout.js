/**
 * Opening Range Breakout Strategy (ORB)
 * 
 * Core Logic:
 * - Builds 5-minute bars from incoming 1-minute data
 * - Captures the Opening Range (first 15 min high/low after open)
 * - Enters LONG only when price breaks above OR high with confirmation
 * - Uses 5-min EMA for trend bias (only trade in trend direction)
 * - Dynamic stop at OR level + buffer (tight ORs = smaller losses)
 * - Hard 12-point max stop cap — never exceeded
 * - 2R profit target with optional trail
 * 
 * Why this works better than raw 1-min breakout:
 * - Opening range is a real institutional level (not noise)
 * - 5-min structure filters out 1-min false breakouts
 * - Dynamic stop means risk scales with OR width (not always $60)
 * - AI filters weak setups on the fly
 */

const BaseStrategy = require('./base');

class OpeningRangeBreakoutStrategy extends BaseStrategy {
  constructor(config) {
    super('ORB', config);

    // Opening Range parameters
    this.orPeriodMinutes = config.orPeriodMinutes || 15;  // First 15 min
    this.orBuffer = config.orBuffer || 0.5;               // Points above/below OR level

    // 5-minute bar building
    this.fiveMinBars = [];
    this.currentFiveMinBar = null;
    this.oneMinCount = 0;

    // Stop/Target
    this.maxStopPoints = config.maxStopPoints || 8;       // Hard cap: 8 points = $40 on MES (v5 data-driven)
    this.minOrRange = config.minOrRange || 6;              // Min OR width — reject noisy tight ORs
    this.maxOrRange = config.maxOrRange || 10;             // Max OR width — reject wide/volatile ORs
    this.minBodyRatio = config.minBodyRatio || 0.3;        // Min body/range ratio on breakout bar
    this.stopBuffer = config.stopBuffer || 1.0;            // Wiggle room beyond OR level
    this.profitTargetR = config.profitTargetR || 2;
    this.useTrailingStop = config.useTrailingStop !== false;
    this.trailActivationR = config.trailActivationR || 1.0; // Trail after 1R
    this.trailDistancePoints = config.trailDistancePoints || 6; // 6 point trail

    // Trend filter (5-min EMA)
    this.emaFastPeriod = config.emaFastPeriod || 9;
    this.emaSlowPeriod = config.emaSlowPeriod || 21;
    this.useTrendFilter = config.useTrendFilter !== false;

    // Volume confirmation
    this.useVolumeFilter = config.useVolumeFilter !== false;
    this.volumeAvgPeriod = config.volumeAvgPeriod || 10;  // 10 five-min bars
    this.volumeMinRatio = config.volumeMinRatio || 1.0;

    // RSI filter (5-min)
    this.useRSIFilter = config.useRSIFilter !== false;
    this.rsiPeriod = config.rsiPeriod || 14;
    this.rsiOverbought = config.rsiOverbought || 75;
    this.rsiOversold = config.rsiOversold || 25;

    // ADX regime filter (5-min)
    this.useADXFilter = config.useADXFilter !== false;
    this.adxPeriod = config.adxPeriod || 14;
    this.adxMinTrend = config.adxMinTrend || 20;

    // Signal cooldown
    this.signalCooldownBars = config.signalCooldownBars || 3; // 3 five-min bars = 15 min
    this.lastSignalBar = -999;

    // Opening Range state (reset each day)
    this.orHigh = null;
    this.orLow = null;
    this.orEstablished = false;
    this.orBarsCollected = 0;
    this.sessionBarCount = 0;
    this.dayStarted = false;

    // Allow shorts (AI filters weak setups on the fly)
    this.allowShorts = config.allowShorts !== false;

    // Session filter reference
    this.sessionFilter = config.sessionFilter || null;
  }

  /**
   * Reset for new trading day
   */
  resetDay() {
    this.orHigh = null;
    this.orLow = null;
    this.orEstablished = false;
    this.orBarsCollected = 0;
    this.sessionBarCount = 0;
    this.currentFiveMinBar = null;
    this.oneMinCount = 0;
    this.fiveMinBars = [];
    this.lastSignalBar = -999;
    this.dayStarted = true;
  }

  /**
   * Process incoming 1-minute bar
   * Builds 5-min bars and manages Opening Range
   */
  onBar(bar) {
    // Store raw 1-min bars in base class
    this.bars.push(bar);
    if (this.bars.length > 500) this.bars.shift();

    this.sessionBarCount++;

    // Build 5-minute bars from 1-min data
    this.buildFiveMinBar(bar);

    // Collect Opening Range (first N minutes)
    if (!this.orEstablished) {
      this.collectOpeningRange(bar);
    }
  }

  /**
   * Aggregate 1-min bars into 5-min bars
   */
  buildFiveMinBar(bar) {
    this.oneMinCount++;

    if (!this.currentFiveMinBar) {
      this.currentFiveMinBar = {
        timestamp: bar.timestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume || 0,
      };
    } else {
      this.currentFiveMinBar.high = Math.max(this.currentFiveMinBar.high, bar.high);
      this.currentFiveMinBar.low = Math.min(this.currentFiveMinBar.low, bar.low);
      this.currentFiveMinBar.close = bar.close;
      this.currentFiveMinBar.volume += (bar.volume || 0);
    }

    // Close 5-min bar every 5 bars
    if (this.oneMinCount >= 5) {
      this.fiveMinBars.push({ ...this.currentFiveMinBar });
      if (this.fiveMinBars.length > 200) this.fiveMinBars.shift();

      this.currentFiveMinBar = null;
      this.oneMinCount = 0;

      // Analyze on 5-min bar close (not every 1-min bar)
      if (this.isActive && this.orEstablished) {
        this.analyze();
      }
    }
  }

  /**
   * Collect Opening Range from first N minutes
   */
  collectOpeningRange(bar) {
    this.orBarsCollected++;

    if (this.orHigh === null || bar.high > this.orHigh) {
      this.orHigh = bar.high;
    }
    if (this.orLow === null || bar.low < this.orLow) {
      this.orLow = bar.low;
    }

    if (this.orBarsCollected >= this.orPeriodMinutes) {
      this.orEstablished = true;
      const orRange = this.orHigh - this.orLow;
      // Don't log during backtest (isActive check handles this)
    }
  }

  /**
   * Calculate EMA on 5-min bars
   */
  calcEMA(period) {
    if (this.fiveMinBars.length < period) return null;
    const closes = this.fiveMinBars.map(b => b.close);
    const mult = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema = (closes[i] - ema) * mult + ema;
    }
    return ema;
  }

  /**
   * Calculate RSI on 5-min bars
   */
  calcRSI(period) {
    if (this.fiveMinBars.length < period + 1) return null;
    const closes = this.fiveMinBars.map(b => b.close);
    let gains = 0, losses = 0;
    const start = closes.length - period - 1;
    for (let i = start + 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change > 0) gains += change;
      else losses += Math.abs(change);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
  }

  /**
   * Calculate ADX on 5-min bars (simplified)
   */
  calcADX(period) {
    if (this.fiveMinBars.length < period * 2) return null;
    const bars = this.fiveMinBars;
    const len = bars.length;

    let plusDMSum = 0, minusDMSum = 0, trSum = 0;
    for (let i = len - period; i < len; i++) {
      const high = bars[i].high;
      const low = bars[i].low;
      const prevHigh = bars[i - 1].high;
      const prevLow = bars[i - 1].low;
      const prevClose = bars[i - 1].close;

      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      const plusDM = (high - prevHigh > prevLow - low && high - prevHigh > 0) ? high - prevHigh : 0;
      const minusDM = (prevLow - low > high - prevHigh && prevLow - low > 0) ? prevLow - low : 0;

      trSum += tr;
      plusDMSum += plusDM;
      minusDMSum += minusDM;
    }

    if (trSum === 0) return 0;
    const plusDI = (plusDMSum / trSum) * 100;
    const minusDI = (minusDMSum / trSum) * 100;
    const diSum = plusDI + minusDI;
    if (diSum === 0) return 0;
    return Math.abs(plusDI - minusDI) / diSum * 100;
  }

  /**
   * Calculate average volume on 5-min bars
   */
  calcAvgVolume(period) {
    if (this.fiveMinBars.length < period + 1) return null;
    const vols = this.fiveMinBars.slice(-period - 1, -1).map(b => b.volume);
    return vols.reduce((a, b) => a + b, 0) / vols.length;
  }

  /**
   * Main analysis — runs on every 5-min bar close after OR is established
   * 
   * Uses a 2-phase approach:
   * Phase 1: Detect breakout (price closes above OR high)
   * Phase 2: Wait for pullback near OR high, then enter with tight stop
   * 
   * This gives much better R:R than chasing the breakout candle.
   */
  analyze() {
    if (!this.orEstablished || this.fiveMinBars.length < 5) return;
    if (this.position) return;

    const currentBar = this.fiveMinBars[this.fiveMinBars.length - 1];
    const prevBar = this.fiveMinBars.length >= 2 ? this.fiveMinBars[this.fiveMinBars.length - 2] : null;
    const price = currentBar.close;

    // Check cooldown
    if (this.fiveMinBars.length - this.lastSignalBar < this.signalCooldownBars) return;

    const breakoutHigh = this.orHigh + this.orBuffer;
    const breakoutLow = this.orLow - this.orBuffer;

    // ── LONG: Breakout-and-hold or pullback entry ──
    if (price > breakoutHigh) {
      if (prevBar && prevBar.close <= breakoutHigh) {
        // Fresh breakout — body ratio filter replaces close strength
        this.evaluateEntry('buy', price, currentBar);
        return;
      }
    }

    // ── SHORT: (if enabled) ──
    if (this.allowShorts && price < breakoutLow) {
      if (prevBar && prevBar.close >= breakoutLow) {
        // Fresh breakdown — body ratio filter replaces close weakness
        this.evaluateEntry('sell', price, currentBar);
        return;
      }
    }
  }

  /**
   * Evaluate entry through all filters and calculate stop/target
   */
  evaluateEntry(signalType, price, bar) {
    const filters = [];

    // 1. Trend filter (5-min EMAs)
    if (this.useTrendFilter) {
      const emaFast = this.calcEMA(this.emaFastPeriod);
      const emaSlow = this.calcEMA(this.emaSlowPeriod);
      if (!emaFast || !emaSlow) return false;

      if (signalType === 'buy') {
        if (emaFast <= emaSlow) {
          filters.push({ name: 'Trend', passed: false, reason: `EMA9 <= EMA21 — no longs` });
          return false;
        }
        if (price < emaSlow) {
          filters.push({ name: 'Trend', passed: false, reason: `Price below EMA21` });
          return false;
        }
      } else {
        if (emaFast >= emaSlow) {
          filters.push({ name: 'Trend', passed: false, reason: `EMA9 >= EMA21 — no shorts` });
          return false;
        }
        if (price > emaSlow) {
          filters.push({ name: 'Trend', passed: false, reason: `Price above EMA21` });
          return false;
        }
      }
      filters.push({ name: 'Trend', passed: true, reason: `EMA aligned for ${signalType}` });
    }

    // 2. ADX regime filter
    if (this.useADXFilter) {
      const adx = this.calcADX(this.adxPeriod);
      if (adx !== null && adx < this.adxMinTrend) {
        filters.push({ name: 'ADX', passed: false, reason: `ADX ${adx.toFixed(1)} < ${this.adxMinTrend} (ranging)` });
        return false;
      }
      filters.push({ name: 'ADX', passed: true, reason: `ADX ${adx ? adx.toFixed(1) : 'N/A'} (trending)` });
    }

    // 3. RSI filter
    if (this.useRSIFilter) {
      const rsi = this.calcRSI(this.rsiPeriod);
      if (rsi !== null) {
        if (signalType === 'buy' && rsi > this.rsiOverbought) {
          filters.push({ name: 'RSI', passed: false, reason: `RSI ${rsi.toFixed(1)} overbought` });
          return false;
        }
        if (signalType === 'sell' && rsi < this.rsiOversold) {
          filters.push({ name: 'RSI', passed: false, reason: `RSI ${rsi.toFixed(1)} oversold` });
          return false;
        }
      }
      filters.push({ name: 'RSI', passed: true, reason: `RSI ${rsi ? rsi.toFixed(1) : 'N/A'} OK` });
    }

    // 4. Volume confirmation
    if (this.useVolumeFilter) {
      const avgVol = this.calcAvgVolume(this.volumeAvgPeriod);
      if (avgVol && avgVol > 0) {
        const ratio = bar.volume / avgVol;
        if (ratio < this.volumeMinRatio) {
          filters.push({ name: 'Volume', passed: false, reason: `Vol ratio ${ratio.toFixed(2)}x < ${this.volumeMinRatio}x` });
          return false;
        }
        filters.push({ name: 'Volume', passed: true, reason: `Vol ratio ${ratio.toFixed(2)}x` });
      }
    }

    // ── Calculate stop loss: always at OR level + buffer ──
    // The stop is ALWAYS placed just beyond the OR boundary.
    // Reject if the OR RANGE itself is too wide (> maxStopPoints).
    // This is different from stop distance — price may have moved past the OR,
    // but the OR width determines if the setup is valid.
    const orRange = this.orHigh - this.orLow;
    if (orRange > this.maxOrRange) return false;
    if (this.minOrRange && orRange < this.minOrRange) return false;

    // Body ratio filter: reject weak/indecisive breakout bars
    if (this.minBodyRatio > 0) {
      const barRange = bar.high - bar.low;
      const bodyRatio = barRange > 0 ? Math.abs(bar.close - bar.open) / barRange : 0;
      if (bodyRatio < this.minBodyRatio) return false;
    }

    let stopLoss;
    if (signalType === 'buy') {
      stopLoss = this.orLow - this.stopBuffer;
    } else {
      stopLoss = this.orHigh + this.stopBuffer;
    }

    const stopDistance = Math.abs(price - stopLoss);

    // Cap stop at maxStopPoints from entry if price has run far past OR level
    // (e.g., OR is 8 pts wide but price broke out 6 pts past — stop would be 15 pts)
    if (stopDistance > this.maxStopPoints) {
      stopLoss = signalType === 'buy'
        ? price - this.maxStopPoints
        : price + this.maxStopPoints;
    }

    const finalStopDist = Math.abs(price - stopLoss);

    // Minimum stop distance (at least 3 points to avoid noise)
    if (finalStopDist < 3) return false;

    // Calculate target based on actual stop distance
    const targetDistance = finalStopDist * this.profitTargetR;

    // Update cooldown
    this.lastSignalBar = this.fiveMinBars.length;

    // Emit signal
    this.emit('signal', {
      type: signalType,
      price,
      stopLoss,
      timestamp: new Date(bar.timestamp),
      filterResults: filters,
      orHigh: this.orHigh,
      orLow: this.orLow,
      stopDistance,
      targetDistance,
    });

    return true;
  }

  /**
   * Get current price from latest data
   */
  getCurrentPrice() {
    if (this.currentQuote?.last) return this.currentQuote.last;
    if (this.fiveMinBars.length > 0) return this.fiveMinBars[this.fiveMinBars.length - 1].close;
    if (this.bars.length > 0) return this.bars[this.bars.length - 1].close;
    return null;
  }

  hasEnoughData() {
    return this.fiveMinBars.length >= this.emaSlowPeriod + 1 && this.orEstablished;
  }

  getStatus() {
    return {
      name: this.name,
      active: this.isActive,
      barsCount1m: this.bars.length,
      barsCount5m: this.fiveMinBars.length,
      orEstablished: this.orEstablished,
      orHigh: this.orHigh,
      orLow: this.orLow,
      orRange: this.orHigh && this.orLow ? (this.orHigh - this.orLow).toFixed(2) : 'N/A',
      position: this.position,
      maxStopPoints: this.maxStopPoints,
    };
  }
}

module.exports = OpeningRangeBreakoutStrategy;
