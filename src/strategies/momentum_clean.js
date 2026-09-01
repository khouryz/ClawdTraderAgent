/**
 * MOMENTUM CLEAN — a from-scratch rewrite of the trading logic that keeps the EXACT same
 * infrastructure/API contract (extends BaseStrategy, onBar/onTick, emits 'signal', plugs
 * into InstrumentRunner → SignalHandler → native stop-entry / OCO / risk pipeline).
 *
 * Distills ONLY the edges validated this session into ~1 clean file (vs the 3.7k-line
 * accumulation of mostly-dead setups it replaces):
 *   1. Multi-timeframe MOMENTUM PULLBACK (PB) — impulse → pullback → confluence≥N → enter on
 *      the break of the pullback bar's extreme (stop-entry), stop beyond the pullback,
 *      target = profitTargetR × stop distance. Runs on 5m + 3m for two frequencies.
 *   2. LEVEL-BREAK continuation (LVLB) — break of prior-day high/low with continuation,
 *      ATR-based stop, lbTargetR target.
 *
 * Entry: Brooks stop-entry. Arms on a closed bar; fires on the intra-bar (1s) break of the
 * signal bar's extreme. In native mode (nativeStopEntry) it ALSO emits the arm as an
 * orderType:'Stop' signal so InstrumentRunner can rest a real exchange order (parity: the
 * harness drives the synthetic tick-fire path, live uses the native path).
 *
 * Signal shape matches the pipeline exactly:
 *   { type:'buy'|'sell', price, stopLoss, targetPrice, stopDistance, targetDistance,
 *     orderType, strategy, timestamp, tickTriggered, stopTriggered, confluenceScore, ... }
 */

const BaseStrategy = require('./base');
const VWAPEngine = require('../indicators/VWAPEngine');
const ConfluenceScorer = require('../indicators/ConfluenceScorer');
const { calcEMA, calcATR, calcRSI } = require('../indicators/zlema');

const num = (v, d) => (v === undefined || v === null || v === '' || isNaN(parseFloat(v)) ? d : parseFloat(v));

