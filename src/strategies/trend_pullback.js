/**
 * TREND PULLBACK — from-scratch strategy targeting 50% win rate, 2-4 trades/day.
 *
 * Core edge: In a confirmed trend (EMA stack + VWAP alignment), pullbacks to EMA21
 * on 5m bars resume the trend direction ~55% of the time. We enter on the first 5m
 * bar that closes back in the trend direction after touching EMA21, with an ATR-based
 * stop that survives normal noise, a 2R target, and BE at 1R.
 *
 * Why this works where the old strategy doesn't:
 * - ATR stops (1.5x) instead of structural stops (pullback extreme + buffer) →
 *   the old 1-6pt MES stops were inside the bid/ask spread; ATR scales with vol
 * - 2R target instead of 2.75R → achievable at 50% WR (PF 2.0 at breakeven WR)
 * - BE at 1R → converts marginal winners into breakevens, protects capital
 * - EMA21 pullback instead of impulse geometry → simpler, more frequent, more robust
 * - Trend gate (EMA9 > EMA21 > EMA50 + VWAP) → only trades with the prevailing trend
 * - Time stop (12 5m bars = 1hr) → exits flat trades instead of holding all day
 *
 * API contract: extends BaseStrategy, onBar/onTick, emits 'signal', plugs into
 * InstrumentRunner → SignalHandler → OCO / risk pipeline.
 *
 * Signal shape:
 *   { type:'buy'|'sell', price, stopLoss, targetPrice, stopDistance, targetDistance,
 *     orderType, strategy, timestamp, tickTriggered, stopTriggered, confluenceScore, ... }
 */

const BaseStrategy = require('./base');
const VWAPEngine = require('../indicators/VWAPEngine');
const { calcEMA, calcATR, calcRSI } = require('../indicators/zlema');

const num = (v, d) => (v === undefined || v === null || v === '' || isNaN(parseFloat(v)) ? d : parseFloat(v));

class TrendPullback extends BaseStrategy {
  constructor(config = {}) {
    super('TREND_PULLBACK', config);
    const c = config;

    // ── instrument geometry ──
    this.tickSize = num(c.tickSize, 0.25);
    this.pointValue = num(c.pointValue, 5);
    this.stopBuffer = num(c.stopBuffer, 0.25);

    // ── EMA periods ──
    this.emaFastPeriod = Math.round(num(c.emaFastPeriod, 9));
    this.emaMidPeriod = Math.round(num(c.emaMidPeriod, 21));
    this.emaSlowPeriod = Math.round(num(c.emaSlowPeriod, 50));

    // ── ATR ──
    this.atrPeriod = Math.round(num(c.atrPeriod, 14));
    this.atrStopMult = num(c.atrStopMult, 1.5);

    // ── stops / targets ──
    this.maxStopPoints = num(c.maxStopPoints, 60);
    this.minStopPoints = num(c.minStopPoints, 5);
    this.minTargetPoints = num(c.minTargetPoints, 10);
    this.profitTargetR = num(c.profitTargetR, 2.0);
    this.beActivationR = num(c.beActivationR, 1.0);
    this.moveStopToBE = c.moveStopToBE !== false;

    // ── pullback zone ──
    this.pullbackZoneATR = num(c.pullbackZoneATR, 0.5);

    // ── session ──
    this.sessionOpen = num(c.sessionStartMin, 390);   // 6:30 PST
    this.hardEntryCutoff = num(c.hardEntryCutoff, 630); // 10:30 PST
    this.cooldownBars = Math.round(num(c.cooldownBars, 2));
    this.maxTradesPerDay = Math.round(num(c.maxTradesPerDay, 4));
    this.skipDows = (Array.isArray(c.skipDows) ? c.skipDows :
      (typeof c.skipDows === 'string' && c.skipDows ? c.skipDows.split(',').map(Number) : []));

    // ── time stop ──
    this.timeStopBars = Math.round(num(c.timeStopBars, 12)); // 12 5m bars = 1hr
    this.timeStopEnabled = c.timeStopEnabled !== false;

    // ── stop-entry (Brooks) ──
    this.stopEntryOffsetTicks = Math.round(num(c.stopEntryOffsetTicks, 1));
    this.stopEntryCancelBars = Math.round(num(c.stopEntryCancelBars, 3));
    this.nativeStopEntry = c.nativeStopEntry === true;
    this.entryOrderType = c.entryOrderType === 'Limit' ? 'Limit' : 'Market';

    // ── RSI filter (optional, default off) ──
    this.rsiFilterEnabled = c.rsiFilterEnabled === true;
    this.rsiPeriod = Math.round(num(c.rsiPeriod, 14));
    this.rsiMin = num(c.rsiMin, 35);
    this.rsiMax = num(c.rsiMax, 70);

    // ── indicators / state ──
    this.vwap = new VWAPEngine();
    this.bars1m = [];
    this.bars5m = [];
    this._cur5m = null;
    this._cur5mBucket = null;
    this._armed = null;
    this._nativeCommitted = false;
    this.signalFired = false;
    this._cooldownRemaining = 0;
    this._tradesToday = 0;
    this._consecutiveLosses = 0;
    this._maxConsecutiveLosses = Math.round(num(c.maxConsecutiveLosses, 4));

    // prior-day levels
    this._pdh = null; this._pdl = null; this._pdc = null;
    this._dailyATR = null;
    this._todayGapATR = null;

    // EMA cache (computed on 5m bar close)
    this._emaFast = null;
    this._emaMid = null;
    this._emaSlow = null;
    this._atr = null;
    this._rsi = null;

    // pullback tracking
    this._inPullbackZone = false;
    this._pullbackDir = null; // 'up' or 'dn'

    this.logTag = c.instrumentLabel ? `[${c.instrumentLabel}] ` : `[TP] `;
    this.quietLogs = c.quietPriceLogs === true;
  }

