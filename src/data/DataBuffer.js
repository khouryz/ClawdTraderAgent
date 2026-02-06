/**
 * DataBuffer - Efficient data buffering with transformation support
 * 
 * Handles incoming tick/bar data with:
 * - Automatic deduplication by timestamp
 * - Configurable max length (rolling window)
 * - Data transformation pipelines
 * - Array-like interface
 */

class DataBuffer {
  /**
   * @param {Function|null} transformer - Optional function to transform incoming data
   * @param {Array} initialData - Optional initial data
   */
  constructor(transformer = null, initialData = []) {
    this.buffer = [...initialData];
    this.transformer = transformer;
    this.maxLength = null;
    this._lastTimestamp = null;
  }

  /**
   * Set maximum buffer length (rolling window)
   * @param {number} max - Maximum number of items to keep
   */
  setMaxLength(max) {
    this.maxLength = max;
    this._trimBuffer();
    return this;
  }

  /**
   * Push new data through transformer and into buffer
   * Handles deduplication by timestamp
   * @param {*} data - Raw data to push
   */
  push(data) {
    let results;
    
    if (this.transformer && typeof this.transformer === 'function') {
      results = this.transformer(data);
    } else {
      results = Array.isArray(data) ? data : [data];
    }

    // Ensure results is always an array
    if (!Array.isArray(results)) {
      results = [results];
    }

    // Sort by timestamp if available
    results = results.sort((a, b) => {
      const tsA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      const tsB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      return tsA - tsB;
    });

    // Add to buffer with deduplication
    results.forEach(item => {
      const itemTs = item.timestamp ? new Date(item.timestamp).getTime() : null;
      
      if (this.buffer.length === 0 || !itemTs || itemTs > this._lastTimestamp) {
        // New item - append
        this.buffer.push(item);
        if (itemTs) this._lastTimestamp = itemTs;
      } else if (itemTs === this._lastTimestamp) {
        // Same timestamp - update last item
        this.buffer[this.buffer.length - 1] = { ...item };
      }
      // Older timestamps are ignored (out of order)
    });

    this._trimBuffer();
    return this;
  }

  /**
   * Push without transformation (raw push)
   * @param {*} item - Item to push directly
   */
  pushRaw(item) {
    this.buffer.push(item);
    this._trimBuffer();
    return this;
  }

  /**
   * Trim buffer to max length
   */
  _trimBuffer() {
    if (this.maxLength && this.buffer.length > this.maxLength) {
      this.buffer = this.buffer.slice(-this.maxLength);
    }
  }

  /**
   * Get slice of buffer for a specific period
   * @param {number|null} period - Number of items from end, null for all
   */
  slicePeriod(period) {
    if (period === null || period === undefined) {
      return this.buffer.slice();
    }
    return this.buffer.slice(-period);
  }

  /**
   * Get all data or specific index
   * @param {number} index - Optional index (-1 for all)
   */
  getData(index = -1) {
    return index > -1 ? this.buffer[index] : this.buffer;
  }

  /**
   * Get last N items
   * @param {number} n - Number of items from end (default 1)
   */
  last(n = 1) {
    if (n === 1) {
      return this.buffer[this.buffer.length - 1];
    }
    return this.buffer.slice(-n);
  }

  /**
   * Get first N items
   * @param {number} n - Number of items from start (default 1)
   */
  first(n = 1) {
    if (n === 1) {
      return this.buffer[0];
    }
    return this.buffer.slice(0, n);
  }

  /**
   * Clear the buffer
   */
  clear() {
    this.buffer = [];
    this._lastTimestamp = null;
    return this;
  }

  // Array-like methods
  get length() { return this.buffer.length; }
  forEach(callback) { return this.buffer.forEach(callback); }
  map(callback) { return this.buffer.map(callback); }
  reduce(callback, seed) { return this.buffer.reduce(callback, seed); }
  slice(start, end) { return this.buffer.slice(start, end); }
  indexOf(item) { return this.buffer.indexOf(item); }
  every(predicate) { return this.buffer.every(predicate); }
  filter(predicate) { return this.buffer.filter(predicate); }
  some(predicate) { return this.buffer.some(predicate); }
  find(predicate) { return this.buffer.find(predicate); }
  findIndex(predicate) { return this.buffer.findIndex(predicate); }

  /**
   * Iterator support
   */
  [Symbol.iterator]() {
    return this.buffer[Symbol.iterator]();
  }
}

/**
 * Transform raw Tradovate bar data into standardized format
 * @param {Object} response - Raw response from Tradovate chart API
 * @returns {Array} Transformed bar data
 */
function BarsTransformer(response) {
  const { bars } = response;
  if (!bars || !Array.isArray(bars)) return [];

  return bars.map(bar => ({
    timestamp: bar.timestamp,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: (bar.upVolume || 0) + (bar.downVolume || 0),
    upVolume: bar.upVolume || 0,
    downVolume: bar.downVolume || 0,
    upTicks: bar.upTicks || 0,
    downTicks: bar.downTicks || 0,
    bidVolume: bar.bidVolume || 0,
    offerVolume: bar.offerVolume || 0
  }));
}

/**
 * Transform raw Tradovate tick data into standardized format
 * @param {Object} response - Raw tick response
 * @returns {Array} Transformed tick data
 */
function TicksTransformer(response) {
  const { id: subId, bp, bt, ts, tks } = response;
  if (!tks || !Array.isArray(tks)) return [];

  return tks.map(({ t, p, s, b, a, bs, as: asks, id }) => ({
    subscriptionId: subId,
    id,
    contractTickSize: ts,
    timestamp: new Date(bt + t),
    price: (bp + p) * ts,
    volume: s,
    bidPrice: bs ? (bp + b) * ts : null,
    bidSize: bs || null,
    askPrice: asks ? (bp + a) * ts : null,
    askSize: asks || null
  }));
}

/**
 * Transform quote data into standardized format
 * @param {Object} quote - Raw quote from WebSocket
 * @returns {Object} Standardized quote
 */
function QuoteTransformer(quote) {
  return {
    contractId: quote.contractId,
    timestamp: quote.timestamp || new Date().toISOString(),
    bid: quote.bid || quote.entries?.Bid?.price,
    ask: quote.ask || quote.entries?.Offer?.price,
    last: quote.last || quote.entries?.Trade?.price,
    bidSize: quote.bidSize || quote.entries?.Bid?.size,
    askSize: quote.askSize || quote.entries?.Offer?.size,
    lastSize: quote.lastSize || quote.entries?.Trade?.size,
    volume: quote.totalVolume || quote.volume,
    high: quote.high,
    low: quote.low,
    open: quote.open,
    close: quote.close
  };
}

module.exports = {
  DataBuffer,
  BarsTransformer,
  TicksTransformer,
  QuoteTransformer
};
