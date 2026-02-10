/**
 * MNQ Momentum Strategy — EMAX + Pullback (PB)
 * 
 * 12-Month Backtest: PF 2.13, 142 trades, $4,128 P&L, $162 avg win, 14.5% DD
 * 
 * Two sub-strategies, priority order:
 * 
 * 1. EMAX (EMA Cross Momentum) — 2-min bars
 *    - Detects EMA9/EMA21 crossover on 2-min bars
 *    - Entry on crossover bar if body >= 50% of range, range >= 5pt
 *    - Stop: below bar low + 2pt buffer (max 25pt)
 *    - Target: 4R adaptive (no trail, no BE — pure target or stop)
 *    - Window: 6:30 AM – 8:00 AM PST
 *    - Standalone PF: 2.45, 46 trades, $156 avg win
 * 
 * 2. PB (Momentum Pullback) — 5-min bars
 *    - Finds strong impulse bar (range >= 20pt, body >= 50%)
 *    - Waits for pullback (20-60% retrace) with bounce confirmation
 *    - Stop: below pullback bar low + 2pt buffer (max 25pt)
 *    - Target: 4R adaptive (no trail, no BE)
 *    - Window: 6:30 AM – 8:30 AM PST
 *    - Standalone PF: 1.99, 96 trades, $166 avg win
 * 
 * MNQ: tick=0.25, tickValue=$0.50, pointValue=$2.00
 * Max 1 trade at a time. EMAX gets first priority.
 * Multiple trades per day allowed. 3 consecutive losers = stop for day.
 */

const BaseStrategy = require('./base');

class MNQMomentumStrategy extends BaseStrategy {
  constructor(config) {
    super('MNQ_MOMENTUM', config);

    // ── EMAX Parameters ──
    this.emaxEmaFast = config.emaxEmaFast || 9;
    this.emaxEmaSlow = config.emaxEmaSlow || 21;
    this.emaxMinBarRange = config.emaxMinBarRange || 5;       // Min 2m bar range (pts)
    this.emaxMinBodyRatio = config.emaxMinBodyRatio || 0.5;   // Min body/range ratio
    this.emaxMaxTime = config.emaxMaxTime || 480;             // 8:00 AM PST (minutes from midnight)

    // ── PB Parameters ──
    this.pbMinImpulse = config.pbMinImpulse || 20;           // Min impulse bar range (pts)
    this.pbMinImpBodyRatio = config.pbMinImpBodyRatio || 0.5; // Min impulse body ratio
    this.pbRetraceMin = config.pbRetraceMin || 0.2;           // Min retrace %
    this.pbRetraceMax = config.pbRetraceMax || 0.6;           // Max retrace %
    this.pbMaxTime = config.pbMaxTime || 510;                 // 8:30 AM PST

    // ── Shared Parameters ──
    this.maxStopPoints = config.maxStopPoints || 25;          // Max stop distance (pts)
    this.minStopPoints = config.minStopPoints || 5;           // Min stop distance (pts)
    this.stopBuffer = config.stopBuffer || 2;                 // Buffer beyond bar extreme (pts)
    this.profitTargetR = config.profitTargetR || 4;           // 4R target
    this.minTargetPoints = config.minTargetPoints || 60;      // Min target distance (pts)

    // ── Bar Building State ──
    this.twoMinBars = [];
    this.fiveMinBars = [];
    this.current2mBar = null;
    this.current5mBar = null;
    this.oneMinCount2m = 0;
    this.oneMinCount5m = 0;

    // ── Day State ──
    this.signalFired = false;   // True while a signal is pending/in position
    this.sessionBarCount = 0;
    this.dayStarted = false;

    // Session filter reference
    this.sessionFilter = config.sessionFilter || null;
  }

  /**
   * Reset for new trading day
   */
  resetDay() {
    this.twoMinBars = [];
    this.fiveMinBars = [];
    this.current2mBar = null;
    this.current5mBar = null;
    this.oneMinCount2m = 0;
    this.oneMinCount5m = 0;
    this.signalFired = false;
    this.sessionBarCount = 0;
    this.dayStarted = true;
  }

  /**
   * Process incoming 1-minute bar
   */
  onBar(bar) {
    // Store raw 1-min bars
    this.bars.push(bar);
    if (this.bars.length > 500) this.bars.shift();

    this.sessionBarCount++;

    // Log every 10 bars to confirm strategy is receiving data 
    if (this.sessionBarCount % 10 === 0) {
      console.log(`[Strategy:${this.name}] ${this.sessionBarCount} bars | 2m: ${this.twoMinBars.length} | 5m: ${this.fiveMinBars.length} | signalFired: ${this.signalFired}`);
    }

    // Build 2-min and 5-min bars simultaneously
    this._build2mBar(bar);
    this._build5mBar(bar);
  }

