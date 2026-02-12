/**
 * MNQ Momentum Strategy V2 — EMAX + Pullback + VWAP Mean Reversion
 * 
 * Three sub-strategies covering the FULL trading session:
 * 
 * 1. EMAX (EMA Cross Momentum) — 2-min bars, 6:30-8:00 AM PST
 *    - ZLEMA9/ZLEMA21 crossover (zero-lag for earlier signals)
 *    - Body >= 50% of range, range >= 5pt
 *    - Confluence score >= 3 required
 *    - Target: 4R | Stop: bar extreme + buffer
 * 
 * 2. PB (Momentum Pullback) — 5-min bars, 6:30-8:30 AM PST
 *    - Strong impulse bar (>= 20pt), 20-60% retrace, bounce confirmation
 *    - Confluence score >= 3 required
 *    - Target: 4R | Stop: pullback extreme + buffer
 * 
 * 3. VR (VWAP Mean Reversion) — 1-min bars, 8:30 AM-12:30 PM PST
 *    - Price stretches to VWAP ±2σ band (overextended)
 *    - Confirmation candle: opens+closes between 1σ and VWAP (reverting)
 *    - Volume spike on reversion bar (>= 0.8x avg)
 *    - Confluence score >= 3 required (inverted logic for MR)
 *    - Target: VWAP line (dynamic) | Stop: beyond 2σ band
 *    - This fills the 8:30 AM - 12:30 PM "dead time" window
 * 
 * Shared features:
 * - VWAP as directional filter (EMAX/PB) and target (VR)
 * - Prior day levels (HOD/LOD/Close/VWAP/VAH/VAL/POC) as confluence
 * - Multi-confluence scoring: minimum 3 factors must align
 * - Partial profit at 2R + move stop to breakeven (research-backed)
 * - EMAX gets priority > PB > VR. Max 1 trade at a time.
 * 
 * MNQ: tick=0.25, tickValue=$0.50, pointValue=$2.00
 */

const BaseStrategy = require('./base');
const VWAPEngine = require('../indicators/VWAPEngine');
const ConfluenceScorer = require('../indicators/ConfluenceScorer');
const { calcZLEMA, calcEMA, calcATR, calcRSI } = require('../indicators/zlema');

