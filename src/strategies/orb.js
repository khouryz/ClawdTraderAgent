// Opening Range Breakout Strategy
// Defines first N minutes as opening range, trades breakouts with stop at opposite end
// Naturally large stops (20-40pt) make 7pt slippage negligible
const EventEmitter = require('events');

class ORB extends EventEmitter {
  constructor(config = {}) {
    super();
    this.name = 'ORB';
    this.logTag = config.logTag || '[ORB]';

    this.rangeMinutes = config.rangeMinutes || 15; // opening range duration
    this.targetR = config.targetR || 2;
    this.maxTradesPerDay = config.maxTradesPerDay || 2;
    this.cooldownBars = config.cooldownBars || 3;
    this.sessStart = config.sessionStartMin || 390;
    this.sessEnd = config.sessionEndMin || 660;
    this.maxContracts = config.maxContracts || 5;
    this.riskPerTrade = config.riskPerTrade || config.riskPerTradeMax || 90;
    this.pointValue = config.pointValue || 2;
    this.maxConsecLosses = config.maxConsecLosses || 5;
    this.maxHoldBars = config.maxHoldBars || 60; // 1m bars
    this.timeStopEnabled = config.timeStopEnabled !== false;
    this.stopBuffer = config.stopBuffer || 2; // extra buffer beyond range
    this.minRangeSize = config.minRangeSize || 10; // min range in points to trade
    this.maxRangeSize = config.maxRangeSize || 80; // max range in points (too wide = bad)
    this.requireVolume = config.requireVolume !== false; // require above-avg volume on breakout bar
    this.breakoutRetest = config.breakoutRetest || false; // wait for retest of range edge
    this.maxStopPoints = config.maxStopPoints || 60;
    this.minStopPoints = config.minStopPoints || 10;
    this.entryOrderType = 'Market';
    this.entryLimitBufferTicks = 0;

    this._rangeHigh = 0;
    this._rangeLow = Infinity;
    this._rangeOpen = 0;
    this._rangeClose = 0;
    this._rangeComplete = false;
    this._rangeVol = 0;
    this._avgVol = 0;
    this._volCount = 0;
    this._volSum = 0;

    this._tradeCountToday = 0;
    this._cooldownRemaining = 0;
    this.signalFired = false;
    this.position = null;
    this._barCount = 0;
    this._consecLosses = 0;
    this._prevTradeResult = null;
    this.isActive = true;
  }

  initialize() {
    this._rangeHigh = 0;
    this._rangeLow = Infinity;
    this._rangeComplete = false;
  }

  setPosition(pos) {
    this.position = pos;
    if (pos) this.signalFired = true;
    else this.signalFired = false;
  }

  resetDay() {
    this._tradeCountToday = 0;
    this._cooldownRemaining = 0;
    this.signalFired = false;
    this._rangeHigh = 0;
    this._rangeLow = Infinity;
    this._rangeComplete = false;
    this._rangeOpen = 0;
    this._rangeClose = 0;
    this._rangeVol = 0;
    this._volSum = 0;
    this._volCount = 0;
    this._avgVol = 0;
  }

  onSignalRejected() { this.signalFired = false; }

  onTradeResult(result) {
    this._prevTradeResult = result;
    if (result && result.result === 'loss') this._consecLosses++;
    else this._consecLosses = 0;
  }

  _getPSTMinutes(timestamp) {
    const ms = Date.parse(timestamp);
    const d = new Date(ms);
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    const laMin = (+p.find(x => x.type === 'hour').value % 24) * 60 + (+p.find(x => x.type === 'minute').value);
    let diff = (d.getUTCHours() * 60 + d.getUTCMinutes()) - laMin;
    if (diff < 0) diff += 1440;
    const adjusted = new Date(ms - diff * 60000);
    return adjusted.getUTCHours() * 60 + adjusted.getUTCMinutes();
  }

  _isWeekday(timestamp) {
    const ms = Date.parse(timestamp);
    const d = new Date(ms);
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' }).format(d);
    return p !== 'Sat' && p !== 'Sun';
  }

  _canSignal() {
    if (this.position) return false;
    if (this._tradeCountToday >= this.maxTradesPerDay) return false;
    if (this._consecLosses >= this.maxConsecLosses) return false;
    if (this._cooldownRemaining > 0) return false;
    return true;
  }

