/**
 * Technical Indicators Module
 * Centralized indicator calculations to avoid duplication
 * 
 * All indicators accept an array of bars/prices and return calculated values
 */

/**
 * Calculate Simple Moving Average (SMA)
 * @param {Array<number>|Array<{close: number}>} data - Array of prices or bars
 * @param {number} period - SMA period
 * @returns {number|null} SMA value or null if insufficient data
 */
function SMA(data, period) {
  if (!data || data.length < period) return null;
  
  const prices = data.slice(-period).map(d => typeof d === 'number' ? d : d.close);
  return prices.reduce((sum, p) => sum + p, 0) / period;
}

/**
 * Calculate Exponential Moving Average (EMA)
 * @param {Array<number>|Array<{close: number}>} data - Array of prices or bars
 * @param {number} period - EMA period
 * @returns {number|null} EMA value or null if insufficient data
 */
function EMA(data, period) {
  if (!data || data.length < period) return null;
  
  const prices = data.map(d => typeof d === 'number' ? d : d.close);
  const multiplier = 2 / (period + 1);
  
  // Start with SMA for first EMA value
  let ema = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;
  
  // Calculate EMA for remaining values
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

/**
 * Calculate Average True Range (ATR)
 * @param {Array<{high: number, low: number, close: number}>} bars - Array of OHLC bars
 * @param {number} period - ATR period (default 14)
 * @returns {number|null} ATR value or null if insufficient data
 */
function ATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  
  const trueRanges = [];
  
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevClose = bars[i - 1].close;
    
    const tr = Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    );
    trueRanges.push(tr);
  }
  
  // Use simple average of last N true ranges
  const recentTR = trueRanges.slice(-period);
  return recentTR.reduce((sum, tr) => sum + tr, 0) / recentTR.length;
}

/**
 * Calculate Relative Strength Index (RSI)
 * @param {Array<number>|Array<{close: number}>} data - Array of prices or bars
 * @param {number} period - RSI period (default 14)
 * @returns {number|null} RSI value (0-100) or null if insufficient data
 */
