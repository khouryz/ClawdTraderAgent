/**
 * Test: Market Entry + OCO (Stop+Target) + BE Stop Modification
 * 
 * Uses placeOCO instead of startOrderStrategy:
 * 1. Place market entry order → wait for fill
 * 2. Place OCO: Stop order + Limit target (absolute prices)
 *    → returns { orderId, ocoId } — we know exactly which is the stop
 * 3. modifyOrder(stopOrderId, { stopPrice: entryPrice }) to move to BE
 * 4. Verify stop moved, then close position
 * 
 * Run: node tests/test_bracket_be.js
 */
require('dotenv').config();
const TradovateAuth = require('../src/api/auth');
const TradovateClient = require('../src/api/client');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runTest(client, account, contract, side) {
  const entryAction = side === 'long' ? 'Buy' : 'Sell';
  const exitAction = side === 'long' ? 'Sell' : 'Buy';
  const label = side.toUpperCase();
  const dir = side === 'long' ? 1 : -1;

  console.log('\n' + '═'.repeat(60));
  console.log(`TEST: ${label} entry → OCO stop+target → move stop to BE`);
  console.log('═'.repeat(60));

  // Clean slate
  console.log('Cancelling existing orders...');
  await client.cancelAllOrders(account.id);
  await sleep(2000);

  // ── Step 1: Market entry ──
  console.log(`\nStep 1: Placing ${entryAction} market order...`);
  const entryResp = await client.placeMarketOrder(account.id, contract.id, 1, entryAction);
  const entryOrderId = entryResp.orderId;
  console.log(`Entry order ID: ${entryOrderId}`);

  // Wait for fill
  await sleep(3000);

  // Get fill price using the specific order ID (not account-wide fills)
  let entryPrice = null;
  try {
    const orderFills = await client.getFillsByOrder(entryOrderId);
    if (Array.isArray(orderFills) && orderFills.length > 0) {
      entryPrice = orderFills[0].price;
    }
  } catch (e) {
    // Fallback to account fills
    const fills = await client.getFillsByAccount(account.id);
    const entryFill = fills.filter(f => f.contractId === contract.id && f.action === entryAction).pop();
    entryPrice = entryFill ? entryFill.price : null;
  }
  console.log(`Entry fill price: ${entryPrice}`);

  if (!entryPrice) {
    console.log('❌ No fill price found, aborting test');
    return;
  }

  // ── Step 2: Place OCO (Stop + Limit Target) ──
  // Stop: 50 points away from entry
  // Target: 100 points away from entry
  const stopPrice = entryPrice - dir * 50;
  const targetPrice = entryPrice + dir * 100;

  console.log(`\nStep 2: Placing OCO...`);
  console.log(`  Stop:   ${exitAction} Stop @ ${stopPrice} (50pt from entry)`);
  console.log(`  Target: ${exitAction} Limit @ ${targetPrice} (100pt from entry)`);

  // placeOCO: the main order is the Stop, the "other" is the Limit
  const ocoBody = {
    accountSpec: account.name,
    accountId: account.id,
    action: exitAction,
    symbol: contract.name,
    orderQty: 1,
    orderType: 'Stop',
    stopPrice: stopPrice,
    isAutomated: true,
    other: {
      action: exitAction,
      orderType: 'Limit',
      price: targetPrice,
    }
  };

  console.log('OCO request:', JSON.stringify(ocoBody, null, 2));
  const ocoResp = await client.request('POST', '/order/placeoco', ocoBody);
  console.log('OCO response:', JSON.stringify(ocoResp, null, 2));

  const stopOrderId = ocoResp.orderId;
  const targetOrderId = ocoResp.ocoId;
  console.log(`\n✓ Stop order ID: ${stopOrderId}`);
  console.log(`✓ Target (OCO) order ID: ${targetOrderId}`);

  // Wait for orders to become Working
  await sleep(2000);

  // Verify working orders
  console.log('\nWorking orders after OCO:');
  const workingOrders = await client.getWorkingOrders(account.id);
  for (const o of workingOrders) {
    console.log(`  Order ${o.id}: ${o.action} ${o.ordStatus}`);
  }

  // ── Step 3: Move stop to BE ──
  console.log(`\nStep 3: Moving stop ${stopOrderId} from ${stopPrice} to BE (${entryPrice})...`);
  try {
    const modResp = await client.modifyOrder(stopOrderId, {
      orderType: 'Stop',
      stopPrice: entryPrice,
      orderQty: 1,
    });
    console.log('Modify response:', JSON.stringify(modResp, null, 2));
    console.log(`✅ ${label} BE STOP MODIFICATION WORKS!`);
  } catch (err) {
    console.error(`✗ Modify failed: ${err.message}`);
    console.log(`❌ ${label} BE STOP MODIFICATION FAILED`);
  }

  // ── Step 4: Verify — wait so user can see it on Tradovate ──
  console.log('\nStep 4: Waiting 10 seconds — CHECK YOUR TRADOVATE ACCOUNT NOW...');
  console.log(`  → Stop order ${stopOrderId} should now be at ${entryPrice} (was ${stopPrice})`);
  console.log(`  → Target order ${targetOrderId} should still be at ${targetPrice}`);
  await sleep(10000);

  console.log('\nVerification — working orders:');
  const finalOrders = await client.getWorkingOrders(account.id);
  for (const o of finalOrders) {
    console.log(`  Order ${o.id}: ${o.action} ${o.ordStatus}`);
  }

  // ── Clean up ──
  console.log(`\nClosing ${label} position...`);
  try {
    await client.placeMarketOrder(account.id, contract.id, 1, exitAction);
    console.log(`✓ ${label} position closed`);
  } catch (err) {
    console.log('Close error:', err.message);
  }
  await sleep(2000);
  await client.cancelAllOrders(account.id);
  await sleep(2000);
}

async function main() {
  const auth = new TradovateAuth({
    env: process.env.TRADOVATE_ENV || 'demo',
    username: process.env.TRADOVATE_USERNAME,
    password: process.env.TRADOVATE_PASSWORD,
    cid: parseInt(process.env.TRADOVATE_CID),
    secret: process.env.TRADOVATE_SECRET,
  });
  await auth.authenticate();
  console.log('✓ Authenticated\n');

  const client = new TradovateClient(auth);

  const accounts = await client.getAccounts();
  const account = accounts[0];
  console.log(`Account: ${account.name} (ID: ${account.id})`);

  const contractSymbol = process.env.MNQ_SYMBOL || 'MNQH6';
  const contract = await client.findContract(contractSymbol);
  if (!contract) {
    console.error(`ERROR: Contract ${contractSymbol} not found`);
    process.exit(1);
  }
  console.log(`Contract: ${contract.name} (ID: ${contract.id})\n`);

  // Test LONG
  await runTest(client, account, contract, 'long');

  // Test SHORT
  await runTest(client, account, contract, 'short');

  console.log('\n' + '═'.repeat(60));
  console.log('ALL TESTS COMPLETE');
  console.log('═'.repeat(60));
  process.exit(0);
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
