/**
 * MNQ Momentum Strategy V2.9 — PB + VR (EMAX disabled)
 * 
 * Two active sub-strategies covering the trading session:
 * 
 * 1. EMAX (EMA Cross Momentum) — DISABLED (PF 0.80-0.89)
 * 
 * 2. PB (Momentum Pullback) — 5-min bars, 6:30-9:30 AM PST
 *    - Strong impulse bar (>= 15pt), 10-85% retrace
 *    - limit_structural entry mode (limit order at 60% retrace zone)
 *    - Confluence: disabled (minConfluence=0)
 *    - Target: 2.5R | Stop: pullback extreme + 2pt buffer, max 35pt
 *    - BE stop at 1.2R activation
 * 
 * 3. VR (VWAP Mean Reversion) — 1-min bars, 8:30-11:00 AM PST
 *    - Price stretches to VWAP ±1.3σ band (overextended)
 *    - Confirmation candle: opens+closes between 1σ and VWAP (reverting)
 *    - Volume spike on reversion bar (>= 0.8x avg)
 *    - Target: 4R fixed | Stop: beyond 2σ band + 3pt, max 20pt
 *    - This fills the 8:30 AM - 11:00 AM window after PB cutoff
 * 
 * Shared features:
 * - VWAP as directional filter (PB) and target reference (VR)
 * - Prior day levels (HOD/LOD/Close/VWAP/VAH/VAL/POC) as confluence factors
 * - Volume filter: bar vol >= 0.9x avg (Monte Carlo validated)
 * - Dynamic contract sizing: $60 max risk, up to 10 contracts
 * - Max 3 losses/day, max 3 consecutive losses
 * - Max 1 trade at a time
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

    // ── PB Parameters (5m) ──
    this.pbMinImpulse = config.pbMinImpulse || 15;
    this.pbMaxImpulse = config.pbMaxImpulse || Infinity;      // Max impulse range (pts), Infinity = no cap
    this.pbMinImpBodyRatio = config.pbMinImpBodyRatio || 0.15;
    this.pbRetraceMin = config.pbRetraceMin || 0.10;
    this.pbRetraceMax = config.pbRetraceMax || 0.85;
    this.pbMaxTime = config.pbMaxTime || 510;                 // 8:30 AM PST
    this.pbLookbackBars = config.pbLookbackBars || 1;         // How many bars back to search for impulse (1=adjacent only)

    // ── PB 3m Parameters (scaled from 5m) ──
    this.pb3mEnabled = config.pb3mEnabled === true;            // Default: false (opt-in)
    this.pb3mMinImpulse = config.pb3mMinImpulse || 10;
    this.pb3mMaxImpulse = config.pb3mMaxImpulse || 30;
    this.pb3mMinImpBodyRatio = config.pb3mMinImpBodyRatio || 0.15;
    this.pb3mRetraceMin = config.pb3mRetraceMin || 0.10;
    this.pb3mRetraceMax = config.pb3mRetraceMax || 0.85;
    this.pb3mMaxTime = config.pb3mMaxTime || 570;             // 9:30 AM PST
    this.pb3mLookbackBars = config.pb3mLookbackBars || 1;
    this.pb3mMaxStopPoints = config.pb3mMaxStopPoints || 25;  // Tighter stops for smaller TF
    this.pb3mMinStopPoints = config.pb3mMinStopPoints || 3;
    this.pb3mMinTargetPoints = config.pb3mMinTargetPoints || 15;

    // ── PB 2m Parameters (scaled from 3m) ──
    this.pb2mEnabled = config.pb2mEnabled === true;            // Default: false (opt-in)
    this.pb2mMinImpulse = config.pb2mMinImpulse || 8;
    this.pb2mMaxImpulse = config.pb2mMaxImpulse || 25;
    this.pb2mMinImpBodyRatio = config.pb2mMinImpBodyRatio || 0.15;
    this.pb2mRetraceMin = config.pb2mRetraceMin || 0.10;
    this.pb2mRetraceMax = config.pb2mRetraceMax || 0.85;
    this.pb2mMaxTime = config.pb2mMaxTime || 570;             // 9:30 AM PST
    this.pb2mLookbackBars = config.pb2mLookbackBars || 1;
    this.pb2mMaxStopPoints = config.pb2mMaxStopPoints || 20;  // Tighter stops for smallest TF
    this.pb2mMinStopPoints = config.pb2mMinStopPoints || 2;
    this.pb2mMinTargetPoints = config.pb2mMinTargetPoints || 10;

    // ── PB Entry Timing Improvements ──
    // Entry mode: 'immediate' (5m close, legacy), 'confirm1m' (wait for 1m bounce), 'limit' (limit at zone)
    this.pbEntryMode = config.pbEntryMode || 'immediate';
    this.pbConfirmBars = config.pbConfirmBars || 5;            // Max 1m bars to wait for confirmation
    this.pbLimitRetracePct = config.pbLimitRetracePct || 0.5;  // Limit order at 50% of impulse retrace zone
    this.pbLimitTimeoutBars = config.pbLimitTimeoutBars || 3;  // Cancel limit after N 1m bars
    this.pbTrendFilterEnabled = config.pbTrendFilterEnabled === true;  // VWAP+EMA trend filter (default OFF, opt-in via .env)

    // ── Tick-Triggered Entry (intra-bar evaluation) ──
    this.pbTickEntry = config.pbTickEntry === true;             // PB 5m tick entry (default OFF)
    this.pb3mTickEntry = config.pb3mTickEntry === true;         // PB 3m tick entry (default OFF)
    this.pb2mTickEntry = config.pb2mTickEntry === true;         // PB 2m tick entry (default OFF)

    // ── Post-Trade Cooldown ──
    this.cooldownBars = config.cooldownBars !== undefined ? config.cooldownBars : 6;  // 1m bars to wait after a trade

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
    this.maxStopPoints = config.maxStopPoints || 35;
    this.minStopPoints = config.minStopPoints || 5;
    this.stopBuffer = config.stopBuffer || 2;
    this.profitTargetR = config.profitTargetR !== undefined ? config.profitTargetR : 2.5;
    this.minTargetPoints = config.minTargetPoints || 20;
    this.maxLossesPerDay = config.maxLossesPerDay !== undefined ? config.maxLossesPerDay : 3;

    // ── Partial Profit Parameters ──
    this.partialProfitEnabled = config.partialProfitEnabled === true;  // Default: false
    this.partialProfitR = config.partialProfitR || 2;                  // Take partial at 2R
    this.moveStopToBE = config.moveStopToBE === true;                  // Default: false (explicit opt-in)

    // ── Confluence Parameters ──
    this.minConfluence = config.minConfluence !== undefined ? config.minConfluence : 0; // Default: 0 (V2.9 frequency sweep)
    this.confluenceScorer = new ConfluenceScorer({
      minScore: this.minConfluence,
      volumeAvgPeriod: config.volumeAvgPeriod || 20,
      momentumBars: config.momentumBars || 5,
      priorLevelTolerance: config.priorLevelTolerance || 5,
    });

    // ── Volume Filter Parameters ──
    this.volumeFilterEnabled = config.volumeFilterEnabled === true;  // Default: false
    this.volumeFilterMin = config.volumeFilterMin !== undefined ? config.volumeFilterMin : 0.9;
    this.volumeFilterPeriod = config.volumeFilterPeriod || 20;

    // ── VWAP Engine (injected by TradovateBot, or created here) ──
    this.vwapEngine = config.vwapEngine || new VWAPEngine();

    // ── Bar Building State ──
    this.twoMinBars = [];
    this.threeMinBars = [];
    this.fiveMinBars = [];
    this.current2mBar = null;
    this.current3mBar = null;
    this.current5mBar = null;
    this._current2mBucket = null;
    this._current3mBucket = null;
    this._current5mBucket = null;

    // ── PB Watch State (for 1m confirmation / limit entry) ──
    this._pbWatch = null;          // Pending PB setup waiting for confirmation

    // ── Tick-Triggered Armed State ──
    this._armedPB = null;          // Armed PB 5m setup waiting for tick trigger
    this._armedPB3m = null;        // Armed PB 3m setup waiting for tick trigger
    this._armedPB2m = null;        // Armed PB 2m setup waiting for tick trigger
    this._prevTickPrice = null;    // Previous tick price for direction detection
    this._tickCount = 0;           // Tick count since last armed setup (for logging)

    // ── Cooldown State ──
    this._cooldownRemaining = 0;   // 1m bars remaining before next signal allowed

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
    this._lossCountToday = 0;       // Losses today (stop after maxLossesPerDay)
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
    this.threeMinBars = [];
    this.fiveMinBars = [];
    this.current2mBar = null;
    this.current3mBar = null;
    this.current5mBar = null;
    this._current2mBucket = null;
    this._current3mBucket = null;
    this._current5mBucket = null;
    this.signalFired = false;
    this.sessionBarCount = 0;
    this.dayStarted = true;
    this._tradeCountToday = 0;
    this._lossCountToday = 0;
    this._prevTradeResult = 'none';
    this._pbWatch = null;
    this._armedPB = null;
    this._armedPB3m = null;
    this._armedPB2m = null;
    this._prevTickPrice = null;
    this._tickCount = 0;
    this._cooldownRemaining = 0;
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

    // ── Log 1m bar count every bar ──
    console.log(`[1m #${this.sessionBarCount}] O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} V=${bar.volume || 0}`);

    // ── Cooldown decrement ──
    if (this._cooldownRemaining > 0) {
      this._cooldownRemaining--;
      if (this._cooldownRemaining === 0) {
        console.log(`[COOLDOWN] ✅ Cooldown expired — ready for new signals`);
      } else {
        console.log(`[COOLDOWN] ${this._cooldownRemaining} bars remaining`);
      }
    }

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
      const armed = [this._armedPB ? 'PB' : null, this._armedPB3m ? 'PB3m' : null, this._armedPB2m ? 'PB2m' : null].filter(Boolean).join('+') || 'none';
      console.log(`[Strategy:${this.name}] ${this.sessionBarCount} bars | 2m:${this.twoMinBars.length} | 3m:${this.threeMinBars.length} | 5m:${this.fiveMinBars.length} | ${vState} | sig:${this.signalFired} | armed:${armed} | cd:${this._cooldownRemaining}`);
    }

    // Build 2-min, 3-min, and 5-min bars simultaneously
    this._build2mBar(bar);
    if (this.pb3mEnabled) this._build3mBar(bar);
    this._build5mBar(bar);

    // ── Check PB 1m confirmation (if watching for bounce) ──
    if (this._pbWatch && this._canSignal()) {
      this._checkPBConfirmation(bar);
    }

    // ── Check VR (VWAP Mean Reversion) on every 1-min bar ──
    if (this.vrEnabled && this._canSignal()) {
      if (this._vrCooldownCount > 0) {
        this._vrCooldownCount--;
      } else {
        this._checkVR(bar);
      }
    }
  }

  /**
   * Check if a new signal is allowed (shared guard for cooldown + all existing checks)
   */
  _canSignal() {
    return this.isActive && !this.signalFired && !this.position
      && this._lossCountToday < this.maxLossesPerDay
      && this._cooldownRemaining <= 0;
  }

  /**
   * Process incoming tick (real-time trade print) for intra-bar entry evaluation.
   * Called by InstrumentRunner/TradovateBot on every Databento trade event.
   */
  onTick(tick) {
    if (!this._canSignal()) return;

    const price = tick.price;

    // ── Tick sanity filter: reject corrupt/stale prices far from last known price ──
    // Databento occasionally sends auction prints or garbled prices (e.g. 214.4, 24959
    // when market is at 24730). These can cause false armed-setup invalidations.
    const refPrice = this._prevTickPrice
      || (this.bars.length > 0 ? this.bars[this.bars.length - 1].close : null);
    if (refPrice !== null) {
      const deviation = Math.abs(price - refPrice);
      if (deviation > 100) {
        // Silently discard — don't update _prevTickPrice either
        return;
      }
    }

    // Evaluate armed setups against current tick
    // Re-check _canSignal after each because a trigger sets signalFired=true
    if (this._armedPB2m && this._canSignal()) this._tickCheckArmed(this._armedPB2m, price, 'PB2m');
    if (this._armedPB3m && this._canSignal()) this._tickCheckArmed(this._armedPB3m, price, 'PB3m');
    if (this._armedPB   && this._canSignal()) this._tickCheckArmed(this._armedPB,   price, 'PB');

    // Track previous tick for direction detection
    this._prevTickPrice = price;
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

        if (this.emaxEnabled && this._canSignal()) {
          this._checkEMAX();
        }
        if (this.pb2mEnabled && this._canSignal()) {
          this._checkPB2m();
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

  _build3mBar(bar) {
    // Clock-aligned 3m bars: minutes 0-2, 3-5, 6-8, ... etc.
    const barMin = new Date(bar.timestamp).getUTCMinutes();
    const bucket3m = Math.floor(barMin / 3);

    if (!this.current3mBar || this._current3mBucket !== bucket3m) {
      if (this.current3mBar) {
        this.threeMinBars.push({ ...this.current3mBar });
        if (this.threeMinBars.length > 200) this.threeMinBars.shift();

        if (this._canSignal()) {
          this._checkPB3m();
        }
      }
      this.current3mBar = {
        timestamp: bar.timestamp,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume || 0,
      };
      this._current3mBucket = bucket3m;
    } else {
      this.current3mBar.high = Math.max(this.current3mBar.high, bar.high);
      this.current3mBar.low = Math.min(this.current3mBar.low, bar.low);
      this.current3mBar.close = bar.close;
      this.current3mBar.volume += (bar.volume || 0);
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

        if (this._canSignal()) {
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

    // ── Volume Filter ──
    const volCheck = this._checkVolumeFilter(bar);
    if (!volCheck.passed) return;

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

    const pstMins = this._getPSTMinutes(pb.timestamp);
    if (pstMins > this.pbMaxTime) {
      console.log(`[PB #${barIdx}] SKIP: past cutoff (${pstMins} > ${this.pbMaxTime})`);
      return;
    }

    // Search up to pbLookbackBars back for a qualifying impulse bar
    let impulse = null;
    let impRange = 0;
    let impBody = 0;
    let isBullish = false;
    let isBearish = false;

    for (let lookback = 2; lookback <= 1 + this.pbLookbackBars; lookback++) {
      const candidate = this.fiveMinBars[barIdx - lookback];
      if (!candidate) continue;

      const candRange = candidate.high - candidate.low;
      if (candRange < this.pbMinImpulse) continue;
      if (candRange > this.pbMaxImpulse) continue;
      const candBody = Math.abs(candidate.close - candidate.open);
      if (candBody / candRange < this.pbMinImpBodyRatio) continue;

      // Found a qualifying impulse
      impulse = candidate;
      impRange = candRange;
      impBody = candBody;
      isBullish = candidate.close > candidate.open;
      isBearish = candidate.close < candidate.open;
      break; // Use the most recent qualifying impulse
    }

    if (!impulse) {
      console.log(`[PB #${barIdx}] SKIP: no qualifying impulse in last ${this.pbLookbackBars} bars`);
      return;
    }

    // ── Pre-compute confluence and trend filter (needed for both tick and bar-close paths) ──
    const direction = isBullish ? 'buy' : 'sell';
    const fiveMinCloses = this.fiveMinBars.map(b => b.close);
    const emaFast5m = calcEMA(fiveMinCloses, 9);
    const emaSlow5m = calcEMA(fiveMinCloses, 21);

    const confluence = this.confluenceScorer.score({
      direction,
      price: pb.close,
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

    // ── Trend Filter ──
    if (this.pbTrendFilterEnabled) {
      const filterMode = this.pbTrendFilterEnabled === true ? 'both' : this.pbTrendFilterEnabled;
      const vwap = this.vwapEngine.isReady() ? this.vwapEngine.vwap : null;
      const hasVwap = vwap != null;
      const hasEma = emaFast5m != null && emaSlow5m != null;

      let vwapOk = true, emaOk = true;
      if ((filterMode === 'both' || filterMode === 'vwap_only') && hasVwap) {
        vwapOk = direction === 'buy' ? pb.close > vwap : pb.close < vwap;
      }
      if ((filterMode === 'both' || filterMode === 'ema_only') && hasEma) {
        emaOk = direction === 'buy' ? emaFast5m > emaSlow5m : emaFast5m < emaSlow5m;
      }

      const pass = filterMode === 'both' ? (vwapOk && emaOk) : (filterMode === 'vwap_only' ? vwapOk : emaOk);
      if (!pass) {
        const side = direction === 'buy' ? 'LONG' : 'SHORT';
        const reasons = [];
        if (!vwapOk && hasVwap) reasons.push(`price ${direction === 'buy' ? 'below' : 'above'} VWAP(${vwap.toFixed(1)})`);
        if (!emaOk && hasEma) reasons.push(`EMA9(${emaFast5m.toFixed(1)}) ${direction === 'buy' ? '<' : '>'} EMA21(${emaSlow5m.toFixed(1)})`);
        console.log(`[PB #${barIdx}] SKIP: ${side} counter-trend [${filterMode}]: ${reasons.join(', ')}`);
        return;
      }
    }

    // ── Tick entry: arm for intra-bar trigger on the NEXT forming bar ──
    if (this.pbTickEntry && !this._armedPB) {
      console.log(`[PB #${barIdx}] 🔫 Impulse confirmed — arming tick entry for ${direction.toUpperCase()}`);
      this._armTickEntry('PB', impulse, { isBullish, isBearish, impRange, impBody, confluence });
    }

    // ── Bar-close fallback: evaluate the closed pullback bar (existing logic) ──
    let signal = null;
    let entryPrice = 0;
    let stopLoss = 0;
    let stopDist = 0;

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

    // If tick entry already fired during this bar, skip bar-close firing
    if (this.signalFired) {
      console.log(`[PB #${barIdx}] Bar-close signal skipped — tick entry already fired`);
      return;
    }

    const targetDist = stopDist * this.profitTargetR;
    const targetPrice = signal === 'buy' ? entryPrice + targetDist : entryPrice - targetDist;

    console.log(`[PB #${barIdx}] ✅ BAR-CLOSE PATTERN: ${signal.toUpperCase()} @ ${entryPrice} | stop=${stopLoss} (${stopDist.toFixed(1)}pt) | target=${targetPrice.toFixed(2)} (${this.profitTargetR}R) | conf=${confluence.score}`);

    // ── Volume Filter ──
    const volCheck = this._checkVolumeFilter(this.bars[this.bars.length - 1]);
    if (!volCheck.passed) return;

    // Disarm any tick entry since bar-close is firing
    this._disarmSetup('PB');

    // Always use market entry (V2.11 — removed limit/watch modes for PB 5m)
    this._firePBSignal({
      type: signal,
      stopLoss,
      stopDistance: stopDist,
      targetDistance: targetDist,
      strategy: 'PB',
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: this.partialProfitEnabled,
      partialProfitR: this.partialProfitR,
      moveStopToBE: this.moveStopToBE,
      confluenceScore: confluence.score,
      vwapState: this.vwapEngine.getState(),
      impulse,
      pb,
      isBullish,
      impRange,
      impBody,
      confluence,
    }, entryPrice, new Date(pb.timestamp));
  }

  // ═══════════════════════════════════════════════════════════════
  //  STRATEGY 2b: PB 3m (Momentum Pullback on 3-min bars)
  // ═══════════════════════════════════════════════════════════════

  _checkPB3m() {
    const barIdx = this.threeMinBars.length;
    if (barIdx < 5) return;

    const pb = this.threeMinBars[barIdx - 1];

    const pstMins = this._getPSTMinutes(pb.timestamp);
    if (pstMins > this.pb3mMaxTime) return;

    // Search up to pb3mLookbackBars back for a qualifying impulse bar
    let impulse = null;
    let impRange = 0;
    let impBody = 0;
    let isBullish = false;
    let isBearish = false;

    for (let lookback = 2; lookback <= 1 + this.pb3mLookbackBars; lookback++) {
      const candidate = this.threeMinBars[barIdx - lookback];
      if (!candidate) continue;

      const candRange = candidate.high - candidate.low;
      if (candRange < this.pb3mMinImpulse) continue;
      if (candRange > this.pb3mMaxImpulse) continue;
      const candBody = Math.abs(candidate.close - candidate.open);
      if (candBody / candRange < this.pb3mMinImpBodyRatio) continue;

      impulse = candidate;
      impRange = candRange;
      impBody = candBody;
      isBullish = candidate.close > candidate.open;
      isBearish = candidate.close < candidate.open;
      break;
    }

    if (!impulse) return;

    // ── Pre-compute confluence and trend filter (needed for both tick and bar-close paths) ──
    const direction = isBullish ? 'buy' : 'sell';
    const threeMinCloses = this.threeMinBars.map(b => b.close);
    const emaFast3m = calcEMA(threeMinCloses, 9);
    const emaSlow3m = calcEMA(threeMinCloses, 21);

    const confluence = this.confluenceScorer.score({
      direction,
      price: pb.close,
      vwapEngine: this.vwapEngine,
      emaFast: emaFast3m,
      emaSlow: emaSlow3m,
      rsi: this._lastRSI,
      recentBars: this.bars,
      strategyType: 'PB',
    });

    if (!confluence.passed) return;

    // ── Trend Filter ──
    if (this.pbTrendFilterEnabled) {
      const filterMode = this.pbTrendFilterEnabled === true ? 'both' : this.pbTrendFilterEnabled;
      const vwap = this.vwapEngine.isReady() ? this.vwapEngine.vwap : null;
      const hasVwap = vwap != null;
      const hasEma = emaFast3m != null && emaSlow3m != null;

      let vwapOk = true, emaOk = true;
      if ((filterMode === 'both' || filterMode === 'vwap_only') && hasVwap) {
        vwapOk = direction === 'buy' ? pb.close > vwap : pb.close < vwap;
      }
      if ((filterMode === 'both' || filterMode === 'ema_only') && hasEma) {
        emaOk = direction === 'buy' ? emaFast3m > emaSlow3m : emaFast3m < emaSlow3m;
      }

      const pass = filterMode === 'both' ? (vwapOk && emaOk) : (filterMode === 'vwap_only' ? vwapOk : emaOk);
      if (!pass) return;
    }

    // ── Tick entry: arm for intra-bar trigger on the NEXT forming bar ──
    if (this.pb3mTickEntry && !this._armedPB3m) {
      console.log(`[PB3m #${barIdx}] 🔫 Impulse confirmed — arming tick entry for ${direction.toUpperCase()}`);
      this._armTickEntry('PB3m', impulse, { isBullish, isBearish, impRange, impBody, confluence });
    }

    // ── Bar-close fallback: evaluate the closed pullback bar (existing logic) ──
    let signal = null;
    let entryPrice = 0;
    let stopLoss = 0;
    let stopDist = 0;

    if (isBullish) {
      const retrace = impulse.high - pb.low;
      const retracePct = retrace / impRange;
      if (retracePct < this.pb3mRetraceMin || retracePct > this.pb3mRetraceMax) return;
      if (pb.close <= pb.open) return;
      if (pb.close < impulse.close - impRange * 0.3) return;

      stopDist = pb.close - pb.low + this.stopBuffer;
      if (stopDist > this.pb3mMaxStopPoints || stopDist < this.pb3mMinStopPoints) return;
      if (stopDist * this.profitTargetR < this.pb3mMinTargetPoints) return;

      signal = 'buy';
      entryPrice = pb.close;
      stopLoss = pb.low - this.stopBuffer;
    }

    if (!signal && isBearish) {
      const retrace = pb.high - impulse.low;
      const retracePct = retrace / impRange;
      if (retracePct < this.pb3mRetraceMin || retracePct > this.pb3mRetraceMax) return;
      if (pb.close >= pb.open) return;
      if (pb.close > impulse.close + impRange * 0.3) return;

      stopDist = pb.high - pb.close + this.stopBuffer;
      if (stopDist > this.pb3mMaxStopPoints || stopDist < this.pb3mMinStopPoints) return;
      if (stopDist * this.profitTargetR < this.pb3mMinTargetPoints) return;

      signal = 'sell';
      entryPrice = pb.close;
      stopLoss = pb.high + this.stopBuffer;
    }

    if (!signal) return;

    // If tick entry already fired during this bar, skip bar-close firing
    if (this.signalFired) {
      console.log(`[PB3m #${barIdx}] Bar-close signal skipped — tick entry already fired`);
      return;
    }

    const targetDist = stopDist * this.profitTargetR;
    const targetPrice = signal === 'buy' ? entryPrice + targetDist : entryPrice - targetDist;

    console.log(`[PB3m #${barIdx}] ✅ BAR-CLOSE PATTERN: ${signal.toUpperCase()} @ ${entryPrice} | stop=${stopLoss} (${stopDist.toFixed(1)}pt) | target=${targetPrice.toFixed(2)} (${this.profitTargetR}R) | conf=${confluence.score}`);

    // ── Volume Filter ──
    const volCheck = this._checkVolumeFilter(this.bars[this.bars.length - 1]);
    if (!volCheck.passed) return;

    this._disarmSetup('PB3m');
    this.signalFired = true;
    this._tradeCountToday++;

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      orderType: 'Market',
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(pb.timestamp),
      strategy: 'PB3m',
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: this.partialProfitEnabled,
      partialProfitR: this.partialProfitR,
      moveStopToBE: this.moveStopToBE,
      confluenceScore: confluence.score,
      vwapState: this.vwapEngine.getState(),
      tickTriggered: false,
      filterResults: [
        { name: 'Impulse', passed: true, reason: `${impRange.toFixed(1)}pt range, ${(impBody / impRange * 100).toFixed(0)}% body` },
        { name: 'Pullback', passed: true, reason: `${((isBullish ? impulse.high - pb.low : pb.high - impulse.low) / impRange * 100).toFixed(0)}% retrace` },
        { name: 'Confluence', passed: true, reason: `${confluence.score}/${confluence.maxScore} factors` },
        ...confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
      ],
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  STRATEGY 2c: PB 2m (Momentum Pullback on 2-min bars)
  // ═══════════════════════════════════════════════════════════════

  _checkPB2m() {
    const barIdx = this.twoMinBars.length;
    if (barIdx < 5) return;

    const pb = this.twoMinBars[barIdx - 1];

    const pstMins = this._getPSTMinutes(pb.timestamp);
    if (pstMins > this.pb2mMaxTime) return;

    // Search up to pb2mLookbackBars back for a qualifying impulse bar
    let impulse = null;
    let impRange = 0;
    let impBody = 0;
    let isBullish = false;
    let isBearish = false;

    for (let lookback = 2; lookback <= 1 + this.pb2mLookbackBars; lookback++) {
      const candidate = this.twoMinBars[barIdx - lookback];
      if (!candidate) continue;

      const candRange = candidate.high - candidate.low;
      if (candRange < this.pb2mMinImpulse) continue;
      if (candRange > this.pb2mMaxImpulse) continue;
      const candBody = Math.abs(candidate.close - candidate.open);
      if (candBody / candRange < this.pb2mMinImpBodyRatio) continue;

      impulse = candidate;
      impRange = candRange;
      impBody = candBody;
      isBullish = candidate.close > candidate.open;
      isBearish = candidate.close < candidate.open;
      break;
    }

    if (!impulse) return;

    // ── Pre-compute confluence and trend filter (needed for both tick and bar-close paths) ──
    const direction = isBullish ? 'buy' : 'sell';
    const twoMinCloses = this.twoMinBars.map(b => b.close);
    const emaFast2m = calcEMA(twoMinCloses, 9);
    const emaSlow2m = calcEMA(twoMinCloses, 21);

    const confluence = this.confluenceScorer.score({
      direction,
      price: pb.close,
      vwapEngine: this.vwapEngine,
      emaFast: emaFast2m,
      emaSlow: emaSlow2m,
      rsi: this._lastRSI,
      recentBars: this.bars,
      strategyType: 'PB',
    });

    if (!confluence.passed) return;

    // ── Trend Filter ──
    if (this.pbTrendFilterEnabled) {
      const filterMode = this.pbTrendFilterEnabled === true ? 'both' : this.pbTrendFilterEnabled;
      const vwap = this.vwapEngine.isReady() ? this.vwapEngine.vwap : null;
      const hasVwap = vwap != null;
      const hasEma = emaFast2m != null && emaSlow2m != null;

      let vwapOk = true, emaOk = true;
      if ((filterMode === 'both' || filterMode === 'vwap_only') && hasVwap) {
        vwapOk = direction === 'buy' ? pb.close > vwap : pb.close < vwap;
      }
      if ((filterMode === 'both' || filterMode === 'ema_only') && hasEma) {
        emaOk = direction === 'buy' ? emaFast2m > emaSlow2m : emaFast2m < emaSlow2m;
      }

      const pass = filterMode === 'both' ? (vwapOk && emaOk) : (filterMode === 'vwap_only' ? vwapOk : emaOk);
      if (!pass) return;
    }

    // ── Tick entry: arm for intra-bar trigger on the NEXT forming bar ──
    if (this.pb2mTickEntry && !this._armedPB2m) {
      console.log(`[PB2m #${barIdx}] 🔫 Impulse confirmed — arming tick entry for ${direction.toUpperCase()}`);
      this._armTickEntry('PB2m', impulse, { isBullish, isBearish, impRange, impBody, confluence });
      // Don't return — continue to bar-close fallback evaluation below
    }

    // ── Bar-close fallback: evaluate the closed pullback bar (existing logic) ──
    let signal = null;
    let entryPrice = 0;
    let stopLoss = 0;
    let stopDist = 0;

    if (isBullish) {
      const retrace = impulse.high - pb.low;
      const retracePct = retrace / impRange;
      if (retracePct < this.pb2mRetraceMin || retracePct > this.pb2mRetraceMax) return;
      if (pb.close <= pb.open) return;
      if (pb.close < impulse.close - impRange * 0.3) return;

      stopDist = pb.close - pb.low + this.stopBuffer;
      if (stopDist > this.pb2mMaxStopPoints || stopDist < this.pb2mMinStopPoints) return;
      if (stopDist * this.profitTargetR < this.pb2mMinTargetPoints) return;

      signal = 'buy';
      entryPrice = pb.close;
      stopLoss = pb.low - this.stopBuffer;
    }

    if (!signal && isBearish) {
      const retrace = pb.high - impulse.low;
      const retracePct = retrace / impRange;
      if (retracePct < this.pb2mRetraceMin || retracePct > this.pb2mRetraceMax) return;
      if (pb.close >= pb.open) return;
      if (pb.close > impulse.close + impRange * 0.3) return;

      stopDist = pb.high - pb.close + this.stopBuffer;
      if (stopDist > this.pb2mMaxStopPoints || stopDist < this.pb2mMinStopPoints) return;
      if (stopDist * this.profitTargetR < this.pb2mMinTargetPoints) return;

      signal = 'sell';
      entryPrice = pb.close;
      stopLoss = pb.high + this.stopBuffer;
    }

    if (!signal) return;

    // If tick entry already fired during this bar, skip bar-close firing
    if (this.signalFired) {
      console.log(`[PB2m #${barIdx}] Bar-close signal skipped — tick entry already fired`);
      return;
    }

    const targetDist = stopDist * this.profitTargetR;
    const targetPrice = signal === 'buy' ? entryPrice + targetDist : entryPrice - targetDist;

    console.log(`[PB2m #${barIdx}] ✅ BAR-CLOSE PATTERN: ${signal.toUpperCase()} @ ${entryPrice} | stop=${stopLoss} (${stopDist.toFixed(1)}pt) | target=${targetPrice.toFixed(2)} (${this.profitTargetR}R) | conf=${confluence.score}`);

    // ── Volume Filter ──
    const volCheck = this._checkVolumeFilter(this.bars[this.bars.length - 1]);
    if (!volCheck.passed) return;

    // Disarm any tick entry since bar-close is firing
    this._disarmSetup('PB2m');

    this.signalFired = true;
    this._tradeCountToday++;

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      orderType: 'Market',
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(pb.timestamp),
      strategy: 'PB2m',
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: this.partialProfitEnabled,
      partialProfitR: this.partialProfitR,
      moveStopToBE: this.moveStopToBE,
      confluenceScore: confluence.score,
      vwapState: this.vwapEngine.getState(),
      tickTriggered: false,
      filterResults: [
        { name: 'Impulse', passed: true, reason: `${impRange.toFixed(1)}pt range, ${(impBody / impRange * 100).toFixed(0)}% body` },
        { name: 'Pullback', passed: true, reason: `${((isBullish ? impulse.high - pb.low : pb.high - impulse.low) / impRange * 100).toFixed(0)}% retrace` },
        { name: 'Confluence', passed: true, reason: `${confluence.score}/${confluence.maxScore} factors` },
        ...confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
      ],
    });
  }

  /**
   * Fire the actual PB signal (used by both immediate and confirmed entries)
   * @private
   */
  _firePBSignal(setup, entryPrice, timestamp) {
    const { type: signal, stopLoss, stopDistance: stopDist, confluence, impulse, pb, isBullish, impRange, impBody } = setup;
    const targetDist = stopDist * this.profitTargetR;
    const targetPrice = signal === 'buy' ? entryPrice + targetDist : entryPrice - targetDist;

    this.signalFired = true;
    this._tradeCountToday++;
    this._pbWatch = null;

    console.log(`[PB] 🚀 BAR-CLOSE SIGNAL FIRED: ${signal.toUpperCase()} @ ${entryPrice} | stop=${stopLoss} (${stopDist.toFixed(1)}pt) | target=${targetPrice.toFixed(2)} (${this.profitTargetR}R)`);

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      orderType: 'Market',
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp,
      strategy: 'PB',
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: setup.prevTradeResult,
      partialProfitEnabled: setup.partialProfitEnabled,
      partialProfitR: setup.partialProfitR,
      moveStopToBE: setup.moveStopToBE,
      confluenceScore: confluence.score,
      vwapState: setup.vwapState,
      tickTriggered: false,
      filterResults: [
        { name: 'Impulse', passed: true, reason: `${impRange.toFixed(1)}pt range, ${(impBody / impRange * 100).toFixed(0)}% body` },
        { name: 'Pullback', passed: true, reason: `${((isBullish ? impulse.high - pb.low : pb.high - impulse.low) / impRange * 100).toFixed(0)}% retrace` },
        { name: 'Confluence', passed: true, reason: `${confluence.score}/${confluence.maxScore} factors` },
        ...confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
      ],
    });
  }

  /**
   * Check 1m bars for PB confirmation bounce or limit fill zone.
   * Called on every 1m bar while _pbWatch is active.
   * @private
   */
  _checkPBConfirmation(bar) {
    const w = this._pbWatch;
    if (!w) return;

    w.barsWaited++;
    const isLong = w.type === 'buy';

    // Track 1m swing extremes for potential tighter stop
    if (bar.low < w.swingLow) w.swingLow = bar.low;
    if (bar.high > w.swingHigh) w.swingHigh = bar.high;

    // ── Check for invalidation: price moved too far against us ──
    // If price breaks beyond the stop level, the setup is dead
    if (isLong && bar.low <= w.stopLoss) {
      console.log(`[PB WATCH] ❌ INVALIDATED: price ${bar.low} broke below stop ${w.stopLoss}`);
      this._pbWatch = null;
      return;
    }
    if (!isLong && bar.high >= w.stopLoss) {
      console.log(`[PB WATCH] ❌ INVALIDATED: price ${bar.high} broke above stop ${w.stopLoss}`);
      this._pbWatch = null;
      return;
    }

    // ── Limit modes: check if price dipped to limit zone ──
    if (w.mode === 'limit' || w.mode === 'limit_structural') {
      const hitZone = isLong
        ? bar.low <= w.limitPrice && bar.close > w.limitPrice
        : bar.high >= w.limitPrice && bar.close < w.limitPrice;

      if (hitZone) {
        const entryPrice = w.limitPrice;
        const savedPts = Math.abs(w.signalEntryPrice - entryPrice);
        if (w.mode === 'limit_structural') {
          // Keep original structural stop + original stopDistance for target calc
          // Better entry = more room to target, same stop = same structural level
          console.log(`[PB WATCH] ✅ LIMIT+STRUCTURAL: ${w.type.toUpperCase()} @ ${entryPrice.toFixed(2)} (saved ${savedPts.toFixed(1)}pt) | stop=${w.stopLoss} (orig) | target uses orig ${w.stopDistance.toFixed(1)}pt R`);
          this._firePBSignal(w, entryPrice, new Date(bar.timestamp));
        } else {
          // Recalculate stop distance from the better entry (tighter stop = smaller target)
          const newStopDist = Math.abs(entryPrice - w.stopLoss);
          console.log(`[PB WATCH] ✅ LIMIT ZONE HIT: ${w.type.toUpperCase()} @ ${entryPrice.toFixed(2)} (saved ${savedPts.toFixed(1)}pt vs 5m close)`);
          const improvedSetup = { ...w, stopDistance: newStopDist };
          this._firePBSignal(improvedSetup, entryPrice, new Date(bar.timestamp));
        }
        return;
      }
    }

    // ── Confirm1m mode: check for bounce confirmation ──
    if (w.mode === 'confirm1m') {
      const barBody = bar.close - bar.open;
      const barRange = bar.high - bar.low;
      const bodyRatio = barRange > 0 ? Math.abs(barBody) / barRange : 0;

      // Confirmation: 1m bar closes in trade direction with decent body
      const confirmed = isLong
        ? (bar.close > bar.open && bodyRatio >= 0.4 && bar.close > (bar.high + bar.low) / 2)
        : (bar.close < bar.open && bodyRatio >= 0.4 && bar.close < (bar.high + bar.low) / 2);

      if (confirmed) {
        // Use 1m close as entry — typically better than 5m close
        const entryPrice = bar.close;
        // Use 1m swing as tighter stop if better than 5m stop
        let newStop = w.stopLoss;
        if (isLong && w.swingLow > w.stopLoss + 1) {
          // Tighter stop at 1m swing low + buffer (only if meaningfully better)
          newStop = w.swingLow - this.stopBuffer;
          console.log(`[PB WATCH] Tighter stop: 5m=${w.stopLoss.toFixed(2)} → 1m swing=${newStop.toFixed(2)}`);
        }
        if (!isLong && w.swingHigh < w.stopLoss - 1) {
          newStop = w.swingHigh + this.stopBuffer;
          console.log(`[PB WATCH] Tighter stop: 5m=${w.stopLoss.toFixed(2)} → 1m swing=${newStop.toFixed(2)}`);
        }

        const newStopDist = Math.abs(entryPrice - newStop);
        // Validate tighter stop still meets min/max constraints
        if (newStopDist < this.minStopPoints || newStopDist > this.maxStopPoints) {
          console.log(`[PB WATCH] ✅ CONFIRMED but stop ${newStopDist.toFixed(1)}pt outside ${this.minStopPoints}-${this.maxStopPoints}, using original`);
          newStop = w.stopLoss;
        }

        const finalStopDist = Math.abs(entryPrice - newStop);
        console.log(`[PB WATCH] ✅ 1m CONFIRMED: ${w.type.toUpperCase()} @ ${entryPrice.toFixed(2)} | bar ${w.barsWaited}/${w.maxBars}`);
        const improvedSetup = { ...w, stopLoss: newStop, stopDistance: finalStopDist };
        this._firePBSignal(improvedSetup, entryPrice, new Date(bar.timestamp));
        return;
      }
    }

    // ── Timeout: no confirmation within max bars ──
    if (w.barsWaited >= w.maxBars) {
      console.log(`[PB WATCH] ⏰ TIMEOUT after ${w.barsWaited} bars — no ${w.mode} confirmation`);
      this._pbWatch = null;
    }
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

    // Log VR state every 10 bars during VR window
    if (this.sessionBarCount % 10 === 0) {
      const vwap = this.vwapEngine.vwap;
      const u2 = this.vwapEngine.upperBand2;
      const l2 = this.vwapEngine.lowerBand2;
      console.log(`[VR] σ=${sigmaDistance?.toFixed(2)} | price=${price} | VWAP=${vwap?.toFixed(1)} | bands=[${l2?.toFixed(1)}..${u2?.toFixed(1)}] | watching=${this._vrWatching || 'none'}`);
    }

    // ── Phase 1: Watch for overextension (price hits ±2σ or beyond) ──
    if (!this._vrWatching) {
      if (sigmaDistance >= this.vrMinSigma) {
        this._vrWatching = 'short'; // Price above 2σ → watch for short reversion
        this._vrWatchPrice = price;
        console.log(`[VR] 🔍 WATCH SHORT: price=${price} σ=${sigmaDistance.toFixed(2)} >= ${this.vrMinSigma}`);
      } else if (sigmaDistance <= -this.vrMinSigma) {
        this._vrWatching = 'long'; // Price below -2σ → watch for long reversion
        this._vrWatchPrice = price;
        console.log(`[VR] 🔍 WATCH LONG: price=${price} σ=${sigmaDistance.toFixed(2)} <= -${this.vrMinSigma}`);
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
        console.log(`[VR] LONG entry zone HIT: O=${bar.open} C=${bar.close} | lower1=${lower1.toFixed(1)} VWAP=${vwap.toFixed(1)} | stop=${stopDist.toFixed(1)}pt`);
      } else {
        if (sigmaDistance > 0) {
          console.log(`[VR] LONG watch cancelled: price crossed above VWAP (σ=${sigmaDistance.toFixed(2)})`);
          this._vrWatching = null;
          this._vrWatchPrice = null;
          return;
        }
        // Log why entry didn't trigger
        if (this.sessionBarCount % 5 === 0) {
          const reasons = [];
          if (bar.open > lower1) reasons.push(`O=${bar.open} > lower1=${lower1.toFixed(1)}`);
          if (bar.close <= lower1) reasons.push(`C=${bar.close} <= lower1=${lower1.toFixed(1)}`);
          if (bar.close >= vwap) reasons.push(`C=${bar.close} >= VWAP=${vwap.toFixed(1)}`);
          if (bar.close <= bar.open) reasons.push(`bearish bar`);
          if (reasons.length > 0) console.log(`[VR] LONG waiting: ${reasons.join(', ')} | σ=${sigmaDistance.toFixed(2)}`);
        }
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
        console.log(`[VR] SHORT entry zone HIT: O=${bar.open} C=${bar.close} | upper1=${upper1.toFixed(1)} VWAP=${vwap.toFixed(1)} | stop=${stopDist.toFixed(1)}pt`);
      } else {
        if (sigmaDistance < 0) {
          console.log(`[VR] SHORT watch cancelled: price crossed below VWAP (σ=${sigmaDistance.toFixed(2)})`);
          this._vrWatching = null;
          this._vrWatchPrice = null;
          return;
        }
        if (this.sessionBarCount % 5 === 0) {
          const reasons = [];
          if (bar.open < upper1) reasons.push(`O=${bar.open} < upper1=${upper1.toFixed(1)}`);
          if (bar.close >= upper1) reasons.push(`C=${bar.close} >= upper1=${upper1.toFixed(1)}`);
          if (bar.close <= vwap) reasons.push(`C=${bar.close} <= VWAP=${vwap.toFixed(1)}`);
          if (bar.close >= bar.open) reasons.push(`bullish bar`);
          if (reasons.length > 0) console.log(`[VR] SHORT waiting: ${reasons.join(', ')} | σ=${sigmaDistance.toFixed(2)}`);
        }
      }
    }

    if (!signal) return;

    // Validate stop/target distances
    if (stopDist > this.vrMaxStopPoints || stopDist < this.vrMinStopPoints) {
      console.log(`[VR] SKIP: stop ${stopDist.toFixed(1)}pt outside ${this.vrMinStopPoints}-${this.vrMaxStopPoints}`);
      this._vrWatching = null;
      return;
    }
    if (targetDist < 5) { // Minimum 5pt target for VR
      console.log(`[VR] SKIP: target ${targetDist.toFixed(1)}pt < 5pt min`);
      this._vrWatching = null;
      return;
    }

    // ── Volume check on entry bar ──
    const avgVol = this.bars.slice(-20).reduce((s, b) => s + (b.volume || 0), 0) / 20;
    const barVol = bar.volume || 0;
    if (avgVol > 0 && barVol / avgVol < this.vrMinBarVolRatio) {
      console.log(`[VR] SKIP: low volume ${barVol} / avg ${avgVol.toFixed(0)} = ${(barVol/avgVol).toFixed(2)} < ${this.vrMinBarVolRatio}`);
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

    // ── Volume Filter ──
    const volCheck = this._checkVolumeFilter(bar);
    if (!volCheck.passed) return;

    // ── Emit Signal ──
    this.signalFired = true;
    this._vrWatching = null;
    this._vrWatchPrice = null;
    this._vrCooldownCount = this.vrCooldownBars;
    this._vrTradeCount++;
    this._tradeCountToday++;

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
  //  TICK-TRIGGERED ENTRY (Intra-Bar Evaluation)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Arm a setup for tick-triggered entry. Called when a qualifying impulse bar is detected.
   * Stores all pre-computed data so tick evaluation is lightweight.
   * @param {string} strategy - 'PB', 'PB3m', or 'PB2m'
   * @param {Object} impulse - The confirmed impulse bar
   * @param {Object} preComputed - Pre-computed filters: { confluence, trendOk, volumeOk, isBullish, isBearish, impRange, impBody, pstMins }
   */
  _armTickEntry(strategy, impulse, preComputed) {
    const { isBullish, isBearish, impRange, impBody, confluence } = preComputed;

    // Determine stop and retrace params based on strategy
    let retraceMin, retraceMax, minStop, maxStop, minTarget;
    if (strategy === 'PB2m') {
      retraceMin = this.pb2mRetraceMin; retraceMax = this.pb2mRetraceMax;
      minStop = this.pb2mMinStopPoints; maxStop = this.pb2mMaxStopPoints;
      minTarget = this.pb2mMinTargetPoints;
    } else if (strategy === 'PB3m') {
      retraceMin = this.pb3mRetraceMin; retraceMax = this.pb3mRetraceMax;
      minStop = this.pb3mMinStopPoints; maxStop = this.pb3mMaxStopPoints;
      minTarget = this.pb3mMinTargetPoints;
    } else {
      retraceMin = this.pbRetraceMin; retraceMax = this.pbRetraceMax;
      minStop = this.minStopPoints; maxStop = this.maxStopPoints;
      minTarget = this.minTargetPoints;
    }

    const armed = {
      strategy,
      impulse,
      isBullish,
      isBearish,
      impRange,
      impBody,
      confluence,
      retraceMin,
      retraceMax,
      minStop,
      maxStop,
      minTarget,
      armedAt: Date.now(),
      ticksSeen: 0,
      // Time-based expiry: 2x the bar timeframe in seconds
      maxAgeMs: strategy === 'PB2m' ? 120000 : strategy === 'PB3m' ? 180000 : 300000,
    };

    if (strategy === 'PB2m') this._armedPB2m = armed;
    else if (strategy === 'PB3m') this._armedPB3m = armed;
    else this._armedPB = armed;

    console.log(`[${strategy} TICK-ARM] 🔫 ARMED ${isBullish ? 'LONG' : 'SHORT'} | impulse: O=${impulse.open} H=${impulse.high} L=${impulse.low} C=${impulse.close} (${impRange.toFixed(1)}pt, ${(impBody/impRange*100).toFixed(0)}% body) | retrace zone: ${(retraceMin*100).toFixed(0)}-${(retraceMax*100).toFixed(0)}% | stop bounds: ${minStop}-${maxStop}pt`);
  }

  /**
   * Evaluate a tick against an armed setup. If conditions met, fire signal immediately.
   * @param {Object} armed - Armed setup object from _armTickEntry
   * @param {number} price - Current tick price
   * @param {string} label - Strategy label for logging
   */
  _tickCheckArmed(armed, price, label) {
    armed.ticksSeen++;
    const { impulse, isBullish, isBearish, impRange } = armed;

    // Log every 50th tick for monitoring (avoid log spam)
    if (armed.ticksSeen % 50 === 0) {
      console.log(`[${label} TICK] #${armed.ticksSeen} price=${price} | impulse H=${impulse.high} L=${impulse.low} | armed ${((Date.now() - armed.armedAt)/1000).toFixed(1)}s ago`);
    }

    // ── Time-based expiry ──
    const ageMs = Date.now() - armed.armedAt;
    if (ageMs > armed.maxAgeMs) {
      console.log(`[${label} TICK-ARM] ⏰ EXPIRED after ${(ageMs/1000).toFixed(0)}s (max ${armed.maxAgeMs/1000}s) — disarming`);
      this._disarmSetup(label);
      return;
    }

    // ── Invalidation: price broke the impulse extreme (setup dead) ──
    if (isBullish && price < impulse.low - this.stopBuffer) {
      console.log(`[${label} TICK-ARM] ❌ INVALIDATED: price ${price} broke below impulse low ${impulse.low}`);
      this._disarmSetup(label);
      return;
    }
    if (isBearish && price > impulse.high + this.stopBuffer) {
      console.log(`[${label} TICK-ARM] ❌ INVALIDATED: price ${price} broke above impulse high ${impulse.high}`);
      this._disarmSetup(label);
      return;
    }

    // ── Extension invalidation: price ran too far beyond impulse (no pullback coming) ──
    if (isBullish && price > impulse.high + impRange * 2) {
      console.log(`[${label} TICK-ARM] ❌ EXTENDED: price ${price} ran ${(price - impulse.high).toFixed(1)}pt above impulse high ${impulse.high} (>2x range) — disarming`);
      this._disarmSetup(label);
      return;
    }
    if (isBearish && price < impulse.low - impRange * 2) {
      console.log(`[${label} TICK-ARM] ❌ EXTENDED: price ${price} ran ${(impulse.low - price).toFixed(1)}pt below impulse low ${impulse.low} (>2x range) — disarming`);
      this._disarmSetup(label);
      return;
    }

    // ── Check retrace zone ──
    let retracePct;
    if (isBullish) {
      // Bullish impulse: price should pull back from impulse.high
      retracePct = (impulse.high - price) / impRange;
    } else {
      // Bearish impulse: price should pull back (bounce) from impulse.low
      retracePct = (price - impulse.low) / impRange;
    }

    if (retracePct < armed.retraceMin || retracePct > armed.retraceMax) {
      return; // Not in zone yet — silent, happens on most ticks
    }

    // ── Direction confirmation: tick moving in trade direction ──
    if (this._prevTickPrice === null) return; // Need at least 2 ticks
    const tickDirection = price - this._prevTickPrice;
    if (isBullish && tickDirection <= 0) return; // Need uptick for long
    if (isBearish && tickDirection >= 0) return; // Need downtick for short

    // ── Calculate stop using impulse bar extreme ──
    let stopLoss, stopDist;
    if (isBullish) {
      stopLoss = impulse.low - this.stopBuffer;
      stopDist = price - stopLoss;
    } else {
      stopLoss = impulse.high + this.stopBuffer;
      stopDist = stopLoss - price;
    }

    // ── Validate stop distance ──
    if (stopDist < armed.minStop || stopDist > armed.maxStop) {
      // Log once every 20 ticks in zone to avoid spam
      if (armed.ticksSeen % 20 === 0) {
        console.log(`[${label} TICK] In zone but stop ${stopDist.toFixed(1)}pt outside ${armed.minStop}-${armed.maxStop}pt`);
      }
      return;
    }

    // ── Validate minimum target ──
    const targetDist = stopDist * this.profitTargetR;
    if (targetDist < armed.minTarget) {
      return;
    }

    // ── Check bar direction confirmation (forming bar should be in trade direction) ──
    // For bullish: current price should be above the forming bar's open
    // For bearish: current price should be below the forming bar's open
    let formingBar;
    if (label === 'PB2m') formingBar = this.current2mBar;
    else if (label === 'PB3m') formingBar = this.current3mBar;
    else formingBar = this.current5mBar;

    if (formingBar) {
      if (isBullish && price <= formingBar.open) return;  // Forming bar not bullish
      if (isBearish && price >= formingBar.open) return;  // Forming bar not bearish
    }

    // ── All checks passed — FIRE SIGNAL ──
    const signal = isBullish ? 'buy' : 'sell';
    const entryPrice = price;
    const targetPrice = isBullish ? entryPrice + targetDist : entryPrice - targetDist;

    console.log(`[${label} TICK-ENTRY] 🎯 TRIGGERED ${signal.toUpperCase()} @ ${entryPrice} | stop=${stopLoss.toFixed(2)} (${stopDist.toFixed(1)}pt) | target=${targetPrice.toFixed(2)} (${this.profitTargetR}R) | retrace=${(retracePct*100).toFixed(1)}% | tick #${armed.ticksSeen} | armed for ${((Date.now() - armed.armedAt)/1000).toFixed(1)}s | tick direction: ${tickDirection > 0 ? 'UP' : 'DOWN'} ${Math.abs(tickDirection).toFixed(2)}pt`);

    // Volume check on impulse bar (it's closed — volume is final)
    const volCheck = this._checkVolumeFilter(armed.impulse);
    if (!volCheck.passed) {
      console.log(`[${label} TICK-ENTRY] ❌ Volume filter failed on impulse bar — rejecting tick entry`);
      return;
    }

    this.signalFired = true;
    this._tradeCountToday++;
    this._disarmAll(); // Clear all armed setups

    this.emit('signal', {
      type: signal,
      price: entryPrice,
      orderType: 'Market',
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(),
      strategy: label,
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: this.partialProfitEnabled,
      partialProfitR: this.partialProfitR,
      moveStopToBE: this.moveStopToBE,
      confluenceScore: armed.confluence.score,
      vwapState: this.vwapEngine.getState(),
      tickTriggered: true, // Flag for logging/analysis
      ticksSeen: armed.ticksSeen,
      armedDurationMs: Date.now() - armed.armedAt,
      filterResults: [
        { name: 'Impulse', passed: true, reason: `${armed.impRange.toFixed(1)}pt range, ${(armed.impBody / armed.impRange * 100).toFixed(0)}% body` },
        { name: 'Tick Entry', passed: true, reason: `Tick @ ${entryPrice} | retrace ${(retracePct*100).toFixed(1)}% | direction confirmed` },
        { name: 'Impulse Stop', passed: true, reason: `${stopDist.toFixed(1)}pt to impulse ${isBullish ? 'low' : 'high'}` },
        { name: 'Confluence', passed: true, reason: `${armed.confluence.score}/${armed.confluence.maxScore} factors` },
        ...armed.confluence.factors.map(f => ({ name: f.name, passed: f.passed, reason: f.reason })),
      ],
    });
  }

  /**
   * Disarm a specific strategy's armed setup
   */
  _disarmSetup(strategy) {
    if (strategy === 'PB2m') this._armedPB2m = null;
    else if (strategy === 'PB3m') this._armedPB3m = null;
    else if (strategy === 'PB') this._armedPB = null;
  }

  /**
   * Disarm all armed setups (called when a signal fires or position opens)
   */
  _disarmAll() {
    this._armedPB = null;
    this._armedPB3m = null;
    this._armedPB2m = null;
    this._prevTickPrice = null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  VOLUME FILTER
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if current bar volume passes the volume filter.
   * Returns { passed, ratio, avgVol } or { passed: true } if filter disabled.
   */
  _checkVolumeFilter(bar) {
    if (!this.volumeFilterEnabled) return { passed: true, ratio: null, avgVol: null };
    if (this.bars.length < this.volumeFilterPeriod) return { passed: true, ratio: null, avgVol: null };

    const recentVols = this.bars.slice(-this.volumeFilterPeriod).map(b => b.volume || 0);
    const avgVol = recentVols.reduce((s, v) => s + v, 0) / recentVols.length;
    const currentVol = bar.volume || 0;
    const ratio = avgVol > 0 ? currentVol / avgVol : 0;
    const passed = ratio >= this.volumeFilterMin;

    if (!passed) {
      console.log(`[VOL_FILTER] Signal rejected: volume ratio ${ratio.toFixed(2)}x < ${this.volumeFilterMin}x (bar=${currentVol}, avg=${avgVol.toFixed(0)})`);
    }

    return { passed, ratio, avgVol };
  }

  // ═══════════════════════════════════════════════════════════════
  //  OVERRIDES
  // ═══════════════════════════════════════════════════════════════

  setPosition(position) {
    super.setPosition(position);
    if (position) {
      this.signalFired = true;
      this._pbWatch = null;
      this._disarmAll();
    } else {
      this.signalFired = false;
      this._pbWatch = null;
      this._disarmAll();
      // Start cooldown when position closes
      if (this.cooldownBars > 0) {
        this._cooldownRemaining = this.cooldownBars;
        console.log(`[COOLDOWN] 🕐 Trade closed — ${this.cooldownBars}-bar cooldown started`);
      }
      // Reset VR watch state when position closes (allow new VR setups)
      this._vrWatching = null;
      this._vrWatchPrice = null;
    }
  }

  /**
   * Called by SignalHandler when a signal was emitted but the trade was rejected
   * (risk too high, AI rejection, etc). Resets signalFired so new signals can fire.
   */
  onSignalRejected() {
    this.signalFired = false;
    this._pbWatch = null;
    this._disarmAll();
    // Also undo the _tradeCountToday increment since no trade was actually placed
    if (this._tradeCountToday > 0) this._tradeCountToday--;
  }

  /**
   * Called by PositionHandler when a trade closes.
   * Updates _prevTradeResult for AI context on next signal.
   * @param {'win'|'loss'} result
   */
  onTradeResult(result) {
    this._prevTradeResult = result;
    if (result === 'loss') {
      this._lossCountToday++;
      if (this._lossCountToday >= this.maxLossesPerDay) {
        console.log(`[Strategy:${this.name}] 🛑 ${this._lossCountToday} losses today — done for the day (max ${this.maxLossesPerDay})`);
      }
    }
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
      barsCount3m: this.threeMinBars.length,
      barsCount5m: this.fiveMinBars.length,
      inPosition: !!this.position,
      signalFired: this.signalFired,
      position: this.position,
      maxStopPoints: this.maxStopPoints,
      profitTargetR: this.profitTargetR,
      // Tick entry state
      armedPB: this._armedPB ? `${this._armedPB.isBullish ? 'LONG' : 'SHORT'} (${this._armedPB.ticksSeen} ticks)` : null,
      armedPB3m: this._armedPB3m ? `${this._armedPB3m.isBullish ? 'LONG' : 'SHORT'} (${this._armedPB3m.ticksSeen} ticks)` : null,
      armedPB2m: this._armedPB2m ? `${this._armedPB2m.isBullish ? 'LONG' : 'SHORT'} (${this._armedPB2m.ticksSeen} ticks)` : null,
      cooldownRemaining: this._cooldownRemaining,
      tradeCountToday: this._tradeCountToday,
      lossCountToday: this._lossCountToday,
      vrEnabled: this.vrEnabled,
      vrWatching: this._vrWatching,
      vrTradeCount: this._vrTradeCount,
      vwap: this.vwapEngine.vwap ? +this.vwapEngine.vwap.toFixed(2) : null,
      vwapReady: this.vwapEngine.isReady(),
      priorDayHigh: this.vwapEngine.priorDayHigh,
      priorDayLow: this.vwapEngine.priorDayLow,
      confluenceMin: this.minConfluence,
      volumeFilterEnabled: this.volumeFilterEnabled,
      volumeFilterMin: this.volumeFilterMin,
      rsi: this._lastRSI ? +this._lastRSI.toFixed(1) : null,
      atr: this._lastATR ? +this._lastATR.toFixed(2) : null,
    };
  }
}

module.exports = MNQMomentumStrategyV2;