  initialize() {
    this.isActive = true;
    this.emit('initialized');
  }

  // ════════════════════════════════════════════════════════════════
  // DAILY RESET
  // ════════════════════════════════════════════════════════════════
  resetDay() {
    if (this.bars5m.length > 5) {
      let hi = -Infinity, lo = Infinity, lastClose = null;
      for (const b of this.bars5m) {
        if (b.high > hi) hi = b.high;
        if (b.low < lo) lo = b.low;
        lastClose = b.close;
      }
      if (isFinite(hi)) {
        this._pdh = hi; this._pdl = lo; this._pdc = lastClose;
      }
      this._dailyATR = calcATR(this.bars5m, this.atrPeriod) || this._dailyATR;
    }
    this.bars1m = []; this.bars5m = [];
    this._cur5m = null; this._cur5mBucket = null;
    this._armed = null; this._nativeCommitted = false;
    this.signalFired = false; this._cooldownRemaining = 0;
    this._tradesToday = 0;
    this._inPullbackZone = false;
    this._pullbackDir = null;
    try { this.vwap.resetDay(); } catch (e) {}
  }

  _canSignal() {
    return this.isActive
      && !this.signalFired
      && !this.position
      && this._cooldownRemaining <= 0
      && this._tradesToday < this.maxTradesPerDay
      && this._consecutiveLosses < this._maxConsecutiveLosses;
  }

