/**
 * Error Handler
 * Centralized error handling with specific error types and recovery strategies
 */

const { ERROR_CODES } = require('./constants');

class TradingError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TradingError';
    this.code = code;
    this.details = details;
    this.timestamp = new Date().toISOString();
  }
}

class ErrorHandler {
  /**
   * Handle an error and determine recovery strategy
   */
  static handle(error, context = {}) {
    const errorInfo = this._extractErrorInfo(error);
    
    console.error(`[${context.component || 'Bot'}] ${errorInfo.code}: ${errorInfo.message}`);
    
    return {
      ...errorInfo,
      recovery: this._getRecoveryStrategy(errorInfo.code),
      context,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Extract error information from various error types
   */
  static _extractErrorInfo(error) {
    if (error instanceof TradingError) {
      return {
        code: error.code,
        message: error.message,
        details: error.details
      };
    }

    // Handle Axios errors
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;

      if (status === 401) {
        return { code: ERROR_CODES.AUTH_FAILED, message: 'Authentication failed', details: data };
      }
      if (status === 429) {
        return { code: ERROR_CODES.RATE_LIMITED, message: 'Rate limit exceeded', details: data };
      }
      if (status === 400) {
        return { code: ERROR_CODES.INVALID_ORDER, message: data?.message || 'Invalid request', details: data };
      }
      
      return { code: 'API_ERROR', message: data?.message || error.message, details: { status, data } };
    }

    // Handle connection errors
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
      return { code: ERROR_CODES.CONNECTION_FAILED, message: 'Connection failed', details: { originalCode: error.code } };
    }

    return { code: 'UNKNOWN', message: error.message, details: {} };
  }

  /**
   * Get recovery strategy for error code
   */
  static _getRecoveryStrategy(code) {
    const strategies = {
      [ERROR_CODES.INSUFFICIENT_BALANCE]: { action: 'HALT', retryable: false, message: 'Halt trading - insufficient funds' },
      [ERROR_CODES.MARKET_CLOSED]: { action: 'WAIT', retryable: true, delayMs: 60000, message: 'Wait for market open' },
      [ERROR_CODES.RATE_LIMITED]: { action: 'BACKOFF', retryable: true, delayMs: 60000, message: 'Back off and retry' },
      [ERROR_CODES.AUTH_FAILED]: { action: 'REAUTH', retryable: true, delayMs: 5000, message: 'Re-authenticate' },
      [ERROR_CODES.INVALID_ORDER]: { action: 'SKIP', retryable: false, message: 'Skip this order' },
      [ERROR_CODES.RISK_LIMIT_EXCEEDED]: { action: 'HALT', retryable: false, message: 'Halt trading - risk limit' },
      [ERROR_CODES.CONNECTION_FAILED]: { action: 'RETRY', retryable: true, delayMs: 5000, message: 'Retry connection' },
      'UNKNOWN': { action: 'LOG', retryable: false, message: 'Log and continue' }
    };

    return strategies[code] || strategies['UNKNOWN'];
  }

  /**
   * Create specific error types
   */
  static insufficientBalance(balance) {
    return new TradingError(ERROR_CODES.INSUFFICIENT_BALANCE, 'Insufficient account balance', { balance });
  }

  static marketClosed() {
    return new TradingError(ERROR_CODES.MARKET_CLOSED, 'Market is closed');
  }

  static rateLimited(retryAfter) {
    return new TradingError(ERROR_CODES.RATE_LIMITED, 'API rate limit exceeded', { retryAfter });
  }

  static authFailed(details) {
    return new TradingError(ERROR_CODES.AUTH_FAILED, 'Authentication failed', details);
  }

  static invalidOrder(details) {
    return new TradingError(ERROR_CODES.INVALID_ORDER, 'Invalid order parameters', details);
  }

  static riskLimitExceeded(limit, current) {
    return new TradingError(ERROR_CODES.RISK_LIMIT_EXCEEDED, 'Risk limit exceeded', { limit, current });
  }
}

module.exports = { ErrorHandler, TradingError };
