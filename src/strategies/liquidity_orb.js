/**
 * Liquidity ORB Strategy
 * 
 * Based on institutional order flow / liquidity concepts:
 * 
 * Key Levels:
 *   1. Opening Range (OR): 8:00-8:15 AM EST (5:00-5:15 AM PST) 15-min candle on ES/NQ/M2K
 *   2. Previous Session High/Low: Yesterday's high and low (liquidity pools)
 * 
 * Three Setups:
 *   1. Break & Retest (primary, ~60% of trades):
 *      - Wait for price to break above/below OR by 9:30 AM EST (6:30 AM PST)
 *      - Enter on retest of OR zone (top, midpoint, or bottom)
 *      - Stop: beyond midpoint (~5 pts), Target: 15 pts (1:3 R:R)
 * 
 *   2. Bounce off Untested Lows (~20% of trades):
 *      - Identify untested previous session low
 *      - Enter long when price taps level with wick but doesn't close below
 *      - Wait for 5 candle closures confirming bounce
 *      - Stop: 5-10 pts below level, Target: 20 pts (1:4 R:R)
 * 
 *   3. Rejection off Untested Highs (~20% of trades):
 *      - Identify untested previous session high
 *      - Enter short when price fails to break above (multiple rejections)
 *      - Stop: 6 pts above level, Target: 30 pts (1:5 R:R)
 * 
 * Timeframes: 15-min for OR marking, 5-min + 1-min for entries
 * Instruments: ES (MES), NQ (MNQ), RTY (M2K)
 */

const BaseStrategy = require('./base');

class LiquidityORBStrategy extends BaseStrategy {
  constructor(config) {
    super('LIQ_ORB', config);

    // ── Opening Range Parameters ──
    // OR is the 8:00 AM EST candle (first 15 min)
    // 8:00 AM EST = 5:00 AM PST = 13:00 UTC (standard) / 12:00 UTC (DST)
    this.orStartMinPST = config.orStartMinPST || 300;     // 5:00 AM PST = 300 min
    this.orDurationMin = config.orDurationMin || 15;        // 15-minute OR window
    this.orEstablished = false;
    this.orHigh = null;
    this.orLow = null;
    this.orMid = null;
    this.orBarsCollected = 0;

    // ── Break & Retest Parameters ──
    this.brtEnabled = config.brtEnabled !== false;
    this.brtWaitMinPST = config.brtWaitMinPST || 390;     // 6:30 AM PST (9:30 AM EST)
    this.brtMaxTimePST = config.brtMaxTimePST || 600;     // 10:00 AM PST (1:00 PM EST)
    this.brtStopPoints = config.brtStopPoints || 5;
    this.brtTargetPoints = config.brtTargetPoints || 15;
    this.brtRetestTolerance = config.brtRetestTolerance || 1.0; // Points tolerance for retest
    this.brtMinBodyRatio = config.brtMinBodyRatio || 0.3;  // Min body ratio on entry bar
    this.brtBreakoutDir = null;  // 'long' or 'short' — set after 9:30 AM EST

    // ── Bounce Parameters (untested lows) ──
    this.bounceEnabled = config.bounceEnabled !== false;
    this.bounceStopPoints = config.bounceStopPoints || 7;
    this.bounceTargetPoints = config.bounceTargetPoints || 20;
    this.bounceConfirmBars = config.bounceConfirmBars || 5; // Wait N 1-min bars after tap
    this.bounceMaxTimePST = config.bounceMaxTimePST || 660; // 11:00 AM PST

    // ── Rejection Parameters (untested highs) ──
    this.rejectionEnabled = config.rejectionEnabled !== false;
    this.rejectionStopPoints = config.rejectionStopPoints || 6;
    this.rejectionTargetPoints = config.rejectionTargetPoints || 30;
    this.rejectionMinTouches = config.rejectionMinTouches || 2; // Min failed attempts
    this.rejectionMaxTimePST = config.rejectionMaxTimePST || 660;

    // ── Shared Parameters ──
    this.maxTradesPerDay = config.maxTradesPerDay || 3;
    this.levelTolerance = config.levelTolerance || 1.5;    // Points tolerance for level touch
    this.minBarsSinceOR = config.minBarsSinceOR || 5;

    // ── State ──
    this.fiveMinBars = [];
    this.current5mBar = null;
    this._current5mBucket = null;
    this.sessionBarCount = 0;
    this.dayStarted = false;
    this.signalFired = false;
    this._tradeCountToday = 0;

    // Previous session levels
    this.prevSessionHigh = null;
    this.prevSessionLow = null;
    this.prevSessionHighTested = false;
    this.prevSessionLowTested = false;

    // Bounce/rejection tracking
    this._bounceWatching = null;  // { level, tapBar, confirmCount }
    this._rejectionWatching = null; // { level, touches, firstTouchBar }

    // Today's session tracking (for building prev session levels)
    this._todayHigh = null;
    this._todayLow = null;
  }

