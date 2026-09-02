/**
 * Webhook Server Tests — validation, dedup, auth, end-to-end with mocked bot
 *
 * Run: node tests/test_webhook.js
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebhookServer = require('../src/api/webhook_server');

// ── Mock bot ────────────────────────────────────────────────────────

class MockBot {
  constructor() {
    this.signals = [];
    this.notifications = { send: async () => {} };
    this._paused = false;
    this._halted = false;
  }

  async executeSignal(signal) {
    this.signals.push(signal);
    if (this._paused) return { accepted: false, reason: 'paused', blocked: true };
    if (this._halted) return { accepted: false, reason: 'halted', blocked: true };
    return { accepted: true, signalId: signal.signalId, status: 'submitted', orderId: 12345 };
  }

  getStatus() {
    return {
      connected: true, executionOnly: true, paused: this._paused,
      halted: this._halted, tradesToday: this.signals.length, maxTrades: 3,
      dailyPnl: 0, lossLimitRemaining: 150, openPositions: 0,
      marketOpen: true, pastEntryCutoff: false,
    };
  }

  async getOpenPositions() { return { positions: [], workingOrders: [] }; }
  async flattenAll() { return { flattened: false, reason: 'No open position' }; }
}

// ── Helpers ─────────────────────────────────────────────────────────

const TOKEN = 'a'.repeat(40); // 40-char token for tests
const PORT = 9876;

function request(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, method, path,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'Connection': 'close',
        ...(token ? { 'X-Signal-Token': token } : {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withServer(fn, opts = {}) {
  const bot = opts.bot || new MockBot();
  const server = new WebhookServer(bot, {
    port: PORT,
    token: TOKEN,
    maxQty: opts.maxQty || 2,
    maxStopTicks: opts.maxStopTicks || 200,
    dedupMs: opts.dedupMs || 300000,
    contractsPath: opts.contractsPath || path.join(__dirname, '..', 'config', 'contracts.json'),
  });
  await server.start();
  try {
    await fn(bot, server);
  } finally {
    await server.stop();
    await sleep(100); // let the port release
  }
}

// ── Tests ───────────────────────────────────────────────────────────

async function testAuthMissing() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', { type: 'long', symbol: 'MNQ', price: 100, stopLoss: 99 });
    assert.strictEqual(res.status, 401, 'Missing token should return 401');
    assert.strictEqual(res.body.error, 'unauthorized');
  });
  console.log('✓ testAuthMissing');
}

async function testAuthWrong() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', { type: 'long', symbol: 'MNQ', price: 100, stopLoss: 99 }, 'wrongtoken');
    assert.strictEqual(res.status, 401, 'Wrong token should return 401');
  });
  console.log('✓ testAuthWrong');
}

async function testMalformedJSON() {
  await withServer(async (bot) => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: PORT, method: 'POST', path: '/signal',
        headers: { 'Content-Type': 'application/json', 'X-Signal-Token': TOKEN, 'Connection': 'close' },
      }, (r) => {
        let b = ''; r.on('data', c => b += c);
        r.on('end', () => resolve({ status: r.statusCode, body: b }));
      });
      req.on('error', reject);
      req.end('{not valid json');
    });
    assert.strictEqual(res.status, 400);
  });
  console.log('✓ testMalformedJSON');
}

async function testInvertedStopLong() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'test1', type: 'long', symbol: 'MNQ', price: 100, stopLoss: 101,
    }, TOKEN);
    assert.strictEqual(res.status, 400, 'Long with stop above entry should 400');
    assert.match(res.body.reason, /must be below/);
  });
  console.log('✓ testInvertedStopLong');
}

async function testInvertedStopShort() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'test2', type: 'short', symbol: 'MNQ', price: 100, stopLoss: 99,
    }, TOKEN);
    assert.strictEqual(res.status, 400, 'Short with stop below entry should 400');
    assert.match(res.body.reason, /must be above/);
  });
  console.log('✓ testInvertedStopShort');
}

async function testUnknownSymbol() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'test3', type: 'long', symbol: 'XYZ', price: 100, stopLoss: 99,
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /Unknown symbol/);
  });
  console.log('✓ testUnknownSymbol');
}

async function testQtyOverMax() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'test4', type: 'long', symbol: 'MNQ', price: 100, stopLoss: 99, quantity: 10,
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /exceeds MAX_WEBHOOK_QTY/);
  });
  console.log('✓ testQtyOverMax');
}

async function testPriceOffTick() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'test5', type: 'long', symbol: 'MNQ', price: 100.10, stopLoss: 99,
    }, TOKEN);
    assert.strictEqual(res.status, 400, 'MNQ tick=0.25, 100.10 not aligned');
    assert.match(res.body.reason, /not aligned to tick/);
  });
  console.log('✓ testPriceOffTick');
}

async function testStopDistanceOverMax() {
  await withServer(async (bot) => {
    // MNQ tick=0.25, 200 ticks = 50 points. Stop at 100-51=49 → 51pt = 204 ticks > 200
    const res = await request('POST', '/signal', {
      signalId: 'test6', type: 'long', symbol: 'MNQ', price: 100, stopLoss: 49,
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /exceeds MAX_WEBHOOK_STOP_TICKS/);
  });
  console.log('✓ testStopDistanceOverMax');
}

async function testDuplicateSignalId() {
  await withServer(async (bot) => {
    const sig = { signalId: 'dup1', type: 'long', symbol: 'MNQ', price: 100, stopLoss: 99 };
    const r1 = await request('POST', '/signal', sig, TOKEN);
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r1.body.accepted, true);
    const r2 = await request('POST', '/signal', sig, TOKEN);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.body.duplicate, true, 'Second should be marked duplicate');
    assert.strictEqual(bot.signals.length, 1, 'Only one order should be placed');
  });
  console.log('✓ testDuplicateSignalId');
}

async function testPausedRejects() {
  await withServer(async (bot) => {
    bot._paused = true;
    const res = await request('POST', '/signal', {
      signalId: 'pause1', type: 'long', symbol: 'MNQ', price: 100, stopLoss: 99,
    }, TOKEN);
    assert.strictEqual(res.status, 200, 'Paused is a blocked state, not a 400');
    assert.strictEqual(res.body.accepted, false);
    assert.match(res.body.reason, /paused/);
  });
  console.log('✓ testPausedRejects');
}

async function testHaltedRejects() {
  await withServer(async (bot) => {
    bot._halted = true;
    const res = await request('POST', '/signal', {
      signalId: 'halt1', type: 'long', symbol: 'MNQ', price: 100, stopLoss: 99,
    }, TOKEN);
    assert.strictEqual(res.status, 200, 'Halted is a blocked state, not a 400');
    assert.strictEqual(res.body.accepted, false);
    assert.match(res.body.reason, /halted/);
  });
  console.log('✓ testHaltedRejects');
}

async function testValidSignalExecutes() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'valid1', type: 'long', symbol: 'MNQ', price: 100, stopLoss: 99, targetPrice: 103,
    }, TOKEN);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.accepted, true);
    assert.strictEqual(res.body.orderId, 12345);
    assert.strictEqual(bot.signals.length, 1);
    assert.strictEqual(bot.signals[0].type, 'buy', 'long → buy');
    assert.strictEqual(bot.signals[0].orderType, 'Market');
  });
  console.log('✓ testValidSignalExecutes');
}

async function testShortSignalExecutes() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'short1', type: 'short', symbol: 'MNQ', price: 100, stopLoss: 101, targetPrice: 97,
    }, TOKEN);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.accepted, true);
    assert.strictEqual(bot.signals[0].type, 'sell', 'short → sell');
  });
  console.log('✓ testShortSignalExecutes');
}

async function testLimitOrderType() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'lim1', type: 'long', symbol: 'MNQ', price: 100, stopLoss: 99, orderType: 'limit',
    }, TOKEN);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(bot.signals[0].orderType, 'Limit', 'limit → capitalized');
  });
  console.log('✓ testLimitOrderType');
}

async function testStopOrderTypeAcceptedAtWebhook() {
  // Regression: SignalHandler gained a Stop branch, but the webhook's
  // orderType allowlist still only held market/limit — so every stop entry
  // was rejected 400 before reaching the bot. Unit-testing SignalHandler
  // directly did not catch it; only an end-to-end send did.
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'stp1', type: 'short', symbol: 'MNQ', price: 29150, stopLoss: 29175, orderType: 'stop', refPrice: 29200,
    }, TOKEN);
    assert.strictEqual(res.status, 200, `stop must be accepted, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(bot.signals[0].orderType, 'Stop', 'stop → capitalized Stop');
  });
  console.log('✓ testStopOrderTypeAcceptedAtWebhook');
}

async function testEntryTimeoutReachesTheBot() {
  // The validator rebuilds the signal from scratch, so any field it does not
  // explicitly copy is silently dropped — entryTimeoutSec was.
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'stp2', type: 'short', symbol: 'MNQ', price: 29150, stopLoss: 29175,
      orderType: 'stop', entryTimeoutSec: 900, refPrice: 29200,
    }, TOKEN);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(bot.signals[0].entryTimeoutSec, 900, 'entryTimeoutSec must survive validation');
  });
  await withServer(async () => {
    const bad = await request('POST', '/signal', {
      signalId: 'stp3', type: 'short', symbol: 'MNQ', price: 29150, stopLoss: 29175,
      orderType: 'stop', entryTimeoutSec: -5, refPrice: 29200,
    }, TOKEN);
    assert.strictEqual(bad.status, 400, 'negative timeout must be rejected');
  });
  console.log('✓ testEntryTimeoutReachesTheBot');
}

async function testBogusOrderTypeStillRejected() {
  await withServer(async () => {
    const res = await request('POST', '/signal', {
      signalId: 'bad1', type: 'long', symbol: 'MNQ', price: 100, stopLoss: 99, orderType: 'trailing',
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /market.*limit.*stop/);
  });
  console.log('✓ testBogusOrderTypeStillRejected');
}

async function testMissingSignalId() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      type: 'long', symbol: 'MNQ', price: 100, stopLoss: 99,
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /signalId/);
  });
  console.log('✓ testMissingSignalId');
}

async function testMissingPrice() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'noprice', type: 'long', symbol: 'MNQ', stopLoss: 99,
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /price/);
  });
  console.log('✓ testMissingPrice');
}

async function testTargetOnWrongSide() {
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'wrongtgt', type: 'long', symbol: 'MNQ', price: 100, stopLoss: 99, targetPrice: 98,
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /targetPrice.*above/);
  });
  console.log('✓ testTargetOnWrongSide');
}

async function testStatusEndpoint() {
  await withServer(async (bot) => {
    const res = await request('GET', '/status', null, TOKEN);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.executionOnly, true);
  });
  console.log('✓ testStatusEndpoint');
}

async function testFlattenEndpoint() {
  await withServer(async (bot) => {
    const res = await request('POST', '/flatten', null, TOKEN);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.flattened, false);
  });
  console.log('✓ testFlattenEndpoint');
}

async function test404() {
  await withServer(async (bot) => {
    const res = await request('GET', '/nonexistent', null, TOKEN);
    assert.strictEqual(res.status, 404);
  });
  console.log('✓ test404');
}

async function testTokenTooShort() {
  try {
    new WebhookServer(new MockBot(), { port: PORT, token: 'short' });
    assert.fail('Should throw on short token');
  } catch (err) {
    assert.match(err.message, /32 characters/);
  }
  console.log('✓ testTokenTooShort');
}

// ── Multi-target exits tests ────────────────────────────────────────

async function testExitsQtySumMismatch() {
  const server = new WebhookServer(new MockBot(), { port: PORT, token: TOKEN });
  await server.start();
  await sleep(50);
  try {
    const res = await request('POST', '/signal', {
      signalId: 'exit-qty-1', symbol: 'MNQ', type: 'long', price: 19500.00,
      stopLoss: 19490.00, quantity: 2,
      exits: [{ qty: 1, targetPrice: 19520.00 }, { qty: 2, targetPrice: 19540.00 }],
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /sum.*must equal/);
  } finally { await server.stop(); await sleep(50); }
  console.log('✓ testExitsQtySumMismatch');
}

async function testExitsOutOfOrder() {
  const server = new WebhookServer(new MockBot(), { port: PORT, token: TOKEN });
  await server.start();
  await sleep(50);
  try {
    // Long: targets must be ascending (nearest first). Descending → reject.
    const res = await request('POST', '/signal', {
      signalId: 'exit-order-1', symbol: 'MNQ', type: 'long', price: 19500.00,
      stopLoss: 19490.00, quantity: 2,
      exits: [{ qty: 1, targetPrice: 19540.00 }, { qty: 1, targetPrice: 19520.00 }],
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /strictly ordered/);
  } finally { await server.stop(); await sleep(50); }
  console.log('✓ testExitsOutOfOrder');
}

async function testExitsAndTargetPriceBothPresent() {
  const server = new WebhookServer(new MockBot(), { port: PORT, token: TOKEN });
  await server.start();
  await sleep(50);
  try {
    const res = await request('POST', '/signal', {
      signalId: 'exit-both-1', symbol: 'MNQ', type: 'long', price: 19500.00,
      stopLoss: 19490.00, quantity: 2, targetPrice: 19520.00,
      exits: [{ qty: 1, targetPrice: 19520.00 }, { qty: 1, targetPrice: 19540.00 }],
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /Cannot specify both/);
  } finally { await server.stop(); await sleep(50); }
  console.log('✓ testExitsAndTargetPriceBothPresent');
}

async function testExitsTargetOnWrongSide() {
  const server = new WebhookServer(new MockBot(), { port: PORT, token: TOKEN });
  await server.start();
  await sleep(50);
  try {
    // Long but target below entry
    const res = await request('POST', '/signal', {
      signalId: 'exit-wrongside-1', symbol: 'MNQ', type: 'long', price: 19500.00,
      stopLoss: 19490.00, quantity: 1,
      exits: [{ qty: 1, targetPrice: 19480.00 }],
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /must be above entry/);
  } finally { await server.stop(); await sleep(50); }
  console.log('✓ testExitsTargetOnWrongSide');
}

async function testExitsTargetOffTick() {
  const server = new WebhookServer(new MockBot(), { port: PORT, token: TOKEN });
  await server.start();
  await sleep(50);
  try {
    const res = await request('POST', '/signal', {
      signalId: 'exit-offtick-1', symbol: 'MNQ', type: 'long', price: 19500.00,
      stopLoss: 19490.00, quantity: 1,
      exits: [{ qty: 1, targetPrice: 19520.10 }],
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /not aligned to tick/);
  } finally { await server.stop(); await sleep(50); }
  console.log('✓ testExitsTargetOffTick');
}

async function testExitsDuplicateTargets() {
  const server = new WebhookServer(new MockBot(), { port: PORT, token: TOKEN });
  await server.start();
  await sleep(50);
  try {
    // Two legs at same target → not strictly ordered (dist equal)
    const res = await request('POST', '/signal', {
      signalId: 'exit-dup-1', symbol: 'MNQ', type: 'long', price: 19500.00,
      stopLoss: 19490.00, quantity: 2,
      exits: [{ qty: 1, targetPrice: 19520.00 }, { qty: 1, targetPrice: 19520.00 }],
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /strictly ordered/);
  } finally { await server.stop(); await sleep(50); }
  console.log('✓ testExitsDuplicateTargets');
}

async function testExitsMissingQuantity() {
  const server = new WebhookServer(new MockBot(), { port: PORT, token: TOKEN });
  await server.start();
  await sleep(50);
  try {
    const res = await request('POST', '/signal', {
      signalId: 'exit-noqty-1', symbol: 'MNQ', type: 'long', price: 19500.00,
      stopLoss: 19490.00,
      exits: [{ qty: 1, targetPrice: 19520.00 }],
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /quantity is required/);
  } finally { await server.stop(); await sleep(50); }
  console.log('✓ testExitsMissingQuantity');
}

async function testValidExitsSignalExecutes() {
  const bot = new MockBot();
  const server = new WebhookServer(bot, { port: PORT, token: TOKEN });
  await server.start();
  await sleep(50);
  try {
    const res = await request('POST', '/signal', {
      signalId: 'exit-valid-1', symbol: 'MNQ', type: 'long', price: 19500.00,
      stopLoss: 19490.00, quantity: 2, orderType: 'market',
      exits: [{ qty: 1, targetPrice: 19520.00 }, { qty: 1, targetPrice: 19540.00 }],
      moveStopToBEAfterFirstTarget: true,
    }, TOKEN);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.accepted, true);
    assert.strictEqual(bot.signals.length, 1);
    const sig = bot.signals[0];
    assert.ok(sig.exits, 'exits should be passed through');
    assert.strictEqual(sig.exits.length, 2);
    assert.strictEqual(sig.exits[0].qty, 1);
    assert.strictEqual(sig.exits[0].targetPrice, 19520.00);
    assert.strictEqual(sig.exits[1].targetPrice, 19540.00);
    assert.strictEqual(sig.moveStopToBEAfterFirstTarget, true);
  } finally { await server.stop(); await sleep(50); }
  console.log('✓ testValidExitsSignalExecutes');
}

async function testShortExitsDescending() {
  const bot = new MockBot();
  const server = new WebhookServer(bot, { port: PORT, token: TOKEN });
  await server.start();
  await sleep(50);
  try {
    // Short: targets must be descending (nearest first)
    const res = await request('POST', '/signal', {
      signalId: 'exit-short-1', symbol: 'MNQ', type: 'short', price: 19500.00,
      stopLoss: 19510.00, quantity: 2,
      exits: [{ qty: 1, targetPrice: 19480.00 }, { qty: 1, targetPrice: 19460.00 }],
    }, TOKEN);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.accepted, true);
  } finally { await server.stop(); await sleep(50); }
  console.log('✓ testShortExitsDescending');
}

async function testExitsTooManyLegs() {
  const server = new WebhookServer(new MockBot(), { port: PORT, token: TOKEN });
  await server.start();
  await sleep(50);
  try {
    const res = await request('POST', '/signal', {
      signalId: 'exit-many-1', symbol: 'MNQ', type: 'long', price: 19500.00,
      stopLoss: 19490.00, quantity: 2,
      exits: [
        { qty: 1, targetPrice: 19510.00 },
        { qty: 1, targetPrice: 19520.00 },
        { qty: 1, targetPrice: 19530.00 },
        { qty: 1, targetPrice: 19540.00 },
        { qty: 1, targetPrice: 19550.00 },
      ],
    }, TOKEN);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.reason, /1-4/);
  } finally { await server.stop(); await sleep(50); }
  console.log('✓ testExitsTooManyLegs');
}

// ── Multi-leg OCO placement tests (mocked client) ───────────────────

async function testMultiLegOCOPlacement() {
  // Test that placeOCO is called once per leg with the same stop
  const placedOCOs = [];
  const mockClient = {
    placeOCO: async (accountSpec, accountId, symbol, qty, exitAction, stopPrice, targetPrice) => {
      const result = { orderId: 1000 + placedOCOs.length, ocoId: 2000 + placedOCOs.length };
      placedOCOs.push({ qty, stopPrice, targetPrice, ...result });
      return result;
    },
    cancelOrder: async () => {},
    placeMarketOrder: async () => ({ orderId: 999 }),
    getOrder: async () => ({ ordStatus: 'Working' }),
  };

  // Re-create a minimal ExecutionBot-like context to test _placeMultiLegOCO
  const ExecutionBot = require('../src/bot/ExecutionBot');
  const bot = Object.create(ExecutionBot.prototype);
  bot.client = mockClient;
  bot.contract = { id: 1, name: 'MNQ' };
  bot.account = { id: 1, name: 'TEST' };
  const { CONTRACTS } = require('../src/utils/constants');
  bot.notifications = { send: async () => {} };

  const ocoParams = {
    accountSpec: 'TEST', accountId: 1, contractName: 'MNQ',
    contracts: 2, exitAction: 'Sell',
    exits: [{ qty: 1, targetPrice: 19520.00 }, { qty: 1, targetPrice: 19540.00 }],
  };
  const position = { bracketLegs: [], quantity: 2, side: 'Buy', entryPrice: 19500.00 };

  await bot._placeMultiLegOCO(ocoParams, position, 19490.00, 19500.00);

  assert.strictEqual(placedOCOs.length, 2, 'should place 2 OCOs');
  assert.strictEqual(placedOCOs[0].qty, 1);
  assert.strictEqual(placedOCOs[1].qty, 1);
  assert.strictEqual(placedOCOs[0].stopPrice, 19490.00);
  assert.strictEqual(placedOCOs[1].stopPrice, 19490.00, 'both legs share same stop');
  assert.strictEqual(placedOCOs[0].targetPrice, 19520.00);
  assert.strictEqual(placedOCOs[1].targetPrice, 19540.00);
  assert.strictEqual(position.bracketLegs.length, 2);
  console.log('✓ testMultiLegOCOPlacement');
}

async function testMultiLegPartialFailureFallback() {
  // Leg 1 succeeds, leg 2 fails → cancel leg 1, fallback single OCO
  const placedOCOs = [];
  let callCount = 0;
  const mockClient = {
    placeOCO: async (accountSpec, accountId, symbol, qty, exitAction, stopPrice, targetPrice) => {
      callCount++;
      if (callCount === 2) throw new Error('Exchange rejected leg 2');
      const result = { orderId: 1000 + placedOCOs.length, ocoId: 2000 + placedOCOs.length };
      placedOCOs.push({ qty, stopPrice, targetPrice, ...result });
      return result;
    },
    cancelOrder: async (orderId) => { /* track cancellations */ },
    placeMarketOrder: async () => ({ orderId: 999 }),
  };

  const ExecutionBot = require('../src/bot/ExecutionBot');
  const bot = Object.create(ExecutionBot.prototype);
  bot.client = mockClient;
  bot.contract = { id: 1, name: 'MNQ' };
  bot.account = { id: 1, name: 'TEST' };
  bot.notifications = { send: async () => {} };

  const ocoParams = {
    accountSpec: 'TEST', accountId: 1, contractName: 'MNQ',
    contracts: 2, exitAction: 'Sell',
    exits: [{ qty: 1, targetPrice: 19520.00 }, { qty: 1, targetPrice: 19540.00 }],
  };
  const position = { bracketLegs: [], quantity: 2, side: 'Buy', entryPrice: 19500.00 };

  await bot._placeMultiLegOCO(ocoParams, position, 19490.00, 19500.00);

  // Should have placed: leg 1 + fallback single OCO = 2 total
  assert.strictEqual(placedOCOs.length, 2, 'should have leg 1 + fallback');
  // Fallback should be for full quantity with nearest target
  assert.strictEqual(placedOCOs[1].qty, 2, 'fallback should be full qty');
  assert.strictEqual(placedOCOs[1].targetPrice, 19520.00, 'fallback uses nearest target');
  assert.strictEqual(position.bracketLegs.length, 1, 'should have single fallback leg');
  console.log('✓ testMultiLegPartialFailureFallback');
}

