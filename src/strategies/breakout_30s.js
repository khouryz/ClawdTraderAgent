/**
 * Breakout30s — live adapter for the 30s momentum-breakout strategy.
 *
 * This is the live counterpart to backtest/s30 `makeBreakout`. It builds 30s
 * bars from the 1s tick stream (InstrumentRunner feeds full 1s OHLC into
 * onTick), computes EMA9/21/50 on the 30s closes (per-session, SMA-seeded —
 * identical to the backtest's emaSeries), and on each 30s bar close detects a
 * breakout of the prior N-bar base in the direction of the EMA stack.
 *
 * Sizing and R-multiple target are NOT done here — RiskManager handles them:
 *   contracts = floor(RISK_PER_TRADE_MAX / riskPerContract)
 *   target    = entry ± priceRisk * PROFIT_TARGET_R
 * The 13-minute hold cap is enforced by ProfitManager (maxTradeDurationMinutes),
 * wired in InstrumentRunner.
 *
 * Signals fire on the 30s bar CLOSE with a market entry — matching the
 * backtest, which signals on 30s close and fills on the next 1s bars.
 */

const BaseStrategy = require('./base');

class Breakout30sStrategy extends BaseStrategy {
  constructor(config = {}) {
    super('Breakout30s', config);

    // ── Strategy params (defaults match backtest makeBreakout + chosen config) ──
    this.lookback = config.lookback != null ? config.lookback : 10;        // base = prior N 30s bars (10*30s = 5min)
    this.stopBufferPts = config.stopBufferPts != null ? config.stopBufferPts : 2.0;
    this.maxBaseRangePts = config.maxBaseRangePts != null ? config.maxBaseRangePts : 25; // base must be tighter than this
    this.minBreakPts = config.minBreakPts != null ? config.minBreakPts : 1.0;            // require breaking by at least this
    this.requireEmaStack = config.requireEmaStack !== undefined ? config.requireEmaStack : true;
    this.warmup = config.warmup != null ? config.warmup : 55;              // bars before signalling (ema50 + lookback)
    this.emaFastPeriod = config.emaFastPeriod != null ? config.emaFastPeriod : 9;
    this.emaMidPeriod = config.emaMidPeriod != null ? config.emaMidPeriod : 21;
    this.emaSlowPeriod = config.emaSlowPeriod != null ? config.emaSlowPeriod : 50;

    // RiskManager enforces the actual stop cap, but reject obviously-too-wide
    // stops here too (mirrors backtest maxStopPts default of 40).
    this.maxStopPts = config.maxStopPts != null ? config.maxStopPts : 40;
    this.minStopPts = config.minStopPts != null ? config.minStopPts : 2;

    // ── Session window (PT minutes-since-midnight) — matches backtest RTH ──
    this.sessionStartMin = config.sessionStartMin != null ? config.sessionStartMin : 6 * 60 + 30; // 06:30 PT
    this.sessionEndMin = config.sessionEndMin != null ? config.sessionEndMin : 13 * 60;           // 13:00 PT

    // ── 30s bar aggregation state ──
    this.periodMs = 30 * 1000;
    this.thirtySecBars = [];      // [{ t, closeT, o, h, l, c, v, n }]
    this._curBar = null;          // current in-progress 30s bar
    this._barCount = 0;           // 30s bars closed this session

    // ── Clock alignment ──
    // 30s buckets are epoch-aligned (floor(t/30000)) so they always begin on a
    // wall-clock :00 or :30. But if we connect mid-minute we'd open a PARTIAL
    // first bucket. To keep cadence consistent we discard ticks until the top
    // of a fresh minute, then aggregate cleanly :00→:30, :30→:00, :00→...
    this._aligned = false;        // true once we've locked onto a minute boundary
    this._lastTickMinute = null;  // minute index of the previous discarded tick

    // ── Day / signal state ──
    this.signalFired = false;
    this.dayStarted = false;
  }

  /**
   * Reset for a new trading day — clears all per-session 30s state so EMAs
   * re-seed from the session open (identical to the backtest's per-day bars).
   */
  resetDay() {
    this.thirtySecBars = [];
    this._curBar = null;
    this._barCount = 0;
    this._aligned = false;
    this._lastTickMinute = null;
    this.signalFired = false;
    this.dayStarted = true;
    console.log(`[Breakout30s] Day reset — 30s state cleared, re-aligning to next minute boundary`);
  }

  /**
   * 1-minute bars are unused for signalling (the strategy is 30s-native).
   * We keep the base behaviour of storing raw bars but never analyze on them.
   */
  onBar(bar) {
    this.bars.push(bar);
    if (this.bars.length > 250) this.bars.shift();
    // No analyze() here — all logic runs on 30s bar close in onTick().
  }

