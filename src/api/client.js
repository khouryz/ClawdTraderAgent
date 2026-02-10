const axios = require('axios');
const EventEmitter = require('events');
const RateLimiter = require('../utils/rate_limiter');
const { API } = require('../utils/constants');

/**
 * Tradovate API Client
 * Comprehensive REST API client for Tradovate trading platform
 * Supports: Accounts, Positions, Orders, Fills, Cash Balance, Contracts, Market Data
 * 
 * API Documentation: https://api.tradovate.com/
 * 
 * Base URLs:
 * - Demo: https://demo.tradovateapi.com/v1
 * - Live: https://live.tradovateapi.com/v1
 * - Market Data Demo: https://md-demo.tradovateapi.com/v1
 * - Market Data Live: https://md.tradovateapi.com/v1
 */

class TradovateClient extends EventEmitter {
  constructor(auth, config = {}) {
    super();
    this.auth = auth;
    this.config = {
      retryAttempts: config.retryAttempts || API.RETRY_ATTEMPTS,
      retryDelayMs: config.retryDelayMs || API.RETRY_DELAY_MS,
      retryBackoffMultiplier: config.retryBackoffMultiplier || API.RETRY_BACKOFF_MULTIPLIER,
      timeout: config.timeout || API.DEFAULT_TIMEOUT,
      ...config
    };
    
    // Rate limiter to prevent API bans
    this.rateLimiter = new RateLimiter({
      requestsPerSecond: API.RATE_LIMIT_PER_SECOND,
      requestsPerMinute: API.RATE_LIMIT_PER_MINUTE,
      burstLimit: API.BURST_LIMIT
    });
    
    // Cache for frequently accessed data
    this.cache = {
      accounts: null,
      contracts: new Map(),
      products: new Map(),
      lastSync: null
    };
  }

  /**
   * Get market data base URL
   */
  getMdBaseUrl() {
    return this.auth.config.env === 'demo'
      ? 'https://md-demo.tradovateapi.com/v1'
      : 'https://md.tradovateapi.com/v1';
  }

  /**
   * Make an authenticated API request with retry logic
   */
  async request(method, endpoint, data = null, attempt = 1, useMdServer = false) {
    // Wait for rate limit before making request
    await this.rateLimiter.acquire();
    
    const token = useMdServer 
      ? await this.auth.getMdAccessToken()
      : await this.auth.getAccessToken();
    const baseUrl = useMdServer ? this.getMdBaseUrl() : this.auth.getBaseUrl();
    const url = `${baseUrl}${endpoint}`;

    const config = {
      method,
      url,
      timeout: this.config.timeout,
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
      this.emit('request', { method, endpoint, success: true });
      return response.data;
    } catch (error) {
      const errorData = error.response?.data || { message: error.message };
      const statusCode = error.response?.status;
      
      console.error(`[API] Error: ${method} ${endpoint} (attempt ${attempt})`, errorData);
      this.emit('error', { method, endpoint, error: errorData, statusCode, attempt });

      // Retry on specific error codes (rate limit, server errors)
      const retryableCodes = [429, 500, 502, 503, 504];
      if (attempt < this.config.retryAttempts && retryableCodes.includes(statusCode)) {
        const delay = this.config.retryDelayMs * Math.pow(this.config.retryBackoffMultiplier, attempt - 1);
        console.log(`[API] Retrying in ${delay}ms...`);
        await this.sleep(delay);
        return this.request(method, endpoint, data, attempt + 1);
      }

      throw error;
    }
  }

  /**
   * Sleep helper for retry delays
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
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
   * Returns: { accountId, timestamp, tradeDate, beginningBalance, realizedPnL, openPnL, cashBalance, ... }
   */
  async getCashBalance(accountId) {
    // Use /cashBalance/list endpoint and return the most recent entry
    const balances = await this.request('GET', `/cashBalance/list`);
    // Find the balance for this account, or return the first one
    const balance = balances.find(b => b.accountId === accountId) || balances[0];
    if (!balance) {
      throw new Error(`No cash balance found for account ${accountId}`);
    }
    return balance;
  }

