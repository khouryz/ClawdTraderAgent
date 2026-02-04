/**
 * Order Manager
 * Handles order lifecycle, confirmation, state tracking, partial fills, and retry logic
 */

const EventEmitter = require('events');

// Order states
const OrderState = {
  PENDING: 'PENDING',           // Order created but not yet sent
  SUBMITTED: 'SUBMITTED',       // Order sent to exchange
  WORKING: 'WORKING',           // Order acknowledged by exchange
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED'              // Failed to submit
};

// Order types
const OrderType = {
  MARKET: 'Market',
  LIMIT: 'Limit',
  STOP: 'Stop',
  STOP_LIMIT: 'StopLimit'
};

// Order actions
const OrderAction = {
  BUY: 'Buy',
  SELL: 'Sell'
};

class Order {
  constructor(params) {
    this.id = params.id || null;                    // Exchange order ID
    this.clientId = params.clientId || this.generateClientId();
    this.accountId = params.accountId;
    this.contractId = params.contractId;
    this.action = params.action;                    // Buy or Sell
    this.type = params.type || OrderType.MARKET;
    this.quantity = params.quantity;
    this.filledQuantity = 0;
    this.remainingQuantity = params.quantity;
    this.price = params.price || null;              // For limit orders
    this.stopPrice = params.stopPrice || null;      // For stop orders
    this.state = OrderState.PENDING;
    this.fills = [];                                // Array of fill events
    this.averageFillPrice = null;
    this.bracket = params.bracket || null;          // { stopLoss, takeProfit }
    this.parentOrderId = params.parentOrderId || null;
    this.childOrders = [];                          // For bracket orders
    this.createdAt = new Date();
    this.updatedAt = new Date();
    this.submittedAt = null;
    this.filledAt = null;
    this.cancelledAt = null;
    this.rejectedAt = null;
    this.rejectReason = null;
    this.retryCount = 0;
    this.maxRetries = params.maxRetries || 3;
    this.isAutomated = true;
  }

