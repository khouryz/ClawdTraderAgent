/**
 * SharedPriceProvider - Single Databento stream for multiple instruments
 * 
 * Databento limits concurrent live sessions to ~2 per API key.
 * This provider subscribes to ALL symbols in ONE db.Live() session,
 * then routes bars/quotes to per-symbol listeners.
 * 
 * Historical data is still fetched per-symbol (separate processes, sequential).
 */

const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');
const logger = require('../utils/logger');

class SharedPriceProvider extends EventEmitter {
  /**
   * @param {Object} config
   * @param {string} config.apiKey - Databento API key
   * @param {string[]} config.symbols - Array of symbols (e.g. ['MNQ.FUT', 'MES.FUT', 'M2K.FUT'])
   * @param {string} [config.schema='ohlcv-1m'] - Data schema
   * @param {string} [config.dataset='GLBX.MDP3'] - Dataset
   * @param {string} [config.pythonPath='python'] - Path to Python executable
   */
  constructor(config = {}) {
    super();
    this.config = {
      apiKey: config.apiKey || process.env.DATABENTO_API_KEY,
      symbols: config.symbols || [],
      schema: config.schema || 'ohlcv-1m',
      dataset: config.dataset || 'GLBX.MDP3',
      pythonPath: config.pythonPath || 'python',
      reconnectDelayMs: config.reconnectDelayMs || 5000,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
    };

    this.process = null;
    this.isConnected = false;
    this.isRunning = false;
    this.reconnectAttempts = 0;
    this._buffer = '';
    this._disconnectedAt = null;

    // Per-symbol state for dedup (same logic as DatabentoPriceProvider)
    // symbol -> { lastBarTs, lastBarVol, pendingBar, barFlushTimer, lastEmittedBarTs }
    this._symbolState = new Map();
    for (const sym of this.config.symbols) {
      this._symbolState.set(sym, {
        lastBarTs: null,
        lastBarVol: 0,
        pendingBar: null,
        barFlushTimer: null,
        lastEmittedBarTs: null,
      });
    }

    this._tag = `[Databento:SHARED]`;
    this._scriptPath = path.join(__dirname, 'databento_stream.py');
  }

  /**
   * Start the shared live stream for all symbols
   */
  async startLiveStream() {
    if (this.isRunning) {
      logger.warn(`${this._tag} Stream already running`);
      return;
    }
    if (!this.config.apiKey) {
      throw new Error('Databento API key not configured');
    }
    this.isRunning = true;
    this.reconnectAttempts = 0;
    await this._spawnStream();
  }

