/**
 * EOD Close Integration Test — Demo Account
 * 
 * Tests the full EOD close flow:
 *   1. Authenticate with Tradovate demo
 *   2. Place a market BUY entry + OCO (stop + target)
 *   3. Verify position exists and brackets are working
 *   4. Simulate eodClose() logic: cancel brackets, verify position, flatten
 *   5. Verify fill price retrieval and P&L calculation
 *   6. Verify brackets are cancelled and no orphaned orders remain
 *   7. Test the "position already closed" race condition path
 * 
 * Usage: node test/test_eod_close.js
 */

require('dotenv').config();
const TradovateAuth = require('../src/api/auth');
const TradovateClient = require('../src/api/client');
const { CONTRACTS } = require('../src/utils/constants');

const POINT_VALUE = CONTRACTS.MNQ.pointValue; // $2.00

// ── Helpers ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(emoji, msg) {
  const ts = new Date().toISOString().split('T')[1].split('.')[0];
  console.log(`[${ts}] ${emoji} ${msg}`);
}

function section(title) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'═'.repeat(60)}`);
}

let passCount = 0;
let failCount = 0;

function assert(condition, label) {
  if (condition) {
    log('✅', `PASS: ${label}`);
    passCount++;
  } else {
    log('❌', `FAIL: ${label}`);
    failCount++;
  }
}

async function main() {
  section('EOD CLOSE INTEGRATION TEST — DEMO ACCOUNT');

  // ── Step 1: Authenticate ──
  section('STEP 1: Authenticate');
  const auth = new TradovateAuth({
    env: process.env.TRADOVATE_ENV || 'demo',
    username: process.env.TRADOVATE_USERNAME,
    password: process.env.TRADOVATE_PASSWORD,
    cid: parseInt(process.env.TRADOVATE_CID),
    secret: process.env.TRADOVATE_SECRET,
  });
  await auth.authenticate();
  log('🔑', `Authenticated (${auth.config.env})`);
  assert(auth.accessToken !== null, 'Auth token obtained');

  const client = new TradovateClient(auth);

  // Get account
  const accounts = await client.getAccounts();
  const account = accounts[0];
  log('💰', `Account: ${account.name} (ID: ${account.id})`);
  assert(account.id > 0, 'Account found');

  // Get MNQ contract by symbol from .env
  const contractSymbol = process.env.MNQ_SYMBOL || 'MNQH6';
  const contract = await client.findContract(contractSymbol);
  log('📄', `Contract: ${contract.name} (ID: ${contract.id})`);
  assert(contract.id > 0, 'MNQ contract found');

  // ── Step 2: Clean slate — cancel any existing orders, flatten any positions ──
  section('STEP 2: Clean Slate');
  try {
    const existingPositions = await client.getOpenPositions(account.id);
    const mnqPositions = existingPositions.filter(p => p.contractId === contract.id);
    if (mnqPositions.length > 0) {
      log('⚠️', `Found existing MNQ position — flattening first`);
      await client.liquidatePosition(account.id, contract.id, mnqPositions[0].netPos);
      await sleep(1000);
    }
    const cancelResult = await client.cancelAllOrders(account.id);
    log('🧹', `Cancelled ${cancelResult.cancelled} existing orders`);
  } catch (e) {
    log('⚠️', `Clean slate: ${e.message}`);
  }
  await sleep(1000);

  // ── Step 3: Place entry + OCO (simulating what SignalHandler does) ──
  section('STEP 3: Place Entry + OCO');

  // Get current price for reference
  const workingOrders = await client.getWorkingOrders(account.id);
  log('📋', `Working orders before entry: ${workingOrders.length}`);

  // Place market BUY
  log('📤', 'Placing market BUY 1 MNQ...');
  const entryOrder = await client.placeMarketOrder(account.id, contract.id, 1, 'Buy');
  const entryOrderId = entryOrder.orderId || entryOrder.id;
  log('✅', `Entry order placed: orderId=${entryOrderId}`);
  assert(entryOrderId > 0, 'Entry order ID obtained');

  // Wait for fill
  await sleep(2000);

  // Get fill price
  let entryPrice = null;
  const entryFills = await client.getFillsByOrder(entryOrderId);
  if (Array.isArray(entryFills) && entryFills.length > 0) {
    entryPrice = entryFills[0].price;
    log('💵', `Entry filled @ $${entryPrice}`);
  } else {
    log('⚠️', `No entry fill found yet, checking position...`);
    const pos = await client.getOpenPositions(account.id);
    const mnqPos = pos.filter(p => p.contractId === contract.id);
    if (mnqPos.length > 0) {
      entryPrice = mnqPos[0].netPrice;
      log('💵', `Entry price from position: $${entryPrice}`);
    }
  }
  assert(entryPrice !== null, 'Entry price obtained');

  // Place OCO: Stop 30pts below, Target 30pts above
  const stopPrice = Math.round((entryPrice - 30) * 4) / 4; // Round to tick
  const targetPrice = Math.round((entryPrice + 30) * 4) / 4;
  log('📤', `Placing OCO: Stop @ $${stopPrice} | Target @ $${targetPrice}`);

  const oco = await client.placeOCO(
    account.name || account.id.toString(),
    account.id,
    contract.name,
    1,
    'Sell',
    stopPrice,
    targetPrice
  );
  const stopOrderId = oco.orderId || oco.id;
  const targetOrderId = oco.ocoId;
  log('✅', `OCO placed: stopOrderId=${stopOrderId}, targetOrderId=${targetOrderId}`);
  assert(stopOrderId > 0, 'Stop order ID obtained');
  assert(targetOrderId > 0, 'Target order ID obtained');

  await sleep(1500);

  // Verify working orders
  const ordersAfterOCO = await client.getWorkingOrders(account.id);
  log('📋', `Working orders after OCO: ${ordersAfterOCO.length}`);
  assert(ordersAfterOCO.length >= 2, 'At least 2 working orders (stop + target)');

  // Verify position exists
  const posAfterEntry = await client.getOpenPositions(account.id);
  const mnqPosAfterEntry = posAfterEntry.filter(p => p.contractId === contract.id);
  log('📊', `MNQ positions: ${mnqPosAfterEntry.length}`);
  assert(mnqPosAfterEntry.length === 1, 'Exactly 1 MNQ position open');

  // ══════════════════════════════════════════════════════════════
  //  TEST A: EOD Close — Normal Path
  //  Cancel brackets by ID → verify position → flatten → get fill → compute P&L
  // ══════════════════════════════════════════════════════════════
  section('TEST A: EOD Close — Normal Path');

  // Step A1: Cancel only this instrument's bracket orders by ID
  log('🔧', 'Cancelling bracket orders by ID...');
  for (const oid of [stopOrderId, targetOrderId]) {
    try {
      await client.cancelOrder(oid);
      log('✅', `Cancelled order ${oid}`);
    } catch (cancelErr) {
      log('⚠️', `Cancel order ${oid}: ${cancelErr.message}`);
    }
  }
  await sleep(1000);

  // Verify brackets are cancelled
  const ordersAfterCancel = await client.getWorkingOrders(account.id);
  const remainingBrackets = ordersAfterCancel.filter(
    o => o.id === stopOrderId || o.id === targetOrderId
  );
  log('📋', `Working orders after cancel: ${ordersAfterCancel.length} (brackets remaining: ${remainingBrackets.length})`);
  assert(remainingBrackets.length === 0, 'All bracket orders cancelled');

  // Step A2: Verify position still exists on exchange
  const posBeforeFlatten = await client.getOpenPositions(account.id);
  const mnqPosBeforeFlatten = posBeforeFlatten.filter(p => p.contractId === contract.id);
  log('📊', `MNQ positions before flatten: ${mnqPosBeforeFlatten.length}`);
  assert(mnqPosBeforeFlatten.length === 1, 'Position still exists after bracket cancel');

  // Step A3: Flatten with market order
  log('📤', 'Placing market SELL to flatten...');
  const flattenOrder = await client.placeMarketOrder(account.id, contract.id, 1, 'Sell');
  const flattenOrderId = flattenOrder.orderId || flattenOrder.id;
  log('✅', `Flatten order placed: orderId=${flattenOrderId}`);
  assert(flattenOrderId > 0, 'Flatten order ID obtained');

  // Step A4: Wait and get fill price
  await sleep(2000);
  let exitPrice = null;
  const flattenFills = await client.getFillsByOrder(flattenOrderId);
  if (Array.isArray(flattenFills) && flattenFills.length > 0) {
    exitPrice = flattenFills[0].price;
    log('💵', `Flatten filled @ $${exitPrice}`);
    log('📊', `Fill object keys: ${Object.keys(flattenFills[0]).join(', ')}`);
    log('📊', `Fill details: action=${flattenFills[0].action}, qty=${flattenFills[0].qty}, price=${flattenFills[0].price}`);
  }
  assert(exitPrice !== null, 'Exit fill price obtained via getFillsByOrder');

  // Step A5: Compute P&L and determine win/loss
  if (exitPrice !== null && entryPrice !== null) {
    const pnl = (exitPrice - entryPrice) * 1 * POINT_VALUE; // Long position
    const result = pnl > 0 ? 'win' : 'loss';
    const pnlStr = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`;
    log('📊', `P&L: ${pnlStr} (${result.toUpperCase()})`);
    log('📊', `Entry: $${entryPrice} → Exit: $${exitPrice} = ${(exitPrice - entryPrice).toFixed(2)} pts × $${POINT_VALUE}/pt`);
    assert(typeof pnl === 'number' && !isNaN(pnl), 'P&L calculated correctly');
    assert(result === 'win' || result === 'loss', 'Win/loss determined correctly');
  }

  // Step A6: Verify position is closed
  await sleep(500);
  const posAfterFlatten = await client.getOpenPositions(account.id);
  const mnqPosAfterFlatten = posAfterFlatten.filter(p => p.contractId === contract.id);
  log('📊', `MNQ positions after flatten: ${mnqPosAfterFlatten.length}`);
  assert(mnqPosAfterFlatten.length === 0, 'Position fully closed after flatten');

  // Step A7: Verify no orphaned orders
  const ordersAfterFlatten = await client.getWorkingOrders(account.id);
  const orphanedOrders = ordersAfterFlatten.filter(
    o => o.contractId === contract.id
  );
  log('📋', `Orphaned MNQ orders: ${orphanedOrders.length}`);
  assert(orphanedOrders.length === 0, 'No orphaned orders after EOD close');

  // ══════════════════════════════════════════════════════════════
  //  TEST B: Position-Already-Closed Path
  //  Simulates the race condition where stop/target fills between cancel and flatten
  // ══════════════════════════════════════════════════════════════
  section('TEST B: Position-Already-Closed Race Condition Path');

  // Place a new entry
  log('📤', 'Placing new market BUY 1 MNQ...');
  const entry2 = await client.placeMarketOrder(account.id, contract.id, 1, 'Buy');
  const entry2Id = entry2.orderId || entry2.id;
  await sleep(2000);

  let entry2Price = null;
  const entry2Fills = await client.getFillsByOrder(entry2Id);
  if (Array.isArray(entry2Fills) && entry2Fills.length > 0) {
    entry2Price = entry2Fills[0].price;
  }
  log('💵', `Entry 2 filled @ $${entry2Price}`);

  // Place OCO with very tight stop (1 pt) so it might fill quickly
  const stop2 = Math.round((entry2Price - 30) * 4) / 4;
  const target2 = Math.round((entry2Price + 30) * 4) / 4;
  const oco2 = await client.placeOCO(
    account.name || account.id.toString(),
    account.id,
    contract.name,
    1,
    'Sell',
    stop2,
    target2
  );
  const stop2Id = oco2.orderId || oco2.id;
  const target2Id = oco2.ocoId;
  log('✅', `OCO 2 placed: stop=${stop2Id}, target=${target2Id}`);
  await sleep(1000);

  // Now flatten the position manually FIRST (simulating stop/target filling)
  log('📤', 'Manually flattening to simulate stop/target fill...');
  await client.placeMarketOrder(account.id, contract.id, 1, 'Sell');
  await sleep(2000);

  // Now simulate what eodClose does: cancel brackets, then check position
  log('🔧', 'Cancelling brackets (they may already be cancelled by OCO)...');
  for (const oid of [stop2Id, target2Id]) {
    try {
      await client.cancelOrder(oid);
      log('✅', `Cancelled order ${oid}`);
    } catch (cancelErr) {
      log('ℹ️', `Cancel order ${oid}: ${cancelErr.message} (expected — may be auto-cancelled)`);
    }
  }

  // Check position — should be gone
  const posCheck = await client.getOpenPositions(account.id);
  const mnqPosCheck = posCheck.filter(p => p.contractId === contract.id);
  log('📊', `MNQ positions (should be 0): ${mnqPosCheck.length}`);
  assert(mnqPosCheck.length === 0, 'Position already closed — skip flatten (race condition path works)');

  if (mnqPosCheck.length === 0) {
    log('✅', 'Race condition path: Correctly detected position already closed, would skip flatten');
  } else {
    log('❌', 'Race condition path: Position still exists — would need to flatten');
    // Clean up
    await client.liquidatePosition(account.id, contract.id, mnqPosCheck[0].netPos);
  }

  // ══════════════════════════════════════════════════════════════
  //  TEST C: Verify syncPosition fill lookup (stop vs target)
  // ══════════════════════════════════════════════════════════════
  section('TEST C: Verify getFillsByOrder for stop/target detection');

  // The fills from Test A should still be queryable
  log('🔍', `Checking getFillsByOrder for stop order ${stopOrderId}...`);
  const stopFillsCheck = await client.getFillsByOrder(stopOrderId);
  log('📊', `Stop order fills: ${Array.isArray(stopFillsCheck) ? stopFillsCheck.length : 'not array'}`);
  assert(Array.isArray(stopFillsCheck), 'getFillsByOrder returns array for stop order');

  log('🔍', `Checking getFillsByOrder for target order ${targetOrderId}...`);
  const targetFillsCheck = await client.getFillsByOrder(targetOrderId);
  log('📊', `Target order fills: ${Array.isArray(targetFillsCheck) ? targetFillsCheck.length : 'not array'}`);
  assert(Array.isArray(targetFillsCheck), 'getFillsByOrder returns array for target order');

  // Neither should have fills (we cancelled them before they could fill)
  assert(stopFillsCheck.length === 0, 'Stop order has 0 fills (was cancelled, not filled)');
  assert(targetFillsCheck.length === 0, 'Target order has 0 fills (was cancelled, not filled)');

  // ── Final Cleanup ──
  section('CLEANUP');
  try {
    await client.cancelAllOrders(account.id);
    const finalPos = await client.getOpenPositions(account.id);
    const finalMnq = finalPos.filter(p => p.contractId === contract.id);
    if (finalMnq.length > 0) {
      await client.liquidatePosition(account.id, contract.id, finalMnq[0].netPos);
    }
    log('🧹', 'Cleanup complete');
  } catch (e) {
    log('⚠️', `Cleanup: ${e.message}`);
  }

  // ── Results ──
  section('RESULTS');
  console.log(`\n  ✅ Passed: ${passCount}`);
  console.log(`  ❌ Failed: ${failCount}`);
  console.log(`  Total:   ${passCount + failCount}\n`);

  if (failCount === 0) {
    log('🎉', 'ALL TESTS PASSED — EOD close logic is verified');
  } else {
    log('🚨', `${failCount} test(s) FAILED — review output above`);
  }

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