class MNQMomentumStrategyV2 extends BaseStrategy {
  constructor(config) {
    super('MNQ_MOMENTUM_V2', config);

    // ── EMAX Parameters ──
    this.emaxEnabled = config.emaxEnabled !== undefined ? config.emaxEnabled : false; // Default: false (PF 0.80-0.89)
    this.emaxEmaFast = config.emaxEmaFast || 9;
    this.emaxEmaSlow = config.emaxEmaSlow || 21;
    this.emaxMinBarRange = config.emaxMinBarRange || 5;
    this.emaxMinBodyRatio = config.emaxMinBodyRatio || 0.5;
    this.emaxMaxTime = config.emaxMaxTime || 480;             // 8:00 AM PST
    this.emaxUseZLEMA = config.emaxUseZLEMA === true;         // Default: false (EMA outperforms ZLEMA)

    // ── PB Parameters ──
    this.pbMinImpulse = config.pbMinImpulse || 20;
    this.pbMinImpBodyRatio = config.pbMinImpBodyRatio || 0.5;
    this.pbRetraceMin = config.pbRetraceMin || 0.2;
    this.pbRetraceMax = config.pbRetraceMax || 0.6;
    this.pbMaxTime = config.pbMaxTime || 510;                 // 8:30 AM PST

    // ── VR (VWAP Mean Reversion) Parameters ──
    this.vrEnabled = config.vrEnabled !== false;               // Default: true
    this.vrMinTime = config.vrMinTime || 510;                  // 8:30 AM PST (after PB cutoff)
    this.vrMaxTime = config.vrMaxTime || 750;                  // 12:30 PM PST (30 min before EOD close)
    this.vrMinSigma = config.vrMinSigma || 1.5;               // Min σ distance to trigger watch
    this.vrEntrySigmaMax = config.vrEntrySigmaMax || 1.0;      // Entry when price reverts inside 1σ
    this.vrStopBeyondBand = config.vrStopBeyondBand || 3;      // Stop: 3pt beyond 2σ band
    this.vrTargetMode = config.vrTargetMode || 'fixed';         // 'fixed' or 'vwap'
    this.vrTargetR = config.vrTargetR || 4;                     // R-multiple for fixed target mode
    this.vrMinBarVolRatio = config.vrMinBarVolRatio || 0.8;    // Min volume ratio on entry bar
    this.vrMaxStopPoints = config.vrMaxStopPoints || 20;       // Max stop distance for VR
    this.vrMinStopPoints = config.vrMinStopPoints || 4;        // Min stop distance for VR
    this.vrCooldownBars = config.vrCooldownBars || 10;         // Bars between VR signals

    // ── Shared Parameters ──
    this.maxStopPoints = config.maxStopPoints || 25;
    this.minStopPoints = config.minStopPoints || 5;
    this.stopBuffer = config.stopBuffer || 2;
    this.profitTargetR = config.profitTargetR || 4;
    this.minTargetPoints = config.minTargetPoints || 60;

    // ── Partial Profit Parameters ──
    this.partialProfitEnabled = config.partialProfitEnabled !== false; // Default: true
    this.partialProfitR = config.partialProfitR || 2;                  // Take partial at 2R
    this.moveStopToBE = config.moveStopToBE !== false;                 // Move stop to BE after partial

    // ── Confluence Parameters ──
    this.minConfluence = config.minConfluence !== undefined ? config.minConfluence : 0; // Default: 0 (sub-strategy filters sufficient)
    this.confluenceScorer = new ConfluenceScorer({
      minScore: this.minConfluence,
      volumeAvgPeriod: config.volumeAvgPeriod || 20,
      momentumBars: config.momentumBars || 5,
      priorLevelTolerance: config.priorLevelTolerance || 5,
    });

    // ── VWAP Engine (injected by TradovateBot, or created here) ──
    this.vwapEngine = config.vwapEngine || new VWAPEngine();

    // ── Bar Building State ──
    this.twoMinBars = [];
    this.fiveMinBars = [];
    this.current2mBar = null;
    this.current5mBar = null;
    this._current2mBucket = null;
    this._current5mBucket = null;

    // ── VR State ──
    this._vrWatching = null;       // 'long' or 'short' when price hit 2σ
    this._vrWatchPrice = null;     // Price when we started watching
    this._vrCooldownCount = 0;     // Bars since last VR signal
    this._vrTradeCount = 0;        // VR trades today

    // ── Day State ──
    this.signalFired = false;
    this.sessionBarCount = 0;
    this.dayStarted = false;
    this._tradeCountToday = 0;     // Total trades fired today (for AI context)
    this._prevTradeResult = 'none'; // 'win', 'loss', or 'none' (for AI context)

    // ── Indicator Cache ──
    this._lastRSI = null;
    this._lastATR = null;

    // Session filter reference
    this.sessionFilter = config.sessionFilter || null;
  }

  /**
   * Reset for new trading day
   */
  resetDay() {
    // VWAP engine saves prior day levels internally on resetDay()
    this.vwapEngine.resetDay();

    this.twoMinBars = [];
    this.fiveMinBars = [];
    this.current2mBar = null;
    this.current5mBar = null;
    this._current2mBucket = null;
    this._current5mBucket = null;
    this.signalFired = false;
    this.sessionBarCount = 0;
    this.dayStarted = true;
    this._tradeCountToday = 0;
    this._prevTradeResult = 'none';
    this._vrWatching = null;
    this._vrWatchPrice = null;
    this._vrCooldownCount = 0;
    this._vrTradeCount = 0;
    this._lastRSI = null;
    this._lastATR = null;
  }

