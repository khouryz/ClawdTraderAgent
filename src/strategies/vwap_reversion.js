// VWAP Mean Reversion Strategy
// Fades extreme deviations from VWAP — naturally large stops, high WR
// Key advantage: 7pt slippage is negligible when stop is 30-50pt
const EventEmitter = require('events');

class VWAPReversion extends EventEmitter {
  constructor(config = {}) {
    super();
    this.name = 'VWAP-Rev';
    this.logTag = config.logTag || '[VWAP-Rev]';

    // Strategy params
    this.devThresh = config.devThresh || 30; // min deviation from VWAP in points
    this.stopSize = config.stopSize || 40; // fixed stop in points
    this.targetR = config.targetR || 1; // target in R multiples
    this.maxTradesPerDay = config.maxTradesPerDay || 3;
    this.cooldownBars = config.cooldownBars || 5;
    this.sessStart = config.sessionStartMin || 390;
    this.sessEnd = config.sessionEndMin || 660;
    this.maxContracts = config.maxContracts || 5;
    this.riskPerTrade = config.riskPerTrade || config.riskPerTradeMax || 90;
    this.pointValue = config.pointValue || 2;
    this.maxConsecLosses = config.maxConsecLosses || 5;
    this.maxHoldBars = config.maxHoldBars || 30; // 1m bars
    this.timeStopEnabled = config.timeStopEnabled !== false;
    this.useSD = config.useSD || false; // use standard deviation instead of fixed points
    this.sdThresh = config.sdThresh || 2.0; // SD threshold for entry
    this.sdStopMult = config.sdStopMult || 3.0; // SD multiplier for stop
    this.minDevForSD = config.minDevForSD || 15; // min deviation in points even with SD mode
    this.entryOrderType = 'Market';
    this.entryLimitBufferTicks = 0;

    // VWAP state
    this._vwapNum = 0;
    this._vwapDen = 0;
    this._vwap = 0;
    this._devs = []; // rolling deviations for SD calc
    this._maxDevs = 100;

    // Trade management
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
    this._vwapNum = 0;
    this._vwapDen = 0;
    this._vwap = 0;
    this._devs = [];
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
    this._vwapNum = 0;
    this._vwapDen = 0;
    this._vwap = 0;
    this._devs = [];
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

    // Update VWAP
    const tp = (bar.high + bar.low + bar.close) / 3;
    this._vwapNum += tp * (bar.volume || 0);
    this._vwapDen += (bar.volume || 0);
    this._vwap = this._vwapDen > 0 ? this._vwapNum / this._vwapDen : bar.close;

    // Track deviation
    const dev = bar.close - this._vwap;
    this._devs.push(dev);
    if (this._devs.length > this._maxDevs) this._devs.shift();

    // Decrement cooldown
    if (this._cooldownRemaining > 0) this._cooldownRemaining--;

    // Check for signal
    if (this._canSignal() && this._vwapDen > 0) {
      this._checkSignal(bar, dev);
    }
  }

  onTick(tick) {
    // No intra-bar entry
  }

  _checkSignal(bar, dev) {
    const pstMin = this._getPSTMinutes(bar.timestamp);
    if (pstMin < this.sessStart || pstMin >= this.sessEnd) return;
    if (!this._isWeekday(bar.timestamp)) return;

    // Need enough VWAP data (at least 10 bars)
    if (this._barCount < 10) return;

    let shouldEnter = false;
    let dir = 0;
    let stopDist = this.stopSize;

    if (this.useSD) {
      // SD-based entry
      if (this._devs.length < 20) return;
      const meanDev = this._devs.reduce((s, d) => s + d, 0) / this._devs.length;
      const variance = this._devs.reduce((s, d) => s + (d - meanDev) ** 2, 0) / this._devs.length;
      const sd = Math.sqrt(variance);
      if (sd < 1) return;

      const zScore = (dev - meanDev) / sd;
      const absDev = Math.abs(dev);

      if (zScore > this.sdThresh && absDev >= this.minDevForSD) {
        shouldEnter = true;
        dir = -1; // fade up deviation
        stopDist = Math.max(this.stopSize, sd * this.sdStopMult);
      } else if (zScore < -this.sdThresh && absDev >= this.minDevForSD) {
        shouldEnter = true;
        dir = 1; // fade down deviation
        stopDist = Math.max(this.stopSize, sd * this.sdStopMult);
      }
    } else {
      // Fixed deviation threshold
      if (dev > this.devThresh) {
        shouldEnter = true;
        dir = -1;
        stopDist = this.stopSize;
      } else if (dev < -this.devThresh) {
        shouldEnter = true;
        dir = 1;
        stopDist = this.stopSize;
      }
    }

    if (!shouldEnter) return;

    const entry = bar.close;
    const stop = dir === 1 ? entry - stopDist : entry + stopDist;
    const target = dir === 1 ? entry + stopDist * this.targetR : entry - stopDist * this.targetR;
    const targetDist = Math.abs(target - entry);

    // Contract sizing
    const dollarRiskPerCt = stopDist * this.pointValue;
    const contracts = Math.max(1, Math.min(this.maxContracts, Math.floor(this.riskPerTrade / dollarRiskPerCt)));

    this.signalFired = true;
    this._tradeCountToday++;
    this._cooldownRemaining = this.cooldownBars;

    const side = dir === 1 ? 'LONG' : 'SHORT';
    const emoji = dir === 1 ? '🟢' : '🔴';
    const devStr = this.useSD ? `z=${((dev - this._devs.reduce((s,d)=>s+d,0)/this._devs.length) / Math.sqrt(this._devs.reduce((s,d)=>s+(d-this._devs.reduce((s2,d2)=>s2+d2,0)/this._devs.length)**2,0)/this._devs.length)).toFixed(2)}` : `dev=${dev.toFixed(1)}pt`;
    console.log(`${this.logTag}[VWAP-Rev] ${emoji} ${side} @ ${entry.toFixed(2)} | VWAP ${this._vwap.toFixed(1)} | ${devStr} | stop ${stop.toFixed(2)} (${stopDist.toFixed(1)}pt) | target ${target.toFixed(2)} (${this.targetR}R) | ${contracts}c`);

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
      strategy: 'VWAP-Rev',
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
      vwapState: { vwap: this._vwap, dev },
      tickTriggered: false,
      features: {
        strat: 'VWAP-Rev',
        side: dir === 1 ? 'B' : 'S',
        stopDist: stopDist.toFixed(1),
        rMultiple: this.targetR.toFixed(2),
        dev: dev.toFixed(1),
        vwap: this._vwap.toFixed(1),
      },
      filterResults: [
        { name: 'Deviation', passed: true, reason: `dev ${dev.toFixed(1)}pt ${dev > 0 ? '>' : '<'} ${this.useSD ? 'SD thresh' : '-' + this.devThresh + 'pt'}` },
        { name: 'Session', passed: true, reason: `${pstMin} in ${this.sessStart}-${this.sessEnd}` },
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
      vwap: +this._vwap.toFixed(2),
      devCount: this._devs.length,
    };
  }
}

module.exports = VWAPReversion;
