const axios = require('axios');

class TradovateClient {
  constructor(auth) {
    this.auth = auth;
  }

  /**
   * Make an authenticated API request
   */
  async request(method, endpoint, data = null) {
    const token = await this.auth.getAccessToken();
    const url = `${this.auth.getBaseUrl()}${endpoint}`;

    const config = {
      method,
      url,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    if (data) {
      config.data = data;
    }

    try {
      const response = await axios(config);
      return response.data;
    } catch (error) {
      console.error(`[API] Error: ${method} ${endpoint}`, error.response?.data || error.message);
      throw error;
    }
  }

  // ============================================
  // Account Operations
  // ============================================

  /**
   * Get list of accounts
   */
  async getAccounts() {
    return this.request('GET', '/account/list');
  }

  /**
   * Get account by ID
   */
  async getAccount(accountId) {
    return this.request('GET', `/account/item?id=${accountId}`);
  }

  /**
   * Get cash balance for account
   */
  async getCashBalance(accountId) {
    return this.request('GET', `/cashBalance/getcashbalance?accountId=${accountId}`);
  }

  // ============================================
  // Position Operations
  // ============================================

  /**
   * Get all positions
   */
  async getPositions() {
    return this.request('GET', '/position/list');
  }

  /**
   * Get positions for specific account
   */
  async getPositionsByAccount(accountId) {
    return this.request('GET', `/position/list?accountId=${accountId}`);
  }

  // ============================================
  // Contract Operations
  // ============================================

  /**
   * Find contract by name (e.g., "MESM5")
   */
  async findContract(name) {
    return this.request('GET', `/contract/find?name=${name}`);
  }

  /**
   * Get contract by ID
   */
  async getContract(contractId) {
    return this.request('GET', `/contract/item?id=${contractId}`);
  }

  /**
   * Get contract specs (margins, tick size, etc.)
   */
  async getContractMaturity(contractId) {
    return this.request('GET', `/contractMaturity/item?id=${contractId}`);
  }

  // ============================================
  // Order Operations
  // ============================================

  /**
   * Place a market order
   */
  async placeMarketOrder(accountId, contractId, qty, action) {
    const order = {
      accountId,
      accountSpec: accountId.toString(),
      contractId,
      action, // 'Buy' or 'Sell'
      orderQty: qty,
      orderType: 'Market',
      isAutomated: true
    };

    return this.request('POST', '/order/placeorder', order);
  }

  /**
   * Place a limit order
   */
  async placeLimitOrder(accountId, contractId, qty, action, price) {
    const order = {
      accountId,
      accountSpec: accountId.toString(),
      contractId,
      action, // 'Buy' or 'Sell'
      orderQty: qty,
      orderType: 'Limit',
      price,
      isAutomated: true
    };

    return this.request('POST', '/order/placeorder', order);
  }

  /**
   * Place a bracket order (entry + stop + target)
   */
  async placeBracketOrder(accountId, contractId, qty, action, stopLoss, takeProfit) {
    const bracket = {
      accountId,
      accountSpec: accountId.toString(),
      contractId,
      action, // 'Buy' or 'Sell'
      orderQty: qty,
      orderType: 'Market',
      bracket: {
        stopLoss,
        takeProfit
      },
      isAutomated: true
    };

    return this.request('POST', '/order/placeorder', bracket);
  }

  /**
   * Cancel an order
   */
  async cancelOrder(orderId) {
    return this.request('POST', '/order/cancelorder', {
      orderId,
      clOrdId: orderId.toString(),
      isAutomated: true
    });
  }

  /**
   * Get order status
   */
  async getOrder(orderId) {
    return this.request('GET', `/order/item?id=${orderId}`);
  }

  /**
   * Get all orders
   */
  async getOrders() {
    return this.request('GET', '/order/list');
  }

  // ============================================
  // Market Data Operations
  // ============================================

  /**
   * Get historical bars
   */
  async getBars(contractId, timeRange) {
    const params = {
      symbol: contractId,
      chartDescription: {
        underlyingType: 'MinuteBar',
        elementSize: 5,
        elementSizeUnit: 'UnderlyingUnits',
        withHistogram: false
      },
      timeRange: {
        asMuchAsElements: timeRange || 100
      }
    };

    return this.request('POST', '/chart/getbars', params);
  }

  /**
   * Get contract quotes
   */
  async getQuote(contractId) {
    return this.request('GET', `/md/getquote?contractId=${contractId}`);
  }

  // ============================================
  // Risk Operations
  // ============================================

  /**
   * Get account risk parameters
   */
  async getAccountRisk(accountId) {
    return this.request('GET', `/accountRiskStatus/list?accountId=${accountId}`);
  }
}

module.exports = TradovateClient;
