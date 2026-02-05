/**
 * Balanced Trading Preset
 * - Fixed $45 risk per trade
 * - 2R profit target with trailing stop to let winners run
 * - All filters enabled for quality signals
 * - Partial profit taking at 2R, let rest run
 */

module.exports = {
  // Risk Management - Fixed $45 risk
  RISK_PER_TRADE_MIN: 45,
  RISK_PER_TRADE_MAX: 45,
  PROFIT_TARGET_R: 2,
  DAILY_LOSS_LIMIT: 150,
  WEEKLY_LOSS_LIMIT: 300,
  MAX_CONSECUTIVE_LOSSES: 3,
  MAX_DRAWDOWN_PERCENT: 10,
  
  // Strategy - All filters for quality
  STRATEGY: 'enhanced_breakout',
  LOOKBACK_PERIOD: 20,
  ATR_MULTIPLIER: 1.5,
  TREND_EMA_PERIOD: 50,
  USE_TREND_FILTER: true,
  USE_VOLUME_FILTER: true,
  USE_RSI_FILTER: true,
  
  // Session - Standard hours
  TRADING_START_HOUR: 9,
  TRADING_START_MINUTE: 30,
  TRADING_END_HOUR: 16,
  TRADING_END_MINUTE: 0,
  AVOID_LUNCH: true,
  
  // Order Management - Let profits run!
  TRAILING_STOP_ENABLED: true,
  TRAILING_STOP_ATR_MULTIPLIER: 2.0,
  PARTIAL_PROFIT_ENABLED: true,
  PARTIAL_PROFIT_PERCENT: 50,  // Take 50% at 2R
  PARTIAL_PROFIT_R: 2          // First target at 2R, let rest run
};
