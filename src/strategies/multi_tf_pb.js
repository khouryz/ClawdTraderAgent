// Multi-Timeframe Pullback Breakout Strategy
// Runs PB on 3m and 5m bars simultaneously to increase signal count
// Each timeframe has independent signal generation but shared trade counter
const EventEmitter = require('events');

class MultiTFPB extends EventEmitter {
  constructor(config = {}) {
    super();
    this.name = 'MTF-PB';
    this.logTag = config.logTag || '[MTF-PB]';

    // Common params
    this.impMin = config.impMin || 15;
    this.targetR = config.targetR || 3;
    this.stopBuffer = config.stopBuffer || 2;
    this.maxStopPoints = config.maxStopPoints || 40;
    this.minStopPoints = config.minStopPoints || 6;
    this.sessionStartMin = config.sessionStartMin || 390;
    this.sessionEndMin = config.sessionEndMin || 660;
    this.maxTradesPerDay = config.maxTradesPerDay || 6;
    this.cooldownBars = config.cooldownBars || 1;
    this.useVwapFilter = config.useVwapFilter !== false;
    this.useVolFilter = config.useVolFilter !== false;
    this.maxContracts = config.maxContracts || 5;
    this.riskPerTrade = config.riskPerTrade || config.riskPerTradeMax || 90;
    this.pointValue = config.pointValue || 2;
    this.maxConsecLosses = config.maxConsecLosses || 5;
    this.maxHoldBars = config.maxHoldBars || 24;
    this.timeStopEnabled = config.timeStopEnabled !== false;

    // 3m specific params (can be overridden)
    this.impMin3m = config.impMin3m || Math.round(this.impMin * 0.6); // smaller impulse for faster TF
    this.targetR3m = config.targetR3m || this.targetR;

    // 10m specific params
    this.impMin10m = config.impMin10m || Math.round(this.impMin * 1.5); // larger impulse for slower TF
    this.targetR10m = config.targetR10m || this.targetR;
    this.use10m = config.use10m !== false;

    // 5m bars state
    this.bars5m = [];
    this._aggBar5m = null;
    this._aggCount5m = 0;
    this._aggBucket5m = null;
    this._volumes5m = [];

    // 3m bars state
    this.bars3m = [];
    this._aggBar3m = null;
    this._aggCount3m = 0;
    this._aggBucket3m = null;
    this._volumes3m = [];

    // 10m bars state
    this.bars10m = [];
    this._aggBar10m = null;
    this._aggCount10m = 0;
    this._aggBucket10m = null;
    this._volumes10m = [];

    // VWAP (shared, computed on 1m bars)
    this._vwapNum = 0;
    this._vwapDen = 0;
    this._vwap = 0;

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
    this.bars5m = [];
    this.bars3m = [];
    this.bars10m = [];
    this._vwapNum = 0;
    this._vwapDen = 0;
    this._vwap = 0;
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
    this._aggBar5m = null;
    this._aggCount5m = 0;
    this._aggBucket5m = null;
    this._aggBar3m = null;
    this._aggCount3m = 0;
    this._aggBucket3m = null;
    this._aggBar10m = null;
    this._aggCount10m = 0;
    this._aggBucket10m = null;
    // Keep bars for context but reset VWAP
    this._vwapNum = 0;
    this._vwapDen = 0;
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
    if (this._tradeCountToday >= this.maxTradesPerDay) return false;
    if (this._consecLosses >= this.maxConsecLosses) return false;
    if (this._cooldownRemaining > 0) return false;
    return true;
  }

  _getVWAP() {
    return this._vwapDen > 0 ? this._vwapNum / this._vwapDen : 0;
  }

