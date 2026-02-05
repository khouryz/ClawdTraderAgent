/**
 * Rate Limiter
 * Prevents API rate limit violations using token bucket algorithm
 */

const { API } = require('./constants');

class RateLimiter {
  constructor(config = {}) {
    this.requestsPerSecond = config.requestsPerSecond || API.RATE_LIMIT_PER_SECOND;
    this.requestsPerMinute = config.requestsPerMinute || API.RATE_LIMIT_PER_MINUTE;
    this.burstLimit = config.burstLimit || API.BURST_LIMIT;

    // Token bucket for per-second limiting
    this.tokens = this.burstLimit;
    this.lastRefill = Date.now();

    // Sliding window for per-minute limiting
    this.minuteRequests = [];
  }

  /**
   * Wait if rate limit would be exceeded
   */
  async acquire() {
    await this._waitForSecondLimit();
    await this._waitForMinuteLimit();
  }

  /**
   * Per-second rate limiting using token bucket
   */
  async _waitForSecondLimit() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    
    // Refill tokens based on time passed
    this.tokens = Math.min(
      this.burstLimit,
      this.tokens + elapsed * this.requestsPerSecond
    );
    this.lastRefill = now;

    if (this.tokens < 1) {
      const waitMs = ((1 - this.tokens) / this.requestsPerSecond) * 1000;
      await this._sleep(waitMs);
      this.tokens = 0;
    } else {
      this.tokens -= 1;
    }
  }

  /**
   * Per-minute rate limiting using sliding window
   */
  async _waitForMinuteLimit() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove expired requests
    this.minuteRequests = this.minuteRequests.filter(t => t > oneMinuteAgo);

    if (this.minuteRequests.length >= this.requestsPerMinute) {
      const oldestRequest = Math.min(...this.minuteRequests);
      const waitMs = oldestRequest + 60000 - now;
      if (waitMs > 0) {
        await this._sleep(waitMs);
      }
    }

    this.minuteRequests.push(Date.now());
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current rate limiter status
   */
  getStatus() {
    return {
      availableTokens: Math.floor(this.tokens),
      minuteRequestCount: this.minuteRequests.length,
      minuteLimit: this.requestsPerMinute
    };
  }

  /**
   * Reset the rate limiter
   */
  reset() {
    this.tokens = this.burstLimit;
    this.lastRefill = Date.now();
    this.minuteRequests = [];
  }
}

module.exports = RateLimiter;
