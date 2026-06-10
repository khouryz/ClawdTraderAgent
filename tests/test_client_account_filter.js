#!/usr/bin/env node
/**
 * test_client_account_filter.js
 *
 * Regression test for the MIRROR-MODE cross-account leak fix.
 *
 * Tradovate's /position/list?accountId= and /order/list?accountId= IGNORE the
 * accountId query param and return entities for the ENTIRE login. With one
 * sub-account per login this was harmless, but under mirror fanout (several
 * sub-accounts on one login) every account's read leaked the others' positions
 * and working orders — exactly what broke the live mirror trade-test (the primary
 * saw 4 working legs: its own 2 + the secondary's 2).
 *
 * client.getOpenPositions / client.getWorkingOrders now filter client-side by
 * accountId, while DEFENSIVELY keeping any entity that lacks an accountId so
 * single-account behavior is byte-for-byte unchanged.
 */
'use strict';

const assert = require('assert');
const TradovateClient = require('../src/api/client');

let checks = 0, failures = 0;
function ok(cond, msg) {
  checks++;
  if (cond) { console.log(`  \u2713 ${msg}`); }
  else { failures++; console.log(`  \u2717 ${msg}`); }
}

// Build a client whose low-level request() returns a canned, MIXED-account list
// (simulating the leak). Bypasses auth/network/rate-limiter entirely.
function clientReturning(positionList, orderList) {
  const auth = { config: { env: 'demo' } };
  const c = new TradovateClient(auth);
  c.request = async (method, endpoint) => {
    if (endpoint.startsWith('/position/list')) return positionList;
    if (endpoint.startsWith('/order/list')) return orderList;
    return [];
  };
  return c;
}

const A = 1699181; // primary
const B = 1949814; // secondary

(async () => {
  console.log('\n(a) getOpenPositions filters the login-wide list down to ONE account');
  {
    const positions = [
      { id: 1, accountId: A, contractId: 4327110, netPos: 1, netPrice: 28692 },
      { id: 2, accountId: B, contractId: 4327110, netPos: 1, netPrice: 28692 },
      { id: 3, accountId: B, contractId: 4327110, netPos: 0, netPrice: null }, // flat — excluded anyway
    ];
    const c = clientReturning(positions, []);
    const a = await c.getOpenPositions(A);
    const b = await c.getOpenPositions(B);
    ok(a.length === 1 && a[0].accountId === A, `account A sees only its own open position (got ${a.length})`);
    ok(b.length === 1 && b[0].accountId === B, `account B sees only its own open position (got ${b.length})`);
    ok(!a.some(p => p.accountId === B), 'account A does NOT see account B\'s position (leak closed)');
  }

  console.log('\n(b) getWorkingOrders filters the login-wide list down to ONE account');
  {
    // The live run showed 4 working orders on the primary (2 own + 2 leaked).
    const orders = [
      { id: 16385408115, accountId: A, contractId: 4327110, ordStatus: 'Working' },   // A stop
      { id: 16385408116, accountId: A, contractId: 4327110, ordStatus: 'Suspended' }, // A target (OCO suspended)
      { id: 16410278095, accountId: B, contractId: 4327110, ordStatus: 'Working' },   // B stop (leaked)
      { id: 16410278096, accountId: B, contractId: 4327110, ordStatus: 'Suspended' }, // B target (leaked)
      { id: 99, accountId: A, contractId: 4327110, ordStatus: 'Filled' },             // not active — excluded
    ];
    const c = clientReturning([], orders);
    const a = await c.getWorkingOrders(A);
    const b = await c.getWorkingOrders(B);
    ok(a.length === 2, `account A sees exactly its OWN 2 working legs, not 4 (got ${a.length})`);
    ok(a.every(o => o.accountId === A), 'account A working orders all belong to A (leak closed)');
    ok(b.length === 2 && b.every(o => o.accountId === B), `account B sees exactly its own 2 legs (got ${b.length})`);
    ok(!a.some(o => o.id === 16410278095 || o.id === 16410278096), 'account A does NOT see account B\'s OCO legs');
  }

  console.log('\n(c) DEFENSIVE: entities lacking accountId are KEPT (single-account compat)');
  {
    const positions = [
      { id: 1, contractId: 4327110, netPos: 1, netPrice: 28692 }, // no accountId
    ];
    const orders = [
      { id: 10, contractId: 4327110, ordStatus: 'Working' }, // no accountId
    ];
    const c = clientReturning(positions, orders);
    const p = await c.getOpenPositions(A);
    const o = await c.getWorkingOrders(A);
    ok(p.length === 1, 'position without accountId is kept (no regression for single-account logins)');
    ok(o.length === 1, 'working order without accountId is kept (no regression for single-account logins)');
  }

  console.log('\n(d) accountId type coercion (string vs number) still matches');
  {
    const positions = [{ id: 1, accountId: String(A), contractId: 1, netPos: 1 }];
    const orders = [{ id: 2, accountId: String(A), contractId: 1, ordStatus: 'Working' }];
    const c = clientReturning(positions, orders);
    ok((await c.getOpenPositions(A)).length === 1, 'string accountId matches numeric query (positions)');
    ok((await c.getWorkingOrders(A)).length === 1, 'string accountId matches numeric query (orders)');
  }

  console.log(`\n${'\u2500'.repeat(70)}`);
  console.log(`${checks} checks, ${failures} failure(s)`);
  if (failures === 0) console.log('\u2705 ALL CLIENT ACCOUNT-FILTER TESTS PASSED');
  else console.log('\u274c SOME TESTS FAILED');
  console.log(`${'\u2500'.repeat(70)}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
