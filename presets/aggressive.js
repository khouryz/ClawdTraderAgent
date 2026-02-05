/**
 * Aggressive Trading Preset
 * - Higher risk per trade
 * - More relaxed filters
 * - Trailing stops for maximizing gains
 * - Higher loss limits
 */

module.exports = {
  // Risk Management - Higher risk
  RISK_PER_TRADE_MIN: 60,
  RISK_PER_TRADE_MAX: 100,
  PROFIT_TARGET_R: 2.5,
  DAILY_LOSS_LIMIT: 300,
  WEEKLY_LOSS_LIMIT: 600,
  MAX_CONSECUTIVE_LOSSES: 4,
  MAX_DRAWDOWN_PERCENT: 15,
  
  // Strategy - Fewer filters for more signals
  STRATEGY: 'enhanced_breakout',
  LOOKBACK_PERIOD: 15,
  ATR_MULTIPLIER: 1.2,
  TREND_EMA_PERIOD: 30,
  USE_TREND_FILTER: true,
  USE_VOLUME_FILTER: true,
  USE_RSI_FILTER: false,  // Disabled for more signals
  
  // Session - Extended hours
  TRADING_START_HOUR: 9,
  TRADING_START_MINUTE: 15,
  TRADING_END_HOUR: 16,
  TRADING_END_MINUTE: 15,
  AVOID_LUNCH: false,  // Trade through lunch
  
  // Order Management - Maximize gains
  TRAILING_STOP_ENABLED: true,
  TRAILING_STOP_ATR_MULTIPLIER: 1.8,
  PARTIAL_PROFIT_ENABLED: true,
  PARTIAL_PROFIT_PERCENT: 40,
  PARTIAL_PROFIT_R: 1.5
};
