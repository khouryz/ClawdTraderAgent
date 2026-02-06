/**
 * Custom Error Classes for Tradovate Trading Bot
 * 
 * Provides standardized error handling with:
 * - Error codes for programmatic handling
 * - Recovery suggestions
 * - Logging integration
 */

/**
 * Base error class for all trading bot errors
 */
class TradingBotError extends Error {
  /**
   * @param {string} message - Error message
   * @param {string} code - Error code
   * @param {Object} [details] - Additional error details
   */
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'TradingBotError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
    
    // Capture stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Convert to JSON for logging/serialization
   */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      timestamp: this.timestamp,
      stack: this.stack
    };
  }
}

/**
 * Authentication errors
 */
class AuthenticationError extends TradingBotError {
  constructor(message, details = {}) {
    super(message, 'AUTH_ERROR', details);
    this.name = 'AuthenticationError';
    this.recoverable = true;
    this.recovery = 'Check credentials and retry authentication';
  }
}

/**
 * API errors (rate limits, server errors, etc.)
 */
class APIError extends TradingBotError {
  /**
   * @param {string} message - Error message
   * @param {number} statusCode - HTTP status code
   * @param {Object} [details] - Additional details
   */
  constructor(message, statusCode, details = {}) {
    super(message, 'API_ERROR', { statusCode, ...details });
    this.name = 'APIError';
    this.statusCode = statusCode;
    this.recoverable = [429, 500, 502, 503, 504].includes(statusCode);
    this.recovery = this._getRecovery(statusCode);
  }

  _getRecovery(statusCode) {
    switch (statusCode) {
      case 401: return 'Re-authenticate with valid credentials';
      case 403: return 'Check API permissions and subscription';
      case 404: return 'Verify endpoint and resource exists';
      case 429: return 'Wait and retry with exponential backoff';
      case 500:
      case 502:
      case 503:
      case 504: return 'Server error - retry after delay';
      default: return 'Check API documentation';
    }
  }
}

/**
 * WebSocket connection errors
 */
class WebSocketError extends TradingBotError {
  constructor(message, details = {}) {
    super(message, 'WEBSOCKET_ERROR', details);
    this.name = 'WebSocketError';
    this.recoverable = true;
    this.recovery = 'Reconnect with exponential backoff';
  }
}

/**
 * Order execution errors
 */
class OrderError extends TradingBotError {
  /**
   * @param {string} message - Error message
   * @param {string} orderErrorCode - Specific order error code
   * @param {Object} [details] - Order details
   */
  constructor(message, orderErrorCode, details = {}) {
    super(message, 'ORDER_ERROR', { orderErrorCode, ...details });
    this.name = 'OrderError';
    this.orderErrorCode = orderErrorCode;
    this.recoverable = this._isRecoverable(orderErrorCode);
    this.recovery = this._getRecovery(orderErrorCode);
  }

  _isRecoverable(code) {
    const nonRecoverable = ['INSUFFICIENT_MARGIN', 'INVALID_CONTRACT', 'MARKET_CLOSED'];
    return !nonRecoverable.includes(code);
  }

  _getRecovery(code) {
    switch (code) {
      case 'INSUFFICIENT_MARGIN': return 'Reduce position size or add funds';
      case 'INVALID_CONTRACT': return 'Verify contract symbol and expiration';
      case 'MARKET_CLOSED': return 'Wait for market to open';
      case 'REJECTED': return 'Check order parameters and retry';
      case 'TIMEOUT': return 'Retry order placement';
      default: return 'Review order parameters';
    }
  }
}

/**
 * Risk management errors
 */
class RiskError extends TradingBotError {
  /**
   * @param {string} message - Error message
   * @param {string} riskType - Type of risk violation
   * @param {Object} [details] - Risk details
   */
  constructor(message, riskType, details = {}) {
    super(message, 'RISK_ERROR', { riskType, ...details });
    this.name = 'RiskError';
    this.riskType = riskType;
    this.recoverable = false;
    this.recovery = this._getRecovery(riskType);
    this.shouldHalt = this._shouldHalt(riskType);
  }

  _shouldHalt(riskType) {
    const haltTypes = ['DAILY_LOSS_LIMIT', 'WEEKLY_LOSS_LIMIT', 'MAX_DRAWDOWN', 'CONSECUTIVE_LOSSES'];
    return haltTypes.includes(riskType);
  }