  onBar(bar) {
    this._barCount++;

    // Update VWAP on 1m bars
    const tp = (bar.high + bar.low + bar.close) / 3;
    this._vwapNum += tp * (bar.volume || 0);
    this._vwapDen += (bar.volume || 0);
    this._vwap = this._getVWAP();

    const pstMin = this._getPSTMinutes(bar.timestamp);

    // Aggregate into 5m bars
    const bucket5 = Math.floor(pstMin / 5) * 5;
    let justCompleted5m = false;
    if (this._aggBar5m === null || this._aggCount5m >= 5 || this._aggBucket5m !== bucket5) {
      if (this._aggBar5m !== null) {
        this.bars5m.push(this._aggBar5m);
        if (this.bars5m.length > 100) this.bars5m.shift();
        this._volumes5m.push(this._aggBar5m.volume);
        if (this._volumes5m.length > 20) this._volumes5m.shift();
        justCompleted5m = true;
      }
      this._aggBar5m = { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume || 0, timestamp: bar.timestamp, min: bucket5 };
      this._aggCount5m = 1;
      this._aggBucket5m = bucket5;
    } else {
      this._aggBar5m.high = Math.max(this._aggBar5m.high, bar.high);
      this._aggBar5m.low = Math.min(this._aggBar5m.low, bar.low);
      this._aggBar5m.close = bar.close;
      this._aggBar5m.volume += (bar.volume || 0);
      this._aggBar5m.timestamp = bar.timestamp;
      this._aggCount5m++;
    }

    // Aggregate into 3m bars
    const bucket3 = Math.floor(pstMin / 3) * 3;
    let justCompleted3m = false;
    if (this._aggBar3m === null || this._aggCount3m >= 3 || this._aggBucket3m !== bucket3) {
      if (this._aggBar3m !== null) {
        this.bars3m.push(this._aggBar3m);
        if (this.bars3m.length > 100) this.bars3m.shift();
        this._volumes3m.push(this._aggBar3m.volume);
        if (this._volumes3m.length > 20) this._volumes3m.shift();
        justCompleted3m = true;
      }
      this._aggBar3m = { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume || 0, timestamp: bar.timestamp, min: bucket3 };
      this._aggCount3m = 1;
      this._aggBucket3m = bucket3;
    } else {
      this._aggBar3m.high = Math.max(this._aggBar3m.high, bar.high);
      this._aggBar3m.low = Math.min(this._aggBar3m.low, bar.low);
      this._aggBar3m.close = bar.close;
      this._aggBar3m.volume += (bar.volume || 0);
      this._aggBar3m.timestamp = bar.timestamp;
      this._aggCount3m++;
    }

    // Aggregate into 10m bars
    const bucket10 = Math.floor(pstMin / 10) * 10;
    let justCompleted10m = false;
    if (this._aggBar10m === null || this._aggCount10m >= 10 || this._aggBucket10m !== bucket10) {
      if (this._aggBar10m !== null) {
        this.bars10m.push(this._aggBar10m);
        if (this.bars10m.length > 100) this.bars10m.shift();
        this._volumes10m.push(this._aggBar10m.volume);
        if (this._volumes10m.length > 20) this._volumes10m.shift();
        justCompleted10m = true;
      }
      this._aggBar10m = { open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume || 0, timestamp: bar.timestamp, min: bucket10 };
      this._aggCount10m = 1;
      this._aggBucket10m = bucket10;
    } else {
      this._aggBar10m.high = Math.max(this._aggBar10m.high, bar.high);
      this._aggBar10m.low = Math.min(this._aggBar10m.low, bar.low);
      this._aggBar10m.close = bar.close;
      this._aggBar10m.volume += (bar.volume || 0);
      this._aggBar10m.timestamp = bar.timestamp;
      this._aggCount10m++;
    }

    // Decrement cooldown
    if (this._cooldownRemaining > 0) this._cooldownRemaining--;

    // Check 3m signals first (faster timeframe, higher priority for more trades)
    if (justCompleted3m && this._canSignal() && this.bars3m.length >= 4) {
      this._checkPB(this.bars3m, this._volumes3m, this.impMin3m, this.targetR3m, '3m');
    }

    // Then check 5m signals
    if (justCompleted5m && this._canSignal() && this.bars5m.length >= 4) {
      this._checkPB(this.bars5m, this._volumes5m, this.impMin, this.targetR, '5m');
    }

    // Then check 10m signals (slowest timeframe, largest moves)
    if (this.use10m && justCompleted10m && this._canSignal() && this.bars10m.length >= 4) {
      this._checkPB(this.bars10m, this._volumes10m, this.impMin10m, this.targetR10m, '10m');
    }
  }

  onTick(tick) {
    // No intra-bar entry
  }