function RSI(data, period = 14) {
  if (!data || data.length < period + 1) return null;
  
  const prices = data.map(d => typeof d === 'number' ? d : d.close);
  const changes = [];
  
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }
  
  const recentChanges = changes.slice(-period);
  
  let gains = 0;
  let losses = 0;
  
  for (const change of recentChanges) {
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  
  if (avgLoss === 0) return 100;
  
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

/**
 * Calculate Bollinger Bands
 * @param {Array<number>|Array<{close: number}>} data - Array of prices or bars
 * @param {number} period - Period for SMA (default 20)
 * @param {number} stdDev - Standard deviation multiplier (default 2)
 * @returns {{upper: number, middle: number, lower: number, bandwidth: number}|null}
 */
function BollingerBands(data, period = 20, stdDev = 2) {
  if (!data || data.length < period) return null;
  
  const prices = data.slice(-period).map(d => typeof d === 'number' ? d : d.close);
  const middle = prices.reduce((sum, p) => sum + p, 0) / period;
  
  // Calculate standard deviation
  const squaredDiffs = prices.map(p => Math.pow(p - middle, 2));
  const variance = squaredDiffs.reduce((sum, d) => sum + d, 0) / period;
  const sd = Math.sqrt(variance);
  
  const upper = middle + (sd * stdDev);
  const lower = middle - (sd * stdDev);
  const bandwidth = ((upper - lower) / middle) * 100;
  
  return { upper, middle, lower, bandwidth };
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 * @param {Array<number>|Array<{close: number}>} data - Array of prices or bars
 * @param {number} fastPeriod - Fast EMA period (default 12)
 * @param {number} slowPeriod - Slow EMA period (default 26)
 * @param {number} signalPeriod - Signal line period (default 9)
 * @returns {{macd: number, signal: number, histogram: number}|null}
 */
function MACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (!data || data.length < slowPeriod + signalPeriod) return null;
  
  const prices = data.map(d => typeof d === 'number' ? d : d.close);
  
  // Calculate MACD line values for signal calculation
  const macdValues = [];
  for (let i = slowPeriod; i <= prices.length; i++) {
    const slice = prices.slice(0, i);
    const fastEMA = EMA(slice, fastPeriod);
    const slowEMA = EMA(slice, slowPeriod);
    if (fastEMA !== null && slowEMA !== null) {
      macdValues.push(fastEMA - slowEMA);
    }
  }
  
  if (macdValues.length < signalPeriod) return null;
  
  const macd = macdValues[macdValues.length - 1];
  const signal = EMA(macdValues, signalPeriod);
  const histogram = macd - signal;
  
  return { macd, signal, histogram };
}

/**
 * Calculate Average Volume
 * @param {Array<{volume: number}>} bars - Array of bars with volume
 * @param {number} period - Period for average (default 20)
 * @returns {number|null} Average volume or null if insufficient data
 */
function AvgVolume(bars, period = 20) {
  if (!bars || bars.length < period) return null;
  
  const volumes = bars.slice(-period).map(b => b.volume || 0);
  return volumes.reduce((sum, v) => sum + v, 0) / period;
}

/**
 * Find highest high over a period
 * @param {Array<{high: number}>} bars - Array of bars
 * @param {number} period - Lookback period
 * @returns {number|null} Highest high or null if insufficient data
 */
function HighestHigh(bars, period) {
  if (!bars || bars.length < period) return null;
  
  const highs = bars.slice(-period).map(b => b.high);
  return Math.max(...highs);
}

/**
 * Find lowest low over a period
 * @param {Array<{low: number}>} bars - Array of bars
 * @param {number} period - Lookback period
 * @returns {number|null} Lowest low or null if insufficient data
 */
function LowestLow(bars, period) {
  if (!bars || bars.length < period) return null;
  
  const lows = bars.slice(-period).map(b => b.low);
  return Math.min(...lows);
}

/**
 * Calculate Stochastic Oscillator
 * @param {Array<{high: number, low: number, close: number}>} bars - Array of OHLC bars
 * @param {number} kPeriod - %K period (default 14)
 * @param {number} dPeriod - %D smoothing period (default 3)
 * @returns {{k: number, d: number}|null}
 */
function Stochastic(bars, kPeriod = 14, dPeriod = 3) {
  if (!bars || bars.length < kPeriod + dPeriod) return null;
  
  const kValues = [];
  
  for (let i = kPeriod - 1; i < bars.length; i++) {
    const slice = bars.slice(i - kPeriod + 1, i + 1);
    const highestHigh = Math.max(...slice.map(b => b.high));
    const lowestLow = Math.min(...slice.map(b => b.low));
    const close = bars[i].close;
    
    const k = ((close - lowestLow) / (highestHigh - lowestLow)) * 100;
    kValues.push(k);
  }
  
  if (kValues.length < dPeriod) return null;
  
  const k = kValues[kValues.length - 1];
  const d = kValues.slice(-dPeriod).reduce((sum, v) => sum + v, 0) / dPeriod;
  
  return { k, d };
}

/**
 * Calculate ADX (Average Directional Index)
 * @param {Array<{high: number, low: number, close: number}>} bars - Array of OHLC bars
 * @param {number} period - ADX period (default 14)
 * @returns {{adx: number, plusDI: number, minusDI: number}|null}
 */
function ADX(bars, period = 14) {
  if (!bars || bars.length < period * 2) return null;
  
  const plusDM = [];
  const minusDM = [];
  const tr = [];
  
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].high;
    const low = bars[i].low;
    const prevHigh = bars[i - 1].high;
    const prevLow = bars[i - 1].low;
    const prevClose = bars[i - 1].close;
    
    // True Range
    tr.push(Math.max(
      high - low,
      Math.abs(high - prevClose),
      Math.abs(low - prevClose)
    ));
    
    // Directional Movement
    const upMove = high - prevHigh;
    const downMove = prevLow - low;
    
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  
  if (tr.length < period) return null;
  
  // Smoothed values
  const smoothedTR = tr.slice(-period).reduce((a, b) => a + b, 0);
  const smoothedPlusDM = plusDM.slice(-period).reduce((a, b) => a + b, 0);
  const smoothedMinusDM = minusDM.slice(-period).reduce((a, b) => a + b, 0);
  
  const plusDI = (smoothedPlusDM / smoothedTR) * 100;
  const minusDI = (smoothedMinusDM / smoothedTR) * 100;
  
  const dx = (Math.abs(plusDI - minusDI) / (plusDI + minusDI)) * 100;
  
  // For simplicity, return current DX as ADX (proper ADX would need smoothing)
  return { adx: dx, plusDI, minusDI };
}

/**
 * Detect trend direction
 * @param {Array<{close: number}>} bars - Array of bars
 * @param {number} emaPeriod - EMA period for trend detection
 * @returns {'bullish'|'bearish'|'neutral'} Trend direction
 */
function detectTrend(bars, emaPeriod = 50) {
  if (!bars || bars.length < emaPeriod) return 'neutral';
  
  const ema = EMA(bars, emaPeriod);
  const currentPrice = bars[bars.length - 1].close;
  
  if (!ema) return 'neutral';
  
  const percentDiff = ((currentPrice - ema) / ema) * 100;
  
  if (percentDiff > 0.1) return 'bullish';
  if (percentDiff < -0.1) return 'bearish';
  return 'neutral';
}

module.exports = {
  SMA,
  EMA,
  ATR,
  RSI,
  BollingerBands,
  MACD,
  AvgVolume,
  HighestHigh,
  LowestLow,
  Stochastic,
  ADX,
  detectTrend
};