  /**
   * Get all cash balance snapshots for account
   */
  async getCashBalanceList(accountId) {
    return this.request('GET', `/cashBalance/list?accountId=${accountId}`);
  }

  /**
   * Get account summary with margin info
   * Returns detailed account state including margin requirements
   */
  async getAccountSummary(accountId) {
    const [account, cashBalance, positions, riskStatus] = await Promise.all([
      this.getAccount(accountId),
      this.getCashBalance(accountId),
      this.getPositionsByAccount(accountId),
      this.getAccountRisk(accountId).catch(() => null)
    ]);

    return {
      account,
      cashBalance,
      positions,
      riskStatus,
      summary: {
        accountId,
        name: account.name,
        balance: cashBalance.cashBalance,
        realizedPnL: cashBalance.realizedPnL || 0,
        openPnL: cashBalance.openPnL || 0,
        totalPnL: (cashBalance.realizedPnL || 0) + (cashBalance.openPnL || 0),
        openPositions: positions.filter(p => p.netPos !== 0).length,
        timestamp: new Date().toISOString()
      }
    };
  }

  /**
   * Get margin snapshot for account
   */
  async getMarginSnapshot(accountId) {
    return this.request('GET', `/marginSnapshot/list?accountId=${accountId}`);
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

  /**
   * Get a specific position by ID
   */
  async getPosition(positionId) {
    return this.request('GET', `/position/item?id=${positionId}`);
  }

  /**
   * Get open positions only (netPos != 0)
   * Client-side filtering since Tradovate doesn't have this endpoint
   */
  async getOpenPositions(accountId) {
    const positions = await this.getPositionsByAccount(accountId);
    if (!Array.isArray(positions)) {
      return [];
    }
    return positions.filter(p => p.netPos && p.netPos !== 0);
  }

  /**
   * Calculate open P&L for a position
   * Formula: ((currentPrice - netPrice) * valuePerPoint) * netPos
   * @param {Object} position - Position object from API
   * @param {Object} product - Product object with valuePerPoint
   * @param {number} currentPrice - Current market price
   */
  calculateOpenPnL(position, product, currentPrice) {
    if (!position || position.netPos === 0) return 0;
    return ((currentPrice - position.netPrice) * product.valuePerPoint) * position.netPos;
  }

  /**
   * Get position with calculated P&L
   */
  async getPositionWithPnL(positionId, currentPrice) {
    const position = await this.getPosition(positionId);
    if (!position || position.netPos === 0) {
      return { position, openPnL: 0 };
    }

    const contract = await this.getContract(position.contractId);
    const product = await this.getProduct(contract.productId);
    const openPnL = this.calculateOpenPnL(position, product, currentPrice);

    return {
      position,
      contract,
      product,
      currentPrice,
      openPnL,
      rMultiple: position.netPos !== 0 ? openPnL / Math.abs(position.netPos) : 0
    };
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

  /**
   * Get product details (contains valuePerPoint, tickSize, etc.)
   */
  async getProduct(productId) {
    // Check cache first
    if (this.cache.products.has(productId)) {
      return this.cache.products.get(productId);
    }
    const product = await this.request('GET', `/product/item?id=${productId}`);
    this.cache.products.set(productId, product);
    return product;
  }

  /**
   * Get product by name
   */
  async findProduct(name) {
    return this.request('GET', `/product/find?name=${name}`);
  }

  /**
   * Get all available contracts for a product
   */
  async getContractsByProduct(productId) {
    return this.request('GET', `/contract/deps?masterid=${productId}`);
  }

  /**
   * Get front-month contract for a product (for auto-rollover)
   */
  async getFrontMonthContract(productName) {
    const product = await this.findProduct(productName);
    if (!product) {
      throw new Error(`Product not found: ${productName}`);
    }

    const contracts = await this.getContractsByProduct(product.id);
    if (!contracts || contracts.length === 0) {
      throw new Error(`No contracts found for product: ${productName}`);
    }

    // Sort by expiration and get the nearest one that hasn't expired
    const now = new Date();
    const activeContracts = contracts
      .filter(c => new Date(c.expirationDate) > now)
      .sort((a, b) => new Date(a.expirationDate) - new Date(b.expirationDate));

    if (activeContracts.length === 0) {
      throw new Error(`No active contracts found for product: ${productName}`);
    }

    return activeContracts[0];
  }

  /**
   * Get contract specification details
   */
  async getContractSpec(contractId) {
    const contract = await this.getContract(contractId);
    const product = await this.getProduct(contract.productId);
    const maturity = await this.getContractMaturity(contract.contractMaturityId).catch(() => null);

    return {
      contract,
      product,
      maturity,
      specs: {
        symbol: contract.name,
        productName: product.name,
        tickSize: product.tickSize,
        valuePerPoint: product.valuePerPoint,
        currency: product.currencyId,
        expirationDate: contract.expirationDate
      }
    };
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
      symbol: contractId.toString(),
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
      symbol: contractId.toString(),
      action, // 'Buy' or 'Sell'
      orderQty: qty,
      orderType: 'Limit',
      price,
      isAutomated: true
    };

    return this.request('POST', '/order/placeorder', order);
  }

  /**
   * Place a bracket order using Order Strategy API (CORRECT METHOD)
   * This is the proper way to place bracket orders in Tradovate
   */
  async placeBracketOrder(accountId, contractId, qty, action, stopLoss, takeProfit) {
    const oppositeAction = action === 'Buy' ? 'Sell' : 'Buy';
    
    const params = {
      accountId,
      accountSpec: accountId.toString(),
      symbol: contractId,
      orderStrategyTypeId: 2, // 2 = Bracket strategy
      action,
      params: JSON.stringify({
        entryVersion: {
          orderQty: qty,
          orderType: 'Market'
        },
        brackets: [{
          qty,
          profitTarget: takeProfit,
          stopLoss,
          trailingStop: false
        }]
      })
    };

    return this.request('POST', '/orderStrategy/startOrderStrategy', params);
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

  /**
   * Get orders for specific account
   */
  async getOrdersByAccount(accountId) {
    return this.request('GET', `/order/list?accountId=${accountId}`);
  }

  /**
   * Get working (active) orders only
   * Tradovate order statuses: Working, Accepted, PendingNew, PendingReplace
   */
  async getWorkingOrders(accountId) {
    const orders = await this.getOrdersByAccount(accountId);
    if (!Array.isArray(orders)) {
      return [];
    }
    const workingStates = ['Working', 'Accepted', 'PendingNew', 'PendingReplace'];
    return orders.filter(o => o.ordStatus && workingStates.includes(o.ordStatus));
  }

  /**
   * Modify an existing order
   */
  async modifyOrder(orderId, changes) {
    return this.request('POST', '/order/modifyorder', {
      orderId,
      ...changes,
      isAutomated: true
    });
  }

  /**
   * Cancel all working orders for an account
   */
  async cancelAllOrders(accountId) {
    const workingOrders = await this.getWorkingOrders(accountId);
    const results = await Promise.allSettled(
      workingOrders.map(order => this.cancelOrder(order.id))
    );
    return {
      total: workingOrders.length,
      cancelled: results.filter(r => r.status === 'fulfilled').length,
      failed: results.filter(r => r.status === 'rejected').length,
      results
    };
  }

  /**
   * Place a stop order
   */
  async placeStopOrder(accountId, contractId, qty, action, stopPrice) {
    const order = {
      accountId,
      accountSpec: accountId.toString(),
      contractId,
      symbol: contractId.toString(),
      action,
      orderQty: qty,
      orderType: 'Stop',
      stopPrice,
      isAutomated: true
    };
    return this.request('POST', '/order/placeorder', order);
  }

  /**
   * Place a stop-limit order
   */
  async placeStopLimitOrder(accountId, contractId, qty, action, stopPrice, limitPrice) {
    const order = {
      accountId,
      accountSpec: accountId.toString(),
      contractId,
      symbol: contractId.toString(),
      action,
      orderQty: qty,
      orderType: 'StopLimit',
      stopPrice,
      price: limitPrice,
      isAutomated: true
    };
    return this.request('POST', '/order/placeorder', order);
  }

  /**
   * Place an OCO (One-Cancels-Other) order
   * Used for stop-loss and take-profit together
   */
  async placeOCOOrder(accountId, contractId, qty, action, stopPrice, limitPrice) {
    const oco = {
      accountId,
      accountSpec: accountId.toString(),
      contractId,
      action,
      orderQty: qty,
      orderType: 'Limit',
      price: limitPrice,
      oco: {
        other: {
          action,
          orderType: 'Stop',
          stopPrice
        }
      },
      isAutomated: true
    };
    return this.request('POST', '/order/placeorder', oco);
  }

  /**
   * Liquidate a position (close at market)
   */
  async liquidatePosition(accountId, contractId, netPos) {
    const action = netPos > 0 ? 'Sell' : 'Buy';
    const qty = Math.abs(netPos);
    return this.placeMarketOrder(accountId, contractId, qty, action);
  }

  // ============================================
  // Fill Operations
  // ============================================

  /**
   * Get all fills
   */
  async getFills() {
    return this.request('GET', '/fill/list');
  }

  /**
   * Get fills for specific account
   */
  async getFillsByAccount(accountId) {
    return this.request('GET', `/fill/list?accountId=${accountId}`);
  }

  /**
   * Get fills for a specific order (using deps endpoint)
   * This is the proper way to get fill price for an order
   */
  async getFillsByOrder(orderId) {
    return this.request('GET', `/fill/deps?masterid=${orderId}`);
  }

  /**
   * Get fill pairs (matched buy/sell fills)
   */
  async getFillPairs(accountId) {
    return this.request('GET', `/fillPair/list?accountId=${accountId}`);
  }

  /**
   * Get a specific fill by ID
   */
  async getFill(fillId) {
    return this.request('GET', `/fill/item?id=${fillId}`);
  }

  /**
   * Get today's fills for account
   * Filters client-side by timestamp
   */
  async getTodaysFills(accountId) {
    const fills = await this.getFillsByAccount(accountId);
    if (!Array.isArray(fills)) {
      return [];
    }
    const today = new Date().toISOString().split('T')[0];
    return fills.filter(f => {
      if (!f.timestamp) return false;
      // Handle both ISO string and Date object
      const fillDate = typeof f.timestamp === 'string' 
        ? f.timestamp.split('T')[0]
        : new Date(f.timestamp).toISOString().split('T')[0];
      return fillDate === today;
    });
  }

  // ============================================
  // Execution Report Operations
  // ============================================

  /**
   * Get execution reports (detailed order execution info)
   */
  async getExecutionReports(accountId) {
    return this.request('GET', `/executionReport/list?accountId=${accountId}`);
  }

  /**
   * Get execution reports for a specific order
   */
  async getExecutionReportsByOrder(orderId) {
    return this.request('GET', `/executionReport/deps?masterid=${orderId}`);
  }

  // ============================================
  // Market Data Operations (LEGACY - Databento is now primary data source)
  // These methods are kept as fallbacks for Tradovate-specific data needs
  // ============================================

  /**
   * Get historical bars - CORRECTED for Tradovate API
   * Endpoint: POST /md/getChart (on market data server)
   * @param {number} contractId - Contract ID
   * @param {Object} options - Chart options
   */
  async getBars(contractId, options = {}) {
    const chartDesc = {
      underlyingType: options.underlyingType || 'MinuteBar',
      elementSize: options.elementSize || 5,
      elementSizeUnit: options.elementSizeUnit || 'UnderlyingUnits',
      withHistogram: options.withHistogram || false
    };

    const timeRange = options.startTime ? {
      closestTimestamp: options.startTime,
      asFarAsTimestamp: options.endTime || new Date().toISOString()
    } : {
      asMuchAsElements: options.count || 100
    };

    // Use market data server for chart data
    const response = await this.request('POST', '/md/getChart', {
      symbol: contractId,
      chartDescription: chartDesc,
      timeRange
    }, 1, true); // useMdServer = true

    // Tradovate returns: { bars: [...], eoh: [...] }
    // Ensure we return the bars array
    return response;
  }

  /**
   * Alias for getBars - uses same endpoint
   */
  async getChartBars(contractId, count = 100) {
    return this.getBars(contractId, { count });
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

  // ============================================
  // User Sync Operations (Real-time state)
  // ============================================

  /**
   * Sync request - Get current state of all user entities
   * This is the primary way to get real-time account state
   * Returns: accounts, positions, orders, fills, cashBalances, etc.
   */
  async syncRequest() {
    const result = await this.request('POST', '/user/syncrequest', {
      users: [this.auth.userId]
    });
    this.cache.lastSync = new Date();
    return result;
  }

  /**
   * Get comprehensive trading state
   * Combines multiple API calls for complete picture
   */
  async getTradingState(accountId) {
    const [account, cashBalance, positions, workingOrders, todaysFills] = await Promise.all([
      this.getAccount(accountId),
      this.getCashBalance(accountId),
      this.getPositionsByAccount(accountId),
      this.getWorkingOrders(accountId),
      this.getTodaysFills(accountId)
    ]);

    const openPositions = positions.filter(p => p.netPos !== 0);

    // Calculate today's P&L from fills
    let todayRealizedPnL = 0;
    for (const fill of todaysFills) {
      if (fill.pnl) {
        todayRealizedPnL += fill.pnl;
      }
    }

    return {
      timestamp: new Date().toISOString(),
      account: {
        id: account.id,
        name: account.name,
        active: account.active
      },
      balance: {
        cash: cashBalance.cashBalance,
        realizedPnL: cashBalance.realizedPnL || 0,
        openPnL: cashBalance.openPnL || 0,
        todayRealizedPnL
      },
      positions: {
        open: openPositions,
        count: openPositions.length,
        totalQuantity: openPositions.reduce((sum, p) => sum + Math.abs(p.netPos), 0)
      },
      orders: {
        working: workingOrders,
        count: workingOrders.length
      },
      fills: {
        today: todaysFills,
        count: todaysFills.length
      }
    };
  }

  // ============================================
  // Order Strategy Operations (Advanced Orders)
  // ============================================

  /**
   * Start an order strategy (bracket, OCO, etc.)
   * This is the recommended way to place complex orders
   */
  async startOrderStrategy(params) {
    return this.request('POST', '/orderStrategy/startorderstrategy', params);
  }

  /**
   * Place a bracket order using order strategy
   * More reliable than the simple bracket in placeorder
   */
  async placeBracketOrderStrategy(accountId, contractId, qty, action, stopLoss, takeProfit) {
    const oppositeAction = action === 'Buy' ? 'Sell' : 'Buy';
    
    const params = {
      accountId,
      accountSpec: accountId.toString(),
      symbol: contractId,
      orderStrategyTypeId: 2, // Bracket
      action,
      params: JSON.stringify({
        entryVersion: {
          orderQty: qty,
          orderType: 'Market'
        },
        brackets: [{
          qty,
          profitTarget: takeProfit,
          stopLoss,
          trailingStop: false
        }]
      })
    };

    return this.startOrderStrategy(params);
  }

  /**
   * Interrupt/cancel an order strategy
   */
  async interruptOrderStrategy(orderStrategyId) {
    return this.request('POST', '/orderStrategy/interruptorderstrategy', {
      orderStrategyId
    });
  }

  /**
   * Get order strategy status
   */
  async getOrderStrategy(orderStrategyId) {
    return this.request('GET', `/orderStrategy/item?id=${orderStrategyId}`);
  }

  /**
   * Get all order strategies for account
   */
  async getOrderStrategies(accountId) {
    return this.request('GET', `/orderStrategy/list?accountId=${accountId}`);
  }

  // ============================================
  // Command Operations
  // ============================================

  /**
   * Get command status
   */
  async getCommand(commandId) {
    return this.request('GET', `/command/item?id=${commandId}`);
  }

  /**
   * Get command report
   */
  async getCommandReport(commandId) {
    return this.request('GET', `/commandReport/deps?masterid=${commandId}`);
  }

  // ============================================
  // Trade Date Operations
  // ============================================

  /**
   * Get current trade date
   */
  async getTradeDate() {
    const accounts = await this.getAccounts();
    if (accounts.length > 0) {
      const cashBalance = await this.getCashBalance(accounts[0].id);
      return cashBalance.tradeDate;
    }
    return null;
  }

  // ============================================
  // Utility Methods
  // ============================================

  /**
   * Check if market is open for a contract
   */
  async isMarketOpen(contractId) {
    try {
      const quote = await this.getQuote(contractId);
      return quote && quote.timestamp && (Date.now() - new Date(quote.timestamp).getTime()) < 60000;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get complete trade history for today
   */
  async getTodayTradeHistory(accountId) {
    const [fills, fillPairs, orders] = await Promise.all([
      this.getTodaysFills(accountId),
      this.getFillPairs(accountId),
      this.getOrdersByAccount(accountId)
    ]);

    const today = new Date().toISOString().split('T')[0];
    const todayOrders = orders.filter(o => o.timestamp && o.timestamp.startsWith(today));
    const todayFillPairs = fillPairs.filter(fp => fp.timestamp && fp.timestamp.startsWith(today));

    // Calculate statistics
    let totalPnL = 0;
    let wins = 0;
    let losses = 0;

    for (const fp of todayFillPairs) {
      if (fp.pnl !== undefined) {
        totalPnL += fp.pnl;
        if (fp.pnl > 0) wins++;
        else if (fp.pnl < 0) losses++;
      }
    }

    return {
      date: today,
      fills,
      fillPairs: todayFillPairs,
      orders: todayOrders,
      statistics: {
        totalTrades: todayFillPairs.length,
        wins,
        losses,
        winRate: todayFillPairs.length > 0 ? (wins / todayFillPairs.length) * 100 : 0,
        totalPnL,
        avgPnL: todayFillPairs.length > 0 ? totalPnL / todayFillPairs.length : 0
      }
    };
  }

  /**
   * Validate order parameters before submission
   */
  validateOrderParams(params) {
    const errors = [];

    if (!params.accountId) errors.push('accountId is required');
    if (!params.contractId) errors.push('contractId is required');
    if (!params.action || !['Buy', 'Sell'].includes(params.action)) {
      errors.push('action must be "Buy" or "Sell"');
    }
    if (!params.qty || params.qty < 1) errors.push('qty must be at least 1');
    if (params.orderType === 'Limit' && !params.price) {
      errors.push('price is required for Limit orders');
    }
    if (params.orderType === 'Stop' && !params.stopPrice) {
      errors.push('stopPrice is required for Stop orders');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Clear cached data
   */
  clearCache() {
    this.cache.accounts = null;
    this.cache.contracts.clear();
    this.cache.products.clear();
    this.cache.lastSync = null;
  }
}

module.exports = TradovateClient;