  generateClientId() {
    return `CLO_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  updateState(newState, details = {}) {
    const oldState = this.state;
    this.state = newState;
    this.updatedAt = new Date();

    if (newState === OrderState.SUBMITTED) {
      this.submittedAt = new Date();
    } else if (newState === OrderState.FILLED) {
      this.filledAt = new Date();
    } else if (newState === OrderState.CANCELLED) {
      this.cancelledAt = new Date();
    } else if (newState === OrderState.REJECTED) {
      this.rejectedAt = new Date();
      this.rejectReason = details.reason || 'Unknown';
    }

    return { oldState, newState, details };
  }

  addFill(fill) {
    this.fills.push({
      ...fill,
      timestamp: new Date()
    });

    this.filledQuantity += fill.quantity;
    this.remainingQuantity = this.quantity - this.filledQuantity;

    // Calculate average fill price
    const totalValue = this.fills.reduce((sum, f) => sum + (f.price * f.quantity), 0);
    this.averageFillPrice = totalValue / this.filledQuantity;

    // Update state
    if (this.remainingQuantity === 0) {
      this.updateState(OrderState.FILLED);
    } else if (this.filledQuantity > 0) {
      this.updateState(OrderState.PARTIALLY_FILLED);
    }
  }

  canRetry() {
    return this.retryCount < this.maxRetries && 
           (this.state === OrderState.FAILED || this.state === OrderState.REJECTED);
  }

  toJSON() {
    return {
      id: this.id,
      clientId: this.clientId,
      accountId: this.accountId,
      contractId: this.contractId,
      action: this.action,
      type: this.type,
      quantity: this.quantity,
      filledQuantity: this.filledQuantity,
      remainingQuantity: this.remainingQuantity,
      price: this.price,
      stopPrice: this.stopPrice,
      state: this.state,
      averageFillPrice: this.averageFillPrice,
      bracket: this.bracket,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      submittedAt: this.submittedAt,
      filledAt: this.filledAt,
      retryCount: this.retryCount
    };
  }
}

class OrderManager extends EventEmitter {
  constructor(client, config = {}) {
    super();
    this.client = client;
    this.config = {
      maxRetries: config.maxRetries || 3,
      retryDelayMs: config.retryDelayMs || 1000,
      retryBackoffMultiplier: config.retryBackoffMultiplier || 2,
      confirmationTimeoutMs: config.confirmationTimeoutMs || 10000,
      ...config
    };

    this.orders = new Map();              // clientId -> Order
    this.ordersByExchangeId = new Map();  // exchangeId -> Order
    this.pendingConfirmations = new Map(); // clientId -> { timeout, resolve, reject }
    this.activePosition = null;
  }

  /**
   * Create and submit a market order
   */
  async placeMarketOrder(accountId, contractId, quantity, action, bracket = null) {
    const order = new Order({
      accountId,
      contractId,
      quantity,
      action,
      type: OrderType.MARKET,
      bracket,
      maxRetries: this.config.maxRetries
    });

    return this.submitOrder(order);
  }

  /**
   * Create and submit a limit order
   */
  async placeLimitOrder(accountId, contractId, quantity, action, price, bracket = null) {
    const order = new Order({
      accountId,
      contractId,
      quantity,
      action,
      type: OrderType.LIMIT,
      price,
      bracket,
      maxRetries: this.config.maxRetries
    });

    return this.submitOrder(order);
  }

  /**
   * Create and submit a bracket order (entry + stop + target)
   */
  async placeBracketOrder(accountId, contractId, quantity, action, stopLoss, takeProfit) {
    const order = new Order({
      accountId,
      contractId,
      quantity,
      action,
      type: OrderType.MARKET,
      bracket: { stopLoss, takeProfit },
      maxRetries: this.config.maxRetries
    });

    return this.submitOrder(order);
  }

  /**
   * Submit an order to the exchange
   */
  async submitOrder(order) {
    this.orders.set(order.clientId, order);
    this.emit('orderCreated', order);

    try {
      order.updateState(OrderState.SUBMITTED);
      this.emit('orderSubmitted', order);

      let response;
      
      if (order.bracket) {
        // Place bracket order
        response = await this.client.placeBracketOrder(
          order.accountId,
          order.contractId,
          order.quantity,
          order.action,
          order.bracket.stopLoss,
          order.bracket.takeProfit
        );
      } else if (order.type === OrderType.LIMIT) {
        response = await this.client.placeLimitOrder(
          order.accountId,
          order.contractId,
          order.quantity,
          order.action,
          order.price
        );
      } else {
        response = await this.client.placeMarketOrder(
          order.accountId,
          order.contractId,
          order.quantity,
          order.action
        );
      }

      // Update order with exchange ID
      if (response && response.orderId) {
        order.id = response.orderId;
        this.ordersByExchangeId.set(response.orderId, order);
        order.updateState(OrderState.WORKING);
        this.emit('orderWorking', order);
      }

      // Wait for fill confirmation
      const confirmed = await this.waitForConfirmation(order);
      return confirmed;

    } catch (error) {
      console.error(`[OrderManager] Order submission failed: ${error.message}`);
      order.updateState(OrderState.FAILED, { reason: error.message });
      this.emit('orderFailed', order, error);

      // Retry if possible
      if (order.canRetry()) {
        return this.retryOrder(order);
      }

      throw error;
    }
  }

  /**
   * Wait for order confirmation with timeout
   */
  async waitForConfirmation(order) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingConfirmations.delete(order.clientId);
        
        // Check if order was filled while waiting
        if (order.state === OrderState.FILLED) {
          resolve(order);
        } else {
          console.warn(`[OrderManager] Order confirmation timeout for ${order.clientId}`);
          this.emit('confirmationTimeout', order);
          resolve(order); // Resolve anyway, let caller handle state
        }
      }, this.config.confirmationTimeoutMs);

      this.pendingConfirmations.set(order.clientId, {
        timeout,
        resolve,
        reject,
        order
      });
    });
  }

  /**
   * Retry a failed order with exponential backoff
   */
  async retryOrder(order) {
    order.retryCount++;
    const delay = this.config.retryDelayMs * 
                  Math.pow(this.config.retryBackoffMultiplier, order.retryCount - 1);

    console.log(`[OrderManager] Retrying order ${order.clientId} in ${delay}ms (attempt ${order.retryCount}/${order.maxRetries})`);
    this.emit('orderRetrying', order, order.retryCount);

    await this.sleep(delay);

    // Reset state for retry
    order.updateState(OrderState.PENDING);
    
    return this.submitOrder(order);
  }

  /**
   * Handle order update from WebSocket
   */
  handleOrderUpdate(update) {
    const order = this.ordersByExchangeId.get(update.orderId) || 
                  this.findOrderByClientId(update.clOrdId);

    if (!order) {
      console.warn(`[OrderManager] Received update for unknown order: ${update.orderId}`);
      return;
    }

    const oldState = order.state;

    // Map Tradovate order status to our states
    switch (update.ordStatus) {
      case 'PendingNew':
      case 'PendingSubmit':
        order.updateState(OrderState.SUBMITTED);
        break;
      case 'Working':
      case 'Accepted':
        order.updateState(OrderState.WORKING);
        break;
      case 'Filled':
        order.updateState(OrderState.FILLED);
        break;
      case 'Cancelled':
      case 'Canceled':
        order.updateState(OrderState.CANCELLED);
        break;
      case 'Rejected':
        order.updateState(OrderState.REJECTED, { reason: update.rejectReason });
        break;
      case 'Expired':
        order.updateState(OrderState.EXPIRED);
        break;
    }

    if (oldState !== order.state) {
      this.emit('orderStateChanged', order, oldState, order.state);
    }

    // Resolve pending confirmation if filled
    if (order.state === OrderState.FILLED) {
      this.resolveConfirmation(order);
    }

    this.emit('orderUpdated', order, update);
  }

  /**
   * Handle fill notification from WebSocket
   */
  handleFill(fill) {
    const order = this.ordersByExchangeId.get(fill.orderId);

    if (!order) {
      console.warn(`[OrderManager] Received fill for unknown order: ${fill.orderId}`);
      return;
    }

    order.addFill({
      quantity: fill.qty,
      price: fill.price,
      commission: fill.commission || 0,
      exchangeOrderId: fill.orderId
    });

    this.emit('orderFill', order, fill);

    // If fully filled, resolve confirmation
    if (order.state === OrderState.FILLED) {
      this.resolveConfirmation(order);
    }

    return order;
  }

  /**
   * Resolve a pending confirmation
   */
  resolveConfirmation(order) {
    const pending = this.pendingConfirmations.get(order.clientId);
    if (pending) {
      clearTimeout(pending.timeout);
      pending.resolve(order);
      this.pendingConfirmations.delete(order.clientId);
    }
  }

  /**
   * Cancel an order
   */
  async cancelOrder(order) {
    if (!order.id) {
      throw new Error('Cannot cancel order without exchange ID');
    }

    if (order.state === OrderState.FILLED || 
        order.state === OrderState.CANCELLED) {
      throw new Error(`Cannot cancel order in state: ${order.state}`);
    }

    try {
      await this.client.cancelOrder(order.id);
      order.updateState(OrderState.CANCELLED);
      this.emit('orderCancelled', order);
      return order;
    } catch (error) {
      console.error(`[OrderManager] Cancel failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Cancel all working orders
   */
  async cancelAllOrders() {
    const workingOrders = Array.from(this.orders.values())
      .filter(o => o.state === OrderState.WORKING || o.state === OrderState.PARTIALLY_FILLED);

    const results = await Promise.allSettled(
      workingOrders.map(order => this.cancelOrder(order))
    );

    return results;
  }

  /**
   * Find order by client ID
   */
  findOrderByClientId(clientId) {
    return this.orders.get(clientId);
  }

  /**
   * Get all orders
   */
  getAllOrders() {
    return Array.from(this.orders.values());
  }

  /**
   * Get orders by state
   */
  getOrdersByState(state) {
    return Array.from(this.orders.values()).filter(o => o.state === state);
  }

  /**
   * Get working orders
   */
  getWorkingOrders() {
    return this.getOrdersByState(OrderState.WORKING)
      .concat(this.getOrdersByState(OrderState.PARTIALLY_FILLED));
  }

  /**
   * Check if there are any working orders
   */
  hasWorkingOrders() {
    return this.getWorkingOrders().length > 0;
  }

  /**
   * Get order statistics
   */
  getStats() {
    const orders = this.getAllOrders();
    return {
      total: orders.length,
      pending: orders.filter(o => o.state === OrderState.PENDING).length,
      working: orders.filter(o => o.state === OrderState.WORKING).length,
      partiallyFilled: orders.filter(o => o.state === OrderState.PARTIALLY_FILLED).length,
      filled: orders.filter(o => o.state === OrderState.FILLED).length,
      cancelled: orders.filter(o => o.state === OrderState.CANCELLED).length,
      rejected: orders.filter(o => o.state === OrderState.REJECTED).length,
      failed: orders.filter(o => o.state === OrderState.FAILED).length
    };
  }

  /**
   * Clear old orders from memory
   */
  cleanup(maxAgeMs = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;

    for (const [clientId, order] of this.orders) {
      const age = now - order.createdAt.getTime();
      const isTerminal = [OrderState.FILLED, OrderState.CANCELLED, 
                          OrderState.REJECTED, OrderState.EXPIRED, 
                          OrderState.FAILED].includes(order.state);

      if (isTerminal && age > maxAgeMs) {
        this.orders.delete(clientId);
        if (order.id) {
          this.ordersByExchangeId.delete(order.id);
        }
        cleaned++;
      }
    }

    if (cleaned > 0) {
      console.log(`[OrderManager] Cleaned up ${cleaned} old orders`);
    }

    return cleaned;
  }

  /**
   * Sleep helper
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { OrderManager, Order, OrderState, OrderType, OrderAction };