async function testMultiLegAllFailEmergencyClose() {
  // All legs fail AND fallback fails → emergency close
  const mockClient = {
    placeOCO: async () => { throw new Error('Exchange down'); },
    cancelOrder: async () => {},
    placeMarketOrder: async () => ({ orderId: 999 }),
  };
  let emergencyCalled = false;

  const ExecutionBot = require('../src/bot/ExecutionBot');
  const bot = Object.create(ExecutionBot.prototype);
  bot.client = mockClient;
  bot.contract = { id: 1, name: 'MNQ' };
  bot.account = { id: 1, name: 'TEST' };
  bot.notifications = { send: async () => {} };
  bot._emergencyClose = async (params, reason) => { emergencyCalled = true; };

  const ocoParams = {
    accountSpec: 'TEST', accountId: 1, contractName: 'MNQ',
    contracts: 2, exitAction: 'Sell',
    exits: [{ qty: 1, targetPrice: 19520.00 }, { qty: 1, targetPrice: 19540.00 }],
  };
  const position = { bracketLegs: [], quantity: 2, side: 'Buy', entryPrice: 19500.00 };

  await bot._placeMultiLegOCO(ocoParams, position, 19490.00, 19500.00);
  assert.strictEqual(emergencyCalled, true, 'emergency close should be called');
  console.log('✓ testMultiLegAllFailEmergencyClose');
}