  /**
   * Each 1s tick is one 1s OHLC bar from the shared Databento stream.
   * We bucket ticks into clock-aligned 30s bars (epoch-aligned → :00/:30),
   * mirroring backtest lib.aggregate(). On bucket rollover we finalize the
   * previous 30s bar, log it, and run the breakout check.
   *
   * @param {Object} tick - { price, high, low, open, timestamp }
   */
  onTick(tick) {
    if (tick == null || tick.price == null || tick.timestamp == null) return;

    const t = typeof tick.timestamp === 'number' ? tick.timestamp : Date.parse(tick.timestamp);
    if (!Number.isFinite(t)) return;

    // Gate aggregation to the RTH session so EMAs seed from the session open
    // (matches backtest, which only has RTH 1s bars per day).
    const ptMin = this._ptMinutes(t);
    if (ptMin < this.sessionStartMin || ptMin >= this.sessionEndMin) return;

    // ── Alignment guard ──
    // Only start aggregating at the top of a minute so the first 30s bar is a
    // full :00→:30 bar. If the very first in-session tick lands exactly on a
    // minute boundary (e.g. session open 06:30:00) we lock on immediately;
    // otherwise we discard the partial minute and lock on at the first tick of
    // the next minute. (1s Databento bars are stamped at the second boundary,
    // so t is always a whole second; minute tops have t % 60000 === 0.)
    if (!this._aligned) {
      const curMinute = Math.floor(t / 60000);
      if (t % 60000 === 0) {
        // First tick is exactly on a minute boundary — start here.
        this._aligned = true;
      } else if (this._lastTickMinute !== null && curMinute > this._lastTickMinute) {
        // We just crossed into a new minute — this tick is its first; start here.
        this._aligned = true;
      } else {
        // Still inside the partial first minute — discard and keep waiting.
        this._lastTickMinute = curMinute;
        return;
      }
      console.log(`[Breakout30s] ✅ Aligned to minute boundary at ${this._ptHHMMSS(t)} PT — aggregating 30s bars`);
    }

    const high = tick.high != null ? tick.high : tick.price;
    const low = tick.low != null ? tick.low : tick.price;
    const open = tick.open != null ? tick.open : tick.price;
    const vol = tick.volume != null ? tick.volume : 0;

    const bucket = Math.floor(t / this.periodMs) * this.periodMs;

    if (!this._curBar || this._curBar.t !== bucket) {
      // Rollover: finalize the previous in-progress 30s bar
      if (this._curBar) this._finalizeBar(this._curBar);
      this._curBar = { t: bucket, closeT: bucket + this.periodMs, o: open, h: high, l: low, c: tick.price, v: vol, n: 1 };
    } else {
      if (high > this._curBar.h) this._curBar.h = high;
      if (low < this._curBar.l) this._curBar.l = low;
      this._curBar.c = tick.price;
      this._curBar.v += vol;
      this._curBar.n++;
    }
  }

  /**
   * Finalize a closed 30s bar: store it, log it, recompute EMAs, run breakout.
   * @private
   */
  _finalizeBar(bar) {
    this.thirtySecBars.push(bar);
    if (this.thirtySecBars.length > 1000) this.thirtySecBars.shift();
    this._barCount++;

    // Show the full bar window with seconds so :00→:30 and :30→:00 are distinct,
    // plus how many 1s ticks landed in the bar (30 = complete, <30 = gaps).
    const startStr = this._ptHHMMSS(bar.t);
    const endStr = this._ptHHMMSS(bar.closeT);
    const gapFlag = bar.n < 30 ? ` ⚠️${30 - bar.n} missing` : '';
    console.log(
      `[Breakout30s] 30s bar #${this._barCount} ${startStr}→${endStr} PT | ` +
      `O:${bar.o.toFixed(2)} H:${bar.h.toFixed(2)} L:${bar.l.toFixed(2)} C:${bar.c.toFixed(2)} ` +
      `V:${bar.v} (${bar.n}/30 ticks${gapFlag}) | total:${this.thirtySecBars.length}`
    );

    if (!this.isActive) return;
    if (this.signalFired || this.position) return;
    if (this._barCount <= this.warmup) return;

    this._checkBreakout();
  }