  async _spawnStream() {
    return new Promise((resolve, reject) => {
      // Pass all symbols as comma-separated string
      const symbolStr = this.config.symbols.join(',');
      const args = [
        this._scriptPath,
        '--key', this.config.apiKey,
        '--symbol', symbolStr,
        '--schema', this.config.schema,
        '--dataset', this.config.dataset,
        '--mode', 'live'
      ];

      logger.info(`${this._tag} Starting live stream: ${symbolStr} (${this.config.schema})`);

      this.process = spawn(this.config.pythonPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      let resolved = false;

      this.process.stdout.on('data', (data) => {
        this._buffer += data.toString();
        const lines = this._buffer.split('\n');
        this._buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            this._handleMessage(msg);

            if (!resolved && msg.type === 'status' &&
                (msg.message === 'connected' || msg.message === 'streaming')) {
              resolved = true;
              this.isConnected = true;
              if (this.reconnectAttempts > 0) {
                const disconnectedAt = this._disconnectedAt;
                const reconnectedAt = new Date();
                const downtime = disconnectedAt ? reconnectedAt - disconnectedAt : 0;
                const attempts = this.reconnectAttempts;
                this._disconnectedAt = null;
                logger.info(`${this._tag} ✓ Reconnected after ${(downtime / 1000).toFixed(1)}s (${attempts} attempts)`);
                this.emit('reconnected', {
                  downtimeMs: downtime,
                  attempts,
                });
              }
              this.reconnectAttempts = 0;
              resolve();
            }
          } catch (e) {
            logger.debug(`${this._tag} Non-JSON: ${line.substring(0, 100)}`);
          }
        }
      });

      this.process.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg) logger.debug(`${this._tag} stderr: ${msg.substring(0, 200)}`);
      });

      this.process.on('close', (code) => {
        const wasConnected = this.isConnected;
        this.isConnected = false;
        this.process = null;

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
          reject(new Error(`Shared stream failed to start (exit code: ${code})`));
          return;
        }

        if (this.isRunning) {
          this._scheduleReconnect();
        }

        this.emit('disconnected', { code });
      });

      this.process.on('error', (err) => {
        logger.error(`${this._tag} Process error: ${err.message}`);
        if (!resolved) { resolved = true; reject(err); }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          logger.warn(`${this._tag} Connection timeout - continuing`);
          resolve();
        }
      }, 30000);
    });
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'ohlcv':
        this._handleOHLCV(msg);
        break;

      case 'trade': {
        const sym = msg.symbol;
        this.emit(`trade:${sym}`, msg);
        this.emit(`quote:${sym}`, {
          price: msg.price,
          timestamp: msg.ts,
          size: msg.size,
          symbol: sym
        });
        break;
      }

      case 'quote': {
        const sym = msg.symbol;
        this.emit(`quote:${sym}`, {
          price: msg.ask || msg.bid,
          bid: msg.bid,
          ask: msg.ask,
          timestamp: msg.ts,
          symbol: sym
        });
        break;
      }

      case 'status':
        // Only log status every 60s to reduce noise (system heartbeats are every 30s)
        if (msg.message !== 'system') {
          logger.info(`${this._tag} Status: ${msg.message}`);
        }
        this.emit('status', msg);
        break;

      case 'error':
        logger.error(`${this._tag} Error: ${msg.message}`);
        this.emit('error', new Error(msg.message));
        break;

      default:
        break;
    }
  }

  /**
   * Handle OHLCV bar with per-symbol dedup
   */
  _handleOHLCV(msg) {
    const sym = msg.symbol;
    let state = this._symbolState.get(sym);

    // If symbol not in our map (e.g. back-month contract), try to match
    if (!state) {
      // Try matching by base symbol prefix
      for (const [key, val] of this._symbolState) {
        const base = key.replace('.FUT', '');
        if (sym.startsWith(base) || sym === key) {
          state = val;
          // Cache for future lookups
          this._symbolState.set(sym, state);
          break;
        }
      }
      if (!state) return; // Unknown symbol, ignore
    }

    const bar = {
      timestamp: msg.ts,
      open: msg.open,
      high: msg.high,
      low: msg.low,
      close: msg.close,
      volume: msg.volume,
      symbol: sym
    };

    if (state.lastBarTs === msg.ts) {
      // Same timestamp — keep higher-volume bar (front month)
      if (msg.volume > state.lastBarVol) {
        state.pendingBar = bar;
        state.lastBarVol = msg.volume;
      }
      return;
    }

    // New timestamp — flush previous pending bar
    this._flushSymbolBar(sym, state);

    state.lastBarTs = msg.ts;
    state.lastBarVol = msg.volume;
    state.pendingBar = bar;

    if (state.barFlushTimer) clearTimeout(state.barFlushTimer);
    state.barFlushTimer = setTimeout(() => this._flushSymbolBar(sym, state), 3000);
  }

  _flushSymbolBar(sym, state) {
    if (state.barFlushTimer) { clearTimeout(state.barFlushTimer); state.barFlushTimer = null; }
    if (!state.pendingBar) return;

    const bar = state.pendingBar;
    state.pendingBar = null;

    logger.info(`[Databento:${sym}] 1m bar: ${bar.timestamp} O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} V=${bar.volume}`);
    state.lastEmittedBarTs = bar.timestamp;

    // Emit per-symbol events
    this.emit(`bar:${sym}`, bar);
    this.emit(`quote:${sym}`, {
      price: bar.close,
      timestamp: bar.timestamp,
      volume: bar.volume,
      symbol: sym
    });
  }

  _scheduleReconnect() {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      logger.error(`${this._tag} Max reconnect attempts reached`);
      this.isRunning = false;
      this.emit('maxReconnectAttemptsReached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectAttempts <= 2
      ? 2000
      : this.config.reconnectDelayMs * Math.min(this.reconnectAttempts, 6);
    logger.info(`${this._tag} Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.config.maxReconnectAttempts})`);

    setTimeout(async () => {
      try {
        await this._spawnStream();
      } catch (err) {
        logger.error(`${this._tag} Reconnect failed: ${err.message}`);
        if (this.isRunning) this._scheduleReconnect();
      }
    }, delay);
  }

  /**
   * Fetch historical bars for a SINGLE symbol (separate process, no session limit issue)
   */
  async getHistoricalBars(symbol, start, end = null, schema = 'ohlcv-1m', limit = null) {
    if (!this.config.apiKey) throw new Error('Databento API key not configured');

    return new Promise((resolve, reject) => {
      const args = [
        this._scriptPath,
        '--key', this.config.apiKey,
        '--symbol', symbol,
        '--schema', schema,
        '--dataset', this.config.dataset,
        '--mode', 'historical',
        '--start', start,
      ];
      if (end) args.push('--end', end);
      if (limit) args.push('--limit', String(limit));

      logger.info(`[Databento:${symbol}] Fetching historical: ${schema} from ${start}`);

      const proc = spawn(this.config.pythonPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      let output = '';
      let errorOutput = '';

      proc.stdout.on('data', (data) => { output += data.toString(); });
      proc.stderr.on('data', (data) => { errorOutput += data.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`Historical fetch failed (code ${code}): ${errorOutput.substring(0, 500)}`));
          return;
        }
        try {
          const lines = output.trim().split('\n');
          for (const line of lines) {
            const msg = JSON.parse(line);
            if (msg.type === 'historical') {
              const byTs = {};
              for (const r of (msg.records || [])) {
                const bar = { timestamp: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume };
                if (!byTs[r.ts] || r.volume > byTs[r.ts].volume) {
                  byTs[r.ts] = bar;
                }
              }
              const bars = Object.values(byTs).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
              logger.info(`[Databento:${symbol}] Received ${bars.length} historical bars (deduped from ${(msg.records || []).length})`);
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

      proc.on('error', (err) => reject(new Error(`Failed to spawn: ${err.message}`)));
      setTimeout(() => { proc.kill(); reject(new Error('Historical fetch timed out')); }, 60000);
    });
  }

  /**
   * Stop the shared stream
   */
  stop() {
    this.isRunning = false;
    // Flush all pending bars
    for (const [sym, state] of this._symbolState) {
      this._flushSymbolBar(sym, state);
    }
    if (this.process) {
      logger.info(`${this._tag} Stopping stream...`);
      this.process.kill('SIGTERM');
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
          this.process = null;
        }
      }, 5000);
    }
  }
}

module.exports = SharedPriceProvider;