async function testMoveStopToBEAfterFirstTarget() {
  // After first target fills, remaining stops should be modified to entry price
  const modifiedOrders = [];
  const mockClient = {
    getOrder: async (orderId) => ({ ordStatus: 'Working' }), // all stops still working
    modifyOrder: async (orderId, changes) => {
      modifiedOrders.push({ orderId, stopPrice: changes.stopPrice, orderType: changes.orderType, orderQty: changes.orderQty });
      return { ordStatus: 'Accepted' };
    },
  };

  const ExecutionBot = require('../src/bot/ExecutionBot');
  const bot = Object.create(ExecutionBot.prototype);
  bot.client = mockClient;
  bot.contract = { id: 1, name: 'MNQ' };
  bot.account = { id: 1, name: 'TEST' };
  const { CONTRACTS } = require('../src/utils/constants');
  bot.notifications = { send: async () => {} };

  const position = {
    side: 'Buy', quantity: 2, entryPrice: 19500.00,
    bracketLegs: [
      { orderId: 1001, ocoId: 2001, qty: 1, targetPrice: 19520.00 },
      { orderId: 1002, ocoId: 2002, qty: 1, targetPrice: 19540.00 },
    ],
    firstTargetFilled: false,
    moveStopToBEAfterFirstTarget: true,
  };

  await bot._moveStopsToBreakEven(position);

  // Both stops should be modified (we don't know which leg filled, so we try all)
  assert.ok(modifiedOrders.length >= 1, 'at least one stop should be modified');
  for (const mod of modifiedOrders) {
    assert.strictEqual(mod.stopPrice, 19500.00, 'stop should be moved to entry (BE)');
    assert.strictEqual(mod.orderType, 'Stop');
  }
  assert.strictEqual(position.firstTargetFilled, true);
  console.log('✓ testMoveStopToBEAfterFirstTarget');
}

