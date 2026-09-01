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
  await testMissingSignalId();
  await testMissingPrice();
  await testTargetOnWrongSide();
  await testStatusEndpoint();
  await testFlattenEndpoint();
  await test404();
  await testTokenTooShort();

  console.log('\n✅ All webhook tests passed!');
}

main().catch((err) => {
  console.error('\n❌ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
