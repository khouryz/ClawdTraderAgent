const axios = require('axios');
const crypto = require('crypto');

class TradovateAuth {
  constructor(config) {
    this.config = config;
    this.accessToken = null;
    this.mdAccessToken = null;
    this.tokenExpiry = null;
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
   * Request an access token from Tradovate
   */
  async authenticate() {
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

      return {
        accessToken: this.accessToken,
        mdAccessToken: this.mdAccessToken,
        expiry: this.tokenExpiry,
        userId: response.data.userId,
        userStatus: response.data.userStatus
      };
    } catch (error) {
      console.error('[Auth] ✗ Authentication failed:', error.response?.data || error.message);
      throw new Error('Failed to authenticate with Tradovate');
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
