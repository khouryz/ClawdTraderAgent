/**
 * Base Strategy Class
 * All trading strategies should extend this class
 */

const EventEmitter = require('events');

class BaseStrategy extends EventEmitter {
  constructor(name, config) {
    super();
    this.name = name;
    this.config = config;
    this.position = null;
    this.isActive = false;
    this.bars = [];
    this.currentQuote = null;
  }

  /**
   * Initialize the strategy
   */
  async initialize() {
    console.log(`[Strategy:${this.name}] Initializing...`);
    this.isActive = true;
    this.emit('initialized');
  }

  /**
   * Stop the strategy
   */
  stop() {
    console.log(`[Strategy:${this.name}] Stopping...`);
    this.isActive = false;
    this.emit('stopped');
  }

  /**
   * Update with new quote data
   */
  onQuote(quote) {
    this.currentQuote = quote;
    if (this.isActive) {
      this.analyze();
    }
  }

  /**
   * Update with new bar data
   */
  onBar(bar) {
    this.bars.push(bar);
    // Keep only last 100 bars
    if (this.bars.length > 100) {
      this.bars.shift();
    }
    if (this.isActive) {
      this.analyze();
    }
  }

  /**
   * Analyze market data and generate signals
   * Override this in child classes
   */
  analyze() {
    throw new Error('analyze() must be implemented by child class');
  }

  /**
   * Generate a buy signal
   */
  signalBuy(price, stopLoss) {
    if (!this.isActive || this.position) return;

    console.log(`[Strategy:${this.name}] 🟢 BUY SIGNAL at ${price}`);
    this.emit('signal', {
      type: 'buy',
      price,
      stopLoss,
      timestamp: new Date()
    });
  }

  /**
   * Generate a sell signal
   */
  signalSell(price, stopLoss) {
    if (!this.isActive || this.position) return;

    console.log(`[Strategy:${this.name}] 🔴 SELL SIGNAL at ${price}`);
    this.emit('signal', {
      type: 'sell',
      price,
      stopLoss,
      timestamp: new Date()
    });
  }

  /**
   * Update position status
   */
  setPosition(position) {
    this.position = position;
    if (position) {
      console.log(`[Strategy:${this.name}] Position opened: ${position.side} ${position.quantity}@${position.price}`);
    } else {
      console.log(`[Strategy:${this.name}] Position closed`);
    }
  }

  /**
   * Get current market price
   */
  getCurrentPrice() {
    return this.currentQuote?.last || this.currentQuote?.bid || null;
  }

  /**
   * Check if we have enough data to trade
   */
  hasEnoughData() {
    return this.bars.length >= (this.config.minBars || 20);
  }
}

module.exports = BaseStrategy;