  /**
   * Build 2-minute bars from 1-min data
   */
  _build2mBar(bar) {
    this.oneMinCount2m++;

    if (!this.current2mBar) {
      this.current2mBar = {
        timestamp: bar.timestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume || 0,
      };
    } else {
      this.current2mBar.high = Math.max(this.current2mBar.high, bar.high);
      this.current2mBar.low = Math.min(this.current2mBar.low, bar.low);
      this.current2mBar.close = bar.close;
      this.current2mBar.volume += (bar.volume || 0);
    }

    if (this.oneMinCount2m >= 2) {
      this.twoMinBars.push({ ...this.current2mBar });
      if (this.twoMinBars.length > 200) this.twoMinBars.shift();
      this.current2mBar = null;
      this.oneMinCount2m = 0;

      // Check EMAX on every 2-min bar close (only if not already in a trade)
      if (this.isActive && !this.signalFired && !this.position) {
        this._checkEMAX();
      }
    }
  }

  /**
   * Build 5-minute bars from 1-min data
   */
  _build5mBar(bar) {
    this.oneMinCount5m++;

    if (!this.current5mBar) {
      this.current5mBar = {
        timestamp: bar.timestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume || 0,
      };
    } else {
      this.current5mBar.high = Math.max(this.current5mBar.high, bar.high);
      this.current5mBar.low = Math.min(this.current5mBar.low, bar.low);
      this.current5mBar.close = bar.close;
      this.current5mBar.volume += (bar.volume || 0);
    }

    if (this.oneMinCount5m >= 5) {
      this.fiveMinBars.push({ ...this.current5mBar });
      if (this.fiveMinBars.length > 200) this.fiveMinBars.shift();
      this.current5mBar = null;
      this.oneMinCount5m = 0;

      // Check PB on every 5-min bar close (only if not already in a trade)
      if (this.isActive && !this.signalFired && !this.position) {
        this._checkPB();
      }
    }
  }

