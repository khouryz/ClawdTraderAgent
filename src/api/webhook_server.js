/**
 * Webhook Server — execution-only signal intake
 *
 * Receives fully-specified trade signals from an external analysis process,
 * validates them, deduplicates by signalId, and routes them through the bot's
 * existing execution pipeline (guards → SignalHandler → bracket order → Telegram).
 *
 * Loopback-only (127.0.0.1). No external dependencies — uses node:http.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class WebhookServer {
  /**
   * @param {Object} bot - ExecutionBot instance (or façade with executeSignal, getStatus, flattenAll, getOpenPositions)
   * @param {Object} opts - { port, token, contractsPath, maxQty, maxStopTicks, dedupMs }
   */
  constructor(bot, opts = {}) {
    this.bot = bot;
    this.port = parseInt(opts.port) || 8787;
    this.token = opts.token || '';
    this.contractsPath = opts.contractsPath || path.join(__dirname, '..', '..', 'config', 'contracts.json');
    this.maxQty = parseInt(opts.maxQty) || 2;
    this.maxStopTicks = parseInt(opts.maxStopTicks) || 200;
    this.dedupMs = parseInt(opts.dedupMs) || 300000; // 5 min

    this._contracts = null;
    this._dedup = new Map(); // signalId → { at, result }
    this._server = null;

    if (!this.token || this.token.length < 32) {
      throw new Error('WEBHOOK_TOKEN must be set and at least 32 characters');
    }
  }

  /**
   * Load contracts.json for validation (tick sizes, point values).
   */
  _loadContracts() {
    if (this._contracts) return this._contracts;
    try {
      this._contracts = JSON.parse(fs.readFileSync(this.contractsPath, 'utf8'));
    } catch (err) {
      logger.error(`WebhookServer: Failed to load contracts.json: ${err.message}`);
      this._contracts = {};
    }
    return this._contracts;
  }

  /**
   * Start the HTTP server. Returns a promise that resolves when listening.
   */
  start() {
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => this._handle(req, res));
      this._server.on('error', reject);
      this._server.listen(this.port, '127.0.0.1', () => {
        logger.info(`✓ Webhook server listening on 127.0.0.1:${this.port}`);
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server.
   */
  stop() {
    return new Promise((resolve) => {
      if (!this._server) return resolve();
      this._server.close(() => {
        logger.info('Webhook server stopped');
        resolve();
      });
    });
  }

  // ── Request handling ──────────────────────────────────────────────

  async _handle(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);

    // Auth check for all endpoints
    if (!this._checkAuth(req)) {
      logger.warn(`Webhook: 401 unauthorized from ${req.socket.remoteAddress}`);
      this._json(res, 401, { error: 'unauthorized' });
      return;
    }

    // Route
    const method = req.method;
    const pathname = url.pathname;

    if (method === 'POST' && pathname === '/signal') {
      await this._handleSignal(req, res);
    } else if (method === 'GET' && pathname === '/status') {
      this._handleStatus(res);
    } else if (method === 'GET' && pathname === '/report') {
      this._handleReport(res);
    } else if (method === 'GET' && pathname === '/positions') {
      await this._handlePositions(res);
    } else if (method === 'POST' && pathname === '/flatten') {
      await this._handleFlatten(res);
    } else if (method === 'POST' && pathname === '/pause') {
      this._handlePause(res);
    } else if (method === 'POST' && pathname === '/resume') {
      await this._handleResume(res);
    } else if (method === 'POST' && pathname === '/cancel-all') {
      await this._handleCancelAll(req, res);
    } else if (method === 'POST' && pathname === '/modify') {
      await this._handleModify(req, res);
    } else if (method === 'POST' && pathname === '/shutdown') {
      await this._handleShutdown(res);
    } else {
      this._json(res, 404, { error: 'not found' });
    }
  }

  /**
   * Ask the bot to stop GRACEFULLY.
   *
   * taskkill /F (SIGKILL) cannot be caught by any process, so a forced restart
   * skips the offline alert and the clean-shutdown marker entirely — which is
   * why every restart reported "previous shutdown was NOT clean". Scripts call
   * this first and only force-kill if the bot fails to go away.
   *
   * Responds BEFORE shutting down, so the caller gets an answer rather than a
   * dropped connection.
   */
  async _handleShutdown(res) {
    this._json(res, 200, { stopping: true });
    setTimeout(() => {
      Promise.resolve(this.bot.shutdown('shutdown requested via /shutdown'))
        .catch(() => process.exit(1));
    }, 50);
  }

  _checkAuth(req) {
    const provided = req.headers['x-signal-token'];
    if (!provided || typeof provided !== 'string') return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  _json(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
    res.end(json);
  }

  // ── POST /signal ──────────────────────────────────────────────────

  async _handleSignal(req, res) {
    // Read body
    let raw;
    try {
      raw = await this._readBody(req);
    } catch (err) {
      this._json(res, 400, { accepted: false, reason: 'Failed to read request body' });
      return;
    }

    // Parse JSON
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      this._json(res, 400, { accepted: false, reason: 'Malformed JSON' });
      return;
    }

    // Validate
    const validation = this._validateSignal(payload);
    if (!validation.valid) {
      logger.warn(`Webhook: signal rejected — ${validation.reason}`);
      this._notifyRejection(payload, validation.reason);
      this._json(res, 400, { accepted: false, reason: validation.reason });
      return;
    }

    const signal = validation.signal;
    const signalId = signal.signalId;

    // Dedup check
    const dedupEntry = this._dedup.get(signalId);
    if (dedupEntry && (Date.now() - dedupEntry.at) < this.dedupMs) {
      logger.info(`Webhook: duplicate signalId=${signalId} — returning cached result`);
      this._json(res, 200, { ...dedupEntry.result, duplicate: true });
      return;
    }
    // Evict stale entries
    this._evictDedup();

    // Execute via bot
    let result;
    try {
      result = await this.bot.executeSignal(signal);
    } catch (err) {
      logger.error(`Webhook: executeSignal error: ${err.message}`);
      result = { accepted: false, reason: `Internal error: ${err.message}` };
    }

    // Store in dedup
    this._dedup.set(signalId, { at: Date.now(), result });

    // Respond
    const status = result.accepted ? 200 : (result.blocked ? 200 : 400);
    this._json(res, status, result);
  }

  _evictDedup() {
    const now = Date.now();
    for (const [id, entry] of this._dedup) {
      if (now - entry.at > this.dedupMs) {
        this._dedup.delete(id);
      }
    }
  }

  // ── Validation ────────────────────────────────────────────────────

  _validateSignal(payload) {
    if (!payload || typeof payload !== 'object') {
      return { valid: false, reason: 'Payload must be a JSON object' };
    }

    // 1. signalId
    if (!payload.signalId || typeof payload.signalId !== 'string' || payload.signalId.length > 64) {
      return { valid: false, reason: 'signalId is required, must be a string ≤64 chars' };
    }

    // 2. symbol — must exist in contracts.json
    const contracts = this._loadContracts();
    const symbol = payload.symbol;
    if (!symbol || typeof symbol !== 'string' || !contracts[symbol]) {
      return { valid: false, reason: `Unknown symbol "${symbol}" — not in contracts.json` };
    }
    const specs = contracts[symbol];
    const tickSize = specs.tickSize;

    // 3. type — accept "long"/"short" (translate to "buy"/"sell") and "buy"/"sell" directly
    const rawType = payload.type;
    let type;
    if (rawType === 'long' || rawType === 'buy') type = 'buy';
    else if (rawType === 'short' || rawType === 'sell') type = 'sell';
    else return { valid: false, reason: `type must be "long" or "short" (got "${rawType}")` };

    // 4. price — required, numeric
    const price = payload.price;
    if (typeof price !== 'number' || isNaN(price) || price <= 0) {
      return { valid: false, reason: 'price is required and must be a positive number' };
    }

    // 5. stopLoss — required, numeric
    const stopLoss = payload.stopLoss;
    if (typeof stopLoss !== 'number' || isNaN(stopLoss) || stopLoss <= 0) {
      return { valid: false, reason: 'stopLoss is required and must be a positive number' };
    }

    // 6. Stop on correct side: long → stop < price; short → stop > price
    if (type === 'buy' && stopLoss >= price) {
      return { valid: false, reason: `stopLoss ${stopLoss} must be below entry ${price} for a long` };
    }
    if (type === 'sell' && stopLoss <= price) {
      return { valid: false, reason: `stopLoss ${stopLoss} must be above entry ${price} for a short` };
    }

    // 7. targetPrice — optional, but if present must be on correct side
    let targetPrice = payload.targetPrice;
    if (targetPrice !== undefined && targetPrice !== null) {
      if (typeof targetPrice !== 'number' || isNaN(targetPrice)) {
        return { valid: false, reason: 'targetPrice must be a number if provided' };
      }
      if (type === 'buy' && targetPrice <= price) {
        return { valid: false, reason: `targetPrice ${targetPrice} must be above entry ${price} for a long` };
      }
      if (type === 'sell' && targetPrice >= price) {
        return { valid: false, reason: `targetPrice ${targetPrice} must be below entry ${price} for a short` };
      }
    }

    // 8. quantity — optional, positive integer, capped at maxQty
    let quantity = payload.quantity;
    if (quantity !== undefined && quantity !== null) {
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return { valid: false, reason: 'quantity must be a positive integer' };
      }
      if (quantity > this.maxQty) {
        return { valid: false, reason: `quantity ${quantity} exceeds MAX_WEBHOOK_QTY ${this.maxQty}` };
      }
    }

    // 8a. exits — optional array of { qty, targetPrice } for multi-target scaling
    //   - If present, targetPrice (top-level) must NOT be present (mutual exclusion)
    //   - Each leg: qty > 0 integer, targetPrice on correct side, tick-aligned
    //   - sum(exits[].qty) must equal quantity
    //   - Targets strictly ordered by distance from entry, nearest first
    let exits = undefined;
    if (payload.exits !== undefined && payload.exits !== null) {
      if (targetPrice !== undefined && targetPrice !== null) {
        return { valid: false, reason: 'Cannot specify both exits[] and targetPrice — pick one' };
      }
      if (!Array.isArray(payload.exits) || payload.exits.length < 1 || payload.exits.length > 4) {
        return { valid: false, reason: 'exits must be an array of 1-4 leg objects' };
      }
      // quantity is required when exits is present (we need it to verify sum)
      if (quantity === undefined || quantity === null) {
        return { valid: false, reason: 'quantity is required when exits[] is specified (sum of leg qty must equal quantity)' };
      }
      const isTickAlignedFn = (p) => {
        const ticks = p / tickSize;
        return Math.abs(ticks - Math.round(ticks)) < 1e-6;
      };
      exits = [];
      let sumQty = 0;
      let prevDist = -1; // for strict ordering check
      for (let i = 0; i < payload.exits.length; i++) {
        const leg = payload.exits[i];
        if (!leg || typeof leg !== 'object') {
          return { valid: false, reason: `exits[${i}] must be an object` };
        }
        if (!Number.isInteger(leg.qty) || leg.qty <= 0) {
          return { valid: false, reason: `exits[${i}].qty must be a positive integer` };
        }
        if (typeof leg.targetPrice !== 'number' || isNaN(leg.targetPrice) || leg.targetPrice <= 0) {
          return { valid: false, reason: `exits[${i}].targetPrice must be a positive number` };
        }
        // Side check
        if (type === 'buy' && leg.targetPrice <= price) {
          return { valid: false, reason: `exits[${i}].targetPrice ${leg.targetPrice} must be above entry ${price} for a long` };
        }
        if (type === 'sell' && leg.targetPrice >= price) {
          return { valid: false, reason: `exits[${i}].targetPrice ${leg.targetPrice} must be below entry ${price} for a short` };
        }
        // Tick alignment
        if (!isTickAlignedFn(leg.targetPrice)) {
          return { valid: false, reason: `exits[${i}].targetPrice ${leg.targetPrice} not aligned to tick size ${tickSize}` };
        }
        // Strict ordering by distance from entry, nearest first
        const dist = Math.abs(leg.targetPrice - price);
        if (i > 0 && dist <= prevDist) {
          return { valid: false, reason: `exits targets must be strictly ordered by distance from entry, nearest first (leg ${i} distance ${dist.toFixed(2)} <= leg ${i-1} distance ${prevDist.toFixed(2)})` };
        }
        prevDist = dist;
        sumQty += leg.qty;
        exits.push({ qty: leg.qty, targetPrice: leg.targetPrice });
      }
      if (sumQty !== quantity) {
        return { valid: false, reason: `sum(exits[].qty)=${sumQty} must equal quantity=${quantity}` };
      }
    }

    // 9. Stop distance sanity — reject if abs(price - stop) exceeds maxStopTicks ticks
    const stopDistancePts = Math.abs(price - stopLoss);
    const stopDistanceTicks = stopDistancePts / tickSize;
    if (stopDistanceTicks > this.maxStopTicks) {
      return { valid: false, reason: `Stop distance ${stopDistanceTicks.toFixed(0)} ticks exceeds MAX_WEBHOOK_STOP_TICKS ${this.maxStopTicks}` };
    }

    // 10. Tick alignment — all prices must be exact multiples of tickSize
    const isTickAligned = (p) => {
      const ticks = p / tickSize;
      return Math.abs(ticks - Math.round(ticks)) < 1e-6;
    };
    if (!isTickAligned(price)) {
      return { valid: false, reason: `price ${price} not aligned to tick size ${tickSize}` };
    }
    if (!isTickAligned(stopLoss)) {
      return { valid: false, reason: `stopLoss ${stopLoss} not aligned to tick size ${tickSize}` };
    }
    if (targetPrice !== undefined && targetPrice !== null && !isTickAligned(targetPrice)) {
      return { valid: false, reason: `targetPrice ${targetPrice} not aligned to tick size ${tickSize}` };
    }

    // 11. orderType — "market", "limit" or "stop", normalized to capitalized.
    //     "stop" rests until price trades THROUGH `price` — the correct type
    //     for a break-of-signal-bar entry. A limit would fill at-or-better and
    //     therefore fill immediately on the wrong side of the break.
    let orderType = 'Market';
    if (payload.orderType) {
      const ot = payload.orderType.toLowerCase();
      if (ot === 'market') orderType = 'Market';
      else if (ot === 'limit') orderType = 'Limit';
      else if (ot === 'stop') orderType = 'Stop';
      else return { valid: false, reason: `orderType must be "market", "limit" or "stop" (got "${payload.orderType}")` };
    }

    // 12. entryTimeoutSec — optional; how long a resting Limit/Stop entry may
    //     work before it is cancelled. Meaningless on a market order.
    let entryTimeoutSec;
    if (payload.entryTimeoutSec !== undefined && payload.entryTimeoutSec !== null) {
      const t = payload.entryTimeoutSec;
      if (!Number.isInteger(t) || t <= 0 || t > 86400) {
        return { valid: false, reason: 'entryTimeoutSec must be a positive integer no greater than 86400' };
      }
      entryTimeoutSec = t;
    }

    // 13. refPrice — the sender's reading of the current market price.
    //
    //     THIS IS THE ONLY PRICE SOURCE IN THE SYSTEM. The bot makes no market
    //     data calls of any kind: getQuote/getBars/getDepth have zero callers,
    //     and Tradovate has no REST quote endpoint anyway. Every price the bot
    //     acts on arrives in this payload. The sender reads them off the chart.
    //
    //     REQUIRED for Stop entries, because a stop on the wrong side of the
    //     market triggers on submission and becomes an immediate market fill —
    //     the exact opposite of a break entry. Without a reference price there
    //     is no way to catch that, and there is no fallback to fall back to.
    let refPrice;
    if (payload.refPrice !== undefined && payload.refPrice !== null) {
      const r = Number(payload.refPrice);
      if (!Number.isFinite(r) || r <= 0) {
        return { valid: false, reason: 'refPrice must be a positive number' };
      }
      refPrice = r;
    } else if (orderType === 'Stop') {
      return { valid: false, reason: 'refPrice is required for a Stop entry — send the current market price so the order side can be verified (there is no other price source)' };
    }

    // Build the signal object that the execution engine expects
    const signal = {
      signalId: payload.signalId,
      symbol,
      type,                                    // 'buy' or 'sell'
      orderType,                               // 'Market', 'Limit' or 'Stop'
      entryTimeoutSec,                         // undefined → per-type default
      refPrice,                                // undefined → stop side check skipped
      price,
      stopLoss,
      targetPrice: targetPrice || undefined,
      exits: exits || undefined,               // multi-target legs, or undefined
      moveStopToBEAfterFirstTarget: payload.moveStopToBEAfterFirstTarget === true,
      quantity: quantity || undefined,         // undefined → RiskManager calculates
      strategy: payload.strategy || 'webhook', // label for logs + Telegram
      confluenceScore: payload.confluenceScore || null,
      meta: payload.meta || null,
    };

    return { valid: true, signal };
  }

  // ── GET /status ───────────────────────────────────────────────────

  _handleStatus(res) {
    try {
      const status = this.bot.getStatus();
      this._json(res, 200, status);
    } catch (err) {
      this._json(res, 500, { error: err.message });
    }
  }

  // ── GET /positions ────────────────────────────────────────────────

  async _handlePositions(res) {
    try {
      const positions = await this.bot.getOpenPositions();
      this._json(res, 200, positions);
    } catch (err) {
      this._json(res, 500, { error: err.message });
    }
  }

  // ── POST /flatten ─────────────────────────────────────────────────

  async _handleFlatten(res) {
    try {
      const result = await this.bot.flattenAll();
      this._json(res, 200, result);
    } catch (err) {
      this._json(res, 500, { error: err.message });
    }
  }

  // ── POST /resume ──────────────────────────────────────────────────
  //
  // Clears a halt without needing Telegram. This exists because a halt is
  // persisted by saveStateSync() and loadState() only clears daily-scoped
  // halts when the UTC date CHANGES — so a WEBSOCKET_DEAD halt taken during
  // an overnight sleep survives a restart if the session runs on the same
  // UTC date. Telegram /forceresume was the only recovery; now the operator
  // has one too. Mirrors _handleForceResume in TelegramCommandHandler.

  // ── POST /cancel-all ──────────────────────────────────────────────
  //
  // Cancels every working order on the account. Refuses while a position is
  // open unless {"force": true} is sent, since those orders are its brackets.

  async _handleCancelAll(req, res) {
    try {
      let force = false;
      try {
        const body = await this._readBody(req);
        if (body && body.trim()) force = JSON.parse(body).force === true;
      } catch (e) {
        // No body, or unparseable — treat as a non-forced request.
      }

      const result = await this.bot.cancelAllWorkingOrders({ force });
      this._json(res, result.refused ? 409 : 200, result);
    } catch (err) {
      this._json(res, 500, { error: err.message });
    }
  }

  /**
   * Pause this instance (no new entries).
   *
   * Needed so a Telegram /pause can fan out to every instrument. Without it,
   * pausing set _pausedByUser on ONLY the process holding the Telegram poller
   * lock, and the other instrument carried on trading while the operator
   * believed everything was paused.
   */
  /**
   * This instrument's own performance for today.
   *
   * Per-instance because the performance tracker writes into the instance's own
   * DATA_DIR. Telegram fans out across instances and adds an account-wide
   * summary line from the SHARED ledger, which is the figure that actually
   * governs trading.
   */
  _handleReport(res) {
    if (!this.bot?.performance) {
      return this._json(res, 503, { error: 'performance tracker not available' });
    }
    try {
      const st = this.bot.performance.getTodayStats() || {};
      return this._json(res, 200, {
        instrument: this.bot.contract?.name || this.bot.config?.contractSymbol || null,
        pnl: st.pnl || 0,
        trades: st.trades || 0,
        wins: st.wins || 0,
        losses: st.losses || 0,
        breakeven: st.breakeven || 0,
        winRate: st.winRate || 0,
      });
    } catch (err) {
      return this._json(res, 500, { error: err.message });
    }
  }

  _handlePause(res) {
    if (!this.bot) return this._json(res, 503, { paused: false, reason: 'bot not initialized' });
    const already = !!this.bot._pausedByUser;
    this.bot._pausedByUser = true;
    return this._json(res, 200, {
      paused: true,
      alreadyPaused: already,
      instrument: this.bot.contract?.name || this.bot.config?.contractSymbol || null,
    });
  }

  async _handleResume(res) {
    try {
      if (!this.bot?.lossLimits) {
        return this._json(res, 503, { resumed: false, reason: 'bot not fully initialized' });
      }
      const status = this.bot.lossLimits.getStatus();
      this.bot._pausedByUser = false;

      if (!status.isHalted) {
        return this._json(res, 200, { resumed: false, reason: 'not halted', halted: false });
      }

      const clearedReason = status.haltReason;
      this.bot.lossLimits.resume();
      return this._json(res, 200, { resumed: true, clearedHalt: clearedReason, halted: false });
    } catch (err) {
      this._json(res, 500, { error: err.message });
    }
  }

  // ── POST /modify ──────────────────────────────────────────────────

  async _handleModify(req, res) {
    try {
      const body = await this._readBody(req);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        this._json(res, 400, { error: 'malformed JSON' });
        return;
      }

      const orderId = payload.orderId;
      if (!orderId || typeof orderId !== 'number') {
        this._json(res, 400, { error: 'orderId (number) is required' });
        return;
      }

      const changes = {};
      if (payload.stopPrice !== undefined && payload.stopPrice !== null) {
        if (typeof payload.stopPrice !== 'number' || payload.stopPrice <= 0) {
          this._json(res, 400, { error: 'stopPrice must be a positive number' });
          return;
        }
        changes.stopPrice = payload.stopPrice;
      }
      if (payload.price !== undefined && payload.price !== null) {
        if (typeof payload.price !== 'number' || payload.price <= 0) {
          this._json(res, 400, { error: 'price must be a positive number' });
          return;
        }
        changes.price = payload.price;
      }
      if (payload.orderQty !== undefined && payload.orderQty !== null) {
        if (!Number.isInteger(payload.orderQty) || payload.orderQty <= 0) {
          this._json(res, 400, { error: 'orderQty must be a positive integer' });
          return;
        }
        changes.orderQty = payload.orderQty;
      }

      if (Object.keys(changes).length === 0) {
        this._json(res, 400, { error: 'At least one of stopPrice, price, or orderQty must be provided' });
        return;
      }

      const result = await this.bot.modifyOrder(orderId, changes);
      this._json(res, 200, result);
    } catch (err) {
      this._json(res, 500, { error: err.message });
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      let size = 0;
      const MAX = 65536; // 64KB
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX) {
          reject(new Error('Body too large'));
          req.destroy();
          return;
        }
        data += chunk;
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  _notifyRejection(payload, reason) {
    if (this.bot.notifications && typeof this.bot.notifications.send === 'function') {
      const sym = payload?.symbol || '?';
      const id = payload?.signalId || '?';
      this.bot.notifications.send(
        `❌ <b>SIGNAL REJECTED</b>\n` +
        `Symbol: ${sym}\n` +
        `signalId: ${id}\n` +
        `Reason: ${reason}`
      ).catch(() => {});
    }
  }
}

module.exports = WebhookServer;
