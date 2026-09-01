// First Hour Momentum Strategy
// Trades only 6:30-7:30 AM PST (first hour) when volatility is 2x higher
// Uses 3m bars with EMA 5/15 trend filter
// Enters on strong 3m bars (>12pt) in EMA trend direction
// Fixed stop, 2R target, max 4 trades/day, 3 bar cooldown
const EventEmitter = require('events');

class FirstHourMomentum extends EventEmitter {
  constructor(config = {}) {
    super();
    this.name = 'FHM';
    this.logTag = config.logTag || '[FHM]';

    // Strategy params
    this.barThresh = config.barThresh || 12;
    this.targetR = config.targetR || 2;
    this.stopSize = config.stopSize || 8;
    this.maxTrades = config.maxTradesPerDay || 4;
    this.cooldown = config.cooldownBars || 3;
    this.sessStart = config.sessionStartMin || 390;
    this.sessEnd = config.sessionEndMin || 450; // first hour only
    this.useTrend = config.useTrend !== false;
    this.fastPeriod = config.fastPeriod || 5;
    this.slowPeriod = config.slowPeriod || 15;
    this.maxContracts = config.maxContracts || 5;
    this.riskPerTrade = config.riskPerTrade || config.riskPerTradeMax || 90;
    this.pointValue = config.pointValue || 2;
    this.entryOrderType = 'Market';
    this.entryLimitBufferTicks = 0;
    this.maxHoldBars = config.maxHoldBars || 20; // 3m bars
    this.timeStopEnabled = config.timeStopEnabled !== false;

    // EMA state
    this._emaFast = null;
    this._emaSlow = null;
    this._fk = 2 / (this.fastPeriod + 1);
    this._sk = 2 / (this.slowPeriod + 1);

    // 3m bar aggregation
    this._aggBar = null;
    this._aggCount = 0;
    this._aggBucket = null;

    // Trade management
    this._tradeCountToday = 0;
    this._cooldownRemaining = 0;
    this.signalFired = false;
    this.position = null;
    this._barCount = 0;
    this._consecLosses = 0;
    this.maxConsecLosses = config.maxConsecLosses || 5;
    this._prevTradeResult = null;
  }

  initialize() {
    this._emaFast = null;
    this._emaSlow = null;
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
    this._aggBar = null;
    this._aggCount = 0;
    this._aggBucket = null;
    // Reset EMAs at start of each day to avoid cross-day contamination
    this._emaFast = null;
    this._emaSlow = null;
  }

  onSignalRejected() {
    this.signalFired = false;
  }

  onTradeResult(result) {
    this._prevTradeResult = result;
    if (result && result.result === 'loss') {
      this._consecLosses++;
    } else {
      this._consecLosses = 0;
    }
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
    if (this._tradeCountToday >= this.maxTrades) return false;
    if (this._consecLosses >= this.maxConsecLosses) return false;
    if (this._cooldownRemaining > 0) return false;
    return true;
  }

  onBar(bar) {
    this._barCount++;

    // Update EMAs on 1m bar close
    const close = bar.close;
    if (this._emaFast === null) {
      this._emaFast = close;
      this._emaSlow = close;
    } else {
      this._emaFast = close * this._fk + this._emaFast * (1 - this._fk);
      this._emaSlow = close * this._sk + this._emaSlow * (1 - this._sk);
    }

    // Aggregate 1m bars into 3m bars
    const pstMin = this._getPSTMinutes(bar.timestamp);
    const bucket = Math.floor(pstMin / 3) * 3;

    let justCompleted3m = false;
    if (this._aggBar === null || this._aggCount >= 3 || this._aggBucket !== bucket) {
      if (this._aggBar !== null) {
        justCompleted3m = true;
      }
      this._aggBar = {
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.volume || 0, min: this._aggBucket !== null ? this._aggBucket : bucket,
        timestamp: bar.timestamp
      };
      this._aggCount = 1;
      this._aggBucket = bucket;
    } else {
      this._aggBar.high = Math.max(this._aggBar.high, bar.high);
      this._aggBar.low = Math.min(this._aggBar.low, bar.low);
      this._aggBar.close = bar.close;
      this._aggBar.volume += (bar.volume || 0);
      this._aggBar.timestamp = bar.timestamp;
      this._aggCount++;
    }

    // Decrement cooldown
    if (this._cooldownRemaining > 0) this._cooldownRemaining--;

    // Check for signals only when a 3m bar completes
    if (justCompleted3m && this._canSignal()) {
      this._checkSignal(this._aggBar, bar);
    }
  }