  _pstMin(ts) {
    const s = new Date(ts).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false
    });
    const [h, m] = s.split(':').map(Number);
    return h * 60 + m;
  }

  // ════════════════════════════════════════════════════════════════
  // BAR HANDLING
  // ════════════════════════════════════════════════════════════════
  onBar(bar) {
    if (!this.isActive) return;
    this.bars.push(bar);
    if (this.bars.length > 300) this.bars.shift();
    this.bars1m.push(bar);
    if (this.bars1m.length > 400) this.bars1m.shift();
    try { this.vwap.onBar(bar); } catch (e) {}
    if (this._cooldownRemaining > 0) this._cooldownRemaining--;

    // aggregate 1m → 5m
    this._aggregate5m(bar);
  }

  _aggregate5m(bar) {
    const m = new Date(bar.timestamp).getUTCMinutes();
    const bucket = Math.floor(m / 5);
    if (!this._cur5m || this._cur5mBucket !== bucket) {
      if (this._cur5m) {
        this.bars5m.push({ ...this._cur5m });
        if (this.bars5m.length > 200) this.bars5m.shift();
        this._on5mClose();
      }
      this._cur5m = {
        timestamp: bar.timestamp,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume || 0
      };
      this._cur5mBucket = bucket;
    } else {
      const c = this._cur5m;
      c.high = Math.max(c.high, bar.high);
      c.low = Math.min(c.low, bar.low);
      c.close = bar.close;
      c.volume += bar.volume || 0;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // INDICATOR UPDATE (on 5m bar close)
  // ════════════════════════════════════════════════════════════════
  _updateIndicators() {
    const closes = this.bars5m.map(b => b.close);
    if (closes.length >= this.emaSlowPeriod) {
      this._emaFast = calcEMA(closes, this.emaFastPeriod);
      this._emaMid = calcEMA(closes, this.emaMidPeriod);
      this._emaSlow = calcEMA(closes, this.emaSlowPeriod);
    }
    if (this.bars5m.length >= this.atrPeriod + 1) {
      this._atr = calcATR(this.bars5m, this.atrPeriod);
    }
    if (closes.length >= this.rsiPeriod + 1) {
      this._rsi = calcRSI(closes, this.rsiPeriod);
    }
  }

  // ════════════════════════════════════════════════════════════════
  // TREND DETECTION
  // ════════════════════════════════════════════════════════════════
  _getTrend() {
    if (!this._emaFast || !this._emaMid || !this._emaSlow) return null;
    const price = this.bars5m[this.bars5m.length - 1].close;

    let vwapBias = null;
    try {
      if (this.vwap.isReady()) {
        vwapBias = this.vwap.getTrendBias(price);
      }
    } catch (e) {}

    const emaBull = this._emaFast > this._emaMid && this._emaMid > this._emaSlow;
    const emaBear = this._emaFast < this._emaMid && this._emaMid < this._emaSlow;
    const vwapBull = vwapBias === 'bullish';
    const vwapBear = vwapBias === 'bearish';

    if (emaBull && vwapBull) return 'up';
    if (emaBear && vwapBear) return 'down';
    // Weaker signal: EMA stack aligned but VWAP not ready/neutral
    if (emaBull && vwapBias === null) return 'up';
    if (emaBear && vwapBias === null) return 'down';
    return null;
  }

  // ════════════════════════════════════════════════════════════════
  // SETUP DETECTION (on 5m bar close)
  // ════════════════════════════════════════════════════════════════
  _on5mClose() {
    this._updateIndicators();

    if (!this._canSignal()) return;
    if (this._armed) {
      // Check if armed setup expired
      const now = Date.parse(this.bars5m[this.bars5m.length - 1].timestamp);
      if (now - this._armed.armedAt > this._armed.maxAgeMs) {
        if (this.nativeStopEntry && this._nativeCommitted) {
          this.emit('cancelStopEntry', { reason: 'expired' });
        }
        this._armed = null; this._nativeCommitted = false;
        if (this.signalFired) this.signalFired = false;
      }
    }

    const n = this.bars5m.length - 1;
    if (n < this.emaSlowPeriod) return;

    const bar = this.bars5m[n];
    const pstMin = this._pstMin(bar.timestamp);
    if (pstMin < this.sessionOpen || pstMin >= this.hardEntryCutoff) return;
    if (this.skipDows.includes(new Date(bar.timestamp).getUTCDay())) return;

    const trend = this._getTrend();
    if (!trend) {
      this._inPullbackZone = false;
      this._pullbackDir = null;
      return;
    }

    // RSI filter
    if (this.rsiFilterEnabled && this._rsi !== null) {
      if (trend === 'up' && this._rsi > this.rsiMax) return;
      if (trend === 'down' && this._rsi < this.rsiMin) return;
    }

    if (!this._atr || this._atr <= 0) return;
    const zoneWidth = this.pullbackZoneATR * this._atr;

    // ── Pullback detection ──
    // In uptrend: price pulled back to within zoneWidth of EMA21
    // In downtrend: price rallied to within zoneWidth of EMA21
    const isBull = trend === 'up';
    const distToEMA = isBull ? (this._emaMid - bar.low) : (bar.high - this._emaMid);

    // Price entered the pullback zone (touched/crossed EMA21)
    if (isBull && bar.low <= this._emaMid + zoneWidth && bar.low >= this._emaMid - zoneWidth) {
      this._inPullbackZone = true;
      this._pullbackDir = 'up';
      if (!this.quietLogs) console.log(`${this.logTag}[TP] Pullback to EMA21 zone (low ${bar.low.toFixed(2)} vs EMA ${this._emaMid.toFixed(2)}, ATR ${this._atr.toFixed(2)})`);
    } else if (!isBull && bar.high >= this._emaMid - zoneWidth && bar.high <= this._emaMid + zoneWidth) {
      this._inPullbackZone = true;
      this._pullbackDir = 'down';
      if (!this.quietLogs) console.log(`${this.logTag}[TP] Pullback to EMA21 zone (high ${bar.high.toFixed(2)} vs EMA ${this._emaMid.toFixed(2)}, ATR ${this._atr.toFixed(2)})`);
    }

    // ── Entry trigger: bar closed back in trend direction from the zone ──
    if (this._inPullbackZone && this._pullbackDir === trend) {
      const closedInTrend = isBull
        ? bar.close > this._emaMid && bar.close > bar.open
        : bar.close < this._emaMid && bar.close < bar.open;

      if (closedInTrend && !this._armed) {
        this._arm(bar, isBull);
        this._inPullbackZone = false;
        this._pullbackDir = null;
      }
    }

    // Reset pullback zone if price went too far (trend invalidated)
    if (isBull && bar.close < this._emaSlow) {
      this._inPullbackZone = false; this._pullbackDir = null;
    } else if (!isBull && bar.close > this._emaSlow) {
      this._inPullbackZone = false; this._pullbackDir = null;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // ARM / FIRE
  // ════════════════════════════════════════════════════════════════
  _arm(bar, isBull) {
    const atr = this._atr;
    if (!atr || atr <= 0) return;

    // ATR-based stop: 1.5x ATR from entry, but at least beyond the bar extreme
    const structuralStop = isBull
      ? bar.low - this.stopBuffer
      : bar.high + this.stopBuffer;
    const atrStop = isBull
      ? bar.close - this.atrStopMult * atr
      : bar.close + this.atrStopMult * atr;

    // Use the WIDER of the two (more conservative, survives noise)
    const stopLoss = isBull
      ? Math.min(structuralStop, atrStop)
      : Math.max(structuralStop, atrStop);

    const stopDist = Math.abs(bar.close - stopLoss);
    if (stopDist < this.minStopPoints || stopDist > this.maxStopPoints) {
      if (!this.quietLogs) console.log(`${this.logTag}[TP] Setup rejected: stop ${stopDist.toFixed(1)}pt outside [${this.minStopPoints}-${this.maxStopPoints}]`);
      return;
    }

    const targetDist = stopDist * this.profitTargetR;
    if (targetDist < this.minTargetPoints) {
      if (!this.quietLogs) console.log(`${this.logTag}[TP] Setup rejected: target ${targetDist.toFixed(1)}pt < min ${this.minTargetPoints}`);
      return;
    }

    const targetPrice = isBull ? bar.close + targetDist : bar.close - targetDist;

    // Stop-entry trigger: 1 tick beyond the signal bar's high (long) / low (short)
    const off = this.stopEntryOffsetTicks * this.tickSize;
    const trigger = isBull ? bar.high + off : bar.low - off;

    this._armed = {
      isBull,
      trigger,
      stop: stopLoss,
      target: targetPrice,
      targetR: this.profitTargetR,
      stopDist,
      targetDist,
      strat: 'TP',
      armedAt: Date.parse(bar.timestamp),
      maxAgeMs: this.stopEntryCancelBars * 5 * 60000, // cancel bars * 5min
      barHigh: bar.high,
      barLow: bar.low,
    };
    this._nativeCommitted = false;

    console.log(`${this.logTag}[TP ARM] ${isBull ? 'BUY' : 'SELL'}-stop @ ${trigger.toFixed(2)} | stop ${stopLoss.toFixed(2)} (${stopDist.toFixed(1)}pt) | target ${targetPrice.toFixed(2)} (${targetDist.toFixed(1)}pt) | ATR ${atr.toFixed(2)}`);

    if (this.nativeStopEntry) this._emitNativeArm();
  }

  _emitNativeArm() {
    const a = this._armed; if (!a) return;
    a.nativeCommitted = true; this._nativeCommitted = true; this.signalFired = true;
    this._tradesToday++;
    this.emit('signal', this._signalObj(a, a.trigger, 'Stop'));
  }

  // ════════════════════════════════════════════════════════════════
  // TICK HANDLER (for synthetic stop-entry in backtest)
  // ════════════════════════════════════════════════════════════════
  onTick(tick) {
    if (!this._armed || !this._canSignal()) {
      if (this._armed && this.nativeStopEntry) {
        this._nativeInvalidate(tick);
      }
      return;
    }
    if (this.nativeStopEntry) {
      this._nativeInvalidate(tick);
      return;
    }

    const a = this._armed;
    const price = tick.price;
    const hi = tick.high != null ? tick.high : price;
    const lo = tick.low != null ? tick.low : price;
    const now = Date.parse(tick.timestamp);
    if (now - a.armedAt > a.maxAgeMs) {
      this._armed = null;
      if (this.signalFired) this.signalFired = false;
      return;
    }

    const triggered = a.isBull ? hi >= a.trigger : lo <= a.trigger;
    const invalidated = a.isBull ? lo <= a.stop : hi >= a.stop;

    if (invalidated && !triggered) {
      this._armed = null;
      if (this.signalFired) this.signalFired = false;
      return;
    }
    if (!triggered) return;

    // Fire entry
    const op = tick.open != null ? tick.open : price;
    const entry = a.isBull
      ? (op > a.trigger ? op : a.trigger)
      : (op < a.trigger ? op : a.trigger);

    this.signalFired = true;
    this._tradesToday++;
    this._armed = null;

    console.log(`${this.logTag}[TP FIRE] ${a.isBull ? 'BUY' : 'SELL'} @ ${entry.toFixed(2)} | stop ${a.stop.toFixed(2)} | target ${a.target.toFixed(2)}`);
    this.emit('signal', this._signalObj(a, entry, this.entryOrderType, true));
  }

  _nativeInvalidate(tick) {
    const a = this._armed; if (!a) return;
    const hi = tick.high != null ? tick.high : tick.price;
    const lo = tick.low != null ? tick.low : tick.price;
    const now = Date.parse(tick.timestamp);
    const expired = now - a.armedAt > a.maxAgeMs;
    const invalidated = a.isBull ? lo <= a.stop : hi >= a.stop;
    if (expired || invalidated) {
      if (this._nativeCommitted) {
        this.emit('cancelStopEntry', { reason: expired ? 'expired' : 'invalidated' });
        this.signalFired = false;
        this._tradesToday--;
      }
      this._armed = null; this._nativeCommitted = false;
    }
  }

  // ════════════════════════════════════════════════════════════════
  // SIGNAL OBJECT
  // ════════════════════════════════════════════════════════════════
  _signalObj(a, price, orderType, tick) {
    return {
      type: a.isBull ? 'buy' : 'sell',
      price,
      orderType,
      stopLoss: a.stop,
      targetPrice: a.target,
      stopDistance: a.stopDist,
      targetDistance: a.targetDist,
      timestamp: new Date(),
      strategy: a.strat,
      confluenceScore: 0,
      stopTriggered: true,
      tickTriggered: !!tick,
      moveStopToBE: this.moveStopToBE,
      beActivationR: this.beActivationR,
      partialProfitEnabled: false,
      partialProfitR: null,
      vwapState: (() => { try { return this.vwap.getState(); } catch (e) { return null; } })(),
      filterResults: [{
        name: 'Trend Pullback',
        passed: true,
        reason: `EMA${this.emaFastPeriod}>${this.emaMidPeriod}>${this.emaSlowPeriod} ${a.isBull ? 'bull' : 'bear'} | ATR ${this._atr?.toFixed(1)} | stop ${a.stopDist.toFixed(1)}pt`
      }],
    };
  }

  // ════════════════════════════════════════════════════════════════
  // LIFECYCLE HOOKS
  // ════════════════════════════════════════════════════════════════
  setPosition(position) {
    this.position = position;
    if (position) {
      this.signalFired = true;
      this._armed = null;
      this._nativeCommitted = false;
    } else {
      this.signalFired = false;
      this._armed = null;
      this._nativeCommitted = false;
      if (this.cooldownBars > 0) this._cooldownRemaining = this.cooldownBars;
    }
  }

  onSignalRejected() {
    this.signalFired = false;
    if (this._armed) this._armed.nativeCommitted = false;
    this._armed = null;
    this._nativeCommitted = false;
    if (this._tradesToday > 0) this._tradesToday--;
  }

  onTradeResult(result) {
    if (result && result.outcome) {
      if (result.outcome === 'loss') {
        this._consecutiveLosses++;
      } else if (result.outcome === 'win') {
        this._consecutiveLosses = 0;
      }
    }
  }

  getStatus() {
    return {
      name: this.name,
      atr: this._atr,
      emaFast: this._emaFast,
      emaMid: this._emaMid,
      emaSlow: this._emaSlow,
      rsi: this._rsi,
      tradesToday: this._tradesToday,
      consecutiveLosses: this._consecutiveLosses,
      armed: !!this._armed,
    };
  }

  // ── seed prior-day levels (called by runner/harness) ──
  seedDailyLevels(levels) {
    if (levels) {
      this._pdh = levels.pdh ?? this._pdh;
      this._pdl = levels.pdl ?? this._pdl;
      this._pdc = levels.pdc ?? this._pdc;
    }
  }
}

module.exports = TrendPullback;
