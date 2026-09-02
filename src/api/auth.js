const axios = require('axios');
const crypto = require('crypto');

class TradovateAuth {
  constructor(config) {
    this.config = config;
    this.accessToken = null;
    this.mdAccessToken = null;
    this.tokenExpiry = null;
    this._renewalTimer = null;
    this._isRenewing = false;
    this._inflightAuth = null;
  }

  /**
   * Get the base URL for the selected environment
   */
  getBaseUrl() {
    return this.config.env === 'demo' 
      ? 'https://demo.tradovateapi.com/v1'
      : 'https://live.tradovateapi.com/v1';
  }

  /**
   * Generate a unique device ID based on system info
   */
  generateDeviceId() {
    return crypto
      .createHash('sha256')
      .update(process.platform)
      .update(process.arch)
      .update(this.config.username)
      .digest('hex');
  }

  /**
   * Request an access token from Tradovate.
   *
   * Concurrent callers share one in-flight request: when the token lapses,
   * every poller (exit watchdog, fill watchdog, REST calls) asks for a token
   * at once, and N parallel password logins is exactly what earns a
   * Tradovate p-ticket lockout.
   */
  authenticate() {
    if (!this._inflightAuth) {
      this._inflightAuth = this._authenticate().finally(() => { this._inflightAuth = null; });
    }
    return this._inflightAuth;
  }

