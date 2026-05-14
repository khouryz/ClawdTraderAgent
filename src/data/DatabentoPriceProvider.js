/**
 * DatabentoPriceProvider - Market data provider using Databento
 * 
 * Spawns TWO separate Python processes:
 *   1. ohlcv-1m stream — feeds strategy.onBar() via contract-lock dedup
 *   2. ohlcv-1s stream — feeds strategy.onTick() / slippage guard / BE checks
 * 
 * This design guarantees 100% isolation between 1m and 1s data.
 * No heuristic classification needed — each process knows exactly what it is.
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
   * @param {string} [config.schema="ohlcv-1m"] - Data schema (used for 1m stream)
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
      schema: config.schema || 'ohlcv-1m',
      dataset: config.dataset || 'GLBX.MDP3',
      pythonPath: config.pythonPath || 'python',
      reconnectDelayMs: config.reconnectDelayMs || 5000,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
      ...config
    };

    // Two separate processes — one per schema
    this._proc1m = null;
    this._proc1s = null;
    this._buffer1m = '';
    this._buffer1s = '';
    this._reconnectAttempts1m = 0;
    this._reconnectAttempts1s = 0;
    this._disconnectedAt1m = null;
    this._disconnectedAt1s = null;
    this._1mConnected = false;
    this._1sConnected = false;

    this.isConnected = false;
    this.isRunning = false;
    this.reconnectAttempts = 0;  // Legacy compat (used by InstrumentRunner reconnect event)
    this.lastQuote = null;
    this.lastTrade = null;
    this._lastBarTs = null;    // Dedup: track last bar timestamp
    this._lastBarVol = 0;      // Dedup: track last bar volume
    this._pendingBar = null;   // Dedup: hold bar until next timestamp arrives
    this._barFlushTimer = null;
    // Roll-safe dedup: track per-contract cumulative volume to lock to one contract
    this._contractVolumes = {};    // contractSymbol -> cumulative volume
    this._lockedContract = null;   // once determined, only emit bars from this contract
    this._lockConsecutive = 0;
    this._lastLeader = null;

    // Gap recovery: track last emitted bar timestamp and disconnect time
    this._lastEmittedBarTs = null;
    this._disconnectedAt = null;

    // Last price for slippage guard, sourced from 1s bar close.
    this._lastTickPrice = null;
    this._lastTickReceivedAt = null;

    // Log tag includes symbol for multi-instrument disambiguation
    this._tag = `[Databento:${this.config.symbol}]`;

    // Path to the Python bridge script
    this._scriptPath = path.join(__dirname, 'databento_stream.py');
  }

  /**
   * Start both live data streams (1m + 1s)
   * @returns {Promise<void>}
   */
  async startLiveStream() {
    if (this.isRunning) {
      logger.warn(`${this._tag} Stream already running`);
      return;
    }

    if (!this.config.apiKey) {
      throw new Error('Databento API key not configured. Set DATABENTO_API_KEY in .env');
    }

    this.isRunning = true;
    this._reconnectAttempts1m = 0;
    this._reconnectAttempts1s = 0;

    // Spawn both streams in parallel
    await Promise.all([
      this._spawnStream('ohlcv-1m'),
      this._spawnStream('ohlcv-1s'),
    ]);
  }

  /**
   * Spawn a single Python process for the given schema.
   * @param {'ohlcv-1m'|'ohlcv-1s'} schema
   * @private
   */
  async _spawnStream(schema) {
    const is1m = schema === 'ohlcv-1m';
    const label = is1m ? '1m' : '1s';

    return new Promise((resolve, reject) => {
      const args = [
        this._scriptPath,
        '--key', this.config.apiKey,
        '--symbol', this.config.symbol,
        '--schema', schema,
        '--dataset', this.config.dataset,
        '--mode', 'live'
      ];

      logger.info(`${this._tag} Starting ${label} stream`);

      const proc = spawn(this.config.pythonPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      if (is1m) { this._proc1m = proc; } else { this._proc1s = proc; }

      let buffer = '';
      let resolved = false;

      proc.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (is1m) {
              this._handleMessage1m(msg);
            } else {
              this._handleMessage1s(msg);
            }

            if (!resolved && msg.type === 'status' &&
                (msg.message === 'connected' || msg.message === 'streaming')) {
              resolved = true;
              if (is1m) { this._1mConnected = true; } else { this._1sConnected = true; }
              this.isConnected = this._1mConnected && this._1sConnected;

              const attempts = is1m ? this._reconnectAttempts1m : this._reconnectAttempts1s;
              if (attempts > 0) {
                const disconnectedAt = is1m ? this._disconnectedAt1m : this._disconnectedAt1s;
                const downtime = disconnectedAt ? Date.now() - disconnectedAt.getTime() : 0;
                if (is1m) { this._disconnectedAt1m = null; } else { this._disconnectedAt1s = null; }
                logger.info(`${this._tag} \u2713 ${label} reconnected after ${(downtime / 1000).toFixed(1)}s (${attempts} attempts)`);
                if (this._1mConnected && this._1sConnected) {
                  this.emit('reconnected', {
                    downtimeMs: downtime,
                    attempts,
                    lastBarTs: this._lastEmittedBarTs
                  });
                }
              }
              if (is1m) { this._reconnectAttempts1m = 0; } else { this._reconnectAttempts1s = 0; }
              resolve();
            }
          } catch (e) {
            logger.debug(`${this._tag} [${label}] Non-JSON: ${line.substring(0, 100)}`);
          }
        }
      });

      proc.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) logger.debug(`${this._tag} [${label}] stderr: ${msg.substring(0, 200)}`);
      });

      proc.on('close', (code) => {
        const wasConnected = is1m ? this._1mConnected : this._1sConnected;
        if (is1m) { this._1mConnected = false; this._proc1m = null; }
        else { this._1sConnected = false; this._proc1s = null; }
        this.isConnected = this._1mConnected && this._1sConnected;

        if (wasConnected) {
          if (is1m && !this._disconnectedAt1m) this._disconnectedAt1m = new Date();
          if (!is1m && !this._disconnectedAt1s) this._disconnectedAt1s = new Date();
        }

        if (code !== 0 && code !== null) {
          logger.error(`${this._tag} [${label}] Stream exited with code ${code}`);
        } else {
          logger.info(`${this._tag} [${label}] Stream exited`);
        }

        if (!resolved) {
          resolved = true;
          reject(new Error(`${label} stream failed to start (exit code: ${code})`));
          return;
        }

        if (this.isRunning) {
          this._scheduleReconnect(schema);
        }

        this.emit('disconnected', { code, stream: label });
      });

      proc.on('error', (err) => {
        logger.error(`${this._tag} [${label}] Process error: ${err.message}`);
        if (!resolved) { resolved = true; reject(err); }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          logger.warn(`${this._tag} [${label}] Connection timeout - continuing`);
          resolve();
        }
      }, 30000);
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  MESSAGE HANDLERS — completely separate paths for 1m vs 1s
  // ═══════════════════════════════════════════════════════════════

  /**
   * Handle messages from the 1m stream.
   * Every ohlcv message here is guaranteed to be a 1-minute bar.
   */
  _handleMessage1m(msg) {
    switch (msg.type) {
      case 'ohlcv':
        this._handleOHLCV(msg);
        break;
      case 'status':
        logger.info(`${this._tag} [1m] Status: ${msg.message}`);
        this.emit('status', msg);
        break;
      case 'error':
        logger.error(`${this._tag} [1m] Error: ${msg.message}`);
        this.emit('error', new Error(msg.message));
        break;
      case 'historical':
        this.emit('historical', msg);
        break;
      default:
        break;
    }
  }

  /**
   * Handle messages from the 1s stream.
   * Every ohlcv message here is guaranteed to be a 1-second bar.
   */
  _handleMessage1s(msg) {
    switch (msg.type) {
      case 'ohlcv': {
        // Filter out 1s bars from non-locked contract (roll guard)
        if (this._lockedContract && msg.symbol !== this._lockedContract) {
          break;
        }

        this.emit('bar1s', {
          timestamp: msg.ts,
          open: msg.open,
          high: msg.high,
          low: msg.low,
          close: msg.close,
          volume: msg.volume,
          symbol: msg.symbol
        });

        // Update last-price for slippage guard / BE checks
        this._lastTickPrice = msg.close;
        this._lastTickReceivedAt = Date.now();
        break;
      }
      case 'status':
        logger.info(`${this._tag} [1s] Status: ${msg.message}`);
        this.emit('status', msg);
        break;
      case 'error':
        logger.error(`${this._tag} [1s] Error: ${msg.message}`);
        this.emit('error', new Error(msg.message));
        break;
      default:
        break;
    }
  }

  /**
   * Handle OHLCV bar with dedup for multiple contract months.
   * Parent symbols (e.g. MNQ.FUT) deliver bars from both front and back month
   * at the same timestamp. We keep only the highest-volume bar per timestamp.
   * @private
   */
  _handleOHLCV(msg) {
    const actualContract = msg.symbol;

    // Track cumulative volume per contract for roll detection
    if (!this._contractVolumes[actualContract]) {
      this._contractVolumes[actualContract] = 0;
    }
    this._contractVolumes[actualContract] += msg.volume;

    // Determine the volume leader
    let leader = null;
    let leaderVol = 0;
    for (const [contract, vol] of Object.entries(this._contractVolumes)) {
      if (vol > leaderVol) { leader = contract; leaderVol = vol; }
    }

    // If locked to a contract and this bar is from a different one, skip
    if (this._lockedContract && actualContract !== this._lockedContract) {
      if (leader !== this._lockedContract) {
        const lockedVol = this._contractVolumes[this._lockedContract] || 0;
        if (leaderVol > lockedVol * 2) {
          logger.info(`${this._tag} 🔄 Contract roll detected: ${this._lockedContract} → ${leader}`);
          this._lockedContract = leader;
          this._contractVolumes = { [leader]: leaderVol };
        } else {
          return;
        }
      } else {
        return;
      }
    }

    // If not locked yet, check if one contract is consistently winning
    if (!this._lockedContract) {
      if (leader && this._lastLeader === leader) {
        this._lockConsecutive++;
      } else {
        this._lockConsecutive = 1;
        this._lastLeader = leader;
      }
      if (this._lockConsecutive >= 3 && leader) {
        this._lockedContract = leader;
        logger.info(`${this._tag} 🔒 Locked to contract: ${leader}`);
      }
    }

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

    this._lastEmittedBarTs = bar.timestamp;
    this._lastEmittedBarClose = bar.close;  // used by junk-bar guard
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
   * Schedule a reconnection for a specific stream.
   * @param {'ohlcv-1m'|'ohlcv-1s'} schema
   * @private
   */
  _scheduleReconnect(schema) {
    const is1m = schema === 'ohlcv-1m';
    const label = is1m ? '1m' : '1s';
    const attempts = is1m ? ++this._reconnectAttempts1m : ++this._reconnectAttempts1s;

    if (attempts >= this.config.maxReconnectAttempts) {
      logger.error(`${this._tag} [${label}] Max reconnect attempts reached`);
      if (!this._1mConnected && !this._1sConnected) {
        this.isRunning = false;
        this.emit('maxReconnectAttemptsReached');
      }
      return;
    }

    const delay = attempts <= 2
      ? 2000
      : this.config.reconnectDelayMs * Math.min(attempts, 6);
    logger.info(`${this._tag} [${label}] Reconnecting in ${delay}ms (attempt ${attempts}/${this.config.maxReconnectAttempts})`);

    setTimeout(async () => {
      try {
        await this._spawnStream(schema);
      } catch (err) {
        logger.error(`${this._tag} [${label}] Reconnect failed: ${err.message}`);
        if (this.isRunning) this._scheduleReconnect(schema);
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

      logger.info(`${this._tag} Fetching historical: ${schema} from ${start}`);

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
              logger.info(`${this._tag} Received ${bars.length} historical bars (deduped from ${(msg.records || []).length})`);
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
   * Get the last tick price for slippage guard
   * @returns {{ price: number, receivedAt: number, ageMs: number } | null}
   */
  getLastTickPrice() {
    if (this._lastTickPrice === null) return null;
    return {
      price: this._lastTickPrice,
      receivedAt: this._lastTickReceivedAt,
      ageMs: Date.now() - this._lastTickReceivedAt,
    };
  }

  /**
   * Stop both live data streams
   */
  stop() {
    this.isRunning = false;
    this._flushPendingBar();
    const killProc = (proc, label) => {
      if (!proc) return;
      logger.info(`${this._tag} Stopping ${label} stream...`);
      proc.kill('SIGTERM');
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (e) { /* already dead */ }
      }, 5000);
    };
    killProc(this._proc1m, '1m');
    killProc(this._proc1s, '1s');
    this._proc1m = null;
    this._proc1s = null;
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