  /**
   * Breakout detection on the most recently closed 30s bar.
   * Direct port of backtest makeBreakout.onBar().
   * @private
   */
  _checkBreakout() {
    const bars = this.thirtySecBars;
    const i = bars.length - 1;          // index of the just-closed bar
    if (i - this.lookback < 1) return;

    const bar = bars[i];

    // Base = prior `lookback` bars (exclusive of the breakout bar)
    let hi = -Infinity, lo = Infinity;
    for (let j = i - this.lookback; j < i; j++) {
      if (bars[j].h > hi) hi = bars[j].h;
      if (bars[j].l < lo) lo = bars[j].l;
    }
    const baseRange = hi - lo;
    if (baseRange > this.maxBaseRangePts) return;

    // EMA stack on 30s closes (SMA-seeded, per-session — matches backtest)
    const e9 = this._ema(this.emaFastPeriod);
    const e21 = this._ema(this.emaMidPeriod);
    const e50 = this._ema(this.emaSlowPeriod);
    const stackUp = e9 != null && e21 != null && e50 != null && e9 > e21 && e21 > e50;
    const stackDn = e9 != null && e21 != null && e50 != null && e9 < e21 && e21 < e50;

    // LONG breakout
    if (bar.c >= hi + this.minBreakPts && (!this.requireEmaStack || stackUp)) {
      const stop = lo - this.stopBufferPts;
      const stopDist = bar.c - stop;
      if (this._validStop(stopDist)) this._emitSignal('buy', bar.c, stop, stopDist, bar.t);
      return;
    }

    // SHORT breakout
    if (bar.c <= lo - this.minBreakPts && (!this.requireEmaStack || stackDn)) {
      const stop = hi + this.stopBufferPts;
      const stopDist = stop - bar.c;
      if (this._validStop(stopDist)) this._emitSignal('sell', bar.c, stop, stopDist, bar.t);
      return;
    }
  }

  /** @private */
  _validStop(stopDist) {
    if (!(stopDist > 0)) return false;
    if (stopDist < this.minStopPts) return false;
    if (stopDist > this.maxStopPts) return false;
    return true;
  }

  /**
   * Emit a signal in the format SignalHandler expects.
   * RiskManager computes contracts (floor(maxRisk/riskPerContract)) and the
   * R-multiple target from PROFIT_TARGET_R, so we only supply entry + stop.
   * @private
   */
  _emitSignal(type, price, stopLoss, stopDist, barT) {
    this.signalFired = true;
    console.log(`[Breakout30s] 🚦 ${type.toUpperCase()} breakout @ ${price.toFixed(2)} stop ${stopLoss.toFixed(2)} (${stopDist.toFixed(2)}pt) ${this._ptHHMMSS(barT)} PT`);
    this.emit('signal', {
      type,
      price,
      stopLoss,
      stopDistance: stopDist,
      timestamp: new Date(barT),
      strategy: 'Breakout30s',
      orderType: 'Market',
    });
  }

  /**
   * SMA-seeded EMA over the 30s session closes — identical math to
   * backtest lib.emaSeries(), returning the value at the latest bar.
   * @private
   */
  _ema(period) {
    const n = this.thirtySecBars.length;
    if (n < period) return null;
    const k = 2 / (period + 1);
    let sma = 0;
    for (let idx = 0; idx < period; idx++) sma += this.thirtySecBars[idx].c;
    let ema = sma / period;
    for (let idx = period; idx < n; idx++) {
      ema = this.thirtySecBars[idx].c * k + ema * (1 - k);
    }
    return ema;
  }

  /** PT minutes-since-midnight from epoch ms (DST-safe). @private */
  _ptMinutes(tMs) {
    const s = new Date(tMs).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit',
    });
    const [hh, mm] = s.split(':').map(Number);
    return (hh % 24) * 60 + mm;
  }

  /** PT HH:MM string from epoch ms. @private */
  _ptHHMM(tMs) {
    return new Date(tMs).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit',
    });
  }

  /** PT HH:MM:SS string from epoch ms. @private */
  _ptHHMMSS(tMs) {
    return new Date(tMs).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  }

  /**
   * Position lifecycle from InstrumentRunner — block new signals while in a
   * trade, re-arm once flat.
   */
  setPosition(position) {
    super.setPosition(position);
    this.signalFired = !!position;
  }

  /** Signal was rejected (cutoff / pause / slippage) — re-arm. */
  onSignalRejected() {
    this.signalFired = false;
  }

  /** Trade closed — no consecutive-loss logic here (handled by LossLimitsManager). */
  onTradeResult() {
    this.signalFired = false;
  }

  getStatus() {
    return {
      name: this.name,
      active: this.isActive,
      barsCount30s: this.thirtySecBars.length,
      sessionBars: this._barCount,
      inPosition: !!this.position,
      signalFired: this.signalFired,
      position: this.position,
      lookback: this.lookback,
      maxBaseRangePts: this.maxBaseRangePts,
      requireEmaStack: this.requireEmaStack,
    };
  }

  hasEnoughData() {
    return this._barCount > this.warmup;
  }
}

module.exports = Breakout30sStrategy;
