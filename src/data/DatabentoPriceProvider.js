/**
 * DatabentoPriceProvider - Market data provider using Databento
 * 
 * Handles:
 * - Live streaming via Python subprocess bridge (databento_stream.py)
 * - Historical data fetching via Python subprocess
 * - Quote/trade/OHLCV event emission for strategy consumption
 * - Automatic reconnection on stream failure
 * 
 * Architecture:
 *   Node.js (this) <--stdout JSON lines--> Python (databento_stream.py) <--TCP--> Databento API
 */

const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');
const logger = require('../utils/logger');

class DatabentoPriceProvider extends EventEmitter {
  /**
   * @param {Object} config
   * @param {string} config.apiKey - Databento API key
   * @param {string} config.symbol - Symbol to subscribe (e.g., "MES.FUT", "ES.FUT")
   * @param {string} [config.schema="trades"] - Data schema (trades, ohlcv-1s, ohlcv-1m, mbp-1)
   * @param {string} [config.dataset="GLBX.MDP3"] - Dataset
   * @param {string} [config.pythonPath="python"] - Path to Python executable
   * @param {number} [config.reconnectDelayMs=5000] - Delay before reconnecting
   * @param {number} [config.maxReconnectAttempts=10] - Max reconnect attempts
   */
  constructor(config = {}) {
    super();
    this.config = {
      apiKey: config.apiKey || process.env.DATABENTO_API_KEY,
      symbol: config.symbol || 'MES.FUT',
      schema: config.schema || 'trades',
      dataset: config.dataset || 'GLBX.MDP3',
      pythonPath: config.pythonPath || 'python',
      reconnectDelayMs: config.reconnectDelayMs || 5000,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
      ...config
    };

    this.process = null;
    this.isConnected = false;
    this.isRunning = false;
    this.reconnectAttempts = 0;
    this.lastQuote = null;
    this.lastTrade = null;
    this._buffer = '';
    this._lastBarTs = null;    // Dedup: track last bar timestamp
    this._lastBarVol = 0;      // Dedup: track last bar volume
    this._pendingBar = null;   // Dedup: hold bar until next timestamp arrives
    this._barFlushTimer = null;

    // Path to the Python bridge script
    this._scriptPath = path.join(__dirname, 'databento_stream.py');
  }

  /**
   * Start the live data stream
   * @returns {Promise<void>}
   */
  async startLiveStream() {
    if (this.isRunning) {
      logger.warn('[Databento] Stream already running');
      return;
    }

    if (!this.config.apiKey) {
      throw new Error('Databento API key not configured. Set DATABENTO_API_KEY in .env');
    }

    this.isRunning = true;
    this.reconnectAttempts = 0;
    await this._spawnStream();
  }