async function testMoveStopToBERejectedLeavesOriginal() {
  // If modifyOrder is rejected, original stop should remain (no cancel)
  let cancelCalled = false;
  const mockClient = {
    getOrder: async () => ({ ordStatus: 'Working' }),
    modifyOrder: async () => {
      const err = new Error('Modify rejected');
      err.isOrderRejection = true;
      err.rejectReason = 'Price not valid';
      throw err;
    },
    cancelOrder: async () => { cancelCalled = true; },
  };

  const ExecutionBot = require('../src/bot/ExecutionBot');
  const bot = Object.create(ExecutionBot.prototype);
  bot.client = mockClient;
  bot.contract = { id: 1, name: 'MNQ' };
  bot.account = { id: 1, name: 'TEST' };
  bot.notifications = { send: async () => {} };

  const position = {
    side: 'Buy', quantity: 2, entryPrice: 19500.00,
    bracketLegs: [
      { orderId: 1001, ocoId: 2001, qty: 1, targetPrice: 19520.00 },
      { orderId: 1002, ocoId: 2002, qty: 1, targetPrice: 19540.00 },
    ],
    firstTargetFilled: false,
  };

  await bot._moveStopsToBreakEven(position);
  assert.strictEqual(cancelCalled, false, 'should NOT cancel when modify is rejected');
  assert.strictEqual(position.firstTargetFilled, true, 'flag set to prevent retry');
  console.log('✓ testMoveStopToBERejectedLeavesOriginal');
}

