/**
 * Trading Bot Constants
 * Centralized constants to eliminate magic numbers
 */

module.exports = {
  // Trading Constants
  TRADING: {
    MIN_CONTRACTS: 1,
    DEFAULT_PROFIT_TARGET_R: 2,
    
    // Default risk settings
    DEFAULT_RISK_MIN: 30,
    DEFAULT_RISK_MAX: 60,
    DEFAULT_DAILY_LOSS_LIMIT: 150,
    DEFAULT_WEEKLY_LOSS_LIMIT: 300,
    DEFAULT_MAX_CONSECUTIVE_LOSSES: 3,
    DEFAULT_MAX_DRAWDOWN_PERCENT: 10
  },

  // API Constants
  API: {
    RATE_LIMIT_PER_SECOND: 10,
    RATE_LIMIT_PER_MINUTE: 200,
    BURST_LIMIT: 20,
    DEFAULT_TIMEOUT: 30000,
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY_MS: 1000,
    RETRY_BACKOFF_MULTIPLIER: 2
  },

  // WebSocket Constants
  WEBSOCKET: {
    MAX_RECONNECT_ATTEMPTS: 10,
    INITIAL_RECONNECT_DELAY: 1000,
    MAX_RECONNECT_DELAY: 60000,
    RECONNECT_BACKOFF_MULTIPLIER: 2,
    CONNECTION_TIMEOUT: 15000,
    HEARTBEAT_INTERVAL: 2500
  },

  // Session Constants
  SESSION: {
    DEFAULT_START_HOUR: 9,
    DEFAULT_START_MINUTE: 30,
    DEFAULT_END_HOUR: 16,
    DEFAULT_END_MINUTE: 0,
    LUNCH_START_HOUR: 12,
    LUNCH_END_HOUR: 14,
    TRADING_DAYS: [1, 2, 3, 4, 5]
  },

  // Strategy Constants
  STRATEGY: {
    DEFAULT_LOOKBACK: 20,
    DEFAULT_ATR_PERIOD: 14,
    DEFAULT_ATR_MULTIPLIER: 1.5,
    DEFAULT_EMA_PERIOD: 50,
    RSI_OVERBOUGHT: 70,
    RSI_OVERSOLD: 30
  },

  // File Paths
  FILES: {
    DATA_DIR: './data',
    LOGS_DIR: './logs',
    TRADES_FILE: 'trades.json',
    DAILY_STATS_FILE: 'daily_stats.json',
    LOSS_LIMITS_STATE: 'loss_limits_state.json'
  },

  // Contract Specifications
  CONTRACTS: {
    MES: {
      name: 'Micro E-mini S&P 500',
      tickSize: 0.25,
      tickValue: 1.25,
      pointValue: 5,
      currency: 'USD'
    },
    MNQ: {
      name: 'Micro E-mini Nasdaq-100',
      tickSize: 0.25,
      tickValue: 0.50,
      pointValue: 2,
      currency: 'USD'
    },
    MYM: {
      name: 'Micro Dow Jones',
      tickSize: 1.0,
      tickValue: 0.50,
      pointValue: 0.5,
      currency: 'USD'
    }
  },

  // Error Codes
  ERROR_CODES: {
    INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
    MARKET_CLOSED: 'MARKET_CLOSED',
    INVALID_CONTRACT: 'INVALID_CONTRACT',
    RATE_LIMITED: 'RATE_LIMITED',
    AUTH_FAILED: 'AUTH_FAILED',
    INVALID_ORDER: 'INVALID_ORDER',
    RISK_LIMIT_EXCEEDED: 'RISK_LIMIT_EXCEEDED',
    CONNECTION_FAILED: 'CONNECTION_FAILED'
  }
};
