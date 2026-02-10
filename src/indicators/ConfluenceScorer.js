/**
 * ConfluenceScorer — Multi-Confluence Filter System
 * 
 * Scores each trade signal based on how many independent factors align.
 * Research shows requiring 3+ confluences filters out 30%+ of bad setups
 * while dramatically improving win quality.
 * 
 * Confluence factors (each worth 1 point):
 * 1. VWAP Trend Bias — price above/below VWAP matches signal direction
 * 2. EMA Alignment — fast EMA above/below slow EMA matches direction
 * 3. Volume Confirmation — current bar volume > average volume
 * 4. Prior Day Level Support — signal near a prior day S/R level
 * 5. RSI Confirmation — RSI not overbought for longs / not oversold for shorts
 * 6. Session Momentum — price trending in signal direction over last N bars
 * 7. VWAP Band Position — price reverting from extended band (for MR)
 * 
 * Minimum score to trade: configurable (default 3)
 */

class ConfluenceScorer {
  /**
   * @param {Object} config
   * @param {number} config.minScore - Minimum confluence score to allow trade (default 3)
   * @param {number} config.volumeAvgPeriod - Bars to average volume over (default 20)
   * @param {number} config.momentumBars - Bars to check momentum direction (default 5)
   * @param {number} config.priorLevelTolerance - Points tolerance for prior day levels (default 5)
   */
  constructor(config = {}) {
    this.minScore = config.minScore || 3;
    this.volumeAvgPeriod = config.volumeAvgPeriod || 20;
    this.momentumBars = config.momentumBars || 5;
    this.priorLevelTolerance = config.priorLevelTolerance || 5;
  }

  /**
   * Score a trading signal against all confluence factors
   * 
   * @param {Object} params
   * @param {'buy'|'sell'} params.direction - Signal direction
   * @param {number} params.price - Entry price
   * @param {Object} params.vwapEngine - VWAPEngine instance
   * @param {number|null} params.emaFast - Current fast EMA value
   * @param {number|null} params.emaSlow - Current slow EMA value
   * @param {number|null} params.rsi - Current RSI value (0-100)
   * @param {Array<{close: number, volume: number}>} params.recentBars - Recent 1m bars
   * @param {string} params.strategyType - 'EMAX', 'PB', or 'VR' (affects scoring weights)
   * @returns {{ score: number, maxScore: number, passed: boolean, factors: Array<{name: string, passed: boolean, reason: string}> }}
   */
  score(params) {
    const { direction, price, vwapEngine, emaFast, emaSlow, rsi, recentBars, strategyType } = params;
    const isBuy = direction === 'buy';
    const factors = [];

    // ── Factor 1: VWAP Trend Bias ──
    if (vwapEngine && vwapEngine.isReady()) {
      const bias = vwapEngine.getTrendBias(price);
      const aligned = (isBuy && bias === 'bullish') || (!isBuy && bias === 'bearish');
      // For mean reversion (VR), we WANT price away from VWAP (inverted logic)
      const mrAligned = strategyType === 'VR' ? !aligned : aligned;
      factors.push({
        name: 'VWAP Bias',
        passed: mrAligned,
        reason: `Price ${bias} vs VWAP ${vwapEngine.vwap?.toFixed(1)}${strategyType === 'VR' ? ' (MR inverted)' : ''}`
      });
    }

    // ── Factor 2: EMA Alignment ──
    if (emaFast !== null && emaSlow !== null) {
      const aligned = isBuy ? emaFast > emaSlow : emaFast < emaSlow;
      factors.push({
        name: 'EMA Stack',
        passed: aligned,
        reason: `EMA${emaFast?.toFixed(1)} ${aligned ? '✓' : '✗'} EMA${emaSlow?.toFixed(1)}`
      });
    }

    // ── Factor 3: Volume Confirmation ──
    if (recentBars && recentBars.length >= this.volumeAvgPeriod) {
      const avgVol = recentBars.slice(-this.volumeAvgPeriod).reduce((s, b) => s + (b.volume || 0), 0) / this.volumeAvgPeriod;
      const currentVol = recentBars[recentBars.length - 1]?.volume || 0;
      const volRatio = avgVol > 0 ? currentVol / avgVol : 0;
      factors.push({
        name: 'Volume',
        passed: volRatio >= 0.8, // At least 80% of average (relaxed for MNQ)
        reason: `${volRatio.toFixed(2)}x avg (${currentVol} vs ${Math.round(avgVol)})`
      });
    }

    // ── Factor 4: Prior Day Level Support ──
    if (vwapEngine && vwapEngine.priorDayHigh !== null) {
      const nearbyLevels = vwapEngine.getNearbyPriorLevels(price, this.priorLevelTolerance);
      const hasSupport = nearbyLevels.length > 0;
      factors.push({
        name: 'PD Level',
        passed: hasSupport,
        reason: hasSupport
          ? `Near ${nearbyLevels[0].level} (${nearbyLevels[0].distance.toFixed(1)}pt away)`
          : 'No nearby prior day levels'
      });
    }

    // ── Factor 5: RSI Confirmation ──
    if (rsi !== null && rsi !== undefined) {
      // For buys: RSI should not be overbought (< 75)
      // For sells: RSI should not be oversold (> 25)
      // For mean reversion: inverted — we WANT extreme RSI
      let passed;
      let reason;
      if (strategyType === 'VR') {
        // Mean reversion wants extreme RSI
        passed = isBuy ? rsi < 35 : rsi > 65;
        reason = `RSI ${rsi.toFixed(0)} (MR wants extreme)`;
      } else {
        passed = isBuy ? rsi < 75 : rsi > 25;
        reason = `RSI ${rsi.toFixed(0)} ${passed ? 'OK' : 'extreme'}`;
      }
      factors.push({ name: 'RSI', passed, reason });
    }

    // ── Factor 6: Session Momentum ──
    if (recentBars && recentBars.length >= this.momentumBars + 1) {
      const recent = recentBars.slice(-this.momentumBars);
      const oldest = recent[0].close;
      const newest = recent[recent.length - 1].close;
      const momentum = newest - oldest;
      // For momentum strategies: momentum should match direction
      // For mean reversion: momentum should be AGAINST direction (overextended)
      let aligned;
      if (strategyType === 'VR') {
        aligned = isBuy ? momentum < 0 : momentum > 0; // Price was falling, we buy the reversion
      } else {
        aligned = isBuy ? momentum > 0 : momentum < 0;
      }
      factors.push({
        name: 'Momentum',
        passed: aligned,
        reason: `${momentum > 0 ? '+' : ''}${momentum.toFixed(1)}pt over ${this.momentumBars} bars${strategyType === 'VR' ? ' (MR inverted)' : ''}`
      });
    }

    // ── Factor 7: VWAP Band Position (primarily for VR) ──
    if (vwapEngine && vwapEngine.isReady() && strategyType === 'VR') {
      const sigmaDistance = vwapEngine.getVWAPDistance(price);
      // For mean reversion: price should be reverting FROM 1.5σ+ zone
      const extended = Math.abs(sigmaDistance) >= 1.0;
      factors.push({
        name: 'VWAP Band',
        passed: extended,
        reason: `${sigmaDistance.toFixed(2)}σ from VWAP (need ≥1.0σ)`
      });
    }

    // Calculate total score
    const score = factors.filter(f => f.passed).length;
    const maxScore = factors.length;
    const passed = score >= this.minScore;

    return { score, maxScore, passed, factors };
  }
}

module.exports = ConfluenceScorer;
