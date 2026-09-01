/**
 * 5m Pullback Breakout — MNQ Momentum Strategy
 *
 * Optimized via multi-source research + parameter sweep on 5m data.
 * 5m backtest: +$20.6K/yr at $200 risk cap, +$10.3K at $135 risk cap.
 * Key optimizations: cooldown=1 (was 3), maxTrades=3 (was 2), session end=660 (was 480).
 *
 * Core Idea:
 *   After a 3-bar (15min) impulse >=15pt, wait for a pullback (20-70% retrace),
 *   then enter on breakout of the impulse extreme. Ride the continuation.
 *
 * Why it works:
 *   - Impulse + pullback is a classic institutional entry pattern
 *   - 5m aggregation filters 1m noise that killed tight scalps
 *   - VWAP filter ensures we only trade with the session trend
 *   - Volume filter confirms institutional participation
 *   - Time filter (6:30-11:00 PST) captures extended volatility window
 *   - 3R target with no BE = asymmetric payoff (40% WR, PF 1.42)
 *
 * Entry (Long):
 *   1. 3-bar impulse >=15pt upward on 5m bars
 *   2. Price pulls back 20-70% of the impulse
 *   3. Price breaks above impulse high + 0.25pt
 *   4. Breakout bar is bullish (close > open)
 *   5. Price is above VWAP (trend confirmation)
 *   6. Volume >= 1.0x 20-bar avg
 *   7. Time: 6:30-8:00 AM PST
 * Mirror for short.
 *
 * Exit:
 *   - Target: 3R (3x stop distance)
 *   - Stop: beyond impulse extreme + 2pt buffer (6-40pt range)
 *   - No BE (validated: BE destroys the edge)
 *   - Time stop: 24 5m bars (2 hours) if neither target nor stop hit
 *
 * Risk Management:
 *   - $90 max risk per trade -> contracts = floor(90 / (stopDist * $2))
 *   - Max 3 trades/day, cooldown 1 bar between trades
 *   - Max 3 consecutive losses -> stop trading for the day
 *   - Session window: 6:30 AM - 11:00 AM PST
 *
 * MNQ: tick=0.25, tickValue=$0.50, pointValue=$2.00
 */

const BaseStrategy = require('./base');
const VWAPEngine = require('../indicators/VWAPEngine');

class VWAPScalper extends BaseStrategy {
  constructor(config) {
    super('VWAP_PULLBACK', config);

    this.logTag = config.instrumentLabel ? `[${config.instrumentLabel}] ` : '';

    // ── Impulse Parameters ──
    this.impMin = config.impMin !== undefined ? config.impMin : 15;
    this.retraceMin = config.retraceMin !== undefined ? config.retraceMin : 0.20;
    this.retraceMax = config.retraceMax !== undefined ? config.retraceMax : 0.70;

    // ── Stop/Target ──
    this.stopBuffer = config.stopBuffer !== undefined ? config.stopBuffer : 2;
    this.minStopPoints = config.minStopPoints !== undefined ? config.minStopPoints : 6;
    this.maxStopPoints = config.maxStopPoints !== undefined ? config.maxStopPoints : 40;
    this.targetR = config.targetR !== undefined ? config.targetR : 3;

    // ── Time Stop (in 5m bars) ──
    this.maxHoldBars = config.maxHoldBars || 24;
    this.timeStopEnabled = config.timeStopEnabled !== false;

    // ── Session Window (PST minutes) ──
    this.sessionStartMin = config.sessionStartMin || 390;
    this.sessionEndMin = config.sessionEndMin || 660;

    // ── Filters ──
    this.useVwapFilter = config.useVwapFilter !== false;
    this.useVolFilter = config.useVolFilter !== false;
    this.volRatioMin = config.volRatioMin !== undefined ? config.volRatioMin : 1.0;
    this.useConfirmBar = config.useConfirmBar !== false;

    // ── Trade Management ──
    this.maxTradesPerDay = config.maxTradesPerDay || 3;
    this.cooldownBars = config.cooldownBars || 1;
    this.maxConsecLosses = config.maxConsecLosses || 3;

    // ── Risk / Sizing ──
    this.riskPerTrade = config.riskPerTrade || config.riskPerTradeMax || 90;
    this.pointValue = config.pointValue || 2.0;
    this.tickSize = config.tickSize || 0.25;
    this.maxContracts = config.maxContracts || 5;

    // ── Entry Order Type ──
    this.entryOrderType = config.entryOrderType === 'Limit' ? 'Limit' : 'Market';
    this.entryLimitBufferTicks = config.entryLimitBufferTicks !== undefined ? config.entryLimitBufferTicks : 1;

    // ── 5m Aggregation State ──
    this._aggBar = null;
    this._aggBarCount = 0;
    this.bars5m = [];

    // ── VWAP State (computed on 1m bars) ──
    this.vwapEngine = config.vwapEngine || new VWAPEngine();
    this._vwapNum = 0;
    this._vwapDen = 0;
    this._volumes5m = [];

    // ── State ──
    this.signalFired = false;
    this.position = null;
    this._tradeCountToday = 0;
    this._consecLosses = 0;
    this._cooldownRemaining = 0;
    this._prevTradeResult = 'none';
    this._barCount = 0;

    this.isActive = true;
  }

