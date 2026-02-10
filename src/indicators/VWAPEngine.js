/**
 * VWAPEngine — Session VWAP + Standard Deviation Bands + Prior Day Levels + Volume Profile
 * 
 * Computes from 1-min OHLCV bars:
 * - Session VWAP (resets daily at session start)
 * - VWAP standard deviation bands (±1σ, ±2σ, ±3σ)
 * - Prior day levels: HOD, LOD, Close, VWAP close
 * - Volume Profile: VAH, VAL, POC (Point of Control)
 * 
 * All values update on every 1-min bar. The strategy reads these
 * as confluence filters and mean-reversion targets.
 */

class VWAPEngine {
  constructor() {
    // ── Current Session VWAP State ──
    this._cumulativeTPV = 0;    // Σ(typical_price × volume)
    this._cumulativeVol = 0;    // Σ(volume)
    this._cumulativeTPV2 = 0;   // Σ(typical_price² × volume) for variance
    this._barCount = 0;

    // ── Current Session Values (read by strategy) ──
    this.vwap = null;
    this.upperBand1 = null;     // +1σ
    this.lowerBand1 = null;     // -1σ
    this.upperBand2 = null;     // +2σ
    this.lowerBand2 = null;     // -2σ
    this.upperBand3 = null;     // +3σ
    this.lowerBand3 = null;     // -3σ
    this.stdDev = 0;

    // ── Session Tracking ──
    this.sessionHigh = null;
    this.sessionLow = null;
    this.sessionOpen = null;
    this.sessionClose = null;
    this.sessionBars = [];       // All 1m bars for current session (for volume profile)

    // ── Prior Day Levels (set at daily reset from previous session) ──
    this.priorDayHigh = null;
    this.priorDayLow = null;
    this.priorDayClose = null;
    this.priorDayVWAP = null;
    this.priorDayVAH = null;    // Value Area High (70% of volume)
    this.priorDayVAL = null;    // Value Area Low
    this.priorDayPOC = null;    // Point of Control (price with most volume)

    // ── Volume Profile Bins ──
    this._volumeProfile = {};   // { priceLevel: totalVolume }
    this._profileBinSize = 1.0; // 1-point bins for MNQ

    this._initialized = false;
  }

  /**
   * Reset for new trading day.
   * Saves current session data as "prior day" before clearing.
   */
  resetDay() {
    // Save current session as prior day (only if we had data)
    if (this.sessionHigh !== null && this._barCount > 10) {
      this.priorDayHigh = this.sessionHigh;
      this.priorDayLow = this.sessionLow;
      this.priorDayClose = this.sessionClose;
      this.priorDayVWAP = this.vwap;

      // Compute volume profile for prior day
      const profile = this._computeValueArea();
      this.priorDayVAH = profile.vah;
      this.priorDayVAL = profile.val;
      this.priorDayPOC = profile.poc;
    }

    // Clear current session
    this._cumulativeTPV = 0;
    this._cumulativeVol = 0;
    this._cumulativeTPV2 = 0;
    this._barCount = 0;
    this.vwap = null;
    this.upperBand1 = null;
    this.lowerBand1 = null;
    this.upperBand2 = null;
    this.lowerBand2 = null;
    this.upperBand3 = null;
    this.lowerBand3 = null;
    this.stdDev = 0;
    this.sessionHigh = null;
    this.sessionLow = null;
    this.sessionOpen = null;
    this.sessionClose = null;
    this.sessionBars = [];
    this._volumeProfile = {};
    this._initialized = false;
  }

  /**
   * Process a 1-minute bar. Call this for every session bar.
   * @param {Object} bar - { open, high, low, close, volume, timestamp }
   */
  onBar(bar) {
    const tp = (bar.high + bar.low + bar.close) / 3; // Typical price
    const vol = bar.volume || 1; // Avoid division by zero

    // Accumulate VWAP components
    this._cumulativeTPV += tp * vol;
    this._cumulativeVol += vol;
    this._cumulativeTPV2 += tp * tp * vol;
    this._barCount++;

    // Compute VWAP
    this.vwap = this._cumulativeTPV / this._cumulativeVol;

    // Compute standard deviation of typical prices around VWAP
    // Variance = Σ(tp² × vol) / Σ(vol) - VWAP²
    const variance = (this._cumulativeTPV2 / this._cumulativeVol) - (this.vwap * this.vwap);
    this.stdDev = variance > 0 ? Math.sqrt(variance) : 0;

    // Compute bands
    this.upperBand1 = this.vwap + this.stdDev;
    this.lowerBand1 = this.vwap - this.stdDev;
    this.upperBand2 = this.vwap + 2 * this.stdDev;
    this.lowerBand2 = this.vwap - 2 * this.stdDev;
    this.upperBand3 = this.vwap + 3 * this.stdDev;
    this.lowerBand3 = this.vwap - 3 * this.stdDev;

    // Track session OHLC
    if (this.sessionOpen === null) this.sessionOpen = bar.open;
    if (this.sessionHigh === null || bar.high > this.sessionHigh) this.sessionHigh = bar.high;
    if (this.sessionLow === null || bar.low < this.sessionLow) this.sessionLow = bar.low;
    this.sessionClose = bar.close;

    // Store bar for volume profile
    this.sessionBars.push({ high: bar.high, low: bar.low, close: bar.close, volume: vol });

    // Update volume profile bins
    this._updateVolumeProfile(bar.high, bar.low, vol);

    this._initialized = true;
  }