async function testCancelAllBracketLegs() {
  // Multi-leg cancel should cancel all leg order IDs
  const cancelledIds = [];
  const mockClient = {
    cancelOrder: async (orderId) => { cancelledIds.push(orderId); },
  };

  const ExecutionBot = require('../src/bot/ExecutionBot');
  const bot = Object.create(ExecutionBot.prototype);
  bot.client = mockClient;
  bot.account = { id: 1 };

  const position = {
    bracketLegs: [
      { orderId: 1001, ocoId: 2001, qty: 1 },
      { orderId: 1002, ocoId: 2002, qty: 1 },
    ],
  };

  await bot._cancelAllBracketLegs(position);
  assert.ok(cancelledIds.includes(1001), 'should cancel leg 1 stop');
  assert.ok(cancelledIds.includes(2001), 'should cancel leg 1 target');
  assert.ok(cancelledIds.includes(1002), 'should cancel leg 2 stop');
  assert.ok(cancelledIds.includes(2002), 'should cancel leg 2 target');
  console.log('✓ testCancelAllBracketLegs');
}

// ── Explicit target regression test ────────────────────────────────

async function testExplicitTargetHonouredAfterFill() {
  // Regression: PositionHandler must NOT recompute target from R when
  // the signal supplied an explicit targetPrice. It should use the level as-sent.
  // The bug: fill handler unconditionally did fillPrice + stopDist * R,
  // discarding the signal's target.
  const PositionHandler = require('../src/bot/PositionHandler');

  // Build a minimal PositionHandler with mocked dependencies
  const ph = Object.create(PositionHandler.prototype);
  ph.contract = { name: 'MNQU6' };
  ph.notifications = { send: async () => {} };
  ph.performance = { recordTrade: () => {} };
  ph.lossLimits = { recordTrade: () => {}, getStatus: () => ({}) };
  ph.config = { profitTargetR: 2.5, minStopPoints: 4 };
  ph._entryFillAccum = { qty: 0, totalValue: 0, emitted: false };
  ph._exitFillAccum = { qty: 0, totalValue: 0, legCount: 0 };
  ph._processedFillIds = new Set();
  ph._exitClosed = false;

  // Simulate a position with an explicit target
  // Signal said: long @ 29137, stop 29127, target 29147
  // Fill came at 29142 (favourable slippage)
  // Bug would compute: 29142 + (29142-29127)*2.5 = 29142 + 37.5 = 29179.5
  // Correct: use 29147 as sent
  const position = {
    side: 'Buy',
    quantity: 1,
    entryPrice: 29137,
    stopLoss: 29127,
    target: 29147,
    explicitTarget: true,
    profitTargetR: 2.5,
    orderId: 999,
    stopOrderId: null,
    targetOrderId: null,
    bracketLegs: [],
    risk: 20,
  };

  // Simulate an entry fill
  const fill = {
    orderId: 999,
    price: 29142,
    qty: 1,
    action: 'Buy',
    id: 'fill-test-1',
  };

  // handleFill returns { isExit: false } for entry fills, and emits 'entryFilled'
  let emittedData = null;
  ph.emit = (event, data) => {
    if (event === 'entryFilled') emittedData = data;
  };

  // Call handleFill — it should detect this as an entry fill (orderId matches)
  // and emit entryFilled with newTarget = 29147 (the explicit target), NOT 29179.5
  await ph.handleFill(fill, position, 'trade-test-1');

  assert.ok(emittedData, 'entryFilled event should have been emitted');
  assert.strictEqual(emittedData.newTarget, 29147,
    `Explicit target should be 29147 (from signal), got ${emittedData.newTarget}`);
  assert.notStrictEqual(emittedData.newTarget, 29179.5,
    'Should NOT have recomputed target as 2.5R from fill price');

  console.log('✓ testExplicitTargetHonouredAfterFill');
}