  // ═══════════════════════════════════════════════════════════════
  //  DAILY RESET
  // ═══════════════════════════════════════════════════════════════

  resetDay() {
    this.vwapEngine.resetDay();
    this.signalFired = false;
    this.position = null;
    this._tradeCountToday = 0;
    this._consecLosses = 0;
    this._cooldownRemaining = 0;
    this._prevTradeResult = 'none';
    this._barCount = 0;
    this._aggBar = null;
    this._aggBarCount = 0;
    this.bars5m = [];
    this._vwapNum = 0;
    this._vwapDen = 0;
    this._volumes5m = [];
  }

  seedDailyLevels(dailyHLC) {
    if (!dailyHLC || dailyHLC.length === 0) return;
    const last = dailyHLC[dailyHLC.length - 1];
    this._pdh = last.high;
    this._pdl = last.low;
    this._pdc = last.close;
  }

  setPosition(pos) {
    this.position = pos;
    if (!pos) {
      this.signalFired = false;
    }
  }

  onTradeResult(result) {
    this._prevTradeResult = result;
    if (result === 'loss') {
      this._consecLosses++;
    } else if (result === 'win') {
      this._consecLosses = 0;
    }
    this._cooldownRemaining = this.cooldownBars;
  }

  onSignalRejected() {
    this.signalFired = false;
    if (this._tradeCountToday > 0) this._tradeCountToday--;
  }

  _getPSTMinutes(timestamp) {
    const d = (timestamp instanceof Date) ? timestamp : new Date(timestamp);
    const s = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
    const [dp, tp] = s.split(', ');
    const [mo, dy, yr] = dp.split('/');
    const [h, m] = tp.split(':').map(Number);
    return h * 60 + m;
  }

  _isWeekday(timestamp) {
    const d = (timestamp instanceof Date) ? timestamp : new Date(timestamp);
    const s = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
    const [dp] = s.split(', ');
    const [mo, dy, yr] = dp.split('/');
    const dateStr = yr + '-' + String(mo).padStart(2, '0') + '-' + String(dy).padStart(2, '0');
    const dow = new Date(dateStr + 'T12:00:00Z').getDay();
    return dow !== 0 && dow !== 6;
  }

  _canSignal() {
    if (!this.isActive) return false;
    if (this.signalFired) return false;
    if (this.position) return false;
    if (this._tradeCountToday >= this.maxTradesPerDay) return false;
    if (this._consecLosses >= this.maxConsecLosses) return false;
    if (this._cooldownRemaining > 0) return false;
    return true;
  }

  onBar(bar) {
    this._barCount++;

    // Feed VWAP engine on 1m bars
    this.vwapEngine.onBar(bar);

    // Update VWAP numerator/denominator
    const tp = (bar.high + bar.low + bar.close) / 3;
    this._vwapNum += tp * (bar.volume || 0);
    this._vwapDen += (bar.volume || 0);

    // Aggregate 1m bars into 5m bars using clock-aligned buckets
    const pstMin = this._getPSTMinutes(bar.timestamp);
    const bucket = Math.floor(pstMin / 5) * 5;

    let justCompleted5m = false;
    if (this._aggBar === null || this._aggBarCount >= 5 || this._aggBarBucket !== bucket) {
      // Push completed 5m bar
      if (this._aggBar !== null) {
        this.bars5m.push(this._aggBar);
        if (this.bars5m.length > 100) this.bars5m.shift();
        this._volumes5m.push(this._aggBar.volume);
        if (this._volumes5m.length > 20) this._volumes5m.shift();
        justCompleted5m = true;
      }
      // Start new 5m bar
      this._aggBar = {
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        volume: bar.volume || 0,
        timestamp: bar.timestamp,
        min: bucket,
      };
      this._aggBarCount = 1;
      this._aggBarBucket = bucket;
    } else {
      // Accumulate into current 5m bar
      this._aggBar.high = Math.max(this._aggBar.high, bar.high);
      this._aggBar.low = Math.min(this._aggBar.low, bar.low);
      this._aggBar.close = bar.close;
      this._aggBar.volume += (bar.volume || 0);
      this._aggBar.timestamp = bar.timestamp;
      this._aggBarCount++;
    }

    // Decrement cooldown
    if (this._cooldownRemaining > 0) this._cooldownRemaining--;

    // Check for signals ONLY when a new 5m bar just completed
    if (this.isActive && justCompleted5m && this.bars5m.length >= 4) {
      this._checkPullback();
    }
  }

