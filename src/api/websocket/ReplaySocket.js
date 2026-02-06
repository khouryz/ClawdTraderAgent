/**
 * ReplaySocket - Market Replay WebSocket for Backtesting
 * 
 * Connects to Tradovate's Market Replay API to simulate historical trading
 * with realistic fills and market microstructure.
 * 
 * Replay URL: wss://replay.tradovateapi.com/v1/websocket
 */

const WebSocket = require('ws');
const EventEmitter = require('events');

class ReplaySocket extends EventEmitter {
  constructor(auth, config = {}) {
    super();
    this.auth = auth;
    this.ws = null;
    this.isConnected = false;
    this.isAuthorized = false;
    this.subscriptions = [];
    this.heartbeatInterval = null;
    this.requestCounter = 0;
    this.pendingRequests = new Map();
    
    this.config = {
      replayUrl: config.replayUrl || 'wss://replay.tradovateapi.com/v1/websocket',
      heartbeatInterval: config.heartbeatInterval || 2500,
      connectionTimeout: config.connectionTimeout || 15000,
      ...config
    };

    // Replay session state
    this.replaySession = {
      isActive: false,
      startTimestamp: null,
      speed: 400,
      initialBalance: 50000,
      currentTime: null
    };
  }

  /**
   * Get next request ID
   */
  _nextId() {
    return ++this.requestCounter;
  }

  /**
   * Connect to Replay WebSocket
   */
  async connect() {
    const url = this.config.replayUrl;
    console.log(`[ReplaySocket] Connecting to ${url}...`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', async () => {
        console.log('[ReplaySocket] ✓ Connected');
        this.isConnected = true;
        
        // Authorize with access token
        const token = await this.auth.getAccessToken();
        this._send(`authorize\n0\n\n${token}`);
        
        // Start heartbeat
        this._startHeartbeat();
      });

      this.ws.on('message', (data) => {
        this._handleMessage(data.toString(), resolve, reject);
      });

