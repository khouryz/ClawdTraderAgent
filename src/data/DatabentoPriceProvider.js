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
   * @param {string} [config.schema="ohlcv-1m"] - Data schema (ohlcv-1m primary; ohlcv-1s is auto-added)
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
    // Roll-safe dedup: track per-contract cumulative volume to lock to one contract
    this._contractVolumes = {};    // contractSymbol -> cumulative volume
    this._lockedContract = null;   // once determined, only emit bars from this contract
    this._lockConsecutive = 0;
    this._lastLeader = null;

    // Gap recovery: track last emitted bar timestamp and disconnect time
    this._lastEmittedBarTs = null;
    this._disconnectedAt = null;

    // Last price for slippage guard, sourced from 1s bar close.
    // Updated whenever a 1s bar arrives so the slippage guard always has
    // a fresh-enough price without subscribing to raw trade prints.
    this._lastTickPrice = null;
    this._lastTickReceivedAt = null;

    // Log tag includes symbol for multi-instrument disambiguation
    this._tag = `[Databento:${this.config.symbol}]`;

    // Path to the Python bridge script
    this._scriptPath = path.join(__dirname, 'databento_stream.py');
  }

  /**
   * Start the live data stream
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
    this.reconnectAttempts = 0;
    await this._spawnStream();
  }

  /**
   * Spawn the Python streaming subprocess
   * @private
   */
  async _spawnStream() {
    return new Promise((resolve, reject) => {
      // Build schema string. We use ONLY ohlcv-1m + ohlcv-1s — no raw trades.
      // The 1s bar close acts as the "tick" for the slippage guard and
      // real-time BE checks, matching the backtester's exact data cadence.
      const baseSchema = this.config.schema;
      let schemaStr = baseSchema;
      if (!schemaStr.includes('ohlcv-1s')) {
        schemaStr += ',ohlcv-1s';
      }
      const args = [
        this._scriptPath,
        '--key', this.config.apiKey,
        '--symbol', this.config.symbol,
        '--schema', schemaStr,
        '--dataset', this.config.dataset,
        '--mode', 'live'
      ];

      logger.info(`${this._tag} Starting live stream (${schemaStr})`);

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
              // Emit reconnected event with gap info (only on reconnects, not initial connect)
              if (this.reconnectAttempts > 0) {
                const disconnectedAt = this._disconnectedAt;
                const reconnectedAt = new Date();
                const downtime = disconnectedAt ? reconnectedAt - disconnectedAt : 0;
                const attempts = this.reconnectAttempts;
                this._disconnectedAt = null;
                logger.info(`${this._tag} ✓ Reconnected after ${(downtime / 1000).toFixed(1)}s (${attempts} attempts)`);
                this.emit('reconnected', {
                  disconnectedAt: disconnectedAt?.toISOString(),
                  reconnectedAt: reconnectedAt.toISOString(),
                  downtimeMs: downtime,
                  attempts,
                  lastBarTs: this._lastEmittedBarTs
                });
              }
              this.reconnectAttempts = 0;
              resolve();
            }
          } catch (e) {
            logger.debug(`${this._tag} Non-JSON output: ${line.substring(0, 100)}`);
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
        const wasConnected = this.isConnected;
        this.isConnected = false;
        this.process = null;

        // Track when we disconnected (only if we were previously connected)
        if (wasConnected && !this._disconnectedAt) {
          this._disconnectedAt = new Date();
        }

        if (code !== 0 && code !== null) {
          logger.error(`${this._tag} Stream exited with code ${code}`);
        } else {
          logger.info(`${this._tag} Stream exited`);
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
        logger.error(`${this._tag} Process error: ${err.message}`);
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
          logger.warn(`${this._tag} Stream connection timeout - continuing anyway`);
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
      case 'ohlcv': {
        // Defense-in-depth interval detection (see SharedPriceProvider for context).
        // Trust msg.interval but cross-check via rtype (32=1s, 33=1m), timestamp
        // seconds (1m bars always align to :00), recent-ts dedup, and a volume
        // heuristic as last resort.
        const tsStr = msg.ts || '';
        const tsSecondsNonZero = tsStr.length >= 19 && tsStr.substring(17, 19) !== '00';
        const rtypeIs1s = msg.rtype === 32;
        const rtypeIs1m = msg.rtype === 33;

        let is1s;
        if (rtypeIs1s)              is1s = true;
        else if (rtypeIs1m)         is1s = false;
        else if (tsSecondsNonZero)  is1s = true;
        else {
          // :00 boundary with no rtype hint — disambiguate via recent-ts dedup
          // (a bar with the same ts seen within 5s means this is the OTHER
          // timeframe) and volume heuristic (MNQ 1m bars during RTH >> 200,
          // 1s bars << 100).
          const recentSameTs = this._lastBoundaryBar &&
                               this._lastBoundaryBar.ts === tsStr &&
                               (Date.now() - this._lastBoundaryBar.at) < 5000;
          if (recentSameTs) {
            is1s = !this._lastBoundaryBar.is1s;
          } else {
            is1s = (msg.volume != null && msg.volume < 200);
          }
        }

        if (!tsSecondsNonZero) {
          this._lastBoundaryBar = { ts: tsStr, at: Date.now(), is1s };
        }

        if (is1s) {
          // 1s bars: emit as 'bar1s' for strategy tick cadence (live-parity with backtest).
          // Filter out 1s bars from non-locked contract (roll guard).
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

          // Update last-price (sourced from 1s close, not raw ticks) so the
          // slippage guard and _checkTickBE have a fresh price.
          this._lastTickPrice = msg.close;
          this._lastTickReceivedAt = Date.now();
        } else {
          // 1m bars: dedup and emit as 'bar' (unchanged)
          this._handleOHLCV(msg);
        }
        break;
      }

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
        logger.info(`${this._tag} Status: ${msg.message}`);
        this.emit('status', msg);
        break;

      case 'error':
        logger.error(`${this._tag} Error: ${msg.message}`);
        this.emit('error', new Error(msg.message));
        break;

      case 'historical':
        this.emit('historical', msg);
        break;

      default:
        logger.debug(`${this._tag} Unknown message type: ${msg.type}`);
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
      logger.error(`${this._tag} Max reconnect attempts (${this.config.maxReconnectAttempts}) reached`);
      this.isRunning = false;
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;
    // Faster backoff for first 2 attempts (2s), then normal escalation
    const delay = this.reconnectAttempts <= 2
      ? 2000
      : this.config.reconnectDelayMs * Math.min(this.reconnectAttempts, 6);
    logger.info(`${this._tag} Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);

    setTimeout(async () => {
      try {
        await this._spawnStream();
      } catch (err) {
        logger.error(`${this._tag} Reconnect failed: ${err.message}`);
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
   * Stop the live data stream
   */
  stop() {
    this.isRunning = false;
    this._flushPendingBar();
    if (this.process) {
      logger.info(`${this._tag} Stopping stream...`);
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