  /**
   * Process incoming 1-minute bar
   */
  onBar(bar) {
    // Store raw 1-min bars
    this.bars.push(bar);
    if (this.bars.length > 500) this.bars.shift();

    this.sessionBarCount++;

    // ── Feed VWAP Engine ──
    this.vwapEngine.onBar(bar);

    // ── Update indicator cache every bar ──
    if (this.bars.length >= 15) {
      const closes = this.bars.map(b => b.close);
      this._lastRSI = calcRSI(closes, 14);
      this._lastATR = calcATR(this.bars, 14);
    }

    // Log every 10 bars
    if (this.sessionBarCount % 10 === 0) {
      const vState = this.vwapEngine.isReady() ? `VWAP:${this.vwapEngine.vwap?.toFixed(1)}` : 'VWAP:warming';
      console.log(`[Strategy:${this.name}] ${this.sessionBarCount} bars | 2m:${this.twoMinBars.length} | 5m:${this.fiveMinBars.length} | ${vState} | sig:${this.signalFired}`);
    }

    // Build 2-min and 5-min bars simultaneously
    this._build2mBar(bar);
    this._build5mBar(bar);

    // ── Check VR (VWAP Mean Reversion) on every 1-min bar ──
    if (this.vrEnabled && this.isActive && !this.signalFired && !this.position) {
      if (this._vrCooldownCount > 0) {
        this._vrCooldownCount--;
      } else {
        this._checkVR(bar);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  BAR BUILDING
  // ═══════════════════════════════════════════════════════════════

  _build2mBar(bar) {
    // Clock-aligned 2m bars: minutes 0-1, 2-3, 4-5, ... etc.
    const barMin = new Date(bar.timestamp).getUTCMinutes();
    const bucket2m = Math.floor(barMin / 2);

    if (!this.current2mBar || this._current2mBucket !== bucket2m) {
      // New 2m bucket — finalize previous bar if it exists
      if (this.current2mBar) {
        this.twoMinBars.push({ ...this.current2mBar });
        if (this.twoMinBars.length > 200) this.twoMinBars.shift();

        if (this.emaxEnabled && this.isActive && !this.signalFired && !this.position) {
          this._checkEMAX();
        }
      }
      this.current2mBar = {
        timestamp: bar.timestamp,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume || 0,
      };
      this._current2mBucket = bucket2m;
    } else {
      this.current2mBar.high = Math.max(this.current2mBar.high, bar.high);
      this.current2mBar.low = Math.min(this.current2mBar.low, bar.low);
      this.current2mBar.close = bar.close;
      this.current2mBar.volume += (bar.volume || 0);
    }
  }

  _build5mBar(bar) {
    // Clock-aligned 5m bars: minutes 0-4, 5-9, 10-14, 15-19, ... etc.
    // This prevents dropped 1m bars from shifting all subsequent 5m boundaries.
    const barMin = new Date(bar.timestamp).getUTCMinutes();
    const bucket5m = Math.floor(barMin / 5);

    if (!this.current5mBar || this._current5mBucket !== bucket5m) {
      // New 5m bucket — finalize previous bar if it exists
      if (this.current5mBar) {
        this.fiveMinBars.push({ ...this.current5mBar });
        if (this.fiveMinBars.length > 200) this.fiveMinBars.shift();

        // Enhancement 2: Log completed 5m bar for audit trail
        const fb = this.current5mBar;
        console.log(`[5m #${this.fiveMinBars.length}] ${fb.timestamp} O=${fb.open} H=${fb.high} L=${fb.low} C=${fb.close} V=${fb.volume}`);

        if (this.isActive && !this.signalFired && !this.position) {
          this._checkPB();
        }
      }
      this.current5mBar = {
        timestamp: bar.timestamp,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume || 0,
      };
      this._current5mBucket = bucket5m;
    } else {
      this.current5mBar.high = Math.max(this.current5mBar.high, bar.high);
      this.current5mBar.low = Math.min(this.current5mBar.low, bar.low);
      this.current5mBar.close = bar.close;
      this.current5mBar.volume += (bar.volume || 0);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  HELPER: Get PST minutes from timestamp
  // ═══════════════════════════════════════════════════════════════

  _getPSTMinutes(timestamp) {
    const d = new Date(timestamp);
    const pstStr = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
    const parts = pstStr.split(', ')[1].split(':');
    return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  }

  // ═══════════════════════════════════════════════════════════════
  //  STRATEGY 1: EMAX (EMA Cross Momentum on 2-min bars)
  //  Now uses ZLEMA for zero-lag crossover detection
  // ═══════════════════════════════════════════════════════════════

  _checkEMAX() {
    if (this.twoMinBars.length < this.emaxEmaSlow + 5) return;

    const bar = this.twoMinBars[this.twoMinBars.length - 1];
    const pstMins = this._getPSTMinutes(bar.timestamp);
    if (pstMins > this.emaxMaxTime) return;

    // Calculate current and previous EMAs (ZLEMA or standard)
    const closes = this.twoMinBars.map(b => b.close);
    const calcFn = this.emaxUseZLEMA ? calcZLEMA : calcEMA;

    const ema9 = calcFn(closes, this.emaxEmaFast);
    const ema21 = calcFn(closes, this.emaxEmaSlow);
    const prevCloses = closes.slice(0, -1);
    const prevEma9 = calcFn(prevCloses, this.emaxEmaFast);
    const prevEma21 = calcFn(prevCloses, this.emaxEmaSlow);

    if (!ema9 || !ema21 || !prevEma9 || !prevEma21) return;

    // Bar quality checks
    const range = bar.high - bar.low;
    if (range < this.emaxMinBarRange) return;
    const bodyRatio = Math.abs(bar.close - bar.open) / range;
    if (bodyRatio < this.emaxMinBodyRatio) return;

    let signal = null;
    let stopDist = 0;

    // Bullish cross
    if (prevEma9 <= prevEma21 && ema9 > ema21 && bar.close > bar.open) {
      signal = 'buy';
      stopDist = bar.close - bar.low + this.stopBuffer;
    }

    // Bearish cross
    if (prevEma9 >= prevEma21 && ema9 < ema21 && bar.close < bar.open) {
      signal = 'sell';
      stopDist = bar.high - bar.close + this.stopBuffer;
    }

    if (!signal) return;
    if (stopDist > this.maxStopPoints || stopDist < this.minStopPoints) return;

    const targetDist = stopDist * this.profitTargetR;
    if (targetDist < this.minTargetPoints) return;

    // ── Confluence Check ──
    const confluence = this.confluenceScorer.score({
      direction: signal,
      price: bar.close,
      vwapEngine: this.vwapEngine,
      emaFast: ema9,
      emaSlow: ema21,
      rsi: this._lastRSI,
      recentBars: this.bars,
      strategyType: 'EMAX',
    });

    if (!confluence.passed) {
      console.log(`[EMAX] Signal rejected: confluence ${confluence.score}/${confluence.maxScore} < ${this.minConfluence}`);
      return;
    }

    const entryPrice = bar.close;
    const stopLoss = signal === 'buy' ? bar.low - this.stopBuffer : bar.high + this.stopBuffer;
    const targetPrice = signal === 'buy' ? entryPrice + targetDist : entryPrice - targetDist;

    this.signalFired = true;
    this._tradeCountToday++;

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(bar.timestamp),
      strategy: 'EMAX',
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: this.partialProfitEnabled,
      partialProfitR: this.partialProfitR,
      moveStopToBE: this.moveStopToBE,
      confluenceScore: confluence.score,
      vwapState: this.vwapEngine.getState(),
      filterResults: [
        { name: `${this.emaxUseZLEMA ? 'ZL' : ''}EMA Cross`, passed: true, reason: `EMA${this.emaxEmaFast} crossed EMA${this.emaxEmaSlow}` },
        { name: 'Bar Quality', passed: true, reason: `Range: ${range.toFixed(1)}pt, Body: ${(bodyRatio * 100).toFixed(0)}%` },
        { name: 'Confluence', passed: true, reason: `${confluence.score}/${confluence.maxScore} factors` },
        ...confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
        { name: 'Stop', passed: true, reason: `${stopDist.toFixed(1)}pt ($${(stopDist * 2).toFixed(0)})` },
        { name: 'Target', passed: true, reason: `${targetDist.toFixed(1)}pt ($${(targetDist * 2).toFixed(0)}) = ${this.profitTargetR}R` },
      ],
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  STRATEGY 2: PB (Momentum Pullback on 5-min bars)
  // ═══════════════════════════════════════════════════════════════

  _checkPB() {
    const barIdx = this.fiveMinBars.length;
    if (barIdx < 5) return;

    const pb = this.fiveMinBars[barIdx - 1];
    const impulse = this.fiveMinBars[barIdx - 2];
    if (!impulse) return;

    const pstMins = this._getPSTMinutes(pb.timestamp);
    if (pstMins > this.pbMaxTime) {
      console.log(`[PB #${barIdx}] SKIP: past cutoff (${pstMins} > ${this.pbMaxTime})`);
      return;
    }

    // Impulse bar quality
    const impRange = impulse.high - impulse.low;
    if (impRange < this.pbMinImpulse) {
      console.log(`[PB #${barIdx}] SKIP: impulse range ${impRange.toFixed(1)} < ${this.pbMinImpulse}`);
      return;
    }
    const impBody = Math.abs(impulse.close - impulse.open);
    if (impBody / impRange < this.pbMinImpBodyRatio) {
      console.log(`[PB #${barIdx}] SKIP: impulse body ratio ${(impBody/impRange).toFixed(2)} < ${this.pbMinImpBodyRatio}`);
      return;
    }

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
      if (retracePct < this.pbRetraceMin || retracePct > this.pbRetraceMax) {
        console.log(`[PB #${barIdx}] SKIP: bull retrace ${(retracePct*100).toFixed(1)}% outside ${(this.pbRetraceMin*100).toFixed(0)}-${(this.pbRetraceMax*100).toFixed(0)}%`);
        return;
      }
      if (pb.close <= pb.open) {
        console.log(`[PB #${barIdx}] SKIP: bull pb bar not bullish (C=${pb.close} <= O=${pb.open})`);
        return;
      }
      if (pb.close < impulse.close - impRange * 0.3) {
        console.log(`[PB #${barIdx}] SKIP: bull pb.close ${pb.close} too far below impulse`);
        return;
      }

      stopDist = pb.close - pb.low + this.stopBuffer;
      if (stopDist > this.maxStopPoints || stopDist < this.minStopPoints) {
        console.log(`[PB #${barIdx}] SKIP: stop ${stopDist.toFixed(1)}pt outside ${this.minStopPoints}-${this.maxStopPoints}`);
        return;
      }
      if (stopDist * this.profitTargetR < this.minTargetPoints) {
        console.log(`[PB #${barIdx}] SKIP: target ${(stopDist*this.profitTargetR).toFixed(1)}pt < min ${this.minTargetPoints}`);
        return;
      }

      signal = 'buy';
      entryPrice = pb.close;
      stopLoss = pb.low - this.stopBuffer;
    }

    // ── Bearish Pullback ──
    if (!signal && isBearish) {
      const retrace = pb.high - impulse.low;
      const retracePct = retrace / impRange;
      if (retracePct < this.pbRetraceMin || retracePct > this.pbRetraceMax) {
        console.log(`[PB #${barIdx}] SKIP: bear retrace ${(retracePct*100).toFixed(1)}% outside ${(this.pbRetraceMin*100).toFixed(0)}-${(this.pbRetraceMax*100).toFixed(0)}%`);
        return;
      }
      if (pb.close >= pb.open) {
        console.log(`[PB #${barIdx}] SKIP: bear pb bar not bearish (C=${pb.close} >= O=${pb.open})`);
        return;
      }
      if (pb.close > impulse.close + impRange * 0.3) {
        console.log(`[PB #${barIdx}] SKIP: bear pb.close ${pb.close} too far above impulse`);
        return;
      }

      stopDist = pb.high - pb.close + this.stopBuffer;
      if (stopDist > this.maxStopPoints || stopDist < this.minStopPoints) {
        console.log(`[PB #${barIdx}] SKIP: stop ${stopDist.toFixed(1)}pt outside ${this.minStopPoints}-${this.maxStopPoints}`);
        return;
      }
      if (stopDist * this.profitTargetR < this.minTargetPoints) {
        console.log(`[PB #${barIdx}] SKIP: target ${(stopDist*this.profitTargetR).toFixed(1)}pt < min ${this.minTargetPoints}`);
        return;
      }

      signal = 'sell';
      entryPrice = pb.close;
      stopLoss = pb.high + this.stopBuffer;
    }

    if (!signal) return;

    // ── Confluence Check ──
    const fiveMinCloses = this.fiveMinBars.map(b => b.close);
    const emaFast5m = calcEMA(fiveMinCloses, 9);
    const emaSlow5m = calcEMA(fiveMinCloses, 21);

    const confluence = this.confluenceScorer.score({
      direction: signal,
      price: entryPrice,
      vwapEngine: this.vwapEngine,
      emaFast: emaFast5m,
      emaSlow: emaSlow5m,
      rsi: this._lastRSI,
      recentBars: this.bars,
      strategyType: 'PB',
    });

    if (!confluence.passed) {
      console.log(`[PB #${barIdx}] SKIP: confluence ${confluence.score}/${confluence.maxScore} < ${this.minConfluence}`);
      return;
    }

    const targetDist = stopDist * this.profitTargetR;
    const targetPrice = signal === 'buy' ? entryPrice + targetDist : entryPrice - targetDist;

    console.log(`[PB #${barIdx}] ✅ SIGNAL: ${signal.toUpperCase()} @ ${entryPrice} | stop=${stopLoss} (${stopDist.toFixed(1)}pt) | target=${targetPrice.toFixed(2)} (${this.profitTargetR}R) | conf=${confluence.score}`);

    this.signalFired = true;
    this._tradeCountToday++;

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(pb.timestamp),
      strategy: 'PB',
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: this.partialProfitEnabled,
      partialProfitR: this.partialProfitR,
      moveStopToBE: this.moveStopToBE,
      confluenceScore: confluence.score,
      vwapState: this.vwapEngine.getState(),
      filterResults: [
        { name: 'Impulse', passed: true, reason: `${impRange.toFixed(1)}pt range, ${(impBody / impRange * 100).toFixed(0)}% body` },
        { name: 'Pullback', passed: true, reason: `${((isBullish ? impulse.high - pb.low : pb.high - impulse.low) / impRange * 100).toFixed(0)}% retrace` },
        { name: 'Confluence', passed: true, reason: `${confluence.score}/${confluence.maxScore} factors` },
        ...confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
        { name: 'Stop', passed: true, reason: `${stopDist.toFixed(1)}pt ($${(stopDist * 2).toFixed(0)})` },
        { name: 'Target', passed: true, reason: `${targetDist.toFixed(1)}pt ($${(targetDist * 2).toFixed(0)}) = ${this.profitTargetR}R` },
      ],
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  STRATEGY 3: VR (VWAP Mean Reversion on 1-min bars)
  //  Fills the 8:30 AM - 12:30 PM "dead time" window
  // ═══════════════════════════════════════════════════════════════

  _checkVR(bar) {
    if (!this.vwapEngine.isReady()) return;
    if (this.bars.length < 30) return; // Need enough bars for volume avg

    const pstMins = this._getPSTMinutes(bar.timestamp);
    if (pstMins < this.vrMinTime || pstMins > this.vrMaxTime) return;

    const price = bar.close;
    const sigmaDistance = this.vwapEngine.getVWAPDistance(price);

    // ── Phase 1: Watch for overextension (price hits ±2σ or beyond) ──
    if (!this._vrWatching) {
      if (sigmaDistance >= this.vrMinSigma) {
        this._vrWatching = 'short'; // Price above 2σ → watch for short reversion
        this._vrWatchPrice = price;
      } else if (sigmaDistance <= -this.vrMinSigma) {
        this._vrWatching = 'long'; // Price below -2σ → watch for long reversion
        this._vrWatchPrice = price;
      }
      return;
    }

    // ── Phase 2: Wait for reversion confirmation ──
    // Entry: candle opens AND closes between 1σ band and VWAP
    const vwap = this.vwapEngine.vwap;
    const upper1 = this.vwapEngine.upperBand1;
    const lower1 = this.vwapEngine.lowerBand1;
    const upper2 = this.vwapEngine.upperBand2;
    const lower2 = this.vwapEngine.lowerBand2;

    let signal = null;
    let entryPrice = 0;
    let stopLoss = 0;
    let stopDist = 0;
    let targetPrice = 0;
    let targetDist = 0;

    if (this._vrWatching === 'long') {
      // We're watching for a LONG reversion (price was below -2σ, now reverting up)
      // Entry: bar opens below lower1 and closes between lower1 and VWAP
      const barInZone = bar.open <= lower1 && bar.close > lower1 && bar.close < vwap;
      const barBullish = bar.close > bar.open; // Bullish candle

      if (barInZone && barBullish) {
        signal = 'buy';
        entryPrice = bar.close;
        stopLoss = lower2 - this.vrStopBeyondBand;
        stopDist = entryPrice - stopLoss;

        // Target: fixed R-multiple or VWAP line
        if (this.vrTargetMode === 'fixed') {
          targetPrice = entryPrice + stopDist * this.vrTargetR;
        } else if (this.vrTargetMode === 'vwap') {
          targetPrice = vwap;
        } else {
          targetPrice = upper1;
        }
        targetDist = targetPrice - entryPrice;
      } else if (sigmaDistance > 0) {
        // Price crossed above VWAP — reversion complete, cancel watch
        this._vrWatching = null;
        this._vrWatchPrice = null;
        return;
      }
    }

    if (this._vrWatching === 'short') {
      // We're watching for a SHORT reversion (price was above +2σ, now reverting down)
      const barInZone = bar.open >= upper1 && bar.close < upper1 && bar.close > vwap;
      const barBearish = bar.close < bar.open;

      if (barInZone && barBearish) {
        signal = 'sell';
        entryPrice = bar.close;
        stopLoss = upper2 + this.vrStopBeyondBand;
        stopDist = stopLoss - entryPrice;

        if (this.vrTargetMode === 'fixed') {
          targetPrice = entryPrice - stopDist * this.vrTargetR;
        } else if (this.vrTargetMode === 'vwap') {
          targetPrice = vwap;
        } else {
          targetPrice = lower1;
        }
        targetDist = entryPrice - targetPrice;
      } else if (sigmaDistance < 0) {
        // Price crossed below VWAP — reversion complete, cancel watch
        this._vrWatching = null;
        this._vrWatchPrice = null;
        return;
      }
    }

    if (!signal) return;

    // Validate stop/target distances
    if (stopDist > this.vrMaxStopPoints || stopDist < this.vrMinStopPoints) {
      this._vrWatching = null;
      return;
    }
    if (targetDist < 5) { // Minimum 5pt target for VR
      this._vrWatching = null;
      return;
    }

    // ── Volume check on entry bar ──
    const avgVol = this.bars.slice(-20).reduce((s, b) => s + (b.volume || 0), 0) / 20;
    const barVol = bar.volume || 0;
    if (avgVol > 0 && barVol / avgVol < this.vrMinBarVolRatio) {
      return; // Low volume — don't enter, keep watching
    }

    // ── Confluence Check (inverted for mean reversion) ──
    const oneMinCloses = this.bars.map(b => b.close);
    const emaFast1m = calcEMA(oneMinCloses, 9);
    const emaSlow1m = calcEMA(oneMinCloses, 21);

    const confluence = this.confluenceScorer.score({
      direction: signal,
      price: entryPrice,
      vwapEngine: this.vwapEngine,
      emaFast: emaFast1m,
      emaSlow: emaSlow1m,
      rsi: this._lastRSI,
      recentBars: this.bars,
      strategyType: 'VR',
    });

    if (!confluence.passed) {
      console.log(`[VR] Signal rejected: confluence ${confluence.score}/${confluence.maxScore} < ${this.minConfluence}`);
      return; // Keep watching, don't reset
    }

    // ── Emit Signal ──
    this.signalFired = true;
    this._vrWatching = null;
    this._vrWatchPrice = null;
    this._vrCooldownCount = this.vrCooldownBars;
    this._vrTradeCount++;

    const rMultiple = targetDist / stopDist;

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(bar.timestamp),
      strategy: 'VR',
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: false, // VR targets VWAP directly, no partial
      moveStopToBE: false,
      confluenceScore: confluence.score,
      vwapState: this.vwapEngine.getState(),
      filterResults: [
        { name: 'VWAP Reversion', passed: true, reason: `${sigmaDistance.toFixed(2)}σ → reverting to VWAP` },
        { name: 'Entry Zone', passed: true, reason: `Between 1σ and VWAP` },
        { name: 'Volume', passed: true, reason: `${(barVol / avgVol).toFixed(2)}x avg` },
        { name: 'Confluence', passed: true, reason: `${confluence.score}/${confluence.maxScore} factors` },
        ...confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
        { name: 'Stop', passed: true, reason: `${stopDist.toFixed(1)}pt ($${(stopDist * 2).toFixed(0)})` },
        { name: 'Target', passed: true, reason: `${targetDist.toFixed(1)}pt (${rMultiple.toFixed(1)}R) → ${this.vrTargetMode === 'vwap' ? 'VWAP' : '1σ band'}` },
      ],
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  OVERRIDES
  // ═══════════════════════════════════════════════════════════════

  setPosition(position) {
    super.setPosition(position);
    if (position) {
      this.signalFired = true;
    } else {
      this.signalFired = false;
      // Reset VR watch state when position closes (allow new VR setups)
      this._vrWatching = null;
      this._vrWatchPrice = null;
    }
  }

  /**
   * Called by PositionHandler when a trade closes.
   * Updates _prevTradeResult for AI context on next signal.
   * @param {'win'|'loss'} result
   */
  onTradeResult(result) {
    this._prevTradeResult = result;
  }

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
    return this.twoMinBars.length >= this.emaxEmaSlow + 5;
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
      vrEnabled: this.vrEnabled,
      vrWatching: this._vrWatching,
      vrTradeCount: this._vrTradeCount,
      vwap: this.vwapEngine.vwap ? +this.vwapEngine.vwap.toFixed(2) : null,
      vwapReady: this.vwapEngine.isReady(),
      priorDayHigh: this.vwapEngine.priorDayHigh,
      priorDayLow: this.vwapEngine.priorDayLow,
      confluenceMin: this.minConfluence,
      rsi: this._lastRSI ? +this._lastRSI.toFixed(1) : null,
      atr: this._lastATR ? +this._lastATR.toFixed(2) : null,
    };
  }
}

module.exports = MNQMomentumStrategyV2;
