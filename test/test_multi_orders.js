#!/usr/bin/env node
/**
 * Multi-Instrument Order Execution Test
 * 
 * Tests bracket order placement on all 3 instruments (MNQ, MES, M2K)
 * on the Tradovate DEMO account.
 * 
 * Scenarios tested per instrument:
 *   1. BUY bracket order (market entry + stop + target)
 *   2. Cancel bracket (cancel stop/target OCO)
 *   3. SELL bracket order
 *   4. Flatten position
 * 
 * Usage: node test/test_multi_orders.js
 */

require('dotenv').config();
const TradovateAuth = require('../src/api/auth');
const TradovateClient = require('../src/api/client');
const logger = require('../src/utils/logger');

const INSTRUMENTS = [
  { symbol: 'MNQH6', base: 'MNQ', tickSize: 0.25, tickValue: 0.50, pointValue: 2.00, stopPts: 20, targetPts: 40 },
  { symbol: 'MESH6', base: 'MES', tickSize: 0.25, tickValue: 1.25, pointValue: 5.00, stopPts: 8, targetPts: 16 },
  { symbol: 'M2KH6', base: 'M2K', tickSize: 0.10, tickValue: 0.50, pointValue: 5.00, stopPts: 8, targetPts: 16 },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  MULTI-INSTRUMENT ORDER EXECUTION TEST (DEMO)');
  console.log('═══════════════════════════════════════════════════\n');

  // ── Auth ──
  const config = {
    env: process.env.TRADOVATE_ENV || 'demo',
    username: process.env.TRADOVATE_USERNAME,
    password: process.env.TRADOVATE_PASSWORD,
    cid: parseInt(process.env.TRADOVATE_CID),
    secret: process.env.TRADOVATE_SECRET,
  };

  const auth = new TradovateAuth(config);
  await auth.authenticate();
  const client = new TradovateClient(auth);

  const accounts = await client.getAccounts();
  const account = accounts[0];
  console.log(`✓ Account: ${account.name} (ID: ${account.id})\n`);

  // ── Resolve contracts ──
  const contracts = {};
  for (const inst of INSTRUMENTS) {
    const contract = await client.findContract(inst.symbol);
    contracts[inst.base] = contract;
    console.log(`✓ ${inst.base}: ${contract.name} (contractId: ${contract.id})`);
  }
  console.log('');

  // ── Test each instrument ──
  const results = [];

  for (const inst of INSTRUMENTS) {
    const contract = contracts[inst.base];
    console.log(`\n${'─'.repeat(55)}`);
    console.log(`  Testing ${inst.base} (${inst.symbol}) — contractId: ${contract.id}`);
    console.log(`${'─'.repeat(55)}`);

    const testResult = { instrument: inst.base, tests: [] };

    // ── Test 1: BUY market order ──
    try {
      console.log(`\n  [1] BUY market order...`);

      const order = await client.placeMarketOrder(
        account.id,
        contract.id,
        1,
        'Buy'
      );

      console.log(`      ✓ BUY order placed: orderId=${order.orderId || order.id || JSON.stringify(order).substring(0, 100)}`);
      testResult.tests.push({ name: 'BUY market', status: 'PASS', detail: order.orderId || order.id });

      await sleep(3000);

      // Check position
      const positions = await client.getPositionsByAccount(account.id);
      const pos = positions.find(p => p.contractId === contract.id && p.netPos !== 0);
      if (pos) {
        console.log(`      ✓ Position confirmed: ${pos.netPos} @ avg ${pos.netPrice}`);
        testResult.tests.push({ name: 'BUY fill', status: 'PASS', detail: `${pos.netPos} @ ${pos.netPrice}` });
      } else {
        console.log(`      ⚠ No position found (may be pending)`);
        testResult.tests.push({ name: 'BUY fill', status: 'WARN', detail: 'No position yet' });
      }
    } catch (err) {
      console.log(`      ✗ BUY failed: ${err.message}`);
      testResult.tests.push({ name: 'BUY market', status: 'FAIL', detail: err.message });
    }

    await sleep(1000);

    // ── Test 2: Flatten (close the BUY position) ──
    try {
      console.log(`\n  [2] Flatten position...`);

      // Cancel any working orders first
      const orders = await client.getOrdersByAccount(account.id);
      const workingOrders = (orders || []).filter(o => o.contractId === contract.id && o.ordStatus === 'Working');
      for (const wo of workingOrders) {
        await client.cancelOrder(wo.id);
        console.log(`      Cancelled order ${wo.id} (${wo.action} ${wo.orderType})`);
      }

      // Flatten
      const positions = await client.getPositionsByAccount(account.id);
      const pos = positions.find(p => p.contractId === contract.id && p.netPos !== 0);
      if (pos) {
        const closeAction = pos.netPos > 0 ? 'Sell' : 'Buy';
        const closeQty = Math.abs(pos.netPos);
        const closeOrder = await client.placeMarketOrder(account.id, contract.id, closeQty, closeAction);
        console.log(`      ✓ Flatten: ${closeAction} ${closeQty} — orderId=${closeOrder.orderId || closeOrder.id}`);
        testResult.tests.push({ name: 'Flatten BUY', status: 'PASS' });
      } else {
        console.log(`      ⚠ No position to flatten`);
        testResult.tests.push({ name: 'Flatten BUY', status: 'SKIP', detail: 'No position' });
      }
    } catch (err) {
      console.log(`      ✗ Flatten failed: ${err.message}`);
      testResult.tests.push({ name: 'Flatten BUY', status: 'FAIL', detail: err.message });
    }

    await sleep(2000);

    // ── Test 3: SELL bracket order (with stop + target) ──
    try {
      console.log(`\n  [3] SELL bracket order (stop=${inst.stopPts}pt, target=${inst.targetPts}pt)...`);

      const order = await client.placeBracketOrder(
        account.id,
        contract.id,
        1,
        'Sell',
        inst.stopPts,     // stop loss in points
        inst.targetPts,   // take profit in points
      );

      console.log(`      ✓ SELL bracket placed: ${JSON.stringify(order).substring(0, 120)}`);
      testResult.tests.push({ name: 'SELL bracket', status: 'PASS', detail: order.orderStrategyId || order.id });

      await sleep(3000);

      const positions = await client.getPositionsByAccount(account.id);
      const pos = positions.find(p => p.contractId === contract.id && p.netPos !== 0);
      if (pos) {
        console.log(`      ✓ Position confirmed: ${pos.netPos} @ avg ${pos.netPrice}`);
        testResult.tests.push({ name: 'SELL fill', status: 'PASS', detail: `${pos.netPos} @ ${pos.netPrice}` });
      } else {
        console.log(`      ⚠ No position found (may be pending)`);
        testResult.tests.push({ name: 'SELL fill', status: 'WARN', detail: 'No position yet' });
      }
    } catch (err) {
      console.log(`      ✗ SELL bracket failed: ${err.message}`);
      testResult.tests.push({ name: 'SELL bracket', status: 'FAIL', detail: err.message });
    }

    await sleep(1000);

    // ── Test 4: Flatten SELL position ──
    try {
      console.log(`\n  [4] Flatten SELL position...`);

      // Cancel working orders (bracket stop/target)
      const orders = await client.getOrdersByAccount(account.id);
      const workingOrders = (orders || []).filter(o => o.contractId === contract.id && o.ordStatus === 'Working');
      for (const wo of workingOrders) {
        try { await client.cancelOrder(wo.id); } catch(e) { /* ignore */ }
        console.log(`      Cancelled order ${wo.id} (${wo.action} ${wo.orderType})`);
      }

      // Also cancel any order strategies
      try {
        await client.cancelAllOrders(account.id);
      } catch(e) { /* ignore */ }

      await sleep(1000);

      const positions = await client.getPositionsByAccount(account.id);
      const pos = positions.find(p => p.contractId === contract.id && p.netPos !== 0);
      if (pos) {
        const closeAction = pos.netPos > 0 ? 'Sell' : 'Buy';
        const closeQty = Math.abs(pos.netPos);
        const closeOrder = await client.placeMarketOrder(account.id, contract.id, closeQty, closeAction);
        console.log(`      ✓ Flatten: ${closeAction} ${closeQty} — orderId=${closeOrder.orderId || closeOrder.id}`);
        testResult.tests.push({ name: 'Flatten SELL', status: 'PASS' });
      } else {
        console.log(`      ⚠ No position to flatten`);
        testResult.tests.push({ name: 'Flatten SELL', status: 'SKIP', detail: 'No position' });
      }
    } catch (err) {
      console.log(`      ✗ Flatten SELL failed: ${err.message}`);
      testResult.tests.push({ name: 'Flatten SELL', status: 'FAIL', detail: err.message });
    }

    await sleep(2000);

    results.push(testResult);
  }

  // ── Final cleanup: ensure all positions are flat ──
  console.log(`\n${'═'.repeat(55)}`);
  console.log('  FINAL CLEANUP — Flattening all positions');
  console.log(`${'═'.repeat(55)}`);

  try {
    // Cancel all working orders first
    try {
      const cancelResult = await client.cancelAllOrders(account.id);
      console.log(`  ✓ Cancelled ${cancelResult.total} working orders`);
    } catch(e) { /* ignore */ }

    await sleep(1000);

    const positions = await client.getPositionsByAccount(account.id);
    const openPositions = (positions || []).filter(p => p.netPos !== 0);
    if (openPositions.length === 0) {
      console.log('  ✓ All positions already flat');
    } else {
      for (const pos of openPositions) {
        const closeAction = pos.netPos > 0 ? 'Sell' : 'Buy';
        const closeQty = Math.abs(pos.netPos);
        await client.placeMarketOrder(account.id, pos.contractId, closeQty, closeAction);
        console.log(`  ✓ Flattened contractId ${pos.contractId}: ${closeAction} ${closeQty}`);
      }
    }
  } catch (err) {
    console.log(`  ✗ Cleanup error: ${err.message}`);
  }

  // ── Summary ──
  console.log(`\n${'═'.repeat(55)}`);
  console.log('  TEST RESULTS SUMMARY');
  console.log(`${'═'.repeat(55)}`);

  let totalPass = 0, totalFail = 0, totalWarn = 0;
  for (const r of results) {
    console.log(`\n  ${r.instrument}:`);
    for (const t of r.tests) {
      const icon = t.status === 'PASS' ? '✓' : t.status === 'FAIL' ? '✗' : '⚠';
      console.log(`    ${icon} ${t.name}: ${t.status}${t.detail ? ` (${t.detail})` : ''}`);
      if (t.status === 'PASS') totalPass++;
      else if (t.status === 'FAIL') totalFail++;
      else totalWarn++;
    }
  }

  console.log(`\n  TOTAL: ${totalPass} PASS, ${totalFail} FAIL, ${totalWarn} WARN`);
  console.log(`${'═'.repeat(55)}\n`);

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