async function testAutoTargetComputedWhenNoExplicitTarget() {
  // When no explicit target is sent, the fill handler SHOULD compute from R.
  const PositionHandler = require('../src/bot/PositionHandler');

  const ph = Object.create(PositionHandler.prototype);
  ph.contract = { name: 'MNQU6' };
  ph.notifications = { send: async () => {} };
  ph.performance = { recordTrade: () => {} };
  ph.lossLimits = { recordTrade: () => {}, getStatus: () => ({}) };
  ph.config = { profitTargetR: 2.5, minStopPoints: 4 };
  ph._entryFillAccum = { qty: 0, totalValue: 0, emitted: false };
  ph._exitFillAccum = { qty: 0, totalValue: 0, legCount: 0 };
  ph._processedFillIds = new Set();
  ph._exitClosed = false;

  // No explicit target — signal didn't include targetPrice
  // SignalHandler would have computed one, but PositionHandler should recompute
  // from the actual fill price for true R:R
  const position = {
    side: 'Buy',
    quantity: 1,
    entryPrice: 29137,
    stopLoss: 29127,
    target: 29162, // computed by SignalHandler: 29137 + 10*2.5 = 29162
    explicitTarget: false,
    profitTargetR: 2.5,
    orderId: 998,
    stopOrderId: null,
    targetOrderId: null,
    bracketLegs: [],
    risk: 20,
  };

  // Fill at 29142 — stop distance is now 15 points, so 2.5R = 29142 + 37.5 = 29179.5
  // Rounded to tick (0.25): 29179.50
  const fill = {
    orderId: 998,
    price: 29142,
    qty: 1,
    action: 'Buy',
    id: 'fill-test-2',
  };

  let emittedData = null;
  ph.emit = (event, data) => {
    if (event === 'entryFilled') emittedData = data;
  };

  await ph.handleFill(fill, position, 'trade-test-2');

  assert.ok(emittedData, 'entryFilled event should have been emitted');
  // 29142 + (29142-29127)*2.5 = 29142 + 37.5 = 29179.50
  assert.strictEqual(emittedData.newTarget, 29179.5,
    `Auto target should be 29179.5 (2.5R from fill), got ${emittedData.newTarget}`);

  console.log('✓ testAutoTargetComputedWhenNoExplicitTarget');
}

// ── Runner ──────────────────────────────────────────────────────────

async function main() {
  console.log('Running webhook server tests...\n');

  await testAuthMissing();
  await testAuthWrong();
  await testMalformedJSON();
  await testInvertedStopLong();
  await testInvertedStopShort();
  await testUnknownSymbol();
  await testQtyOverMax();
  await testPriceOffTick();
  await testStopDistanceOverMax();
  await testDuplicateSignalId();
  await testPausedRejects();
  await testHaltedRejects();
  await testValidSignalExecutes();
  await testShortSignalExecutes();
  await testLimitOrderType();
  await testStopOrderTypeAcceptedAtWebhook();
  await testEntryTimeoutReachesTheBot();
  await testBogusOrderTypeStillRejected();
  await testMissingSignalId();
  await testMissingPrice();
  await testTargetOnWrongSide();
  await testStatusEndpoint();
  await testFlattenEndpoint();
  await test404();
  await testTokenTooShort();

  // Multi-target exits
  await testExitsQtySumMismatch();
  await testExitsOutOfOrder();
  await testExitsAndTargetPriceBothPresent();
  await testExitsTargetOnWrongSide();
  await testExitsTargetOffTick();
  await testExitsDuplicateTargets();
  await testExitsMissingQuantity();
  await testValidExitsSignalExecutes();
  await testShortExitsDescending();
  await testExitsTooManyLegs();

  // Multi-leg OCO placement
  await testMultiLegOCOPlacement();
  await testMultiLegPartialFailureFallback();
  await testMultiLegAllFailEmergencyClose();
  await testMoveStopToBEAfterFirstTarget();
  await testMoveStopToBERejectedLeavesOriginal();
  await testCancelAllBracketLegs();

  // Explicit target regression
  await testExplicitTargetHonouredAfterFill();
  await testAutoTargetComputedWhenNoExplicitTarget();

  // Stop-entry (break-of-signal-bar) support
  await testStopEntryPlacesStopOrder();
  await testStopEntryWrongSideRejected();
  await testStopEntryRequiresRefPriceAtWebhook();
  await testStopEntryTooCloseToMarketRejected();
  await testRejectedEntryClearsStateAndRefundsBudget();
  await testStopEntryCorrectSidePassesWithRefPrice();
  await testRefPriceReachesTheBotAndIsValidated();
  await testResumeEndpoint();
  await testCancelAllRefusesWithOpenPosition();
  await testCancelAllProceedsWhenFlat();
  await testFlattenCancelsRestingEntryInsteadOfReversing();

  console.log('\n✅ All webhook tests passed!');
}

// ── Stop-entry (break-of-signal-bar) ──────────────────────────────────
//
// A break entry must rest as a STOP order. A Limit fills at-or-better, so a
// buy limit parked above the market fills instantly at the current lower
// price — entering before the break ever happened. Before this support
// existed, orderType 'Stop' fell through SignalHandler's else branch and
// silently became a MARKET order.

function makeStopEntryHandler(overrides = {}) {
  const SignalHandler = require('../src/bot/SignalHandler');
  const sh = Object.create(SignalHandler.prototype);
  const calls = { stop: [], limit: [], market: [] };

  sh.client = {
    getCashBalance: async () => ({ cashBalance: 50000 }),
    getQuote: overrides.getQuote || (async () => ({ entries: { Trade: { price: 29200 } } })),
    placeStopOrder: async (a, c, q, act, px) => { calls.stop.push({ q, act, px }); return { orderId: 5001 }; },
    placeLimitOrder: async (a, c, q, act, px) => { calls.limit.push({ q, act, px }); return { orderId: 5002 }; },
    placeMarketOrder: async (a, c, q, act) => { calls.market.push({ q, act }); return { orderId: 5003 }; },
  };
  sh.account = { id: 1, name: 'DEMO' };
  sh.contract = { id: 42, name: 'MNQU6' };
  sh.config = { profitTargetR: 2.5, riskPerTrade: { max: 60 }, contractSymbol: 'MNQ' };
  sh.riskManager = {
    getContractSpecs: () => ({ tickSize: 0.25, tickValue: 0.5 }),
    validateTrade: () => ({ valid: true }),
  };
  sh._validateSignal = () => ({ valid: true });
  sh.currentPosition = null;
  return { sh, calls };
}

