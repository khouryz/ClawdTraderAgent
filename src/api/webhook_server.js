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
    } else if (method === 'GET' && pathname === '/positions') {
      await this._handlePositions(res);
    } else if (method === 'POST' && pathname === '/flatten') {
      await this._handleFlatten(res);
    } else {
      this._json(res, 404, { error: 'not found' });
    }
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

    // 11. orderType — "market" or "limit", normalize to capitalized
    let orderType = 'Market';
    if (payload.orderType) {
      const ot = payload.orderType.toLowerCase();
      if (ot === 'market') orderType = 'Market';
      else if (ot === 'limit') orderType = 'Limit';
      else return { valid: false, reason: `orderType must be "market" or "limit" (got "${payload.orderType}")` };
    }

    // Build the signal object that the execution engine expects
    const signal = {
      signalId: payload.signalId,
      symbol,
      type,                                    // 'buy' or 'sell'
      orderType,                               // 'Market' or 'Limit'
      price,
      stopLoss,
      targetPrice: targetPrice || undefined,
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