class MomentumClean extends BaseStrategy {
  constructor(config = {}) {
    super('MOMENTUM_CLEAN', config);
    const c = config;
    // ── instrument geometry ──
    this.tickSize = num(c.tickSize, 0.25);
    this.stopBuffer = num(c.stopBuffer, 0.25);

    // ── which setups ──
    this.pbEnabled = c.pbEnabled !== false;          // 5m + 3m momentum pullback
    this.pb3mEnabled = c.pb3mEnabled !== false;      // include the 3m timeframe
    this.lbEnabled = c.lbEnabled === true;           // prior-day level break

    // ── impulse / pullback geometry (5m defaults; 3m scaled) ──
    this.minImpulse = num(c.pbMinImpulse, 15);       // 5m impulse min range (pts)
    this.minImpBodyRatio = num(c.pbMinImpBodyRatio, 0.40);
    this.pbLookback = Math.round(num(c.pbLookbackBars, 3));
    this.retraceMin = num(c.pbRetraceMin, 0.20);
    this.retraceMax = num(c.pbRetraceMax, 0.85);
    this.min3mImpulse = num(c.pb3mMinImpulse, 20);
    this.min3mImpBodyRatio = num(c.pb3mMinImpBodyRatio, 0.10);

    // ── stops / targets ──
    this.maxStopPoints = num(c.maxStopPoints, 6);
    this.minStopPoints = num(c.minStopPoints, 1);
    this.minTargetPoints = num(c.minTargetPoints, 1.25);
    this.profitTargetR = num(c.profitTargetR, 2.75);
    this.lbTargetR = num(c.lbTargetR, 1.5);
    this.lbStopATR = num(c.lbStopATR, 1.0);
    this.lbMaxStop = num(c.lbMaxStop, num(c.maxStopPoints, 40));

    // ── confluence gate ──
    this.minConfluence = Math.round(num(c.minConfluence, 5));
    this.confluence = new ConfluenceScorer({
      minScore: this.minConfluence,
      volumeThreshold: num(c.volumeThreshold, 0.8),
      priorLevelTolerance: num(c.priorLevelTolerance, 5),
      momentumBars: 3,
    });

    // ── session / risk ──
    this.sessionOpen = num(c.sessionStartMin, 390);   // 6:30 PST
    this.hardEntryCutoff = num(c.hardEntryCutoff, 630); // 10:30 PST
    this.cooldownBars = Math.round(num(c.cooldownBars, 1)); // 1m bars after a trade
    this.skipDows = (Array.isArray(c.skipDows) ? c.skipDows : (typeof c.skipDows === 'string' && c.skipDows ? c.skipDows.split(',').map(Number) : []));

    // ── stop-entry (Brooks) ──
    this.stopEntryOffsetTicks = Math.round(num(c.stopEntryOffsetTicks, 1));
    this.stopEntryCancelBars = Math.round(num(c.stopEntryCancelBars, 2));
    this.nativeStopEntry = c.nativeStopEntry === true;
    this.entryOrderType = c.entryOrderType === 'Limit' ? 'Limit' : 'Market';

    // ── indicators / state ──
    this.vwap = new VWAPEngine();
    this.bars1m = []; this.bars3m = []; this.bars5m = [];
    this._cur3m = null; this._cur3mBucket = null;
    this._cur5m = null; this._cur5mBucket = null;
    this._armed = null;              // { isBull, trigger, stop, targetR, strat, sb, armedAt, maxAgeMs }
    this._nativeCommitted = false;
    this.signalFired = false;
    this._cooldownRemaining = 0;
    // prior-day levels (seeded)
    this._pdh = null; this._pdl = null; this._pdc = null;
    this._dailyATR = null;
    this._lbDoneToday = { up: false, dn: false };
    // seeding hook (InstrumentRunner sets this.seedDailyLevels? here we accept injected levels)
    this.injectedLevels = null;
    this._todayGapATR = null;
    this.logTag = c.logTag || `[${this.name}] `;
  }

  initialize() {
    this.isActive = true;
    this.emit('initialized');
  }