  onTick(tick) {
    // No intra-bar entry
  }

  _checkSignal(b3m, current1m) {
    // Session check
    if (b3m.min < this.sessStart || b3m.min >= this.sessEnd) return;

    // Weekday check
    if (!this._isWeekday(b3m.timestamp)) return;

    // Bar size check
    const move = b3m.close - b3m.open;
    if (Math.abs(move) < this.barThresh) return;

    const dir = move > 0 ? 1 : -1;

    // Trend filter
    if (this.useTrend) {
      if (dir === 1 && this._emaFast <= this._emaSlow) return;
      if (dir === -1 && this._emaFast >= this._emaSlow) return;
    }

    // Calculate entry, stop, target
    const entry = current1m.close; // use current 1m bar close as entry
    const stop = dir === 1 ? entry - this.stopSize : entry + this.stopSize;
    const target = dir === 1 ? entry + this.stopSize * this.targetR : entry - this.stopSize * this.targetR;
    const stopDist = Math.abs(entry - stop);
    const targetDist = Math.abs(target - entry);

    // Contract sizing
    const dollarRiskPerContract = stopDist * this.pointValue;
    const contracts = Math.max(1, Math.min(this.maxContracts, Math.floor(this.riskPerTrade / dollarRiskPerContract)));

    this.signalFired = true;
    this._tradeCountToday++;
    this._cooldownRemaining = this.cooldown;

    const side = dir === 1 ? 'LONG' : 'SHORT';
    const emoji = dir === 1 ? '🟢' : '🔴';
    console.log(`${this.logTag}[FHM] ${emoji} ${side} @ ${entry.toFixed(2)} | stop ${stop.toFixed(2)} (${stopDist.toFixed(1)}pt) | target ${target.toFixed(2)} (${this.targetR}R) | ${contracts}c | bar ${move.toFixed(1)}pt | EMA f${this._emaFast.toFixed(1)} s${this._emaSlow.toFixed(1)}`);

    this.emit('signal', {
      type: dir === 1 ? 'buy' : 'sell',
      price: entry,
      orderType: this.entryOrderType,
      limitBufferTicks: this.entryLimitBufferTicks,
      stopLoss: stop,
      targetPrice: target,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(current1m.timestamp),
      strategy: 'FHM',
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
      vwapState: null,
      tickTriggered: false,
      features: {
        strat: 'FHM',
        side: dir === 1 ? 'B' : 'S',
        stopDist: stopDist.toFixed(1),
        rMultiple: this.targetR.toFixed(2),
        barSize: Math.abs(move).toFixed(1),
        emaFast: this._emaFast.toFixed(1),
        emaSlow: this._emaSlow.toFixed(1),
      },
      filterResults: [
        { name: 'BarSize', passed: true, reason: `3m bar ${Math.abs(move).toFixed(1)}pt >= ${this.barThresh}pt` },
        { name: 'Trend', passed: true, reason: dir === 1 ? 'EMA fast > slow' : 'EMA fast < slow' },
        { name: 'Session', passed: true, reason: `${b3m.min} in ${this.sessStart}-${this.sessEnd}` },
      ],
    });
  }

  getStats() {
    return {
      strategy: this.name,
      tradesToday: this._tradeCountToday,
      maxTrades: this.maxTrades,
      consecLosses: this._consecLosses,
      cooldown: this._cooldownRemaining,
      signalFired: this.signalFired,
      hasPosition: !!this.position,
      emaFast: this._emaFast ? +this._emaFast.toFixed(2) : null,
      emaSlow: this._emaSlow ? +this._emaSlow.toFixed(2) : null,
    };
  }
}

module.exports = FirstHourMomentum;