  _checkPB(bars, volumes, impMin, targetR, tfLabel) {
    if (!this._canSignal()) return;
    if (bars.length < 4) return;

    const i = bars.length - 1;
    const b = bars[i];
    const pstMin = b.min;

    if (!this._isWeekday(b.timestamp)) return;
    if (pstMin < this.sessionStartMin || pstMin >= this.sessionEndMin) return;

    // 3-bar impulse
    for (let impEnd = i - 1; impEnd >= Math.max(i - 5, 3); impEnd--) {
      const impChk = bars[impEnd].close - bars[impEnd - 3].close;
      if (Math.abs(impChk) < impMin) continue;

      const impBars = bars.slice(impEnd - 2, impEnd + 1);
      const impHi = Math.max(...impBars.map(b => b.high));
      const impLo = Math.min(...impBars.map(b => b.low));

      // Pullback check
      let pbBar = null;
      for (let j = impEnd + 1; j <= i; j++) {
        const pb = bars[j];
        const ret = impChk > 0 ? (impHi - pb.low) / Math.abs(impChk) : (pb.high - impLo) / Math.abs(impChk);
        if (ret >= 0.20 && ret <= 0.70) { pbBar = j; break; }
      }
      if (!pbBar) continue;

      // Breakout check
      const dir = impChk > 0 ? 1 : -1;
      const brk = dir === 1 ? b.close > impHi + 0.25 : b.close < impLo - 0.25;
      if (!brk) continue;

      // VWAP filter
      if (this.useVwapFilter) {
        const vwapDir = b.close > this._vwap ? 1 : -1;
        if (vwapDir !== dir) continue;
      }

      // Volume filter
      if (this.useVolFilter && volumes.length >= 20) {
        const va = volumes.slice(Math.max(0, i - 20), i).reduce((s, v) => s + v, 0) / Math.min(20, i);
        if (va > 0 && b.volume < va) continue;
      }

      // Calculate entry, stop, target
      const entry = b.close;
      let stop = dir === 1 ? impLo - this.stopBuffer : impHi + this.stopBuffer;
      const sd = Math.abs(entry - stop);
      if (sd > this.maxStopPoints) stop = dir === 1 ? entry - this.maxStopPoints : entry + this.maxStopPoints;
      if (Math.abs(entry - stop) < this.minStopPoints) stop = dir === 1 ? entry - this.minStopPoints : entry + this.minStopPoints;
      const fsd = Math.abs(entry - stop);
      const target = dir === 1 ? entry + fsd * targetR : entry - fsd * targetR;
      const stopDist = fsd;
      const targetDist = Math.abs(target - entry);

      // Contract sizing
      const dollarRiskPerCt = stopDist * this.pointValue;
      const contracts = Math.max(1, Math.min(this.maxContracts, Math.floor(this.riskPerTrade / dollarRiskPerCt)));

      this.signalFired = true;
      this._tradeCountToday++;
      this._cooldownRemaining = this.cooldownBars;

      const side = dir === 1 ? 'LONG' : 'SHORT';
      const emoji = dir === 1 ? '🟢' : '🔴';
      console.log(`${this.logTag}[MTF-PB ${tfLabel}] ${emoji} ${side} @ ${entry.toFixed(2)} | stop ${stop.toFixed(2)} (${stopDist.toFixed(1)}pt) | target ${target.toFixed(2)} (${targetR}R) | ${contracts}c | imp ${Math.abs(impChk).toFixed(1)}pt | VWAP ${this._vwap.toFixed(1)}`);

      this.emit('signal', {
        type: dir === 1 ? 'buy' : 'sell',
        price: entry,
        orderType: 'Market',
        limitBufferTicks: 0,
        stopLoss: stop,
        targetPrice: target,
        targetDistance: targetDist,
        stopDistance: stopDist,
        timestamp: new Date(b.timestamp),
        strategy: 'MTF-PB',
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
        vwapState: { vwap: this._vwap },
        tickTriggered: false,
        features: {
          strat: `MTF-PB-${tfLabel}`,
          side: dir === 1 ? 'B' : 'S',
          stopDist: stopDist.toFixed(1),
          rMultiple: targetR.toFixed(2),
          tf: tfLabel,
          impSize: Math.abs(impChk).toFixed(1),
        },
        filterResults: [
          { name: 'Impulse', passed: true, reason: `${tfLabel} imp ${Math.abs(impChk).toFixed(1)}pt >= ${impMin}pt` },
          { name: 'Pullback', passed: true, reason: `retrace in 0.20-0.70` },
          { name: 'Breakout', passed: true, reason: `close ${dir > 0 ? '>' : '<'} ${dir > 0 ? 'impHi' : 'impLo'}` },
          { name: 'VWAP', passed: true, reason: `close ${dir > 0 ? '>' : '<'} VWAP ${this._vwap.toFixed(1)}` },
        ],
      });
      return; // Only one signal per bar
    }
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
      bars5m: this.bars5m.length,
      bars3m: this.bars3m.length,
      vwap: +this._vwap.toFixed(2),
    };
  }
}

module.exports = MultiTFPB;