  // ── daily reset (called at session boundary by runner/harness) ──
  resetDay() {
    // roll prior-day levels from the day we just finished
    if (this.bars5m.length) {
      let hi = -Infinity, lo = Infinity, lastClose = null;
      for (const b of this.bars5m) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; lastClose = b.close; }
      if (isFinite(hi)) { this._pdh = hi; this._pdl = lo; this._pdc = lastClose; }
    }
    this.bars1m = []; this.bars3m = []; this.bars5m = [];
    this._cur3m = this._cur5m = null; this._cur3mBucket = this._cur5mBucket = null;
    this._armed = null; this._nativeCommitted = false;
    this.signalFired = false; this._cooldownRemaining = 0;
    this._lbDoneToday = { up: false, dn: false };
    try { this.vwap.resetDay(); } catch (e) {}
  }

  _canSignal() {
    return this.isActive && !this.signalFired && !this.position && this._cooldownRemaining <= 0;
  }

  _pstMin(ts) {
    // America/LA minute-of-day (DST-aware); matches the live bot's _getPSTTime
    const s = new Date(ts).toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  }

  // ══════════════════════════════ BAR HANDLING ══════════════════════════════
  onBar(bar) {
    if (!this.isActive) return;
    this.bars.push(bar); if (this.bars.length > 300) this.bars.shift();
    this.bars1m.push(bar); if (this.bars1m.length > 400) this.bars1m.shift();
    try { this.vwap.onBar(bar); } catch (e) {}
    if (this._cooldownRemaining > 0) this._cooldownRemaining--;

    // aggregate to 3m and 5m; run setups on close
    this._aggregate(bar, 3, '_cur3m', '_cur3mBucket', this.bars3m, () => {
      if (this.pbEnabled && this.pb3mEnabled && this._canSignal()) this._checkPullback('3m');
    });
    this._aggregate(bar, 5, '_cur5m', '_cur5mBucket', this.bars5m, () => {
      if (this.pbEnabled && this._canSignal()) this._checkPullback('5m');
      if (this.lbEnabled && this._canSignal()) this._checkLevelBreak();
    });
  }

  _aggregate(bar, mins, curKey, bucketKey, arr, onClose) {
    const m = new Date(bar.timestamp).getUTCMinutes();
    const bucket = Math.floor(m / mins);
    if (!this[curKey] || this[bucketKey] !== bucket) {
      if (this[curKey]) { arr.push({ ...this[curKey] }); if (arr.length > 200) arr.shift(); onClose(); }
      this[curKey] = { timestamp: bar.timestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume || 0 };
      this[bucketKey] = bucket;
    } else {
      const c = this[curKey];
      c.high = Math.max(c.high, bar.high); c.low = Math.min(c.low, bar.low);
      c.close = bar.close; c.volume += bar.volume || 0;
    }
  }

  // ══════════════════════════════ SETUP: PULLBACK ══════════════════════════════
  _checkPullback(tf) {
    const arr = tf === '3m' ? this.bars3m : this.bars5m;
    const n = arr.length - 1;
    if (n < 2) return;
    const pb = arr[n]; // just-closed pullback candidate
    const pstMin = this._pstMin(pb.timestamp);
    if (pstMin < this.sessionOpen || pstMin >= this.hardEntryCutoff) return;
    if (this.skipDows.includes(new Date(pb.timestamp).getUTCDay())) return;

    const minImp = tf === '3m' ? this.min3mImpulse : this.minImpulse;
    const minBodyR = tf === '3m' ? this.min3mImpBodyRatio : this.minImpBodyRatio;

    // find a qualifying impulse in the last pbLookback bars before pb
    let impulse = null, isBull = false;
    for (let lb = 2; lb <= 1 + this.pbLookback; lb++) {
      const cand = arr[n - lb + 1]; // bar preceding pb
      if (!cand) continue;
      const rng = cand.high - cand.low;
      if (rng < minImp) continue;
      if (Math.abs(cand.close - cand.open) < minBodyR * rng) continue;
      isBull = cand.close > cand.open;
      impulse = cand; break;
    }
    if (!impulse) return;
    const impRange = impulse.high - impulse.low;

    // pullback must retrace into [retraceMin, retraceMax] of the impulse, not invalidate it
    let stopLoss, entryPrice;
    if (isBull) {
      const retrace = impulse.high - pb.low;
      if (retrace <= 0 || retrace > impRange) return;         // continuation or invalidated
      const pct = retrace / impRange;
      if (pct < this.retraceMin || pct > this.retraceMax) return;
      stopLoss = pb.low - this.stopBuffer;
      entryPrice = pb.high;                                    // break of pullback high
    } else {
      const retrace = pb.high - impulse.low;
      if (retrace <= 0 || retrace > impRange) return;
      const pct = retrace / impRange;
      if (pct < this.retraceMin || pct > this.retraceMax) return;
      stopLoss = pb.high + this.stopBuffer;
      entryPrice = pb.low;
    }

    // confluence gate
    const conf = this._score(isBull, entryPrice, arr);
    if (conf.score < this.minConfluence) return;

    const stopDist = Math.abs(entryPrice - stopLoss);
    if (stopDist < this.minStopPoints || stopDist > this.maxStopPoints) return;
    if (stopDist * this.profitTargetR < this.minTargetPoints) return;

    this._arm({ isBull, sb: pb, stopLoss, targetR: this.profitTargetR, strat: tf === '3m' ? 'PB3m' : 'PB',
      confScore: conf.score, tfMin: (tf === '3m' ? 3 : 5) });
  }

  // ══════════════════════════════ SETUP: LEVEL BREAK ══════════════════════════════
  _checkLevelBreak() {
    if (this._pdh == null || this._pdl == null) return;
    const n = this.bars5m.length - 1;
    if (n < 1) return;
    const sb = this.bars5m[n];
    const pstMin = this._pstMin(sb.timestamp);
    if (pstMin < this.sessionOpen || pstMin >= this.hardEntryCutoff) return;
    if (this.skipDows.includes(new Date(sb.timestamp).getUTCDay())) return;
    const atr = this._dailyATR || calcATR(this.bars5m, 14) || 0;
    if (atr <= 0) return;
    const stopDist = this.lbStopATR * atr;

    // break-and-close beyond a prior-day level → continuation
    if (!this._lbDoneToday.up && sb.close > this._pdh && sb.high > this._pdh) {
      const stopLoss = sb.close - stopDist - this.stopBuffer;
      this._lbDoneToday.up = true;
      this._arm({ isBull: true, sb, stopLoss, targetR: this.lbTargetR, strat: 'LVLB', confScore: 0, tfMin: 5,
        bounds: { minStop: this.minStopPoints, maxStop: this.lbMaxStop, minTgt: this.minTargetPoints } });
    } else if (!this._lbDoneToday.dn && sb.close < this._pdl && sb.low < this._pdl) {
      const stopLoss = sb.close + stopDist + this.stopBuffer;
      this._lbDoneToday.dn = true;
      this._arm({ isBull: false, sb, stopLoss, targetR: this.lbTargetR, strat: 'LVLB', confScore: 0, tfMin: 5,
        bounds: { minStop: this.minStopPoints, maxStop: this.lbMaxStop, minTgt: this.minTargetPoints } });
    }
  }

  _score(isBull, price, arr) {
    try {
      const closes = arr.map(b => b.close);
      const emaFast = calcEMA(closes, 9);
      const emaSlow = calcEMA(closes, 21);
      const rsi = calcRSI(closes, 14);
      return this.confluence.score({ direction: isBull ? 'buy' : 'sell', price, vwapEngine: this.vwap,
        emaFast, emaSlow, rsi, recentBars: arr, strategyType: 'PB' });
    } catch (e) { return { score: 0, maxScore: 6, factors: [] }; }
  }

  // ══════════════════════════════ STOP-ENTRY ARM / FIRE ══════════════════════════════
  _arm(a) {
    const off = this.stopEntryOffsetTicks * this.tickSize;
    const trigger = a.isBull ? a.sb.high + off : a.sb.low - off;
    const bounds = a.bounds || { minStop: this.minStopPoints, maxStop: this.maxStopPoints, minTgt: this.minTargetPoints };
    this._armed = { isBull: a.isBull, trigger, stop: a.stopLoss, targetR: a.targetR, strat: a.strat,
      confScore: a.confScore || 0, bounds, armedAt: Date.parse(a.sb.timestamp),
      maxAgeMs: this.stopEntryCancelBars * a.tfMin * 60000 };
    this._nativeCommitted = false;
    console.log(`${this.logTag}[${a.strat} STOP-ARM] ${a.isBull ? 'BUY' : 'SELL'}-stop @ ${trigger.toFixed(2)} | stop ${a.stopLoss.toFixed(2)} | conf ${a.confScore}`);
    if (this.nativeStopEntry) this._emitNativeArm();
  }

  _emitNativeArm() {
    const a = this._armed; if (!a) return;
    const stopDist = Math.abs(a.trigger - a.stop);
    if (stopDist < a.bounds.minStop || stopDist > a.bounds.maxStop) { this._armed = null; return; }
    const targetDist = stopDist * a.targetR;
    if (targetDist < a.bounds.minTgt) { this._armed = null; return; }
    const targetPrice = a.isBull ? a.trigger + targetDist : a.trigger - targetDist;
    a.nativeCommitted = true; this._nativeCommitted = true; this.signalFired = true;
    this.emit('signal', this._signalObj(a, a.trigger, stopDist, targetDist, targetPrice, 'Stop'));
  }

  onTick(tick) {
    if (!this._armed || !this._canSignal()) return;
    if (this.nativeStopEntry) { this._nativeInvalidate(tick); return; } // exchange owns the fill; only watch invalidation
    const a = this._armed;
    const price = tick.price;
    const hi = tick.high != null ? tick.high : price;
    const lo = tick.low != null ? tick.low : price;
    const now = Date.parse(tick.timestamp);
    if (now - a.armedAt > a.maxAgeMs) { this._armed = null; return; }
    const triggered = a.isBull ? hi >= a.trigger : lo <= a.trigger;
    const invalidated = a.isBull ? lo <= a.stop : hi >= a.stop;
    if (invalidated && !triggered) { this._armed = null; return; }
    if (!triggered) return;
    const op = tick.open != null ? tick.open : price;
    const entry = a.isBull ? (op > a.trigger ? op : a.trigger) : (op < a.trigger ? op : a.trigger);
    const stopDist = Math.abs(entry - a.stop);
    if (stopDist < a.bounds.minStop || stopDist > a.bounds.maxStop) { this._armed = null; return; }
    const targetDist = stopDist * a.targetR;
    if (targetDist < a.bounds.minTgt) { this._armed = null; return; }
    const targetPrice = a.isBull ? entry + targetDist : entry - targetDist;
    this.signalFired = true; this._armed = null;
    console.log(`${this.logTag}[${a.strat} STOP-ENTRY] 🚀 TRIGGERED ${a.isBull ? 'BUY' : 'SELL'} @ ${entry.toFixed(2)} | stop ${a.stop.toFixed(2)} (${stopDist.toFixed(1)}pt) | target ${targetPrice.toFixed(2)}`);
    this.emit('signal', this._signalObj(a, entry, stopDist, targetDist, targetPrice, this.entryOrderType, true));
  }

  _nativeInvalidate(tick) {
    const a = this._armed; const hi = tick.high != null ? tick.high : tick.price; const lo = tick.low != null ? tick.low : tick.price;
    const now = Date.parse(tick.timestamp);
    const expired = now - a.armedAt > a.maxAgeMs;
    const invalidated = a.isBull ? lo <= a.stop : hi >= a.stop;
    if (expired || invalidated) { this.emit('cancelStopEntry', { reason: expired ? 'expired' : 'invalidated' }); if (a.nativeCommitted) this.signalFired = false; this._armed = null; }
  }

  _signalObj(a, price, stopDist, targetDist, targetPrice, orderType, tick) {
    return { type: a.isBull ? 'buy' : 'sell', price, orderType,
      stopLoss: a.stop, targetPrice, stopDistance: stopDist, targetDistance: targetDist,
      timestamp: new Date(), strategy: a.strat, confluenceScore: a.confScore,
      stopTriggered: orderType === 'Market' || orderType === 'Stop' ? true : false, tickTriggered: !!tick,
      vwapState: (() => { try { return this.vwap.getState(); } catch (e) { return null; } })(),
      filterResults: [{ name: a.strat + ' stop-entry', passed: true, reason: `break @ ${price.toFixed(2)} conf ${a.confScore}` }] };
  }

  // ══════════════════════════════ LIFECYCLE HOOKS ══════════════════════════════
  setPosition(position) {
    this.position = position;
    if (position) { this.signalFired = true; this._armed = null; this._nativeCommitted = false; }
    else {
      this.signalFired = false; this._armed = null; this._nativeCommitted = false;
      if (this.cooldownBars > 0) this._cooldownRemaining = this.cooldownBars;
    }
  }

  onSignalRejected() {
    this.signalFired = false;
    if (this._armed) { this._armed.nativeCommitted = false; }
    this._armed = null; this._nativeCommitted = false;
  }

  onTradeResult() {}

  getStatus() { return { name: this.name, atr: this._dailyATR, rsi: null, ema: null }; }
}

module.exports = MomentumClean;