  /**
   * Spawn the Python streaming subprocess
   * @private
   */
  async _spawnStream() {
    return new Promise((resolve, reject) => {
      const args = [
        this._scriptPath,
        '--key', this.config.apiKey,
        '--symbol', this.config.symbol,
        '--schema', this.config.schema,
        '--dataset', this.config.dataset,
        '--mode', 'live'
      ];

      logger.info(`[Databento] Starting live stream: ${this.config.symbol} (${this.config.schema})`);

      this.process = spawn(this.config.pythonPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      let resolved = false;

      // Handle stdout (JSON lines from Python)
      this.process.stdout.on('data', (data) => {
        this._buffer += data.toString();
        const lines = this._buffer.split('\n');
        // Keep the last incomplete line in the buffer
        this._buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this._handleMessage(msg);

            // Resolve the promise once we get a connected status
            if (!resolved && msg.type === 'status' && 
                (msg.message === 'connected' || msg.message === 'streaming')) {
              resolved = true;
              this.isConnected = true;
              this.reconnectAttempts = 0;
              resolve();
            }
          } catch (e) {
            logger.debug(`[Databento] Non-JSON output: ${line.substring(0, 100)}`);
          }
        }
      });

      // Handle stderr (Python errors/warnings)
      this.process.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) {
          logger.debug(`[Databento:stderr] ${msg.substring(0, 200)}`);
        }
      });

      // Handle process exit
      this.process.on('close', (code) => {
        this.isConnected = false;
        this.process = null;

        if (code !== 0 && code !== null) {
          logger.error(`[Databento] Stream process exited with code ${code}`);
        } else {
          logger.info('[Databento] Stream process exited');
        }

        if (!resolved) {
          resolved = true;
          reject(new Error(`Databento stream failed to start (exit code: ${code})`));
          return;
        }

        // Auto-reconnect if still running
        if (this.isRunning) {
          this._scheduleReconnect();
        }

        this.emit('disconnected', { code });
      });

      this.process.on('error', (err) => {
        logger.error(`[Databento] Process error: ${err.message}`);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      // Timeout for initial connection
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          // Don't reject - the stream might still be connecting
          logger.warn('[Databento] Stream connection timeout - continuing anyway');
          resolve();
        }
      }, 30000);
    });
  }

  /**
   * Handle a parsed message from the Python bridge
   * @private
   */
  _handleMessage(msg) {
    switch (msg.type) {
      case 'trade':
        this.lastTrade = msg;
        // Convert trade to a quote-like format for strategy consumption
        this.lastQuote = {
          price: msg.price,
          timestamp: msg.ts,
          size: msg.size,
          symbol: msg.symbol
        };
        this.emit('trade', msg);
        this.emit('quote', this.lastQuote);
        break;

      case 'ohlcv':
        // Dedup: parent symbol (MNQ.FUT) can deliver bars from multiple contract months
        // at the same timestamp. Keep only the highest-volume bar per timestamp.
        this._handleOHLCV(msg);
        break;

      case 'quote':
        this.lastQuote = {
          price: msg.ask || msg.bid,
          bid: msg.bid,
          ask: msg.ask,
          bidSize: msg.bid_size,
          askSize: msg.ask_size,
          timestamp: msg.ts,
          symbol: msg.symbol
        };
        this.emit('quote', this.lastQuote);
        break;

      case 'status':
        logger.info(`[Databento] Status: ${msg.message}`);
        this.emit('status', msg);
        break;

      case 'error':
        logger.error(`[Databento] Error: ${msg.message}`);
        this.emit('error', new Error(msg.message));
        break;

      case 'historical':
        this.emit('historical', msg);
        break;

      default:
        logger.debug(`[Databento] Unknown message type: ${msg.type}`);
    }
  }

  /**
   * Handle OHLCV bar with dedup for multiple contract months.
   * Parent symbols (e.g. MNQ.FUT) deliver bars from both front and back month
   * at the same timestamp. We keep only the highest-volume bar per timestamp.
   * @private
   */
  _handleOHLCV(msg) {
    const bar = {
      timestamp: msg.ts,
      open: msg.open,
      high: msg.high,
      low: msg.low,
      close: msg.close,
      volume: msg.volume,
      symbol: msg.symbol
    };

    if (this._lastBarTs === msg.ts) {
      // Same timestamp — keep the higher-volume bar (front month)
      if (msg.volume > this._lastBarVol) {
        this._pendingBar = bar;
        this._lastBarVol = msg.volume;
      }
      return;
    }

    // New timestamp — flush the previous pending bar first
    this._flushPendingBar();

    // Start tracking the new bar
    this._lastBarTs = msg.ts;
    this._lastBarVol = msg.volume;
    this._pendingBar = bar;

    // Flush after 3 seconds if no new bar arrives at the same timestamp
    if (this._barFlushTimer) clearTimeout(this._barFlushTimer);
    this._barFlushTimer = setTimeout(() => this._flushPendingBar(), 3000);
  }

  /**
   * Emit the pending bar (the highest-volume bar for the last timestamp).
   * @private
   */
  _flushPendingBar() {
    if (this._barFlushTimer) { clearTimeout(this._barFlushTimer); this._barFlushTimer = null; }
    if (!this._pendingBar) return;

    const bar = this._pendingBar;
    this._pendingBar = null;

    this.emit('bar', bar);
    this.lastQuote = {
      price: bar.close,
      timestamp: bar.timestamp,
      volume: bar.volume,
      symbol: bar.symbol
    };
    this.emit('quote', this.lastQuote);
  }

  /**
   * Schedule a reconnection attempt
   * @private
   */
  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      logger.error(`[Databento] Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`);
      this.isRunning = false;
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelayMs * Math.min(this.reconnectAttempts, 6);
    logger.info(`[Databento] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);

    setTimeout(async () => {
      try {
        await this._spawnStream();
      } catch (err) {
        logger.error(`[Databento] Reconnect failed: ${err.message}`);
        if (this.isRunning) {
          this._scheduleReconnect();
        }
      }
    }, delay);
  }

  /**
   * Fetch historical OHLCV bars from Databento
   * @param {string} start - Start time (ISO format)
   * @param {string} [end] - End time (ISO format, defaults to now)
   * @param {string} [schema="ohlcv-1m"] - Schema for historical data
   * @param {number} [limit] - Max records
   * @returns {Promise<Array>} Array of bar objects
   */
  async getHistoricalBars(start, end = null, schema = 'ohlcv-1m', limit = null) {
    if (!this.config.apiKey) {
      throw new Error('Databento API key not configured');
    }

    return new Promise((resolve, reject) => {
      const args = [
        this._scriptPath,
        '--key', this.config.apiKey,
        '--symbol', this.config.symbol,
        '--schema', schema,
        '--dataset', this.config.dataset,
        '--mode', 'historical',
        '--start', start,
      ];

      if (end) args.push('--end', end);
      if (limit) args.push('--limit', String(limit));

      logger.info(`[Databento] Fetching historical data: ${this.config.symbol} ${schema} from ${start}`);

      const proc = spawn(this.config.pythonPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      let output = '';
      let errorOutput = '';

      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Historical fetch failed (code ${code}): ${errorOutput.substring(0, 500)}`));
          return;
        }

        try {
          // Parse all JSON lines from output
          const lines = output.trim().split('\n');
          for (const line of lines) {
            const msg = JSON.parse(line);
            if (msg.type === 'historical') {
              // Dedup: parent symbol returns bars from multiple contract months
              // Keep only the highest-volume bar per timestamp
              const byTs = {};
              for (const r of (msg.records || [])) {
                const bar = { timestamp: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume };
                if (!byTs[r.ts] || r.volume > byTs[r.ts].volume) {
                  byTs[r.ts] = bar;
                }
              }
              const bars = Object.values(byTs).sort((a, b) => 
                new Date(a.timestamp) - new Date(b.timestamp));
              logger.info(`[Databento] Received ${bars.length} historical bars (deduped from ${(msg.records || []).length})`);
              resolve(bars);
              return;
            }
            if (msg.type === 'error') {
              reject(new Error(msg.message));
              return;
            }
          }
          resolve([]);
        } catch (e) {
          reject(new Error(`Failed to parse historical data: ${e.message}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn historical fetch: ${err.message}`));
      });

      // Timeout after 60 seconds
      setTimeout(() => {
        proc.kill();
        reject(new Error('Historical data fetch timed out'));
      }, 60000);
    });
  }

  /**
   * Stop the live data stream
   */
  stop() {
    this.isRunning = false;
    this._flushPendingBar();
    if (this.process) {
      logger.info('[Databento] Stopping stream...');
      this.process.kill('SIGTERM');
      // Force kill after 5 seconds
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
          this.process = null;
        }
      }, 5000);
    }
  }

  /**
   * Get current connection status
   * @returns {Object}
   */
  getStatus() {
    return {
      connected: this.isConnected,
      running: this.isRunning,
      symbol: this.config.symbol,
      schema: this.config.schema,
      reconnectAttempts: this.reconnectAttempts,
      lastQuote: this.lastQuote,
      lastTrade: this.lastTrade
    };
  }
}

module.exports = DatabentoPriceProvider;