async function testStopEntryPlacesStopOrder() {
  const { sh, calls } = makeStopEntryHandler();
  // Short break-down entry at 29150 with the market at 29200 (above it).
  const res = await sh.handleSignal({
    signalId: 'stop-1', type: 'sell', orderType: 'Stop',
    price: 29150, stopLoss: 29175, targetPrice: 29094.5, quantity: 2,
  });

  assert.strictEqual(calls.stop.length, 1, 'should place exactly one Stop entry');
  assert.strictEqual(calls.market.length, 0, 'must NOT fall through to a market order');
  assert.strictEqual(calls.limit.length, 0, 'must not place a limit order');
  assert.strictEqual(calls.stop[0].px, 29150, 'stop entry price should be the break level');
  assert.strictEqual(calls.stop[0].act, 'Sell');
  assert.ok(res.executed !== false || res.accepted !== false);
  console.log('✓ testStopEntryPlacesStopOrder');
}

async function testStopEntryWrongSideRejected() {
  // A Buy Stop BELOW the market triggers on submission — a planned break
  // entry silently degrading into a market fill. Must be refused.
  // The market reference is refPrice from the sender: Tradovate has no REST
  // quote endpoint, so the broker cannot supply one.
  const { sh, calls } = makeStopEntryHandler();
  const res = await sh.handleSignal({
    signalId: 'stop-2', type: 'buy', orderType: 'Stop', refPrice: 29200,
    price: 29150, stopLoss: 29120, targetPrice: 29300, quantity: 1,
  });

  assert.strictEqual(res.executed, false, 'wrong-side stop must be rejected');
  assert.ok(/wrong side/i.test(res.reason), `reason should name the wrong side, got: ${res.reason}`);
  assert.strictEqual(calls.stop.length, 0, 'no order should be placed');
  assert.strictEqual(calls.market.length, 0, 'must not degrade to market');
  assert.strictEqual(sh.currentPosition, null, 'position state must be cleared on rejection');
  console.log('✓ testStopEntryWrongSideRejected');
}

async function testStopEntryRequiresRefPriceAtWebhook() {
  // refPrice is the ONLY price source in the system — the bot makes no market
  // data calls. A stop entry without one cannot have its side verified, and a
  // wrong-side stop becomes an instant market fill. Must be rejected.
  await withServer(async () => {
    const res = await request('POST', '/signal', {
      signalId: 'norp', type: 'short', symbol: 'MNQ', price: 29150, stopLoss: 29175,
      orderType: 'stop',
    }, TOKEN);
    assert.strictEqual(res.status, 400, 'stop entry without refPrice must be rejected');
    assert.match(res.body.reason, /refPrice is required/);
  });
  // Market and limit entries are unaffected — they have no side to get wrong.
  await withServer(async (bot) => {
    const res = await request('POST', '/signal', {
      signalId: 'mkt-norp', type: 'short', symbol: 'MNQ', price: 29150, stopLoss: 29175,
    }, TOKEN);
    assert.strictEqual(res.status, 200, 'market entry must not require refPrice');
    assert.strictEqual(bot.signals[0].refPrice, undefined);
  });
  console.log('✓ testStopEntryRequiresRefPriceAtWebhook');
}

async function testStopEntryTooCloseToMarketRejected() {
  // Found live 2 Sep: a Buy Stop 0.5pt above the market passed the side check
  // (direction was right) and was REJECTED by Tradovate, because a stop that
  // close triggers on submission.
  const { sh, calls } = makeStopEntryHandler();
  const res = await sh.handleSignal({
    signalId: 'tooclose', type: 'buy', orderType: 'Stop', refPrice: 29136.5,
    price: 29137, stopLoss: 29117, targetPrice: 29187, quantity: 2,
  });
  assert.strictEqual(res.executed, false, 'a stop 0.5pt from market must be refused');
  assert.match(res.reason, /only 0\.50pt from the market/);
  assert.strictEqual(calls.stop.length, 0, 'no order should reach the broker');
  console.log('✓ testStopEntryTooCloseToMarketRejected');
}

async function testRejectedEntryClearsStateAndRefundsBudget() {
  // Found live 2 Sep: placeorder returned 200 + orderId, then Tradovate sent
  // "Rejected" over the WebSocket microseconds later. The bot logged SUCCESS
  // and tracked a resting entry that did not exist at the broker.
  const ExecutionBot = require('../src/bot/ExecutionBot');
  const bot = Object.create(ExecutionBot.prototype);

  let cleared = false, reset = false, notified = '';
  const pos = { orderId: 999, stopOrderId: null, bracketLegs: [] };
  bot._tradesToday = 2;
  bot._maxTradesPerDay = 3;
  bot.signalHandler = { getPosition: () => pos, clearPosition: () => { cleared = true; } };
  bot.positionHandler = {
    handleOrderUpdate: () => {},
    resetFillAccumulators: () => { reset = true; },
  };
  bot.notifications = { send: async (m) => { notified = m; } };
  bot._clearLimitEntryTimeout = () => {};
  bot._clearFillWatchdog = () => {};

  bot._onOrderUpdate({ id: 999, ordStatus: 'Rejected', rejectReason: 'too close to market' });

  assert.ok(cleared, 'position state must be cleared — no order exists');
  assert.ok(reset, 'fill accumulators must be reset');
  assert.strictEqual(bot._tradesToday, 1, 'a rejected entry must refund the daily budget');
  assert.match(notified, /ENTRY REJECTED/);

  // A rejection for an unrelated order id must NOT clear a live position.
  let cleared2 = false;
  const bot2 = Object.create(ExecutionBot.prototype);
  bot2._tradesToday = 1;
  bot2._maxTradesPerDay = 3;
  bot2.signalHandler = { getPosition: () => ({ orderId: 111, stopOrderId: 222, bracketLegs: [] }), clearPosition: () => { cleared2 = true; } };
  bot2.positionHandler = { handleOrderUpdate: () => {}, resetFillAccumulators: () => {} };
  bot2.notifications = { send: async () => {} };
  bot2._clearLimitEntryTimeout = () => {};
  bot2._clearFillWatchdog = () => {};
  bot2._onOrderUpdate({ id: 888, ordStatus: 'Rejected' });
  assert.strictEqual(cleared2, false, 'unrelated rejection must not clear the position');
  assert.strictEqual(bot2._tradesToday, 1, 'unrelated rejection must not refund');
  console.log('✓ testRejectedEntryClearsStateAndRefundsBudget');
}