  onBar(bar) {
    this._barCount++;
    const pstMin = this._getPSTMinutes(bar.timestamp);
    if (!this._isWeekday(bar.timestamp)) return;

    // Track volume
    this._volSum += (bar.volume || 0);
    this._volCount++;

    // Build opening range
    const rangeEnd = this.sessStart + this.rangeMinutes;
    if (pstMin < this.sessStart) return;

    if (pstMin < rangeEnd) {
      // Still building range
      if (this._rangeHigh === 0) {
        this._rangeHigh = bar.high;
        this._rangeLow = bar.low;
        this._rangeOpen = bar.open;
      } else {
        this._rangeHigh = Math.max(this._rangeHigh, bar.high);
        this._rangeLow = Math.min(this._rangeLow, bar.low);
      }
      this._rangeVol += (bar.volume || 0);
      this._rangeClose = bar.close;
      return;
    }

    // Range complete
    if (!this._rangeComplete) {
      this._rangeComplete = true;
      this._avgVol = this._volSum > 0 ? this._volSum / this._volCount : 0;
    }

    if (this._cooldownRemaining > 0) this._cooldownRemaining--;

    // Check for breakout
    if (this._canSignal() && this._rangeComplete && pstMin >= rangeEnd && pstMin < this.sessEnd) {
      this._checkBreakout(bar, pstMin);
    }
  }

  onTick(tick) {}

  _checkBreakout(bar, pstMin) {
    const rangeSize = this._rangeHigh - this._rangeLow;
    if (rangeSize < this.minRangeSize || rangeSize > this.maxRangeSize) return;

    // Volume filter
    if (this.requireVolume && this._avgVol > 0) {
      if ((bar.volume || 0) < this._avgVol) return;
    }

    const dir = bar.close > this._rangeHigh ? 1 : (bar.close < this._rangeLow ? -1 : 0);
    if (dir === 0) return;

    // Entry at close, stop at opposite range edge + buffer
    const entry = bar.close;
    let stop = dir === 1 ? this._rangeLow - this.stopBuffer : this._rangeHigh + this.stopBuffer;
    const stopDist = Math.min(this.maxStopPoints, Math.max(this.minStopPoints, Math.abs(entry - stop)));
    stop = dir === 1 ? entry - stopDist : entry + stopDist;
    const target = dir === 1 ? entry + stopDist * this.targetR : entry - stopDist * this.targetR;
    const targetDist = Math.abs(target - entry);

    const dollarRiskPerCt = stopDist * this.pointValue;
    const contracts = Math.max(1, Math.min(this.maxContracts, Math.floor(this.riskPerTrade / dollarRiskPerCt)));

    this.signalFired = true;
    this._tradeCountToday++;
    this._cooldownRemaining = this.cooldownBars;

    const side = dir === 1 ? 'LONG' : 'SHORT';
    const emoji = dir === 1 ? '🟢' : '🔴';
    console.log(`${this.logTag}[ORB] ${emoji} ${side} @ ${entry.toFixed(2)} | Range ${this._rangeLow.toFixed(1)}-${this._rangeHigh.toFixed(1)} (${rangeSize.toFixed(1)}pt) | stop ${stop.toFixed(2)} (${stopDist.toFixed(1)}pt) | target ${target.toFixed(2)} (${this.targetR}R) | ${contracts}c`);

    this.emit('signal', {
      type: dir === 1 ? 'buy' : 'sell',
      price: entry,
      orderType: this.entryOrderType,
      limitBufferTicks: this.entryLimitBufferTicks,
      stopLoss: stop,
      targetPrice: target,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(bar.timestamp),
      strategy: 'ORB',
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
      vwapState: {},
      tickTriggered: false,
      features: {
        strat: 'ORB',
        side: dir === 1 ? 'B' : 'S',
        stopDist: stopDist.toFixed(1),
        rMultiple: this.targetR.toFixed(2),
        rangeSize: rangeSize.toFixed(1),
      },
      filterResults: [
        { name: 'Range', passed: true, reason: `${rangeSize.toFixed(1)}pt in ${this.minRangeSize}-${this.maxRangeSize}` },
        { name: 'Breakout', passed: true, reason: `close ${dir > 0 ? '>' : '<'} range ${dir > 0 ? 'high' : 'low'}` },
        { name: 'Volume', passed: true, reason: `vol ${bar.volume} >= avg ${this._avgVol.toFixed(0)}` },
      ],
    });
  }

  getStats() {
    return {
      strategy: this.name,
      tradesToday: this._tradeCountToday,
      maxTrades: this.maxTradesPerDay,
      consecLosses: this._consecLosses,
      cooldown: this._cooldownRemaining,
      signalFired: this.signalFired,
      hasPosition: !!this.position,
      rangeComplete: this._rangeComplete,
      rangeHigh: +this._rangeHigh.toFixed(2),
      rangeLow: +this._rangeLow.toFixed(2),
    };
  }
}

module.exports = ORB;