  _getRecovery(riskType) {
    switch (riskType) {
      case 'DAILY_LOSS_LIMIT': return 'Trading halted - daily loss limit reached';
      case 'WEEKLY_LOSS_LIMIT': return 'Trading halted - weekly loss limit reached';
      case 'MAX_DRAWDOWN': return 'Trading halted - max drawdown reached';
      case 'CONSECUTIVE_LOSSES': return 'Trading halted - consecutive loss limit reached';
      case 'POSITION_SIZE': return 'Reduce position size';
      case 'INSUFFICIENT_BALANCE': return 'Add funds or reduce risk';
      default: return 'Review risk parameters';
    }
  }
}

/**
 * Configuration errors
 */
class ConfigError extends TradingBotError {
  constructor(message, details = {}) {
    super(message, 'CONFIG_ERROR', details);
    this.name = 'ConfigError';
    this.recoverable = false;
    this.recovery = 'Fix configuration in .env file';
  }
}

/**
 * Strategy errors
 */
class StrategyError extends TradingBotError {
  constructor(message, details = {}) {
    super(message, 'STRATEGY_ERROR', details);
    this.name = 'StrategyError';
    this.recoverable = true;
    this.recovery = 'Check strategy parameters and data';
  }
}

/**
 * Data errors (missing data, invalid format, etc.)
 */
class DataError extends TradingBotError {
  constructor(message, details = {}) {
    super(message, 'DATA_ERROR', details);
    this.name = 'DataError';
    this.recoverable = true;
    this.recovery = 'Wait for valid data or check data source';
  }
}

/**
 * Error codes enum
 */
const ErrorCodes = {
  // Authentication
  AUTH_FAILED: 'AUTH_FAILED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  
  // API
  API_ERROR: 'API_ERROR',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_ERROR: 'SERVER_ERROR',
  
  // WebSocket
  WS_CONNECTION_FAILED: 'WS_CONNECTION_FAILED',
  WS_AUTH_FAILED: 'WS_AUTH_FAILED',
  WS_DISCONNECTED: 'WS_DISCONNECTED',
  
  // Orders
  ORDER_REJECTED: 'ORDER_REJECTED',
  ORDER_TIMEOUT: 'ORDER_TIMEOUT',
  INSUFFICIENT_MARGIN: 'INSUFFICIENT_MARGIN',
  INVALID_ORDER: 'INVALID_ORDER',
  
  // Risk
  DAILY_LOSS_LIMIT: 'DAILY_LOSS_LIMIT',
  WEEKLY_LOSS_LIMIT: 'WEEKLY_LOSS_LIMIT',
  MAX_DRAWDOWN: 'MAX_DRAWDOWN',
  CONSECUTIVE_LOSSES: 'CONSECUTIVE_LOSSES',
  POSITION_SIZE_EXCEEDED: 'POSITION_SIZE_EXCEEDED',
  
  // Config
  INVALID_CONFIG: 'INVALID_CONFIG',
  MISSING_CONFIG: 'MISSING_CONFIG',
  
  // Strategy
  INSUFFICIENT_DATA: 'INSUFFICIENT_DATA',
  INVALID_SIGNAL: 'INVALID_SIGNAL',
  
  // General
  UNKNOWN_ERROR: 'UNKNOWN_ERROR'
};

/**
 * Create appropriate error from API response
 * @param {Object} response - API error response
 * @returns {TradingBotError}
 */
function createFromAPIResponse(response) {
  const statusCode = response.status || response.statusCode;
  const message = response.data?.message || response.message || 'API request failed';
  
  if (statusCode === 401 || statusCode === 403) {
    return new AuthenticationError(message, { statusCode });
  }
  
  return new APIError(message, statusCode, response.data);
}

/**
 * Wrap unknown errors in TradingBotError
 * @param {Error} error - Original error
 * @param {string} context - Error context
 * @returns {TradingBotError}
 */
function wrapError(error, context = '') {
  if (error instanceof TradingBotError) {
    return error;
  }
  
  return new TradingBotError(
    `${context ? context + ': ' : ''}${error.message}`,
    ErrorCodes.UNKNOWN_ERROR,
    { originalError: error.name, stack: error.stack }
  );
}

module.exports = {
  TradingBotError,
  AuthenticationError,
  APIError,
  WebSocketError,
  OrderError,
  RiskError,
  ConfigError,
  StrategyError,
  DataError,
  ErrorCodes,
  createFromAPIResponse,
  wrapError
};