  /**
   * Reset for new trading day
   */
  resetDay() {
    // Save today's H/L as previous session levels for tomorrow
    if (this._todayHigh !== null && this._todayLow !== null) {
      this.prevSessionHigh = this._todayHigh;
      this.prevSessionLow = this._todayLow;
      this.prevSessionHighTested = false;
      this.prevSessionLowTested = false;
      console.log(`[LIQ_ORB] Prev session levels: H=${this.prevSessionHigh} L=${this.prevSessionLow}`);
    }

    this.orEstablished = false;
    this.orHigh = null;
    this.orLow = null;
    this.orMid = null;
    this.orBarsCollected = 0;
    this.brtBreakoutDir = null;

    this.fiveMinBars = [];
    this.current5mBar = null;
    this._current5mBucket = null;
    this.sessionBarCount = 0;
    this.dayStarted = true;
    this.signalFired = false;
    this._tradeCountToday = 0;

    this._bounceWatching = null;
    this._rejectionWatching = null;
    this._todayHigh = null;
    this._todayLow = null;
  }

  /**
   * Process incoming 1-minute bar
   */
  onBar(bar) {
    this.bars.push(bar);
    if (this.bars.length > 500) this.bars.shift();
    this.sessionBarCount++;

    const pstMins = this._getPSTMinutes(bar.timestamp);

    // Track today's high/low for next day's prev session levels
    if (this._todayHigh === null || bar.high > this._todayHigh) this._todayHigh = bar.high;
    if (this._todayLow === null || bar.low < this._todayLow) this._todayLow = bar.low;

    // ── Collect Opening Range (5:00-5:15 AM PST) ──
    if (!this.orEstablished) {
      this._collectOR(bar, pstMins);
    }

    // ── Determine breakout direction at 6:30 AM PST ──
    if (this.orEstablished && !this.brtBreakoutDir && pstMins >= this.brtWaitMinPST) {
      this._determineBreakoutDirection(bar);
    }

    // ── Build 5-min bars ──
    this._build5mBar(bar);

    // ── Check Bounce/Rejection setups on every 1-min bar ──
    if (this.isActive && !this.signalFired && !this.position && this._tradeCountToday < this.maxTradesPerDay) {
      if (this.bounceEnabled) this._checkBounce(bar, pstMins);
      if (this.rejectionEnabled) this._checkRejection(bar, pstMins);
    }

    // Log every 20 bars
    if (this.sessionBarCount % 20 === 0) {
      const orStr = this.orEstablished ? `OR:${this.orHigh?.toFixed(2)}-${this.orLow?.toFixed(2)}` : 'OR:building';
      const dirStr = this.brtBreakoutDir || 'none';
      console.log(`[LIQ_ORB] ${this.sessionBarCount} bars | 5m:${this.fiveMinBars.length} | ${orStr} | dir:${dirStr} | trades:${this._tradeCountToday} | sig:${this.signalFired}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  OPENING RANGE
  // ═══════════════════════════════════════════════════════════════

  _collectOR(bar, pstMins) {
    // Only collect bars during OR window
    if (pstMins < this.orStartMinPST || pstMins >= this.orStartMinPST + this.orDurationMin) return;

    this.orBarsCollected++;
    if (this.orHigh === null || bar.high > this.orHigh) this.orHigh = bar.high;
    if (this.orLow === null || bar.low < this.orLow) this.orLow = bar.low;

    // OR is established after collecting all bars in the window
    if (pstMins >= this.orStartMinPST + this.orDurationMin - 1) {
      this.orEstablished = true;
      this.orMid = (this.orHigh + this.orLow) / 2;
      const orRange = this.orHigh - this.orLow;
      console.log(`[LIQ_ORB] ✅ OR established: H=${this.orHigh.toFixed(2)} L=${this.orLow.toFixed(2)} Mid=${this.orMid.toFixed(2)} Range=${orRange.toFixed(2)}pt (${this.orBarsCollected} bars)`);
    }
  }

  _determineBreakoutDirection(bar) {
    if (!this.orEstablished) return;

    const price = bar.close;
    if (price > this.orHigh) {
      this.brtBreakoutDir = 'long';
      console.log(`[LIQ_ORB] 📈 Breakout direction: LONG (price ${price.toFixed(2)} > OR high ${this.orHigh.toFixed(2)})`);
    } else if (price < this.orLow) {
      this.brtBreakoutDir = 'short';
      console.log(`[LIQ_ORB] 📉 Breakout direction: SHORT (price ${price.toFixed(2)} < OR low ${this.orLow.toFixed(2)})`);
    } else {
      // Price still inside OR — check on next bar
      console.log(`[LIQ_ORB] ⏳ Price ${price.toFixed(2)} still inside OR [${this.orLow.toFixed(2)}-${this.orHigh.toFixed(2)}], waiting...`);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  5-MIN BAR BUILDING
  // ═══════════════════════════════════════════════════════════════

  _build5mBar(bar) {
    const barMin = new Date(bar.timestamp).getUTCMinutes();
    const bucket5m = Math.floor(barMin / 5);

    if (!this.current5mBar || this._current5mBucket !== bucket5m) {
      if (this.current5mBar) {
        this.fiveMinBars.push({ ...this.current5mBar });
        if (this.fiveMinBars.length > 200) this.fiveMinBars.shift();

        // Check Break & Retest on 5-min bar close
        if (this.isActive && !this.signalFired && !this.position && this._tradeCountToday < this.maxTradesPerDay) {
          if (this.brtEnabled) this._checkBreakAndRetest();
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
  //  SETUP 1: BREAK & RETEST
  // ═══════════════════════════════════════════════════════════════

  _checkBreakAndRetest() {
    if (!this.orEstablished || !this.brtBreakoutDir) return;
    if (this.fiveMinBars.length < this.minBarsSinceOR) return;

    const pstMins = this._getPSTMinutes(this.fiveMinBars[this.fiveMinBars.length - 1].timestamp);
    if (pstMins > this.brtMaxTimePST) return;

    const bar = this.fiveMinBars[this.fiveMinBars.length - 1];
    const prevBar = this.fiveMinBars.length >= 2 ? this.fiveMinBars[this.fiveMinBars.length - 2] : null;
    if (!prevBar) return;

    const price = bar.close;
    const tol = this.brtRetestTolerance;

    if (this.brtBreakoutDir === 'long') {
      // Looking for retest of OR top or midpoint, then bounce up
      // Entry: price dipped to OR zone (top or mid) and bounced — bar closes above OR top
      const retestTop = bar.low <= this.orHigh + tol && bar.low >= this.orMid - tol;
      const bouncedUp = bar.close > bar.open && bar.close > this.orHigh;

      if (retestTop && bouncedUp) {
        // Body ratio check
        const barRange = bar.high - bar.low;
        if (barRange > 0 && Math.abs(bar.close - bar.open) / barRange < this.brtMinBodyRatio) {
          console.log(`[BRT] SKIP: weak body ratio ${(Math.abs(bar.close - bar.open) / barRange).toFixed(2)}`);
          return;
        }

        const stopLoss = this.orMid - this.brtStopPoints;
        const stopDist = price - stopLoss;
        const targetPrice = price + this.brtTargetPoints;

        console.log(`[BRT] ✅ LONG retest: entry=${price.toFixed(2)} stop=${stopLoss.toFixed(2)} (${stopDist.toFixed(1)}pt) target=${targetPrice.toFixed(2)} (${this.brtTargetPoints}pt)`);
        this._emitSignal('buy', price, stopLoss, targetPrice, 'BRT', bar, stopDist);
        return;
      }
    }

    if (this.brtBreakoutDir === 'short') {
      // Looking for retest of OR bottom or midpoint, then drop
      const retestBottom = bar.high >= this.orLow - tol && bar.high <= this.orMid + tol;
      const droppedDown = bar.close < bar.open && bar.close < this.orLow;

      if (retestBottom && droppedDown) {
        const barRange = bar.high - bar.low;
        if (barRange > 0 && Math.abs(bar.close - bar.open) / barRange < this.brtMinBodyRatio) {
          console.log(`[BRT] SKIP: weak body ratio ${(Math.abs(bar.close - bar.open) / barRange).toFixed(2)}`);
          return;
        }

        const stopLoss = this.orMid + this.brtStopPoints;
        const stopDist = stopLoss - price;
        const targetPrice = price - this.brtTargetPoints;

        console.log(`[BRT] ✅ SHORT retest: entry=${price.toFixed(2)} stop=${stopLoss.toFixed(2)} (${stopDist.toFixed(1)}pt) target=${targetPrice.toFixed(2)} (${this.brtTargetPoints}pt)`);
        this._emitSignal('sell', price, stopLoss, targetPrice, 'BRT', bar, stopDist);
        return;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  SETUP 2: BOUNCE OFF UNTESTED LOWS
  // ═══════════════════════════════════════════════════════════════

  _checkBounce(bar, pstMins) {
    if (!this.prevSessionLow || this.prevSessionLowTested) return;
    if (pstMins > this.bounceMaxTimePST) return;

    const price = bar.close;
    const level = this.prevSessionLow;
    const tol = this.levelTolerance;

    // Phase 1: Detect tap of untested low (wick below but close above)
    if (!this._bounceWatching) {
      if (bar.low <= level + tol && bar.close > level) {
        // Wick touched level but didn't close below — potential bounce
        this._bounceWatching = { level, tapBar: this.sessionBarCount, confirmCount: 0 };
        console.log(`[BOUNCE] 🔍 Tap detected at prev low ${level.toFixed(2)} | bar.low=${bar.low.toFixed(2)} close=${bar.close.toFixed(2)}`);
      }
      return;
    }

    // Phase 2: Wait for confirmation (N bullish candle closures above level)
    this._bounceWatching.confirmCount++;

    if (bar.close < level - tol) {
      // Price closed below level — bounce failed
      console.log(`[BOUNCE] ❌ Failed: price closed below level ${level.toFixed(2)} at ${bar.close.toFixed(2)}`);
      this.prevSessionLowTested = true;
      this._bounceWatching = null;
      return;
    }

    if (this._bounceWatching.confirmCount >= this.bounceConfirmBars) {
      // Confirmed bounce — enter long
      if (bar.close <= bar.open) {
        // Last confirm bar is bearish — wait one more
        return;
      }

      const stopLoss = level - this.bounceStopPoints;
      const stopDist = price - stopLoss;
      const targetPrice = price + this.bounceTargetPoints;

      console.log(`[BOUNCE] ✅ LONG bounce off prev low ${level.toFixed(2)}: entry=${price.toFixed(2)} stop=${stopLoss.toFixed(2)} (${stopDist.toFixed(1)}pt) target=${targetPrice.toFixed(2)}`);
      this.prevSessionLowTested = true;
      this._bounceWatching = null;
      this._emitSignal('buy', price, stopLoss, targetPrice, 'BOUNCE', bar, stopDist);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  SETUP 3: REJECTION OFF UNTESTED HIGHS
  // ═══════════════════════════════════════════════════════════════

  _checkRejection(bar, pstMins) {
    if (!this.prevSessionHigh || this.prevSessionHighTested) return;
    if (pstMins > this.rejectionMaxTimePST) return;

    const price = bar.close;
    const level = this.prevSessionHigh;
    const tol = this.levelTolerance;

    // Phase 1: Count touches/rejections at the high
    if (!this._rejectionWatching) {
      if (bar.high >= level - tol && bar.close < level) {
        // First touch — wick hit level but closed below
        this._rejectionWatching = { level, touches: 1, firstTouchBar: this.sessionBarCount };
        console.log(`[REJECT] 🔍 Touch #1 at prev high ${level.toFixed(2)} | bar.high=${bar.high.toFixed(2)} close=${bar.close.toFixed(2)}`);
      }
      return;
    }

    // Check for additional touches
    if (bar.high >= level - tol && bar.close < level) {
      this._rejectionWatching.touches++;
      console.log(`[REJECT] 🔍 Touch #${this._rejectionWatching.touches} at prev high ${level.toFixed(2)}`);
    }

    // If price breaks above and closes above — rejection failed
    if (bar.close > level + tol) {
      console.log(`[REJECT] ❌ Failed: price broke above ${level.toFixed(2)} at ${bar.close.toFixed(2)}`);
      this.prevSessionHighTested = true;
      this._rejectionWatching = null;
      return;
    }

    // Phase 2: Enter after enough rejections + bearish confirmation
    if (this._rejectionWatching.touches >= this.rejectionMinTouches) {
      // Need a bearish bar closing well below the level
      if (bar.close < bar.open && bar.close < level - tol) {
        const stopLoss = level + this.rejectionStopPoints;
        const stopDist = stopLoss - price;
        const targetPrice = price - this.rejectionTargetPoints;

        console.log(`[REJECT] ✅ SHORT rejection at prev high ${level.toFixed(2)}: entry=${price.toFixed(2)} stop=${stopLoss.toFixed(2)} (${stopDist.toFixed(1)}pt) target=${targetPrice.toFixed(2)} (${this._rejectionWatching.touches} touches)`);
        this.prevSessionHighTested = true;
        this._rejectionWatching = null;
        this._emitSignal('sell', price, stopLoss, targetPrice, 'REJECT', bar, stopDist);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  SIGNAL EMISSION
  // ═══════════════════════════════════════════════════════════════

  _emitSignal(type, price, stopLoss, targetPrice, setupName, bar, stopDist) {
    const targetDist = Math.abs(targetPrice - price);
    const rMultiple = stopDist > 0 ? targetDist / stopDist : 0;

    this.signalFired = true;
    this._tradeCountToday++;

    this.emit('signal', {
      type,
      price,
      stopLoss,
      targetPrice,
      targetDistance: targetDist,
      stopDistance: stopDist,
      timestamp: new Date(bar.timestamp),
      strategy: setupName,
      tradeNumToday: this._tradeCountToday,
      filterResults: [
        { name: 'Setup', passed: true, reason: `${setupName} signal` },
        { name: 'Stop', passed: true, reason: `${stopDist.toFixed(1)}pt` },
        { name: 'Target', passed: true, reason: `${targetDist.toFixed(1)}pt (${rMultiple.toFixed(1)}R)` },
      ],
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  HELPERS
  // ═══════════════════════════════════════════════════════════════

  _getPSTMinutes(timestamp) {
    const d = new Date(timestamp);
    const pstStr = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
    const timePart = pstStr.split(', ')[1];
    const [hour, min] = timePart.split(':').map(Number);
    return hour * 60 + min;
  }

  getCurrentPrice() {
    if (this.currentQuote?.last) return this.currentQuote.last;
    if (this.fiveMinBars.length > 0) return this.fiveMinBars[this.fiveMinBars.length - 1].close;
    if (this.bars.length > 0) return this.bars[this.bars.length - 1].close;
    return null;
  }

  hasEnoughData() {
    return this.orEstablished && this.fiveMinBars.length >= 5;
  }

  getStatus() {
    return {
      name: this.name,
      active: this.isActive,
      barsCount1m: this.bars.length,
      barsCount5m: this.fiveMinBars.length,
      orEstablished: this.orEstablished,
      orHigh: this.orHigh,
      orLow: this.orLow,
      orMid: this.orMid,
      breakoutDir: this.brtBreakoutDir,
      prevHigh: this.prevSessionHigh,
      prevLow: this.prevSessionLow,
      tradestoday: this._tradeCountToday,
      position: this.position,
    };
  }
}

module.exports = LiquidityORBStrategy;
