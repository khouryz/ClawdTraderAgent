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
    // symbol -> { lastBarTs, lastBarVol, pendingBar, barFlushTimer, lastEmittedBarTs, ... }
    this._symbolState = new Map();
    for (const sym of this.config.symbols) {
      this._symbolState.set(sym, {
        lastBarTs: null,
        lastBarVol: 0,
        pendingBar: null,
        barFlushTimer: null,
        lastEmittedBarTs: null,
        // Roll-safe dedup: track per-contract cumulative volume to lock to one contract
        contractVolumes: {},    // contractSymbol -> cumulative volume over recent bars
        lockedContract: null,   // once determined, only emit bars from this contract
        lockConsecutive: 0,     // how many consecutive bars the leader has won
      });
    }

    // Per-symbol last price for slippage guard, sourced from 1s bar close.
    // Updated whenever a `bar1s` is emitted so the slippage guard always has
    // a fresh-enough price without subscribing to raw trade ticks.
    // symbol -> { price, receivedAt } (receivedAt = local Date.now() to avoid clock skew)
    this._lastTickPrice = new Map();

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
      // Build schema string. We use ONLY ohlcv-1m + ohlcv-1s — no raw trades.
      // The 1s bar close acts as the "tick" for the slippage guard and
      // real-time BE checks, matching the backtester's exact data cadence.
      let schemaStr = this.config.schema;
      if (!schemaStr.includes('ohlcv-1s')) {
        schemaStr += ',ohlcv-1s';
      }
      const args = [
        this._scriptPath,
        '--key', this.config.apiKey,
        '--symbol', symbolStr,
        '--schema', schemaStr,
        '--dataset', this.config.dataset,
        '--mode', 'live'
      ];

      logger.info(`${this._tag} Starting live stream: ${symbolStr} (${schemaStr})`);

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
      case 'ohlcv': {
        // Defense-in-depth interval detection.
        // Production hit a bug where the Python side defaulted ALL bars to "1m",
        // causing 1s bars to be fed to strategy.onBar() instead of strategy.onTick().
        // We trust msg.interval but cross-check via rtype (32=1s, 33=1m), timestamp
        // seconds (1m bars always align to :00), recent-ts dedup, and a volume
        // heuristic as last resort.
        const tsStr = msg.ts || '';
        const tsSecondsNonZero = tsStr.length >= 19 && tsStr.substring(17, 19) !== '00';
        const rtypeIs1s = msg.rtype === 32;
        const rtypeIs1m = msg.rtype === 33;

        // Resolve parent symbol (e.g. MNQH6 → MNQ.FUT)
        let parentSym = msg.symbol;
        if (!this._symbolState.has(parentSym)) {
          for (const [key] of this._symbolState) {
            const base = key.replace('.FUT', '');
            if (parentSym.startsWith(base) || parentSym === key) { parentSym = key; break; }
          }
        }
        const state = this._symbolState.get(parentSym);

        // Classify the bar. Most-reliable signals first.
        let is1s;
        if (rtypeIs1s)              is1s = true;                  // canonical from Databento
        else if (rtypeIs1m)         is1s = false;                 // canonical from Databento
        else if (tsSecondsNonZero)  is1s = true;                  // 1m bars always align to :00
        else {
          // :00 boundary with no rtype hint. Both 1m and 1s bars share the same ts
          // here (e.g. both stamped 16:17:00). Disambiguate via:
          //   1. Recent-ts dedup — if we already classified a bar at this same ts
          //      within the last 5 seconds, the new one MUST be the other timeframe.
          //   2. Volume heuristic — MNQ 1m bars during RTH have V >> 200, 1s bars
          //      have V << 100.
          const recentSameTs = state && state._lastBoundaryBar &&
                               state._lastBoundaryBar.ts === tsStr &&
                               (Date.now() - state._lastBoundaryBar.at) < 5000;
          if (recentSameTs) {
            is1s = !state._lastBoundaryBar.is1s;
          } else {
            is1s = (msg.volume != null && msg.volume < 200);
          }
        }

        // Track this :00 boundary bar so the next arrival within 5s can be classified
        // as the other timeframe. Non-:00 bars (seconds != 0) don't need tracking —
        // they're deterministically 1s.
        if (state && !tsSecondsNonZero) {
          state._lastBoundaryBar = { ts: tsStr, at: Date.now(), is1s };
        }

        if (is1s) {
          // 1s bars: emit as bar1s:${sym}. We use the 1s close as our "tick" for
          // slippage guard and real-time BE. Matches the backtester's exact data
          // cadence (onTick once per second on bar1s.close).

          // Filter out 1s bars from non-locked contract (roll guard).
          // The 1m dedup locks to the volume leader; honor that lock on 1s too.
          if (state && state.lockedContract && msg.symbol !== state.lockedContract) {
            break;
          }

          this.emit(`bar1s:${parentSym}`, {
            timestamp: msg.ts,
            open: msg.open,
            high: msg.high,
            low: msg.low,
            close: msg.close,
            volume: msg.volume,
            symbol: parentSym
          });

          // Update last-price (sourced from 1s close, not raw ticks) so the
          // slippage guard and _checkTickBE have a fresh price.
          this._lastTickPrice.set(parentSym, { price: msg.close, receivedAt: Date.now() });
        } else {
          // 1m bars: dedup and emit as bar:${sym} (unchanged path).
          this._handleOHLCV(msg);
        }
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
   * Handle OHLCV bar with per-symbol dedup.
   * Roll-safe: tracks per-contract cumulative volume to lock to one contract
   * during roll periods when two contracts have similar bar-by-bar volumes.
   */
  _handleOHLCV(msg) {
    // Resolve the actual contract symbol (e.g. MNQH6, MNQM6) from msg.symbol
    const actualContract = msg.symbol;
    // Find the parent symbol state (e.g. MNQ.FUT)
    let parentSym = actualContract;
    let state = this._symbolState.get(actualContract);

    if (!state) {
      for (const [key, val] of this._symbolState) {
        const base = key.replace('.FUT', '');
        if (actualContract.startsWith(base) || actualContract === key) {
          state = val;
          parentSym = key;
          break;
        }
      }
      if (!state) return;
    }

    // Track cumulative volume per contract for roll detection
    if (!state.contractVolumes[actualContract]) {
      state.contractVolumes[actualContract] = 0;
    }
    state.contractVolumes[actualContract] += msg.volume;

    // Determine the volume leader across all contracts
    let leader = null;
    let leaderVol = 0;
    for (const [contract, vol] of Object.entries(state.contractVolumes)) {
      if (vol > leaderVol) { leader = contract; leaderVol = vol; }
    }

    // If we're locked to a contract and this bar is from a different one, skip it
    if (state.lockedContract && actualContract !== state.lockedContract) {
      // But check if the leader has changed (roll happened) — if the OTHER contract
      // has 2x the cumulative volume, switch the lock
      if (leader !== state.lockedContract) {
        const lockedVol = state.contractVolumes[state.lockedContract] || 0;
        if (leaderVol > lockedVol * 2) {
          logger.info(`${this._tag} 🔄 Contract roll detected: ${state.lockedContract} → ${leader} (vol ${lockedVol} → ${leaderVol})`);
          state.lockedContract = leader;
          state.contractVolumes = { [leader]: leaderVol }; // reset tracking
        } else {
          return; // Still locked to the old contract, skip this bar
        }
      } else {
        return; // Bar from non-locked contract, skip
      }
    }

    // If not locked yet, check if one contract is consistently winning
    if (!state.lockedContract) {
      if (leader && state._lastLeader === leader) {
        state.lockConsecutive++;
      } else {
        state.lockConsecutive = 1;
        state._lastLeader = leader;
      }
      // Lock after 3 consecutive wins by the same contract
      if (state.lockConsecutive >= 3 && leader) {
        state.lockedContract = leader;
        logger.info(`${this._tag} 🔒 Locked to contract: ${leader} (${state.lockConsecutive} consecutive volume wins)`);
      }
    }

    const bar = {
      timestamp: msg.ts,
      open: msg.open,
      high: msg.high,
      low: msg.low,
      close: msg.close,
      volume: msg.volume,
      symbol: parentSym
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
    this._flushSymbolBar(parentSym, state);

    state.lastBarTs = msg.ts;
    state.lastBarVol = msg.volume;
    state.pendingBar = bar;

    if (state.barFlushTimer) clearTimeout(state.barFlushTimer);
    state.barFlushTimer = setTimeout(() => this._flushSymbolBar(parentSym, state), 3000);
  }

  _flushSymbolBar(sym, state) {
    if (state.barFlushTimer) { clearTimeout(state.barFlushTimer); state.barFlushTimer = null; }
    if (!state.pendingBar) return;

    const bar = state.pendingBar;
    state.pendingBar = null;

    // Bar OHLC logged by strategy onBar() as [1m #N] — no need to duplicate here
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
   * Get the last tick price for a symbol (for slippage guard)
   * @param {string} symbol - Symbol to get tick price for (e.g. 'MNQ.FUT')
   * @returns {{ price: number, receivedAt: number, ageMs: number } | null}
   */
  getLastTickPrice(symbol) {
    const tick = this._lastTickPrice.get(symbol);
    if (!tick) return null;
    return {
      price: tick.price,
      receivedAt: tick.receivedAt,
      ageMs: Date.now() - tick.receivedAt,
    };
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