  /**
   * Distribute volume across price bins between bar low and high
   * @private
   */
  _updateVolumeProfile(high, low, volume) {
    const binLow = Math.floor(low / this._profileBinSize) * this._profileBinSize;
    const binHigh = Math.ceil(high / this._profileBinSize) * this._profileBinSize;
    const numBins = Math.max(1, Math.round((binHigh - binLow) / this._profileBinSize));
    const volPerBin = volume / numBins;

    for (let price = binLow; price <= binHigh; price += this._profileBinSize) {
      const key = price.toFixed(1);
      this._volumeProfile[key] = (this._volumeProfile[key] || 0) + volPerBin;
    }
  }

  /**
   * Compute Value Area (70% of volume) and POC from volume profile
   * @returns {{ vah: number, val: number, poc: number }}
   * @private
   */
  _computeValueArea() {
    const entries = Object.entries(this._volumeProfile)
      .map(([price, vol]) => ({ price: parseFloat(price), vol }))
      .sort((a, b) => b.vol - a.vol); // Sort by volume descending

    if (entries.length === 0) return { vah: null, val: null, poc: null };

    // POC = price level with highest volume
    const poc = entries[0].price;

    // Value Area = 70% of total volume, expanding from POC
    const totalVol = entries.reduce((sum, e) => sum + e.vol, 0);
    const targetVol = totalVol * 0.70;

    // Sort by price for expansion
    const byPrice = entries.sort((a, b) => a.price - b.price);
    const pocIdx = byPrice.findIndex(e => e.price === poc);

    let vaVol = byPrice[pocIdx].vol;
    let lo = pocIdx;
    let hi = pocIdx;

    while (vaVol < targetVol && (lo > 0 || hi < byPrice.length - 1)) {
      const expandUp = hi < byPrice.length - 1 ? byPrice[hi + 1].vol : -1;
      const expandDown = lo > 0 ? byPrice[lo - 1].vol : -1;

      if (expandUp >= expandDown && expandUp >= 0) {
        hi++;
        vaVol += byPrice[hi].vol;
      } else if (expandDown >= 0) {
        lo--;
        vaVol += byPrice[lo].vol;
      } else {
        break;
      }
    }

    return {
      vah: byPrice[hi].price,
      val: byPrice[lo].price,
      poc
    };
  }

  /**
   * Get distance from price to VWAP in standard deviations
   * @param {number} price
   * @returns {number} Signed σ distance (positive = above VWAP)
   */
  getVWAPDistance(price) {
    if (!this.vwap || this.stdDev === 0) return 0;
    return (price - this.vwap) / this.stdDev;
  }

  /**
   * Check if price is at or beyond a VWAP band
   * @param {number} price
   * @param {number} bandLevel - 1, 2, or 3 (σ level)
   * @returns {'above'|'below'|'within'}
   */
  getBandPosition(price, bandLevel = 2) {
    if (!this.vwap) return 'within';
    const upper = this.vwap + bandLevel * this.stdDev;
    const lower = this.vwap - bandLevel * this.stdDev;
    if (price >= upper) return 'above';
    if (price <= lower) return 'below';
    return 'within';
  }

  /**
   * Check if price is near a prior day level (within tolerance)
   * @param {number} price
   * @param {number} tolerance - Points tolerance (default 3 for MNQ)
   * @returns {Array<{level: string, price: number, distance: number}>}
   */
  getNearbyPriorLevels(price, tolerance = 3) {
    const levels = [];
    const checks = [
      { name: 'PD_HIGH', value: this.priorDayHigh },
      { name: 'PD_LOW', value: this.priorDayLow },
      { name: 'PD_CLOSE', value: this.priorDayClose },
      { name: 'PD_VWAP', value: this.priorDayVWAP },
      { name: 'PD_VAH', value: this.priorDayVAH },
      { name: 'PD_VAL', value: this.priorDayVAL },
      { name: 'PD_POC', value: this.priorDayPOC },
    ];

    for (const check of checks) {
      if (check.value !== null) {
        const dist = Math.abs(price - check.value);
        if (dist <= tolerance) {
          levels.push({ level: check.name, price: check.value, distance: dist });
        }
      }
    }

    return levels.sort((a, b) => a.distance - b.distance);
  }

  /**
   * Get price position relative to VWAP (for trend bias)
   * @param {number} price
   * @returns {'bullish'|'bearish'|'neutral'}
   */
  getTrendBias(price) {
    if (!this.vwap) return 'neutral';
    if (price > this.vwap + 2) return 'bullish';   // 2pt buffer for MNQ noise
    if (price < this.vwap - 2) return 'bearish';
    return 'neutral';
  }

  /**
   * Check if VWAP engine has enough data
   * @returns {boolean}
   */
  isReady() {
    return this._initialized && this._barCount >= 5 && this.stdDev > 0;
  }

  /**
   * Get full state snapshot for logging/signals
   */
  getState() {
    return {
      vwap: this.vwap ? +this.vwap.toFixed(2) : null,
      stdDev: +this.stdDev.toFixed(2),
      upperBand1: this.upperBand1 ? +this.upperBand1.toFixed(2) : null,
      lowerBand1: this.lowerBand1 ? +this.lowerBand1.toFixed(2) : null,
      upperBand2: this.upperBand2 ? +this.upperBand2.toFixed(2) : null,
      lowerBand2: this.lowerBand2 ? +this.lowerBand2.toFixed(2) : null,
      sessionHigh: this.sessionHigh,
      sessionLow: this.sessionLow,
      barCount: this._barCount,
      priorDayHigh: this.priorDayHigh,
      priorDayLow: this.priorDayLow,
      priorDayClose: this.priorDayClose,
      priorDayVWAP: this.priorDayVWAP ? +this.priorDayVWAP.toFixed(2) : null,
      priorDayPOC: this.priorDayPOC,
      priorDayVAH: this.priorDayVAH,
      priorDayVAL: this.priorDayVAL,
    };
  }
}

module.exports = VWAPEngine;
