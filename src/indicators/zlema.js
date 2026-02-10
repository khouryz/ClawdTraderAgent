/**
 * ZLEMA — Zero-Lag Exponential Moving Average
 * 
 * Reduces phase lag by subtracting the data from (period-1)/2 bars ago
 * from the current data before applying EMA smoothing.
 * 
 * Formula: ZLEMA = EMA(2 * close - close[lag], period)
 * where lag = floor((period - 1) / 2)
 * 
 * This gives earlier signals than standard EMA with fewer false crossovers
 * than simply using a shorter EMA period.
 */

/**
 * Calculate ZLEMA for an array of closes
 * @param {number[]} closes - Array of close prices
 * @param {number} period - EMA period
 * @returns {number|null} Current ZLEMA value, or null if insufficient data
 */
function calcZLEMA(closes, period) {
  const lag = Math.floor((period - 1) / 2);
  if (closes.length < period + lag) return null;

  // Build zero-lag adjusted series
  const adjusted = [];
  for (let i = lag; i < closes.length; i++) {
    adjusted.push(2 * closes[i] - closes[i - lag]);
  }

  // Apply standard EMA to the adjusted series
  if (adjusted.length < period) return null;
  const mult = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += adjusted[i];
  }
  ema /= period;

  for (let i = period; i < adjusted.length; i++) {
    ema = (adjusted[i] - ema) * mult + ema;
  }

  return ema;
}

/**
 * Calculate standard EMA for an array of closes
 * @param {number[]} closes - Array of close prices
 * @param {number} period - EMA period
 * @returns {number|null} Current EMA value, or null if insufficient data
 */
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const mult = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < period; i++) {
    ema += closes[i];
  }
  ema /= period;

  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * mult + ema;
  }

  return ema;
}

/**
 * Calculate ATR (Average True Range) from bars
 * @param {Array<{high: number, low: number, close: number}>} bars
 * @param {number} period - ATR period (default 14)
 * @returns {number|null}
 */
function calcATR(bars, period = 14) {
  if (bars.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;

  // Simple average for first ATR
  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trueRanges[i];
  }
  atr /= period;

  // Smoothed ATR for remaining
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return atr;
}

/**
 * Calculate RSI (Relative Strength Index)
 * @param {number[]} closes - Array of close prices
 * @param {number} period - RSI period (default 14)
 * @returns {number|null} RSI value 0-100, or null
 */
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  // Smoothed for remaining bars
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) {
      avgGain = (avgGain * (period - 1) + change) / period;
      avgLoss = (avgLoss * (period - 1)) / period;
    } else {
      avgGain = (avgGain * (period - 1)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.abs(change)) / period;
    }
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

module.exports = { calcZLEMA, calcEMA, calcATR, calcRSI };