      this.ws.on('error', (error) => {
        console.error('[ReplaySocket] Error:', error.message);
        this.emit('error', error);
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[ReplaySocket] Disconnected (${code}): ${reason}`);
        this.isConnected = false;
        this.isAuthorized = false;
        this._stopHeartbeat();
        this.emit('disconnected', { code, reason });
      });

      // Connection timeout
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('ReplaySocket connection timeout'));
        }
      }, this.config.connectionTimeout);
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  _handleMessage(data, connectResolve, connectReject) {
    const kind = data.slice(0, 1);

    switch (kind) {
      case 'o':
        // Connection opened - already handled in 'open' event
        break;

      case 'h':
        // Heartbeat response
        break;

      case 'a':
        // Data message
        try {
          const parsed = JSON.parse(data.slice(1));
          this._processDataMessages(parsed, connectResolve, connectReject);
        } catch (err) {
          console.error('[ReplaySocket] Parse error:', err);
        }
        break;

      case 'c':
        // Connection closed by server
        this._stopHeartbeat();
        break;

      default:
        console.log('[ReplaySocket] Unknown message type:', kind, data);
    }
  }

  /**
   * Process parsed data messages
   */
  _processDataMessages(messages, connectResolve, connectReject) {
    messages.forEach(msg => {
      // Authorization response
      if (msg.i === 0 && msg.s === 200) {
        console.log('[ReplaySocket] ✓ Authorized');
        this.isAuthorized = true;
        this.emit('authorized');
        if (connectResolve) connectResolve();
        return;
      }

      // Authorization failed
      if (msg.i === 0 && msg.s !== 200) {
        console.error('[ReplaySocket] ✗ Authorization failed:', msg);
        this.emit('authFailed', msg);
        if (connectReject) connectReject(new Error('Authorization failed'));
        return;
      }

      // Handle pending request responses
      if (msg.i && this.pendingRequests.has(msg.i)) {
        const { resolve, reject } = this.pendingRequests.get(msg.i);
        this.pendingRequests.delete(msg.i);
        
        if (msg.s === 200) {
          resolve(msg.d);
        } else {
          reject(new Error(msg.d || `Request failed with status ${msg.s}`));
        }
        return;
      }

      // Clock tick events
      if (msg.e === 'clock') {
        this._handleClockTick(msg.d);
        return;
      }

      // Chart data
      if (msg.e === 'chart') {
        this.emit('chart', msg.d);
        return;
      }

      // Quote data
      if (msg.e === 'md') {
        if (msg.d.quotes) {
          msg.d.quotes.forEach(quote => this.emit('quote', quote));
        }
        if (msg.d.doms) {
          msg.d.doms.forEach(dom => this.emit('dom', dom));
        }
        return;
      }

      // Props (entity updates)
      if (msg.e === 'props') {
        this.emit('props', msg.d);
        return;
      }
    });
  }

  /**
   * Handle clock tick during replay
   */
  _handleClockTick(data) {
    try {
      const { t, s } = typeof data === 'string' ? JSON.parse(data) : data;
      this.replaySession.currentTime = new Date(t);
      this.emit('clock', { timestamp: t, speed: s });
    } catch (err) {
      console.error('[ReplaySocket] Clock parse error:', err);
    }
  }

  /**
   * Send raw message to WebSocket
   */
  _send(message) {
    if (!this.isConnected || !this.ws) {
      console.error('[ReplaySocket] Cannot send - not connected');
      return false;
    }
    this.ws.send(message);
    return true;
  }

  /**
   * Make a request and wait for response
   */
  request(url, body = {}) {
    return new Promise((resolve, reject) => {
      const id = this._nextId();
      
      this.pendingRequests.set(id, { resolve, reject });
      
      const message = `${url}\n${id}\n\n${JSON.stringify(body)}`;
      this._send(message);

      // Timeout for request
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request timeout: ${url}`));
        }
      }, 30000);
    });
  }

  /**
   * Check if replay session is available for given timestamp
   * @param {string} startTimestamp - ISO timestamp to start replay
   */
  async checkReplaySession(startTimestamp) {
    console.log(`[ReplaySocket] Checking replay session for ${startTimestamp}...`);
    
    const result = await this.request('replay/checkReplaySession', {
      startTimestamp
    });

    if (result.checkStatus === 'OK') {
      console.log('[ReplaySocket] ✓ Replay session available');
      return { available: true, ...result };
    } else {
      console.warn('[ReplaySocket] ✗ Replay session not available:', result);
      return { available: false, ...result };
    }
  }

  /**
   * Initialize replay clock
   * @param {Object} options - Replay options
   * @param {string} options.startTimestamp - ISO timestamp to start
   * @param {number} options.speed - Replay speed (default 400)
   * @param {number} options.initialBalance - Starting balance (default 50000)
   */
  async initializeClock(options) {
    const {
      startTimestamp,
      speed = 400,
      initialBalance = 50000
    } = options;

    console.log(`[ReplaySocket] Initializing clock at ${startTimestamp} (speed: ${speed}x)...`);

    const result = await this.request('replay/initializeClock', {
      startTimestamp,
      speed,
      initialBalance
    });

    this.replaySession = {
      isActive: true,
      startTimestamp,
      speed,
      initialBalance,
      currentTime: new Date(startTimestamp)
    };

    console.log('[ReplaySocket] ✓ Clock initialized');
    this.emit('clockInitialized', this.replaySession);

    return result;
  }

  /**
   * Get account list for replay session
   */
  async getAccounts() {
    return this.request('account/list', {});
  }

  /**
   * Synchronize user data
   * @param {number} accountId - Account ID to sync
   */
  async synchronize(accountId) {
    return this.request('user/syncrequest', {
      accounts: [accountId]
    });
  }

  /**
   * Subscribe to quote data
   * @param {string} symbol - Contract symbol
   */
  subscribeQuote(symbol) {
    console.log(`[ReplaySocket] Subscribing to quotes for ${symbol}...`);
    
    const id = this._nextId();
    const message = `md/subscribeQuote\n${id}\n\n${JSON.stringify({ symbol })}`;
    this._send(message);
    
    this.subscriptions.push({ type: 'quote', symbol });
    return () => this.unsubscribeQuote(symbol);
  }

  /**
   * Unsubscribe from quote data
   */
  unsubscribeQuote(symbol) {
    const id = this._nextId();
    const message = `md/unsubscribeQuote\n${id}\n\n${JSON.stringify({ symbol })}`;
    this._send(message);
    
    this.subscriptions = this.subscriptions.filter(
      s => !(s.type === 'quote' && s.symbol === symbol)
    );
  }

  /**
   * Subscribe to chart data
   * @param {Object} options - Chart subscription options
   */
  subscribeChart(options) {
    const {
      symbol,
      chartDescription,
      timeRange
    } = options;

    console.log(`[ReplaySocket] Subscribing to chart for ${symbol}...`);

    const id = this._nextId();
    const body = {
      symbol,
      chartDescription,
      timeRange
    };

    const message = `md/getChart\n${id}\n\n${JSON.stringify(body)}`;
    this._send(message);

    this.subscriptions.push({ type: 'chart', symbol, id });
    
    return () => this.cancelChart(id);
  }

  /**
   * Cancel chart subscription
   */
  cancelChart(subscriptionId) {
    const id = this._nextId();
    const message = `md/cancelChart\n${id}\n\n${JSON.stringify({ subscriptionId })}`;
    this._send(message);
    
    this.subscriptions = this.subscriptions.filter(
      s => !(s.type === 'chart' && s.id === subscriptionId)
    );
  }

  /**
   * Place an order during replay
   * @param {Object} order - Order parameters
   */
  async placeOrder(order) {
    return this.request('order/placeOrder', {
      accountSpec: order.accountSpec,
      accountId: order.accountId,
      action: order.action,
      symbol: order.symbol,
      orderQty: order.orderQty,
      orderType: order.orderType,
      price: order.price,
      stopPrice: order.stopPrice,
      isAutomated: true
    });
  }

  /**
   * Place bracket order during replay
   * @param {Object} options - Bracket order options
   */
  async placeBracketOrder(options) {
    const {
      accountId,
      accountSpec,
      symbol,
      action,
      qty,
      stopLoss,
      profitTarget
    } = options;

    const orderData = {
      entryVersion: {
        orderQty: qty,
        orderType: 'Market'
      },
      brackets: [{
        qty,
        profitTarget,
        stopLoss,
        trailingStop: false
      }]
    };

    return this.request('orderStrategy/startOrderStrategy', {
      accountId,
      accountSpec,
      symbol,
      action,
      orderStrategyTypeId: 2,
      params: JSON.stringify(orderData)
    });
  }

  /**
   * Start heartbeat
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected) {
        this._send('[]');
      }
    }, this.config.heartbeatInterval);
  }

  /**
   * Stop heartbeat
   */
  _stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect() {
    console.log('[ReplaySocket] Disconnecting...');
    
    // Unsubscribe from all
    this.subscriptions.forEach(sub => {
      if (sub.type === 'quote') this.unsubscribeQuote(sub.symbol);
      if (sub.type === 'chart') this.cancelChart(sub.id);
    });
    this.subscriptions = [];
    
    this._stopHeartbeat();
    
    if (this.ws) {
      this.ws.close(1000, 'Client initiated disconnect');
      this.ws = null;
    }
    
    this.isConnected = false;
    this.isAuthorized = false;
    this.replaySession.isActive = false;
  }

  /**
   * Get current replay session state
   */
  getSessionState() {
    return { ...this.replaySession };
  }
}

module.exports = ReplaySocket;
