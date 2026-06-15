/**
 * SharedPriceProvider - Dual Databento streams for multiple instruments
 * 
 * Spawns TWO separate Python processes:
 *   1. ohlcv-1m stream — feeds strategy.onBar() via contract-lock dedup
 *   2. ohlcv-1s stream — feeds strategy.onTick() / slippage guard / BE checks
 * 
 * This design guarantees 100% isolation between 1m and 1s data.
 * No heuristic classification needed — each process knows exactly what it is.
 * 
 * Historical data is still fetched per-symbol (separate processes, sequential).
 */

const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');
const logger = require('../utils/logger');
const MarketDataRecorder = require('../analytics/MarketDataRecorder');

class SharedPriceProvider extends EventEmitter {
  /**
   * @param {Object} config
   * @param {string} config.apiKey - Databento API key
   * @param {string[]} config.symbols - Array of symbols (e.g. ['MNQ.FUT', 'MES.FUT', 'M2K.FUT'])
   * @param {string} [config.schema='ohlcv-1m'] - Data schema (used for 1m stream)
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

    // ── Adaptive bar-flush latency (see _flushDelayFor) ──
    // A freshly-arrived 1m bar is buffered briefly before emission ONLY so a
    // same-minute sibling-contract bar can arrive and the higher-volume (front-
    // month) one can win during a contract roll. Once LOCKED to the front month,
    // the lock filter in _handleOHLCV already drops every other contract's bar
    // before it can reach pendingBar — so the wait is pure latency. We therefore
    // flush FAST when locked (default 500ms) and keep the FULL wait only pre-lock /
    // mid-roll (default 3000ms). Contract SELECTION is unchanged — only emit timing.
    // Kill-switch: set BAR_FLUSH_MS_LOCKED=3000 to restore the original behavior.
    this._lockedFlushMs = this._clampInt(process.env.BAR_FLUSH_MS_LOCKED, 500, 0, 3000);
    this._unlockedFlushMs = this._clampInt(process.env.BAR_FLUSH_MS_UNLOCKED, 3000, 250, 10000);

    // Two separate processes — one per schema
    this._proc1m = null;   // ohlcv-1m process
    this._proc1s = null;   // ohlcv-1s process
    this._buffer1m = '';
    this._buffer1s = '';
    this._reconnectAttempts1m = 0;
    this._reconnectAttempts1s = 0;
    this._disconnectedAt1m = null;
    this._disconnectedAt1s = null;

    // Legacy compat: isConnected means BOTH streams are up
    this.isConnected = false;
    this.isRunning = false;
    this._1mConnected = false;
    this._1sConnected = false;

    // Per-symbol state for 1m dedup
    // symbol -> { lastBarTs, lastBarVol, pendingBar, barFlushTimer, lastEmittedBarTs, ... }
    this._symbolState = new Map();
    for (const sym of this.config.symbols) {
      this._symbolState.set(sym, {
        lastBarTs: null,
        lastBarVol: 0,
        pendingBar: null,
        barFlushTimer: null,
        lastEmittedBarTs: null,
        _lastEmittedBarClose: null,
        // Roll-safe dedup: track per-contract cumulative volume to lock to one contract
        contractVolumes: {},    // contractSymbol -> cumulative volume over recent bars (1m stream)
        lockedContract: null,   // once determined, only emit bars from this contract (shared lock)
        lockConsecutive: 0,     // how many consecutive bars the leader has won
        _lastLeader: null,
        // NEW: Separate tracking for 1s stream to avoid conflicts with 1m
        contractVolumes1s: {}, // contractSymbol -> cumulative volume over recent bars (1s stream)
        lockedContract1s: null, // independent lock for 1s stream
        lockConsecutive1s: 0,   // consecutive wins for 1s stream
        _lastLeader1s: null,
      });
    }

    // Per-symbol last price for slippage guard, sourced from 1s bar close.
    this._lastTickPrice = new Map();

    // ── Historical fetch dedup ──
    // Multiple InstrumentRunners (one per account) call getHistoricalBars() concurrently
    // at boot for the SAME (symbol, start, end) window. Without dedup that's N identical
    // Databento fetches and N python subprocesses spawned. We cache the in-flight Promise
    // so concurrent callers share one fetch, and the resolved bars are reusable for the
    // entire process lifetime (prior-day OHLCV doesn't change).
    //   key   = `${symbol}|${start}|${end||''}|${schema}|${limit||''}`
    //   value = Promise<bars[]>
    this._historicalCache = new Map();

    this._tag = `[Databento:SHARED]`;
    this._scriptPath = path.join(__dirname, 'databento_stream.py');

    // ── Market-data recorder (⑥) ──
    // Records the exact feed the bot saw (1s + 1m + lock/roll events) for
    // deterministic replay + a live-parity backtest dataset. Async/append-only,
    // never on the hot path. Disable with RECORD_MARKET_DATA=false.
    this._md = new MarketDataRecorder({
      dir: process.env.MARKETDATA_DIR || './data/marketdata',
      enabled: process.env.RECORD_MARKET_DATA !== 'false',
      // 1s bars re-fetchable from Databento → not persisted unless explicitly enabled.
      record1s: process.env.RECORD_MARKET_DATA_1S === 'true',
    });
  }

  /**
   * Start both live streams (1m + 1s) for all symbols
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
    this._reconnectAttempts1m = 0;
    this._reconnectAttempts1s = 0;

    // Spawn both streams in parallel
    await Promise.all([
      this._spawnStream('ohlcv-1m'),
      this._spawnStream('ohlcv-1s'),
    ]);

    // Make the Databento session budget unmissable in the boot logs: THIS provider
    // is the ENTIRE live footprint — exactly 2 concurrent sessions (one per schema),
    // each multiplexing EVERY symbol via a single comma-joined subscribe. Adding
    // instruments or accounts adds SYMBOLS to these same 2 sessions, never new
    // sessions. (Historical warmup uses the separate db.Historical endpoint and does
    // NOT count against the live concurrent-session limit.)
    const symList = this.config.symbols.join(', ');
    logger.success(`${this._tag} DATABENTO LIVE SESSIONS: 2/2 — [1] ohlcv-1m + [2] ohlcv-1s | each carries ${this.config.symbols.length} symbol(s): ${symList} | +instruments = +symbols here, 0 new sessions`);

    logger.info(`${this._tag} Bar-flush latency: ${this._lockedFlushMs}ms when locked to front month, ${this._unlockedFlushMs}ms pre-lock/roll`);
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
      const symbolStr = this.config.symbols.join(',');
      const args = [
        this._scriptPath,
        '--key', this.config.apiKey,
        '--symbol', symbolStr,
        '--schema', schema,
        '--dataset', this.config.dataset,
        '--mode', 'live'
      ];

      logger.info(`${this._tag} Starting ${label} stream: ${symbolStr}`);

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
                logger.info(`${this._tag} ✓ ${label} reconnected after ${(downtime / 1000).toFixed(1)}s (${attempts} attempts)`);
                // Only emit reconnected when BOTH are back up
                if (this._1mConnected && this._1sConnected) {
                  this.emit('reconnected', { downtimeMs: downtime, attempts });
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

      // Keep buffer reference accessible for reconnect
      if (is1m) { this._buffer1m = ''; } else { this._buffer1s = ''; }

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
        if (msg.message !== 'system') {
          logger.info(`${this._tag} [1m] Status: ${msg.message}`);
        }
        this.emit('status', msg);
        break;
      case 'error':
        logger.error(`${this._tag} [1m] Error: ${msg.message}`);
        this.emit('error', new Error(msg.message));
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
        // msg.symbol = parent (MNQ.FUT), msg.contract = actual (MNQM6/MNQU6)
        const actualContract = msg.contract || msg.symbol;
        let parentSym = msg.symbol;
        let state = this._symbolState.get(parentSym);
        if (!state) {
          // Fallback: try to resolve parent from contract name
          for (const [key, val] of this._symbolState) {
            const base = key.replace('.FUT', '');
            if (actualContract.startsWith(base) || actualContract === key) {
              parentSym = key;
              state = val;
              break;
            }
          }
          if (!state) break;
        }

        // ── Contract filter: adopt the 1m stream's authoritative lock ──
        // The 1m _handleOHLCV path is the source of truth for which contract is the
        // front month (it runs the 3-consecutive-wins lock + 2x roll-detection).
        // The 1s stream simply mirrors that decision so both streams can never end
        // up looking at different contracts.  Before 1m has locked (first ~3 bars of
        // a session, or right after restart) we fall back to a per-1s leader so we
        // still emit something usable — but as soon as 1m locks, that wins.
        if (state.lockedContract) {
          if (actualContract !== state.lockedContract) break; // not the front month
        } else {
          // Pre-1m-lock fallback: track 1s volumes and only emit from the leader.
          if (!state.contractVolumes1s[actualContract]) state.contractVolumes1s[actualContract] = 0;
          state.contractVolumes1s[actualContract] += msg.volume;
          let leader = null, leaderVol = 0;
          for (const [c, v] of Object.entries(state.contractVolumes1s)) {
            if (v > leaderVol) { leader = c; leaderVol = v; }
          }
          if (leader && actualContract !== leader) break;
        }

        // ── Price-sanity guard ──
        // Reject if BOTH (a) near-zero volume (V<10) AND (b) deviates >50pt.
        const lastTick = this._lastTickPrice.get(parentSym);
        const refPrice = lastTick ? lastTick.price
                       : (state._lastEmittedBarClose != null ? state._lastEmittedBarClose : null);
        const vol1s = msg.volume || 0;
        if (refPrice != null && vol1s < 10 && Math.abs(msg.close - refPrice) > 50) {
          logger.warn(`${this._tag} [1s] Dropping junk bar: C=${msg.close} deviates ${Math.abs(msg.close - refPrice).toFixed(1)}pt from ref ${refPrice} (V=${vol1s})`);
          break;
        }

        const bar1sObj = {
          timestamp: msg.ts,
          open: msg.open,
          high: msg.high,
          low: msg.low,
          close: msg.close,
          volume: msg.volume,
          symbol: parentSym
        };
        this.emit(`bar1s:${parentSym}`, bar1sObj);
        if (this._md) this._md.bar1s(parentSym, bar1sObj);

        // Update last-price for slippage guard / BE checks
        this._lastTickPrice.set(parentSym, { price: msg.close, receivedAt: Date.now() });
        break;
      }
      case 'status':
        if (msg.message !== 'system') {
          logger.info(`${this._tag} [1s] Status: ${msg.message}`);
        }
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
   * Handle OHLCV bar with per-symbol dedup.
   * Roll-safe: tracks per-contract cumulative volume to lock to one contract
   * during roll periods when two contracts have similar bar-by-bar volumes.
   */
  _handleOHLCV(msg) {
    // Use msg.contract (e.g. MNQM6, MNQU6) for roll detection — msg.symbol is the parent (MNQ.FUT)
    const actualContract = msg.contract || msg.symbol;
    // Find the parent symbol state (e.g. MNQ.FUT)
    let parentSym = msg.symbol;
    let state = this._symbolState.get(parentSym);

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
          if (this._md) this._md.event(parentSym, 'roll', { from: state.lockedContract, to: leader, lockedVol, leaderVol });
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
        if (this._md) this._md.event(parentSym, 'lock', { contract: leader, consecutive: state.lockConsecutive });
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
    const flushDelay = this._flushDelayFor(state, actualContract);
    // One-time per-symbol confirmation that the latency-cut path is active.
    if (flushDelay < this._unlockedFlushMs && !state._fastFlushLogged) {
      state._fastFlushLogged = true;
      logger.info(`${this._tag} ⚡ Fast bar-flush active for ${parentSym} (locked ${state.lockedContract}, ${flushDelay}ms vs ${this._unlockedFlushMs}ms) — ~${((this._unlockedFlushMs - flushDelay) / 1000).toFixed(1)}s less entry latency`);
    }
    state.barFlushTimer = setTimeout(() => this._flushSymbolBar(parentSym, state), flushDelay);
  }

