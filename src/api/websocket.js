const WebSocket = require('ws');
const EventEmitter = require('events');
const { WEBSOCKET } = require('../utils/constants');

class TradovateWebSocket extends EventEmitter {
  constructor(auth, type = 'market', config = {}) {
    super();
    this.auth = auth;
    this.type = type; // 'market' or 'order'
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
   * Get WebSocket URL based on type
   */
  getWebSocketUrl() {
    const env = this.auth.config.env;
    
    if (this.type === 'market') {
      return env === 'demo' 
        ? 'wss://md-demo.tradovateapi.com/v1/websocket'
        : 'wss://md.tradovateapi.com/v1/websocket';
    } else {
      return env === 'demo'
        ? 'wss://demo.tradovateapi.com/v1/websocket'
        : 'wss://live.tradovateapi.com/v1/websocket';
    }
  }

  /**
   * Connect to WebSocket
   */
  async connect() {
    const url = this.getWebSocketUrl();
    const token = this.type === 'market' 
      ? await this.auth.getMdAccessToken()
      : await this.auth.getAccessToken();

    console.log(`[WebSocket:${this.type}] Connecting to ${url}...`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        console.log(`[WebSocket:${this.type}] ✓ Connected`);
        this.isConnected = true;
        
        // Authenticate with Bearer prefix
        this.send('authorize', { token: `Bearer ${token}` });
        
        // Start heartbeat
        this.startHeartbeat();
        
        this.emit('connected');
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          console.error(`[WebSocket:${this.type}] Parse error:`, error);
        }
      });

      this.ws.on('error', (error) => {
        console.error(`[WebSocket:${this.type}] Error:`, error.message);
        this.emit('error', error);
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
      
      // Re-subscribe to previous subscriptions
      console.log(`[WebSocket:${this.type}] Re-subscribing to ${this.subscriptions.size} subscriptions...`);
      for (const sub of this.subscriptions) {
        if (this.type === 'market') {
          this.send('md/subscribeQuote', sub);
        }
      }
      
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
   */
  send(action, data = {}) {
    if (!this.isConnected || !this.ws) {
      console.error(`[WebSocket:${this.type}] Cannot send - not connected`);
      return false;
    }

    const message = { action, ...data };
    this.ws.send(JSON.stringify(message));
    return true;
  }

  /**
   * Handle incoming WebSocket messages
   */
  handleMessage(message) {
    // Authorization response
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

    // Heartbeat response
    if (message.e === 'heartbeat') {
      // Silent - just keep connection alive
      return;
    }

    // Market data tick
    if (message.e === 'md/subscribeQuote') {
      this.emit('quote', message.d);
      return;
    }

    // Market data DOM (depth of market)
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

    // Generic event
    if (message.e) {
      this.emit('event', message);
    }
  }

  /**
   * Subscribe to real-time quotes for a contract
   */
  subscribeQuote(contractId) {
    console.log(`[WebSocket:${this.type}] Subscribing to quotes for contract ${contractId}`);
    const sub = { symbol: contractId };
    this.subscriptions.add(sub);
    this.send('md/subscribeQuote', sub);
  }

  /**
   * Subscribe to DOM (depth of market) for a contract
   */
  subscribeDom(contractId) {
    console.log(`[WebSocket:${this.type}] Subscribing to DOM for contract ${contractId}`);
    const sub = { symbol: contractId };
    this.subscriptions.add(sub);
    this.send('md/subscribeDom', sub);
  }

  /**
   * Unsubscribe from quotes
   */
  unsubscribeQuote(contractId) {
    this.send('md/unsubscribeQuote', { symbol: contractId });
  }

  /**
   * Start heartbeat to keep connection alive
   */
  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected) {
        this.send('heartbeat');
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