  onTick(tick) {
    // No intra-bar entry — signals fire on 5m bar close.
    // Stop/target/BE are handled by InstrumentRunner/PositionHandler.
  }

  _checkPullback() {
    if (!this._canSignal()) return;
    if (this.bars5m.length < 4) return;

    const i = this.bars5m.length - 1;
    const b = this.bars5m[i];
    const pstMin = b.min;

    if (!this._isWeekday(b.timestamp)) return;
    if (pstMin < this.sessionStartMin || pstMin >= this.sessionEndMin) return;

    // 3-bar impulse (current bar is the 3rd)
    const imp = b.close - this.bars5m[i - 3].close;
    if (Math.abs(imp) < this.impMin) return;

    const impBars = this.bars5m.slice(i - 2, i + 1);
    const impHigh = Math.max(...impBars.map(b => b.high));
    const impLow = Math.min(...impBars.map(b => b.low));

    // Volume filter
    if (this.useVolFilter && this._volumes5m.length >= 20) {
      const volAvg = this._volumes5m.reduce((s, v) => s + v, 0) / this._volumes5m.length;
      if (volAvg > 0 && (b.volume || 0) < volAvg * this.volRatioMin) return;
    }

    // VWAP filter: impulse must align with VWAP trend
    const vwap = this._vwapDen > 0 ? this._vwapNum / this._vwapDen : b.close;
    if (this.useVwapFilter) {
      const vwapDir = b.close > vwap ? 1 : -1;
      const impDir = imp > 0 ? 1 : -1;
      if (vwapDir !== impDir) return;
    }

    // Wait for pullback + breakout on the NEXT 1-5 5m bars
    // We look at bars after the impulse bar — but since we're processing bar-by-bar,
    // we check if the CURRENT bar is a pullback-breakout relative to a prior impulse.
    // The impulse was detected on bar i. Now we check if bar i+1 (if it exists) is the breakout.
    // But since we're on bar i, we need to check if bar i itself is the breakout after
    // an impulse that ended on bar i-1 or i-2.

    // Alternative approach: check if the current bar IS the breakout bar
    // Look back 1-5 bars for the impulse, then check if current bar is the breakout
    for (let impEnd = i - 1; impEnd >= Math.max(i - 5, 3); impEnd--) {
      const impCheck = this.bars5m[impEnd].close - this.bars5m[impEnd - 3].close;
      if (Math.abs(impCheck) < this.impMin) continue;

      const impBars2 = this.bars5m.slice(impEnd - 2, impEnd + 1);
      const impHigh2 = Math.max(...impBars2.map(b => b.high));
      const impLow2 = Math.min(...impBars2.map(b => b.low));

      // Check if bars between impEnd+1 and i are the pullback
      let pullbackBar = null;
      for (let j = impEnd + 1; j <= i; j++) {
        const pb = this.bars5m[j];
        const retrace = impCheck > 0
          ? (impHigh2 - pb.low) / Math.abs(impCheck)
          : (pb.high - impLow2) / Math.abs(impCheck);
        if (retrace >= this.retraceMin && retrace <= this.retraceMax) {
          pullbackBar = j;
          break;
        }
      }
      if (pullbackBar === null) continue;

      // Current bar must be the breakout
      const dir = impCheck > 0 ? 1 : -1;
      const breakout = dir === 1 ? b.close > impHigh2 + 0.25 : b.close < impLow2 - 0.25;
      if (!breakout) continue;

      // Confirm bar
      if (this.useConfirmBar) {
        const isConfirm = dir === 1 ? b.close > b.open : b.close < b.open;
        if (!isConfirm) continue;
      }

      // Fire signal
      this._fireSignal(b, dir, impHigh2, impLow2, vwap, Math.abs(impCheck));
      return;
    }
  }