  /**
   * Calculate EMA on an array of closes
   */
  _calcEMA(closes, period) {
    if (closes.length < period) return null;
    const mult = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema = (closes[i] - ema) * mult + ema;
    }
    return ema;
  }

  /**
   * Get PST time from timestamp
   */
  _getPSTMinutes(timestamp) {
    const d = new Date(timestamp);
    const pstStr = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
    const parts = pstStr.split(', ')[1].split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  }

  // ═══════════════════════════════════════════════════════════════
  //  STRATEGY 1: EMAX (EMA Cross Momentum on 2-min bars)
  // ═══════════════════════════════════════════════════════════════

  _checkEMAX() {
    if (this.twoMinBars.length < this.emaxEmaSlow + 2) return;

    const bar = this.twoMinBars[this.twoMinBars.length - 1];
    const pstMins = this._getPSTMinutes(bar.timestamp);
    if (pstMins > this.emaxMaxTime) return;

    // Calculate current and previous EMAs
    const closes = this.twoMinBars.map(b => b.close);
    const ema9 = this._calcEMA(closes, this.emaxEmaFast);
    const ema21 = this._calcEMA(closes, this.emaxEmaSlow);

    const prevCloses = closes.slice(0, -1);
    const prevEma9 = this._calcEMA(prevCloses, this.emaxEmaFast);
    const prevEma21 = this._calcEMA(prevCloses, this.emaxEmaSlow);

    if (!ema9 || !ema21 || !prevEma9 || !prevEma21) return;

    // Bar quality checks
    const range = bar.high - bar.low;
    if (range < this.emaxMinBarRange) return;
    const bodyRatio = Math.abs(bar.close - bar.open) / range;
    if (bodyRatio < this.emaxMinBodyRatio) return;

    let signal = null;
    let stopDist = 0;

    // Bullish cross: EMA9 crosses above EMA21
    if (prevEma9 <= prevEma21 && ema9 > ema21 && bar.close > bar.open) {
      signal = 'buy';
      stopDist = bar.close - bar.low + this.stopBuffer;
    }

    // Bearish cross: EMA9 crosses below EMA21
    if (prevEma9 >= prevEma21 && ema9 < ema21 && bar.close < bar.open) {
      signal = 'sell';
      stopDist = bar.high - bar.close + this.stopBuffer;
    }

    if (!signal) return;
    if (stopDist > this.maxStopPoints || stopDist < this.minStopPoints) return;

    const targetDist = stopDist * this.profitTargetR;
    if (targetDist < this.minTargetPoints) return;

    const entryPrice = bar.close;
    const stopLoss = signal === 'buy'
      ? bar.low - this.stopBuffer
      : bar.high + this.stopBuffer;
    const targetPrice = signal === 'buy'
      ? entryPrice + targetDist
      : entryPrice - targetDist;

    this.signalFired = true;

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(bar.timestamp),
      strategy: 'EMAX',
      filterResults: [
        { name: 'EMA Cross', passed: true, reason: `EMA${this.emaxEmaFast} crossed EMA${this.emaxEmaSlow}` },
        { name: 'Bar Quality', passed: true, reason: `Range: ${range.toFixed(1)}pt, Body: ${(bodyRatio * 100).toFixed(0)}%` },
        { name: 'Stop', passed: true, reason: `${stopDist.toFixed(1)}pt ($${(stopDist * 2).toFixed(0)})` },
        { name: 'Target', passed: true, reason: `${targetDist.toFixed(1)}pt ($${(targetDist * 2).toFixed(0)}) = ${this.profitTargetR}R` },
      ],
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  STRATEGY 2: PB (Momentum Pullback on 5-min bars)
  // ═══════════════════════════════════════════════════════════════

  _checkPB() {
    if (this.fiveMinBars.length < 5) return;

    const pb = this.fiveMinBars[this.fiveMinBars.length - 1];
    const impulse = this.fiveMinBars[this.fiveMinBars.length - 2];
    if (!impulse) return;

    const pstMins = this._getPSTMinutes(pb.timestamp);
    if (pstMins > this.pbMaxTime) return;

    // Impulse bar quality
    const impRange = impulse.high - impulse.low;
    if (impRange < this.pbMinImpulse) return;
    const impBody = Math.abs(impulse.close - impulse.open);
    if (impBody / impRange < this.pbMinImpBodyRatio) return;

    const isBullish = impulse.close > impulse.open;
    const isBearish = impulse.close < impulse.open;

    let signal = null;
    let entryPrice = 0;
    let stopLoss = 0;
    let stopDist = 0;

    // ── Bullish Pullback ──
    if (isBullish) {
      const retrace = impulse.high - pb.low;
      const retracePct = retrace / impRange;
      if (retracePct < this.pbRetraceMin || retracePct > this.pbRetraceMax) return;

      // Bounce confirmation: pullback bar closes bullish and near impulse close
      if (pb.close <= pb.open) return;
      if (pb.close < impulse.close - impRange * 0.3) return;

      stopDist = pb.close - pb.low + this.stopBuffer;
      if (stopDist > this.maxStopPoints || stopDist < this.minStopPoints) return;
      if (stopDist * this.profitTargetR < this.minTargetPoints) return;

      signal = 'buy';
      entryPrice = pb.close;
      stopLoss = pb.low - this.stopBuffer;
    }

    // ── Bearish Pullback ──
    if (!signal && isBearish) {
      const retrace = pb.high - impulse.low;
      const retracePct = retrace / impRange;
      if (retracePct < this.pbRetraceMin || retracePct > this.pbRetraceMax) return;

      // Bounce confirmation: pullback bar closes bearish and near impulse close
      if (pb.close >= pb.open) return;
      if (pb.close > impulse.close + impRange * 0.3) return;

      stopDist = pb.high - pb.close + this.stopBuffer;
      if (stopDist > this.maxStopPoints || stopDist < this.minStopPoints) return;
      if (stopDist * this.profitTargetR < this.minTargetPoints) return;

      signal = 'sell';
      entryPrice = pb.close;
      stopLoss = pb.high + this.stopBuffer;
    }

    if (!signal) return;

    const targetDist = stopDist * this.profitTargetR;
    const targetPrice = signal === 'buy'
      ? entryPrice + targetDist
      : entryPrice - targetDist;

    this.signalFired = true;

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(pb.timestamp),
      strategy: 'PB',
      filterResults: [
        { name: 'Impulse', passed: true, reason: `${impRange.toFixed(1)}pt range, ${(impBody / impRange * 100).toFixed(0)}% body` },
        { name: 'Pullback', passed: true, reason: `${((isBullish ? impulse.high - pb.low : pb.high - impulse.low) / impRange * 100).toFixed(0)}% retrace` },
        { name: 'Stop', passed: true, reason: `${stopDist.toFixed(1)}pt ($${(stopDist * 2).toFixed(0)})` },
        { name: 'Target', passed: true, reason: `${targetDist.toFixed(1)}pt ($${(targetDist * 2).toFixed(0)}) = ${this.profitTargetR}R` },
      ],
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  OVERRIDES
  // ═══════════════════════════════════════════════════════════════

  /**
   * Override setPosition to track tradedToday flag
   */
  setPosition(position) {
    super.setPosition(position);
    if (position) {
      this.signalFired = true;  // Block new signals while in position
    } else {
      this.signalFired = false; // Allow new signals after position closes
    }
  }

  /**
   * Not used — analysis happens in _build2mBar and _build5mBar
   */
  analyze() {
    // No-op: analysis is triggered by bar building
  }

  getCurrentPrice() {
    if (this.currentQuote?.last) return this.currentQuote.last;
    if (this.twoMinBars.length > 0) return this.twoMinBars[this.twoMinBars.length - 1].close;
    if (this.bars.length > 0) return this.bars[this.bars.length - 1].close;
    return null;
  }

  hasEnoughData() {
    return this.twoMinBars.length >= this.emaxEmaSlow + 2;
  }

  getStatus() {
    return {
      name: this.name,
      active: this.isActive,
      barsCount1m: this.bars.length,
      barsCount2m: this.twoMinBars.length,
      barsCount5m: this.fiveMinBars.length,
      inPosition: !!this.position,
      signalFired: this.signalFired,
      position: this.position,
      maxStopPoints: this.maxStopPoints,
      profitTargetR: this.profitTargetR,
    };
  }
}

module.exports = MNQMomentumStrategy;
