/**
 * Conservative Trading Preset
 * - Lower risk per trade
 * - All filters enabled
 * - No trailing stops (simpler management)
 * - Tight loss limits
 */

module.exports = {
  // Risk Management
  RISK_PER_TRADE_MIN: 25,
  RISK_PER_TRADE_MAX: 35,
  PROFIT_TARGET_R: 2,
  DAILY_LOSS_LIMIT: 100,
  WEEKLY_LOSS_LIMIT: 200,
  MAX_CONSECUTIVE_LOSSES: 2,
  MAX_DRAWDOWN_PERCENT: 8,
  
  // Strategy - All filters on for quality signals
  STRATEGY: 'enhanced_breakout',
  LOOKBACK_PERIOD: 20,
  ATR_MULTIPLIER: 1.5,
  TREND_EMA_PERIOD: 50,
  USE_TREND_FILTER: true,
  USE_VOLUME_FILTER: true,
  USE_RSI_FILTER: true,
  
  // Session - Standard hours only
  TRADING_START_HOUR: 9,
  TRADING_START_MINUTE: 30,
  TRADING_END_HOUR: 16,
  TRADING_END_MINUTE: 0,
  AVOID_LUNCH: true,
  
  // Order Management - Simple exits
  TRAILING_STOP_ENABLED: false,
  PARTIAL_PROFIT_ENABLED: false
};