async function testStopEntryCorrectSidePassesWithRefPrice() {
  // Sell stop BELOW the market is correct and must not be blocked.
  const { sh, calls } = makeStopEntryHandler();
  await sh.handleSignal({
    signalId: 'stop-4', type: 'sell', orderType: 'Stop', refPrice: 29200,
    price: 29150, stopLoss: 29175, targetPrice: 29094.5, quantity: 1,
  });
  assert.strictEqual(calls.stop.length, 1, 'correct-side stop must be placed');
  console.log('✓ testStopEntryCorrectSidePassesWithRefPrice');
}

async function testRefPriceReachesTheBotAndIsValidated() {
  await withServer(async (bot) => {
    const ok = await request('POST', '/signal', {
      signalId: 'rp1', type: 'short', symbol: 'MNQ', price: 29150, stopLoss: 29175,
      orderType: 'stop', refPrice: 29200,
    }, TOKEN);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(bot.signals[0].refPrice, 29200, 'refPrice must survive validation');
  });
  await withServer(async () => {
    const bad = await request('POST', '/signal', {
      signalId: 'rp2', type: 'short', symbol: 'MNQ', price: 29150, stopLoss: 29175,
      orderType: 'stop', refPrice: -1,
    }, TOKEN);
    assert.strictEqual(bad.status, 400, 'negative refPrice must be rejected');
  });
  console.log('✓ testRefPriceReachesTheBotAndIsValidated');
}

async function testResumeEndpoint() {
  await withServer(async (bot) => {
    let resumed = false;
    bot.lossLimits = {
      getStatus: () => ({ isHalted: true, haltReason: 'WEBSOCKET_DEAD' }),
      resume: () => { resumed = true; return true; },
    };
    const res = await request('POST', '/resume', {}, TOKEN);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.resumed, true);
    assert.strictEqual(res.body.clearedHalt, 'WEBSOCKET_DEAD');
    assert.ok(resumed, 'lossLimits.resume() must be called');

    // Second call on a healthy bot is a clean no-op, not an error.
    bot.lossLimits.getStatus = () => ({ isHalted: false, haltReason: null });
    const again = await request('POST', '/resume', {}, TOKEN);
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.resumed, false);
  });
  console.log('✓ testResumeEndpoint');
}

// Bind the REAL cancelAllWorkingOrders onto the stub bot. Testing MockBot's
// own behaviour would prove nothing — the point is to exercise the actual
// guard that decides whether stripping a position's brackets is allowed.
function equipCancelAll(bot, { netPos, onCancel }) {
  const ExecutionBot = require('../src/bot/ExecutionBot');
  bot.contract = { id: 42 };
  bot.account = { id: 1 };
  bot.client = {
    getOpenPositions: async () => (netPos === 0 ? [] : [{ contractId: 42, netPos }]),
    cancelAllOrders: async () => { onCancel(); return { total: 2, cancelled: 2, failed: 0 }; },
  };
  bot.signalHandler = { getPosition: () => null, clearPosition: () => {} };
  bot.positionHandler = { resetFillAccumulators: () => {} };
  bot.notifications = { send: async () => {} };
  bot.cancelAllWorkingOrders = ExecutionBot.prototype.cancelAllWorkingOrders.bind(bot);
}

async function testCancelAllRefusesWithOpenPosition() {
  // The working orders on a live position ARE its stop and target — cancelling
  // them would leave it naked. Must refuse without force.
  await withServer(async (bot) => {
    let cancelled = false;
    equipCancelAll(bot, { netPos: 2, onCancel: () => { cancelled = true; } });

    const res = await request('POST', '/cancel-all', {}, TOKEN);
    assert.strictEqual(res.status, 409, 'must refuse with 409');
    assert.strictEqual(res.body.refused, true);
    assert.strictEqual(cancelled, false, 'must NOT cancel while a position is open');

    // force overrides deliberately
    const forced = await request('POST', '/cancel-all', { force: true }, TOKEN);
    assert.strictEqual(forced.status, 200);
    assert.ok(cancelled, 'force must actually cancel');
  });
  console.log('✓ testCancelAllRefusesWithOpenPosition');
}

async function testCancelAllProceedsWhenFlat() {
  await withServer(async (bot) => {
    let cancelled = false;
    equipCancelAll(bot, { netPos: 0, onCancel: () => { cancelled = true; } });

    const res = await request('POST', '/cancel-all', {}, TOKEN);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.cancelled, true);
    assert.strictEqual(res.body.cancelledCount, 2);
    assert.ok(cancelled, 'must actually cancel when flat');
  });
  console.log('✓ testCancelAllProceedsWhenFlat');
}

async function testFlattenCancelsRestingEntryInsteadOfReversing() {
  // Bot state holds a position from the moment the entry is SENT. With a
  // resting stop entry that never triggered, the broker is flat — the old
  // flattenAll would market-"close" it and OPEN a reversed position while
  // the entry order kept working. It must cancel the entry instead.
  const ExecutionBot = require('../src/bot/ExecutionBot');
  const bot = Object.create(ExecutionBot.prototype);
  const calls = { cancelled: [], market: [] };

  const restingPos = {
    side: 'Buy', quantity: 2, orderId: 7001,
    stopOrderId: null, targetOrderId: null, bracketLegs: [],
    _isStopEntry: true,
  };

  bot.account = { id: 1 };
  bot.contract = { id: 42, name: 'MNQU6' };
  bot.client = {
    getOpenPositions: async () => [],              // broker is FLAT
    cancelOrder: async (id) => { calls.cancelled.push(id); return { ok: true }; },
    placeMarketOrder: async (a, c, q, act) => { calls.market.push({ q, act }); return { orderId: 9 }; },
  };
  bot.signalHandler = { getPosition: () => restingPos, clearPosition: () => {} };
  bot.positionHandler = { resetFillAccumulators: () => {} };
  bot.notifications = { send: async () => {} };
  bot._cancelAllBracketLegs = async () => {};

  const res = await bot.flattenAll();

  assert.strictEqual(calls.market.length, 0, 'must NOT send a market order when broker is flat');
  assert.deepStrictEqual(calls.cancelled, [7001], 'must cancel the resting entry order');
  assert.strictEqual(res.cancelledEntry, true, 'result should report an entry cancellation');
  console.log('✓ testFlattenCancelsRestingEntryInsteadOfReversing');
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