  async _authenticate() {
    const url = `${this.getBaseUrl()}/auth/accessTokenRequest`;
    const deviceId = this.generateDeviceId();

    console.log(`[Auth] Tradovate base URL: ${this.getBaseUrl()}`);
    console.log(`[Auth] Authenticating with Tradovate (${this.config.env})...`);
    console.log(`[Auth] Device ID: ${deviceId}`);

    const data = {
      name: this.config.username,
      password: this.config.password,
      appId: this.config.appId || 'TradovateBot',
      appVersion: this.config.appVersion || '1.0',
      deviceId,
      cid: this.config.cid || 0,
      sec: this.config.secret || ''
    };

    // Log if API key is missing (will cause 401 on API calls)
    if (!this.config.cid || !this.config.secret) {
      console.log('[Auth] ⚠️  No API Key configured - API calls may fail');
      console.log('[Auth]    Create an API Key at: Tradovate Trader > Settings > API Access');
    }

    try {
      const response = await axios.post(url, data, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      // Tradovate answers a throttled/penalised login with HTTP 200 and a
      // p-ticket/p-time body instead of a token. Treating that as success
      // leaves accessToken undefined and every later call 401s.
      if (!response.data?.accessToken) {
        const penalty = response.data?.['p-time'];
        const detail = penalty != null
          ? `login throttled by Tradovate — retry after ${penalty}s (p-ticket)`
          : (response.data?.errorText || 'no accessToken in response');
        console.error(`[Auth] ✗ Authentication rejected: ${detail}`);
        const err = new Error(`Authentication rejected: ${detail}`);
        err.isAuthRejection = true;
        throw err;
      }

      this.accessToken = response.data.accessToken;
      this.mdAccessToken = response.data.mdAccessToken;
      
      // Handle expiration time - Tradovate may return it in different formats
      const expTime = response.data.expirationTime;
      if (expTime) {
        this.tokenExpiry = new Date(expTime);
      } else {
        // Default to 24 hours from now if not provided
        this.tokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
      }

      console.log('[Auth] ✓ Authentication successful');

      // CRITICAL-5 FIX: Schedule proactive token renewal 10 minutes before expiry
      this._scheduleRenewal();

      return {
        accessToken: this.accessToken,
        mdAccessToken: this.mdAccessToken,
        expiry: this.tokenExpiry,
        userId: response.data.userId,
        userStatus: response.data.userStatus
      };
    } catch (error) {
      if (error.isAuthRejection) throw error;
      const statusCode = error.response?.status;
      const isRateLimit = statusCode === 429;
      const isServerError = statusCode >= 500;
      const isForbidden = statusCode === 403;
      const isTimeout = statusCode === 408;
      
      if (isRateLimit) {
        console.error('[Auth] ✗ Rate limited (429) - waiting 60 seconds before retry...');
        await new Promise(resolve => setTimeout(resolve, 60000)); // Wait 60 seconds
        throw new Error('Rate limited - please wait before retrying');
      }
      
      if (isForbidden) {
        console.error('[Auth] ✗ Access forbidden (403) - check API key/account status');
        throw new Error('Access forbidden - check API key and account status');
      }
      
      if (isTimeout) {
        console.error('[Auth] ✗ Request timeout (408) - waiting 15 seconds before retry...');
        await new Promise(resolve => setTimeout(resolve, 15000)); // Wait 15 seconds
        throw new Error('Request timeout - please try again');
      }
      
      if (isServerError) {
        console.error(`[Auth] ✗ Server error (${statusCode}) - waiting 30 seconds before retry...`);
        await new Promise(resolve => setTimeout(resolve, 30000)); // Wait 30 seconds
        throw new Error(`Server error (${statusCode}) - please wait before retrying`);
      }
      
      console.error('[Auth] ✗ Authentication failed:', error.response?.data || error.message);
      throw new Error('Failed to authenticate with Tradovate');
    }
  }

  /**
   * CRITICAL-5 FIX: Schedule proactive token renewal before expiry.
   * Renews 10 minutes before token expires. If renewal fails, falls back to full re-auth.
   * This prevents API calls from failing during the expiry window.
   * @private
   */
  _scheduleRenewal() {
    if (this._renewalTimer) {
      clearTimeout(this._renewalTimer);
      this._renewalTimer = null;
    }

    if (!this.tokenExpiry) return;

    // Renew 10 minutes before expiry (minimum 60 seconds from now)
    const msUntilExpiry = this.tokenExpiry.getTime() - Date.now();
    const renewInMs = Math.max(60 * 1000, msUntilExpiry - 10 * 60 * 1000);

    this._renewalTimer = setTimeout(async () => {
      if (this._isRenewing) return;
      this._isRenewing = true;

      try {
        console.log('[Auth] Proactive token renewal starting...');
        const renewed = await this.renewToken();
        if (renewed) {
          this._scheduleRenewal(); // Schedule next renewal
        } else {
          // Renewal failed — fall back to full re-authentication
          console.warn('[Auth] Token renewal failed, falling back to full re-auth');
          await this.authenticate();
        }
      } catch (error) {
        console.error('[Auth] Proactive renewal error:', error.message);
        // Last resort: try full re-auth
        try {
          await this.authenticate();
        } catch (authErr) {
          console.error('[Auth] CRITICAL: Re-authentication also failed:', authErr.message);
        }
      } finally {
        this._isRenewing = false;
      }
    }, renewInMs);

    const renewInMin = (renewInMs / 60000).toFixed(1);
    console.log(`[Auth] Token renewal scheduled in ${renewInMin} minutes`);
  }

  /**
   * Stop the proactive renewal timer (call on shutdown)
   */
  stopRenewal() {
    if (this._renewalTimer) {
      clearTimeout(this._renewalTimer);
      this._renewalTimer = null;
    }
  }

  /**
   * Check if the current token is still valid
   */
  isTokenValid() {
    if (!this.accessToken || !this.tokenExpiry) {
      return false;
    }
    return new Date() < this.tokenExpiry;
  }

  /**
   * Get the current access token (refresh if needed)
   */
  async getAccessToken() {
    if (!this.isTokenValid()) {
      await this.authenticate();
    }
    return this.accessToken;
  }

  /**
   * Get the market data access token
   */
  async getMdAccessToken() {
    if (!this.isTokenValid()) {
      await this.authenticate();
    }
    return this.mdAccessToken;
  }

  /**
   * Renew the access token before it expires
   */
  async renewToken() {
    const url = `${this.getBaseUrl()}/auth/renewAccessToken`;
    
    try {
      const response = await axios.post(url, {}, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      this.accessToken = response.data.accessToken;
      this.mdAccessToken = response.data.mdAccessToken;
      this.tokenExpiry = new Date(response.data.expirationTime);

      console.log('[Auth] ✓ Token renewed');
      return true;
    } catch (error) {
      console.error('[Auth] ✗ Token renewal failed:', error.message);
      return false;
    }
  }
}

module.exports = TradovateAuth;