  /**
   * Parse + clamp an integer env value with a default. Defensive: any unparseable
   * or out-of-range value falls back to the default so a bad env can't, e.g., set a
   * negative or absurd flush delay.
   * @private
   */
  _clampInt(val, def, min, max) {
    const n = parseInt(val, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  /**
   * How long to buffer a freshly-arrived 1m bar before emitting it.
   *
   * The buffer exists ONLY to let a same-minute SIBLING-CONTRACT bar arrive so the
   * higher-volume (front-month) one wins during a roll. Once LOCKED to the front
   * month, the lock filter in _handleOHLCV has already dropped every other
   * contract's same-ts bar, so pendingBar can never be replaced by a sibling and
   * the wait is pure latency.
   *   • locked AND this bar IS the locked front month → fast flush (default 500ms)
   *   • not locked yet, or mid-roll ambiguity         → full wait (default 3000ms)
   * Contract SELECTION is unchanged — only emit TIMING.
   * @private
   */
  _flushDelayFor(state, actualContract) {
    const lockedFrontMonth = !!(state.lockedContract && actualContract === state.lockedContract);
    return lockedFrontMonth ? this._lockedFlushMs : this._unlockedFlushMs;
  }

  _flushSymbolBar(sym, state) {
    if (state.barFlushTimer) { clearTimeout(state.barFlushTimer); state.barFlushTimer = null; }
    if (!state.pendingBar) return;

    const bar = state.pendingBar;
    state.pendingBar = null;

    // Bar OHLC logged by strategy onBar() as [1m #N] — no need to duplicate here
    state.lastEmittedBarTs = bar.timestamp;
    state._lastEmittedBarClose = bar.close;  // used by junk-bar guard

    // Emit per-symbol events
    this.emit(`bar:${sym}`, bar);
    if (this._md) this._md.bar1m(sym, bar);
    this.emit(`quote:${sym}`, {
      price: bar.close,
      timestamp: bar.timestamp,
      volume: bar.volume,
      symbol: sym
    });
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
      // If BOTH streams are dead, mark as not running
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
   * Fetch historical bars for a SINGLE symbol with dedup across concurrent callers.
   *
   * In multi-account mode, every InstrumentRunner runs _loadInitialData() concurrently
   * and all of them request the same (symbol, start, end) prior-day window. Without
   * this cache layer, N accounts → N python subprocesses → N identical Databento
   * fetches at boot. With the cache: the first caller kicks off the fetch, subsequent
   * concurrent callers receive the same in-flight Promise, and the resolved bar array
   * is reused for the rest of the process lifetime (historical OHLCV is immutable).
   *
   * Different (start, end, schema, limit) combinations produce different cache keys,
   * so gap-recovery fetches (which use different windows) still hit the wire.
   *
   * On failure the cache entry is evicted so the next call can retry.
   */
  async getHistoricalBars(symbol, start, end = null, schema = 'ohlcv-1m', limit = null) {
    if (!this.config.apiKey) throw new Error('Databento API key not configured');

    const cacheKey = `${symbol}|${start}|${end || ''}|${schema}|${limit || ''}`;
    const cached = this._historicalCache.get(cacheKey);
    if (cached) {
      logger.info(`[Databento:${symbol}] Historical cache hit: ${schema} from ${start}${end ? ` to ${end}` : ''}`);
      return cached;
    }

    const promise = this._fetchHistoricalBars(symbol, start, end, schema, limit);
    this._historicalCache.set(cacheKey, promise);
    // Evict on failure so a retry can re-fetch; keep on success for reuse.
    promise.catch(() => this._historicalCache.delete(cacheKey));
    return promise;
  }

  /**
   * Raw historical fetch — one python subprocess per call. Called via the cached
   * getHistoricalBars wrapper above; do not call directly.
   * @private
   */
  async _fetchHistoricalBars(symbol, start, end, schema, limit) {
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
   * Stop both streams
   */
  stop() {
    this.isRunning = false;
    // Flush all pending 1m bars
    for (const [sym, state] of this._symbolState) {
      this._flushSymbolBar(sym, state);
    }
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
    if (this._md) this._md.closeAll();
  }
}

module.exports = SharedPriceProvider;
