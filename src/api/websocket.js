const WebSocket = require('ws');
const EventEmitter = require('events');
const { WEBSOCKET } = require('../utils/constants');

class TradovateWebSocket extends EventEmitter {
  constructor(auth, type = 'order', config = {}) {
    super();
    this.auth = auth;
    this.type = type; // 'order' only - market data now handled by Databento
    this.ws = null;
    this.isConnected = false;
    this.isAuthorized = false;
    this.subscriptions = new Set();
    this.heartbeatInterval = null;
    
    // Reconnection config with exponential backoff
    this.config = {
      maxReconnectAttempts: config.maxReconnectAttempts || WEBSOCKET.MAX_RECONNECT_ATTEMPTS,
      initialReconnectDelay: config.initialReconnectDelay || WEBSOCKET.INITIAL_RECONNECT_DELAY,
      maxReconnectDelay: config.maxReconnectDelay || WEBSOCKET.MAX_RECONNECT_DELAY,
      reconnectBackoffMultiplier: config.reconnectBackoffMultiplier || WEBSOCKET.RECONNECT_BACKOFF_MULTIPLIER,
      connectionTimeout: config.connectionTimeout || WEBSOCKET.CONNECTION_TIMEOUT,
      ...config
    };
    
    this.reconnectAttempts = 0;
    this.reconnectDelay = this.config.initialReconnectDelay;
    this.shouldReconnect = true;
  }

  /**
   * Get WebSocket URL for order execution
   * Market data is now handled by Databento - this WebSocket is for orders only
   */
  getWebSocketUrl() {
    const env = this.auth.config.env;
    return env === 'demo'
      ? 'wss://demo.tradovateapi.com/v1/websocket'
      : 'wss://live.tradovateapi.com/v1/websocket';
  }

  /**
   * Connect to WebSocket (order execution only)
   */
  async connect() {
    const url = this.getWebSocketUrl();
    const token = await this.auth.getAccessToken();

    console.log(`[WebSocket:${this.type}] Connecting to ${url}...`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        console.log(`[WebSocket:${this.type}] ✓ Connected`);
        this.isConnected = true;
        // Don't authenticate yet - wait for 'o' frame
      });

      this.ws.on('message', (data) => {
        const dataStr = data.toString();
        
        // Handle Tradovate WebSocket protocol messages
        // 'o' = open frame, 'h' = heartbeat, 'c' = close frame
        if (dataStr === 'o') {
          console.log(`[WebSocket:${this.type}] ✓ Connection frame received`);
          // NOW authenticate after receiving open frame
          // Tradovate expects: authorize\n0\n\nTOKEN (token as plain string, not JSON)
          // Use ID 0 for auth, start subscription IDs at 1
          this._messageId = 1;
          this.ws.send(`authorize\n0\n\n${token}`);
          // Start heartbeat
          this.startHeartbeat();
          this.emit('connected');
          resolve();
          return;
        }
        if (dataStr === 'h') {
          // Heartbeat from server, ignore silently
          return;
        }
        if (dataStr.startsWith('c[')) {
          console.log(`[WebSocket:${this.type}] Close frame received`);
          return;
        }
        
        // Handle array-wrapped messages (Tradovate format: a[{...}])
        if (dataStr.startsWith('a[')) {
          try {
            const arr = JSON.parse(dataStr.substring(1));
            // Process each message in the array
            for (const item of arr) {
              if (typeof item === 'object') {
                this.handleMessage(item);
              } else if (typeof item === 'string') {
                try {
                  const parsed = JSON.parse(item);
                  this.handleMessage(parsed);
                } catch (e) {
                  // Not JSON, ignore
                }
              }
            }
          } catch (e) {
            console.error(`[WebSocket:${this.type}] Failed to parse array frame:`, e.message);
          }
          return;
        }
        
        // Try to parse as plain JSON
        try {
          const message = JSON.parse(dataStr);
          this.handleMessage(message);
        } catch (error) {
          // Unknown message format, log only if significant
          if (dataStr.length > 2) {
            console.log(`[WebSocket:${this.type}] Unknown message:`, dataStr.substring(0, 50));
          }
        }
      });

