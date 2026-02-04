const WebSocket = require('ws');
const EventEmitter = require('events');

class TradovateWebSocket extends EventEmitter {
  constructor(auth, type = 'market') {
    super();
    this.auth = auth;
    this.type = type; // 'market' or 'order'
    this.ws = null;
    this.isConnected = false;
    this.subscriptions = new Set();
    this.heartbeatInterval = null;
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
        
        // Authenticate
        this.send('authorize', { token });
        
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
        this.stopHeartbeat();
        this.emit('disconnected', { code, reason });
        
        // Auto-reconnect after 5 seconds
        setTimeout(() => this.reconnect(), 5000);
      });

      // Timeout if connection takes too long
      setTimeout(() => {
        if (!this.isConnected) {
          reject(new Error('WebSocket connection timeout'));
        }
      }, 10000);
    });
  }

  /**
   * Reconnect to WebSocket
   */
  async reconnect() {
    console.log(`[WebSocket:${this.type}] Reconnecting...`);
    try {
      await this.connect();
      
      // Re-subscribe to previous subscriptions
      for (const sub of this.subscriptions) {
        this.send('subscribe', sub);
      }
    } catch (error) {
      console.error(`[WebSocket:${this.type}] Reconnect failed:`, error.message);
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
      this.emit('authorized');
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
    }, 2500); // Every 2.5 seconds
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
    if (this.ws) {
      this.stopHeartbeat();
      this.ws.close();
      this.ws = null;
      this.isConnected = false;
    }
  }
}

module.exports = TradovateWebSocket;