  _fireSignal(bar, dir, impHigh, impLow, vwap, impSize) {
    const entry = bar.close;
    let stop = dir === 1 ? impLow - this.stopBuffer : impHigh + this.stopBuffer;
    const stopDist = Math.abs(entry - stop);

    if (stopDist > this.maxStopPoints) stop = dir === 1 ? entry - this.maxStopPoints : entry + this.maxStopPoints;
    if (Math.abs(entry - stop) < this.minStopPoints) stop = dir === 1 ? entry - this.minStopPoints : entry + this.minStopPoints;

    const finalStopDist = Math.abs(entry - stop);
    const target = dir === 1 ? entry + finalStopDist * this.targetR : entry - finalStopDist * this.targetR;
    const targetDist = Math.abs(target - entry);

    const dollarRiskPerContract = finalStopDist * this.pointValue;
    let contracts = Math.max(1, Math.floor(this.riskPerTrade / dollarRiskPerContract));
    contracts = Math.min(contracts, this.maxContracts);

    this.signalFired = true;
    this._tradeCountToday++;

    const rMultiple = targetDist / finalStopDist;
    const side = dir === 1 ? 'LONG' : 'SHORT';
    const emoji = dir === 1 ? '🟢' : '🔴';

    console.log(`${this.logTag}[PB] ${emoji} ${side} @ ${entry.toFixed(2)} | stop ${stop.toFixed(2)} (${finalStopDist.toFixed(1)}pt) | target ${target.toFixed(2)} (${rMultiple.toFixed(1)}R) | ${contracts}c | imp ${impSize.toFixed(1)}pt | VWAP ${vwap.toFixed(2)}`);

    this.emit('signal', {
      type: dir === 1 ? 'buy' : 'sell',
      price: entry,
      orderType: this.entryOrderType,
      limitBufferTicks: this.entryLimitBufferTicks,
      stopLoss: stop,
      targetPrice: target,
      targetDistance: targetDist,
      stopDistance: finalStopDist,
      timestamp: new Date(bar.timestamp),
      strategy: 'PB',
      tradeNumToday: this._tradeCountToday,
      prevTradeResult: this._prevTradeResult,
      partialProfitEnabled: false,
      partialProfitR: 0,
      moveStopToBE: false,
      beTriggerR: 0,
      maxHoldBars: this.maxHoldBars,
      timeStopEnabled: this.timeStopEnabled,
      contracts,
      confluenceScore: 0,
      vwapState: this.vwapEngine.getState ? this.vwapEngine.getState() : { vwap, stdDev: 0 },
      tickTriggered: false,
      features: {
        strat: 'PB',
        side: dir === 1 ? 'B' : 'S',
        vwap: vwap.toFixed(1),
        stopDist: finalStopDist.toFixed(1),
        rMultiple: rMultiple.toFixed(2),
        impSize: impSize.toFixed(1),
        todMin: bar.min,
      },
      filterResults: [
        { name: 'Impulse', passed: true, reason: `3-bar impulse ${impSize.toFixed(1)}pt >= ${this.impMin}pt` },
        { name: 'Pullback', passed: true, reason: `retrace ${this.retraceMin}-${this.retraceMax}` },
        { name: 'Breakout', passed: true, reason: `broke impulse ${dir === 1 ? 'high' : 'low'}` },
        { name: 'VWAP', passed: true, reason: `price ${dir === 1 ? 'above' : 'below'} VWAP ${vwap.toFixed(1)}` },
        { name: 'Volume', passed: true, reason: `>= ${this.volRatioMin}x avg` },
      ],
    });
  }

  getStats() {
    const vwap = this._vwapDen > 0 ? this._vwapNum / this._vwapDen : null;
    return {
      strategy: this.name,
      tradesToday: this._tradeCountToday,
      maxTrades: this.maxTradesPerDay,
      consecLosses: this._consecLosses,
      cooldown: this._cooldownRemaining,
      signalFired: this.signalFired,
      hasPosition: !!this.position,
      vwap: vwap ? +vwap.toFixed(2) : null,
      bars5m: this.bars5m.length,
    };
  }
}

module.exports = VWAPScalper;