      this.ws.on('error', (error) => {
        console.error(`[WebSocket:${this.type}] Error:`, error.message);
        // Don't emit error event to prevent crash - just log and let reconnect handle it
        this.isConnected = false;
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[WebSocket:${this.type}] Disconnected (${code}): ${reason}`);
        this.isConnected = false;
        this.isAuthorized = false;
        this.stopHeartbeat();
        this.emit('disconnected', { code, reason });
        
        // Auto-reconnect with exponential backoff
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      // Timeout if connection takes too long
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('WebSocket connection timeout'));
        }
      }, WEBSOCKET.CONNECTION_TIMEOUT);
    });
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error(`[WebSocket:${this.type}] Max reconnection attempts (${this.config.maxReconnectAttempts}) reached. Giving up.`);
      this.emit('maxReconnectAttemptsReached', { attempts: this.reconnectAttempts });
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay,
      this.config.maxReconnectDelay
    );

    console.log(`[WebSocket:${this.type}] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})...`);
    this.emit('reconnecting', { attempt: this.reconnectAttempts, delay });

    setTimeout(() => this.reconnect(), delay);

    // Increase delay for next attempt (exponential backoff)
    this.reconnectDelay = Math.min(
      this.reconnectDelay * this.config.reconnectBackoffMultiplier,
      this.config.maxReconnectDelay
    );
  }

  /**
   * Reconnect to WebSocket
   * HIGH-4 FIX: Added position sync callback for order WebSocket reconnects
   */
  async reconnect() {
    try {
      await this.connect();
      
      // Reset reconnection state on successful connect
      this.reconnectAttempts = 0;
      this.reconnectDelay = this.config.initialReconnectDelay;
      
      // HIGH-4 FIX: Emit reconnected event with type so bot can sync position state
      this.emit('reconnected', { 
        subscriptions: this.subscriptions.size,
        type: this.type,
        requiresPositionSync: this.type === 'order'
      });
    } catch (error) {
      console.error(`[WebSocket:${this.type}] Reconnect failed:`, error.message);
      // Schedule another reconnect attempt
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Send a message to the WebSocket
   * Tradovate WebSocket format: "endpoint\nid\nquery\nbody"
   */
  send(endpoint, body = '', id = null, query = '') {
    if (!this.isConnected || !this.ws) {
      console.error(`[WebSocket:${this.type}] Cannot send - not connected`);
      return false;
    }

    // Tradovate uses a specific message format: url\nid\nquery\nbody
    const msgId = id !== null ? id : this._getNextId();
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const message = `${endpoint}\n${msgId}\n${query}\n${bodyStr}`;
    this.ws.send(message);
    return true;
  }

  /**
   * Get next message ID
   */
  _getNextId() {
    if (!this._messageId) this._messageId = 0;
    return this._messageId++;
  }

  /**
   * Handle incoming WebSocket messages
   */
  handleMessage(message) {
    // Debug: log all messages
    console.log(`[WebSocket:${this.type}] MSG:`, JSON.stringify(message).substring(0, 150));

    // Authorization response (i === 0 is the auth request)
    if (message.s === 200 && message.i === 0) {
      console.log(`[WebSocket:${this.type}] ✓ Authorized`);
      this.isAuthorized = true;
      this.emit('authorized');
      return;
    }

    // Authorization failed
    if (message.s && message.s !== 200 && message.i === 0) {
      console.error(`[WebSocket:${this.type}] ✗ Authorization failed:`, message);
      this.emit('authFailed', message);
      return;
    }

    // Subscription confirmation (i > 0 with s === 200)
    if (message.s === 200 && message.i > 0) {
      // This is a subscription confirmation, not auth
      console.log(`[WebSocket:${this.type}] ✓ Subscription response:`, JSON.stringify(message.d || {}).substring(0, 200));
      return;
    }

    // Market data event (e === 'md') with quotes
    if (message.e === 'md' && message.d && message.d.quotes && Array.isArray(message.d.quotes)) {
      message.d.quotes.forEach(quote => this.emit('quote', quote));
      return;
    }

    // Quote data comes in d.quotes array (without e field)
    if (message.d && message.d.quotes && Array.isArray(message.d.quotes)) {
      message.d.quotes.forEach(quote => this.emit('quote', quote));
      return;
    }

    // DOM data comes in d.doms array
    if (message.d && message.d.doms && Array.isArray(message.d.doms)) {
      message.d.doms.forEach(dom => this.emit('dom', dom));
      return;
    }

    // Chart data comes in d.charts array
    if (message.d && message.d.charts && Array.isArray(message.d.charts)) {
      message.d.charts.forEach(chart => this.emit('chart', chart));
      return;
    }

    // Heartbeat response
    if (message.e === 'heartbeat') {
      return;
    }

    // Event-based messages (e field)
    if (message.e === 'md/subscribeQuote') {
      this.emit('quote', message.d);
      return;
    }

    if (message.e === 'md/subscribeDom') {
      this.emit('dom', message.d);
      return;
    }

    // Order updates
    if (message.e === 'order') {
      this.emit('order', message.d);
      return;
    }

    // Position updates
    if (message.e === 'position') {
      this.emit('position', message.d);
      return;
    }

    // Fill updates
    if (message.e === 'fill') {
      this.emit('fill', message.d);
      return;
    }

    // Props event (user data sync)
    if (message.e === 'props') {
      this.emit('props', message.d);
      return;
    }

    // Quote data (Tradovate sends as 'quote' or 'quotes' event)
    if (message.e === 'quote' || message.e === 'quotes') {
      this.emit('quote', message.d);
      return;
    }

    // Chart/bar data
    if (message.e === 'chart' || message.e === 'md/getChart') {
      this.emit('chart', message.d);
      return;
    }

    // Generic event - log for debugging
    if (message.e) {
      console.log(`[WebSocket:${this.type}] Event: ${message.e}`);
      this.emit('event', message);
    } else if (message.d) {
      // Some messages have data without event name
      console.log(`[WebSocket:${this.type}] Data received:`, JSON.stringify(message).substring(0, 100));
    }
  }

  /**
   * Synchronize user data (required before market data subscriptions)
   * @param {number} accountId - Account ID to sync
   */
  synchronize(accountId) {
    console.log(`[WebSocket:${this.type}] Syncing user data for account ${accountId}`);
    this.send('user/syncrequest', { accounts: [accountId] });
  }

  /**
   * Start heartbeat to keep connection alive
   * Tradovate uses empty array [] as heartbeat
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected && this.ws) {
        // Tradovate heartbeat is just an empty array
        this.ws.send('[]');
      }
    }, WEBSOCKET.HEARTBEAT_INTERVAL);
  }

  /**
   * Stop heartbeat
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Disconnect from WebSocket
   */
  disconnect() {
    this.shouldReconnect = false;
    if (this.ws) {
      this.stopHeartbeat();
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
      this.isAuthorized = false;
    }
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      type: this.type,
      connected: this.isConnected,
      authorized: this.isAuthorized,
      subscriptions: this.subscriptions.size,
      reconnectAttempts: this.reconnectAttempts,
      shouldReconnect: this.shouldReconnect
    };
  }

  /**
   * Reset reconnection state (call after manual reconnect)
   */
  resetReconnectState() {
    this.reconnectAttempts = 0;
    this.reconnectDelay = this.config.initialReconnectDelay;
    this.shouldReconnect = true;
  }
}

module.exports = TradovateWebSocket;
