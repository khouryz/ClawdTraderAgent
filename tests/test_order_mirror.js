/**
 * Unit test: OrderMirror (sub-account mirror-trading fanout at the order layer).
 *
 * Pure unit test — NO network, NO Tradovate auth. Uses a MockClient that records
 * every call and returns deterministic orderIds. Proves the guarantees the live
 * system depends on:
 *
 *   (f) createOrderClient returns the REAL client unchanged for N<=1 (byte-for-byte
 *       single-sub-account behavior; OrderMirror never instantiated).
 *   (a) one primary entry -> N identical secondary entries (only accountId /
 *       accountSpec differ; symbol/qty/action/price identical).
 *   (c) placeOCO maps BOTH legs (stop + target) for every secondary.
 *   (b) modifyOrder / cancelOrder fan out to the MAPPED secondary orderIds (the
 *       secondaries' own ids, not the primary's), with identical change payloads.
 *   (e) ownerOfOrder classifies primary / secondary / unknown correctly (this is
 *       what keeps secondary fills out of the primary runner).
 *   (d) liquidatePosition flattens each secondary's OWN net (robust to qty drift).
 *   (g) a secondary entry failure raises divergence (halt-all hook) without
 *       touching the primary.
 *   (h) a NAKED secondary (entry mirrored but OCO failed) is force-flattened, then
 *       reported as divergence with naked:true.
 *
 * Run: node tests/test_order_mirror.js
 */
const { OrderMirror, createOrderClient } = require('../src/api/OrderMirror');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Secondary placements fire in the BACKGROUND (not awaited by the caller). Drain
// them before asserting. Mock methods resolve synchronously so this is ample.
const flush = () => sleep(40);

// ── tiny assertion harness ─────────────────────────────────────────────────
let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (cond) { console.log(`  ✓ ${msg}`); }
  else { failures++; console.error(`  ✗ FAIL: ${msg}`); }
}
function eq(actual, expected, msg) {
  ok(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function deepEq(actual, expected, msg) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
const sortNum = (a) => a.slice().sort((x, y) => x - y);

// ── mock client ─────────────────────────────────────────────────────────────
class MockClient {
  constructor() {
    this.calls = [];          // every call: { method, ...args, [orderId/ocoId] }
    this._seq = 1000;         // deterministic, monotonically increasing ids
    this.positions = {};      // accountId -> [{ contractId, netPos }]
    this.workingOrders = {};  // accountId -> [{ id, contractId, ordType, action, stopPrice/price }]
    this.contracts = { MNQH6: { id: 9999, name: 'MNQH6' } };
    this.failPlaceMarketFor = null; // accountId whose placeMarketOrder should throw
    this.failPlaceOcoFor = null;    // accountId whose placeOCO should throw
    this.primaryId = null;          // for the race test: which accountId is primary
    this.secondaryPlaceDelayMs = 0; // delay secondary place* resolution (simulate slow ack)
  }
  _next() { return this._seq++; }
  _isSecondary(accountId) { return this.primaryId != null && accountId !== this.primaryId; }

  async placeMarketOrder(accountId, contractId, qty, action) {
    if (this.failPlaceMarketFor === accountId) {
      this.calls.push({ method: 'placeMarketOrder', accountId, contractId, qty, action, threw: true });
      throw new Error(`simulated placeMarketOrder failure for ${accountId}`);
    }
    const orderId = this._next();
    this.calls.push({ method: 'placeMarketOrder', accountId, contractId, qty, action, orderId });
    return { orderId };
  }
  async placeLimitOrder(accountId, contractId, qty, action, price) {
    const orderId = this._next();
    this.calls.push({ method: 'placeLimitOrder', accountId, contractId, qty, action, price, orderId });
    return { orderId };
  }
  async placeOCO(accountSpec, accountId, symbol, qty, exitAction, stopPrice, targetPrice) {
    if (this.failPlaceOcoFor === accountId) {
      this.calls.push({ method: 'placeOCO', accountSpec, accountId, symbol, qty, exitAction, stopPrice, targetPrice, threw: true });
      throw new Error(`simulated placeOCO failure for ${accountId}`);
    }
    const orderId = this._next();   // stop leg
    const ocoId = this._next();     // target leg
    this.calls.push({ method: 'placeOCO', accountSpec, accountId, symbol, qty, exitAction, stopPrice, targetPrice, orderId, ocoId });
    if (this.secondaryPlaceDelayMs && this._isSecondary(accountId)) await sleep(this.secondaryPlaceDelayMs);
    return { orderId, ocoId };
  }
  async modifyOrder(orderId, changes) {
    this.calls.push({ method: 'modifyOrder', orderId, changes });
    return { ok: true, orderId };
  }
  async cancelOrder(orderId) {
    this.calls.push({ method: 'cancelOrder', orderId });
    return { ok: true, orderId };
  }
  async liquidatePosition(accountId, contractId, netPos) {
    const orderId = this._next();
    this.calls.push({ method: 'liquidatePosition', accountId, contractId, netPos, orderId });
    return { orderId };
  }
  async getOpenPositions(accountId) {
    this.calls.push({ method: 'getOpenPositions', accountId });
    return this.positions[accountId] || [];
  }
  async getWorkingOrders(accountId) {
    this.calls.push({ method: 'getWorkingOrders', accountId });
    return this.workingOrders[accountId] || [];
  }
  async findContract(symbol) {
    this.calls.push({ method: 'findContract', symbol });
    return this.contracts[symbol] || null;
  }
}

// Standard 3-sub-account fanout (1 primary + 2 secondaries).
const SUBS = [
  { id: 1699181, name: '1699181' },
  { id: 1699182, name: '1699182' },
  { id: 1699183, name: '1699183' },
];
const PRIMARY = SUBS[0].id;
const SECONDARY_IDS = [SUBS[1].id, SUBS[2].id];
const CONTRACT_ID = 9999;
const by = (calls, method) => calls.filter(c => c.method === method);

// ── (f) N<=1 returns the real client untouched ──────────────────────────────
async function testSingleAccountPassthrough() {
  console.log('\n(f) createOrderClient is a no-op for N<=1');
  const real = new MockClient();

  const one = createOrderClient(real, [{ id: 1699181, name: '1699181' }]);
  ok(one.client === real, 'N=1 -> returns the SAME real client object (not a proxy)');
  eq(one.mirror, null, 'N=1 -> mirror is null');

  const none = createOrderClient(real, []);
  ok(none.client === real, 'N=0 -> returns the real client');
  eq(none.mirror, null, 'N=0 -> mirror is null');

  const undef = createOrderClient(real, undefined);
  ok(undef.client === real, 'undefined subAccounts -> returns the real client');

  // Calling through the N=1 client must NOT fan out (only the one real call).
  await one.client.placeMarketOrder(PRIMARY, CONTRACT_ID, 1, 'Buy');
  await flush();
  eq(by(real.calls, 'placeMarketOrder').length, 1, 'N=1 -> exactly one placeMarketOrder, zero mirroring');
}

// ── (a) one entry -> N identical entries ────────────────────────────────────
async function testEntryFanout() {
  console.log('\n(a) one primary entry -> N identical secondary entries');
  const real = new MockClient();
  const { client, mirror } = createOrderClient(real, SUBS);
  ok(mirror instanceof OrderMirror, 'N>1 -> mirror is an OrderMirror instance');

  const res = await client.placeMarketOrder(PRIMARY, CONTRACT_ID, 2, 'Buy');
  await flush();

  const places = by(real.calls, 'placeMarketOrder');
  eq(places.length, 3, '1 primary + 2 secondary placeMarketOrder calls');
  eq(places[0].accountId, PRIMARY, 'first call is the primary (awaited before any secondary)');

  // every call: identical symbol/qty/action; only accountId differs
  for (const p of places) {
    ok(p.contractId === CONTRACT_ID && p.qty === 2 && p.action === 'Buy',
      `call for acct ${p.accountId} has identical params (contract/qty/action)`);
  }
  deepEq(sortNum(places.slice(1).map(p => p.accountId)), sortNum(SECONDARY_IDS),
    'the two secondaries are exactly the configured secondary accountIds');

  ok(res && res.orderId === places[0].orderId, 'caller receives the PRIMARY result (its orderId)');
  return { real, mirror, primaryOrderId: res.orderId, secondaryOrderIds: places.slice(1).map(p => p.orderId) };
}

// ── (e) ownerOfOrder classification (fill routing) ──────────────────────────
async function testOwnerOfOrder() {
  console.log('\n(e) ownerOfOrder classifies primary / secondary / unknown');
  const { mirror, primaryOrderId, secondaryOrderIds } = await testEntryFanout();

  eq(mirror.ownerOfOrder(primaryOrderId).kind, 'primary', 'primary orderId -> {kind:primary}');

  const o1 = mirror.ownerOfOrder(secondaryOrderIds[0]);
  eq(o1.kind, 'secondary', 'secondary orderId -> {kind:secondary}');
  ok(SECONDARY_IDS.includes(o1.accountId), 'secondary owner carries the right accountId');

  // string/number agnostic (WS may deliver orderId as a string)
  eq(mirror.ownerOfOrder(String(primaryOrderId)).kind, 'primary', 'string form of primary id classified as primary');

  eq(mirror.ownerOfOrder(424242), null, 'unknown orderId -> null (caller defaults to primary runner)');
  eq(mirror.ownerOfOrder(null), null, 'null orderId -> null');
}

// ── (c)+(b) OCO maps both legs; modify/cancel fan out by mapped ids ──────────
async function testOcoAndModifyCancel() {
  console.log('\n(c) placeOCO maps both legs  +  (b) modify/cancel fan out by mapped ids');
  const real = new MockClient();
  // Both secondaries ENTERED (hold a position) — the OCO gate brackets only
  // accounts that actually entered.
  real.positions[SUBS[1].id] = [{ contractId: CONTRACT_ID, netPos: 2 }];
  real.positions[SUBS[2].id] = [{ contractId: CONTRACT_ID, netPos: 2 }];
  const { client, mirror } = createOrderClient(real, SUBS);

  const oco = await client.placeOCO('1699181', PRIMARY, 'MNQH6', 2, 'Sell', 100, 200);
  await flush();

  const ocoCalls = by(real.calls, 'placeOCO');
  eq(ocoCalls.length, 3, '1 primary + 2 secondary placeOCO calls');
  for (const c of ocoCalls) {
    ok(c.symbol === 'MNQH6' && c.qty === 2 && c.exitAction === 'Sell' && c.stopPrice === 100 && c.targetPrice === 200,
      `OCO for acct ${c.accountId} has identical symbol/qty/action/prices`);
  }
  const secOco = ocoCalls.filter(c => c.accountId !== PRIMARY);
  ok(secOco.every(c => c.accountSpec === String(c.accountId)),
    'secondary accountSpec defaults to the account name/id string');

  // both legs of the PRIMARY are classified as primary (map covers stop AND target)
  eq(mirror.ownerOfOrder(oco.orderId).kind, 'primary', 'primary STOP leg classified primary');
  eq(mirror.ownerOfOrder(oco.ocoId).kind, 'primary', 'primary TARGET leg classified primary');
  // both legs of each secondary are classified as secondary
  for (const c of secOco) {
    eq(mirror.ownerOfOrder(c.orderId).kind, 'secondary', `secondary ${c.accountId} STOP leg classified secondary`);
    eq(mirror.ownerOfOrder(c.ocoId).kind, 'secondary', `secondary ${c.accountId} TARGET leg classified secondary`);
  }

  // modify the STOP leg -> secondaries' STOP legs move (their own ids), same payload
  await client.modifyOrder(oco.orderId, { stopPrice: 150 });
  await flush();
  const mods = by(real.calls, 'modifyOrder');
  eq(mods.length, 3, 'modifyOrder: 1 primary + 2 secondary');
  eq(mods[0].orderId, oco.orderId, 'first modify hits the primary stop id (awaited)');
  deepEq(sortNum(mods.slice(1).map(m => m.orderId)), sortNum(secOco.map(c => c.orderId)),
    'secondary modifies target the mapped secondary STOP ids (not the primary id, not the target leg)');
  ok(mods.every(m => m.changes && m.changes.stopPrice === 150), 'identical modify payload across all accounts');

  // cancel the TARGET leg -> secondaries' TARGET legs cancel (their own ids)
  await client.cancelOrder(oco.ocoId);
  await flush();
  const cancels = by(real.calls, 'cancelOrder');
  eq(cancels.length, 3, 'cancelOrder: 1 primary + 2 secondary');
  eq(cancels[0].orderId, oco.ocoId, 'first cancel hits the primary target id (awaited)');
  deepEq(sortNum(cancels.slice(1).map(c => c.orderId)), sortNum(secOco.map(c => c.ocoId)),
    'secondary cancels target the mapped secondary TARGET ids');

  // after cancel, the map key is dropped -> a repeat cancel does NOT fan out again
  await client.cancelOrder(oco.ocoId);
  await flush();
  eq(by(real.calls, 'cancelOrder').length, 4, 'repeat cancel of a dropped id makes only the primary call (no stale fanout)');
}

// ── (d) liquidatePosition flattens each secondary's OWN net ─────────────────
async function testLiquidate() {
  console.log("\n(d) liquidatePosition flattens each secondary's OWN net (qty-drift safe)");
  const real = new MockClient();
  real.positions[SUBS[1].id] = [{ contractId: CONTRACT_ID, netPos: 2 }];
  real.positions[SUBS[2].id] = [{ contractId: CONTRACT_ID, netPos: -1 }]; // intentionally drifted
  const { client } = createOrderClient(real, SUBS);

  await client.liquidatePosition(PRIMARY, CONTRACT_ID, 2);
  await flush();

  const liqs = by(real.calls, 'liquidatePosition');
  ok(liqs.some(l => l.accountId === PRIMARY && l.netPos === 2), 'primary liquidation passes through unchanged');
  ok(liqs.some(l => l.accountId === SUBS[1].id && l.netPos === 2), 'secondary 1699182 flattened by its own net (+2)');
  ok(liqs.some(l => l.accountId === SUBS[2].id && l.netPos === -1), 'secondary 1699183 flattened by ITS own net (-1), not the primary qty');
  // each secondary's net was read from its own account
  ok(by(real.calls, 'getOpenPositions').some(c => c.accountId === SUBS[1].id), 'read secondary 1699182 open positions');
  ok(by(real.calls, 'getOpenPositions').some(c => c.accountId === SUBS[2].id), 'read secondary 1699183 open positions');
}

// ── (g) secondary entry failure -> divergence, primary untouched ────────────
async function testEntryDivergence() {
  console.log('\n(g) secondary entry failure raises divergence; primary unaffected');
  const real = new MockClient();
  real.failPlaceMarketFor = SUBS[1].id; // first secondary throws
  const { client, mirror } = createOrderClient(real, SUBS);

  const events = [];
  mirror.setDivergenceHandler((info) => events.push(info));

  const res = await client.placeMarketOrder(PRIMARY, CONTRACT_ID, 1, 'Buy');
  await flush();

  ok(res && res.orderId != null, 'primary entry still succeeds and returns to caller');
  eq(events.length, 1, 'exactly one divergence event (the failed secondary)');
  if (events.length) {
    eq(events[0].method, 'placeMarketOrder', 'divergence method is placeMarketOrder');
    eq(events[0].accountId, SUBS[1].id, 'divergence carries the failing secondary accountId');
    ok(!events[0].naked, 'entry failure is NOT naked (no position was opened)');
  }
  // the healthy secondary still placed
  ok(by(real.calls, 'placeMarketOrder').some(c => c.accountId === SUBS[2].id && !c.threw),
    'the other secondary still places normally');
}

// ── (h) naked secondary (OCO failed) is flattened, then reported naked ──────
async function testNakedOcoFlatten() {
  console.log('\n(h) naked secondary (entry filled, OCO failed) is force-flattened then reported');
  const real = new MockClient();
  real.failPlaceOcoFor = SUBS[1].id; // this secondary's protective OCO fails
  // BOTH entered; the first one's OCO fails → it is left NAKED and must be flattened.
  real.positions[SUBS[1].id] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  real.positions[SUBS[2].id] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  const { client, mirror } = createOrderClient(real, SUBS);

  const events = [];
  mirror.setDivergenceHandler((info) => events.push(info));

  await client.placeOCO('1699181', PRIMARY, 'MNQH6', 1, 'Sell', 100, 200);
  await flush();

  const naked = events.find(e => e.accountId === SUBS[1].id && e.method === 'placeOCO');
  ok(naked, 'divergence reported for the failed-OCO secondary');
  ok(naked && naked.naked === true, 'reported with naked:true');
  // it was flattened: symbol resolved via findContract, position read, liquidated
  ok(by(real.calls, 'findContract').some(c => c.symbol === 'MNQH6'), 'resolved symbol -> contractId for the naked flatten');
  ok(by(real.calls, 'liquidatePosition').some(l => l.accountId === SUBS[1].id && l.netPos === 1),
    "naked secondary's live position was liquidated");
  // the healthy secondary kept its OCO (no flatten for it)
  ok(!by(real.calls, 'liquidatePosition').some(l => l.accountId === SUBS[2].id),
    'the healthy secondary was NOT flattened');
}

// ── (i) modify/cancel awaits an in-flight secondary placement (race fix) ─────
async function testModifyCancelAwaitsPendingPlacement() {
  console.log('\n(i) modify/cancel issued before the secondary placement lands still fan out');

  // modify the stop the instant after placeOCO returns — secondary OCO still in flight
  const real = new MockClient();
  real.primaryId = PRIMARY;
  real.secondaryPlaceDelayMs = 60; // secondary placeOCO resolves 60ms late
  real.positions[SUBS[1].id] = [{ contractId: CONTRACT_ID, netPos: 1 }]; // both entered
  real.positions[SUBS[2].id] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  const { client } = createOrderClient(real, SUBS);

  const oco = await client.placeOCO('1699181', PRIMARY, 'MNQH6', 1, 'Sell', 100, 200);
  // NO flush() here — the secondary mapping is intentionally NOT yet populated.
  await client.modifyOrder(oco.orderId, { stopPrice: 150 }); // must await the pending placement
  await flush();
  const mods = by(real.calls, 'modifyOrder');
  eq(mods.length, 3, 'modify fanned to BOTH secondaries despite the placement race (1 primary + 2 secondary)');

  // same for a cancel issued immediately after placement
  const real2 = new MockClient();
  real2.primaryId = PRIMARY;
  real2.secondaryPlaceDelayMs = 60;
  real2.positions[SUBS[1].id] = [{ contractId: CONTRACT_ID, netPos: 1 }]; // both entered
  real2.positions[SUBS[2].id] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  const c2 = createOrderClient(real2, SUBS);
  const oco2 = await c2.client.placeOCO('1699181', PRIMARY, 'MNQH6', 1, 'Sell', 100, 200);
  await c2.client.cancelOrder(oco2.ocoId);
  await flush();
  const cancels = by(real2.calls, 'cancelOrder');
  eq(cancels.length, 3, 'cancel fanned to BOTH secondaries despite the placement race');

  // control: with NO pending await mechanism, a synchronous-map read would be empty.
  // Confirm the map really was empty at modify time by checking the primary call
  // still happened first (ordering) and secondaries used their own (later) ids.
  ok(mods[0].orderId === oco.orderId, 'primary modify still hits the primary stop id first');
}

// ── (j) flat secondary is NOT bracketed (H2: no naked opening orders) ───────
async function testOcoSkipsFlatSecondary() {
  console.log('\n(j) a secondary that did NOT enter gets NO OCO (no naked opening orders)');
  const real = new MockClient();
  // 1699182 entered (holds a position); 1699183 is FLAT (entry missed/rejected).
  real.positions[SUBS[1].id] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  // SUBS[2] intentionally has NO position.
  const { client, mirror } = createOrderClient(real, SUBS);
  const events = [];
  mirror.setDivergenceHandler((info) => events.push(info));

  await client.placeOCO('1699181', PRIMARY, 'MNQH6', 1, 'Sell', 100, 200);
  await sleep(700); // flat secondary's entry-confirm retries (~3×150ms) must elapse

  const ocoCalls = by(real.calls, 'placeOCO');
  ok(ocoCalls.some(c => c.accountId === PRIMARY), 'primary OCO placed');
  ok(ocoCalls.some(c => c.accountId === SUBS[1].id), 'entered secondary OCO placed');
  ok(!ocoCalls.some(c => c.accountId === SUBS[2].id), 'FLAT secondary got NO OCO (no naked opening orders)');
  ok(events.some(e => e.accountId === SUBS[2].id && /skip/i.test(`${e.method} ${e.error || ''}`)),
    'flat secondary surfaced as a skip alert (no halt)');
}

// ── (k) reconcileSecondaries: re-bracket missing, cancel stray, rewire map ──
async function testReconcileSecondaries() {
  console.log('\n(k) reconcileSecondaries re-brackets unprotected, cancels stray, rewires BE map');
  const real = new MockClient();
  const { client, mirror } = createOrderClient(real, SUBS);

  // PRIMARY: long 1, properly bracketed (stop @100, target @200)
  real.positions[PRIMARY] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  real.workingOrders[PRIMARY] = [
    { id: 5001, contractId: CONTRACT_ID, ordType: 'Stop', action: 'Sell', stopPrice: 100 },
    { id: 5002, contractId: CONTRACT_ID, ordType: 'Limit', action: 'Sell', price: 200 },
  ];
  // SUBS[1]: long 1 but UNPROTECTED (no bracket) → must be re-bracketed at 100/200
  real.positions[SUBS[1].id] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  real.workingOrders[SUBS[1].id] = [];
  // SUBS[2]: FLAT but a stray resting Stop (a naked opening order) → must be cancelled
  real.positions[SUBS[2].id] = [];
  real.workingOrders[SUBS[2].id] = [{ id: 5099, contractId: CONTRACT_ID, ordType: 'Stop', action: 'Sell', stopPrice: 100 }];

  await mirror.reconcileSecondaries(CONTRACT_ID, 'MNQH6');

  const reOco = by(real.calls, 'placeOCO').filter(c => c.accountId === SUBS[1].id);
  eq(reOco.length, 1, 'unprotected secondary re-bracketed exactly once');
  if (reOco.length) {
    ok(reOco[0].stopPrice === 100 && reOco[0].targetPrice === 200 && reOco[0].exitAction === 'Sell' && reOco[0].qty === 1,
      're-bracket uses the PRIMARY current stop/target/exit/qty (100/200/Sell/1)');
  }
  ok(by(real.calls, 'cancelOrder').some(c => c.orderId === 5099), 'stray order on the flat secondary was cancelled');
  ok(!by(real.calls, 'liquidatePosition').some(l => l.accountId === SUBS[1].id), 'protectable secondary was NOT flattened');

  // The order map was rebuilt: a BE modify on the PRIMARY stop now reaches the re-bracketed secondary stop.
  const reStopId = reOco.length ? reOco[0].orderId : null;
  await client.modifyOrder(5001, { stopPrice: 150 });
  await flush();
  ok(by(real.calls, 'modifyOrder').some(m => m.orderId === reStopId && m.changes.stopPrice === 150),
    'BE modify propagates to the re-bracketed secondary stop (map rebuilt)');
}

// ── (l) reconcile flattens a secondary the primary already exited ───────────
async function testReconcileFlattensLeftover() {
  console.log('\n(l) reconcile flattens a secondary still holding after the primary exited');
  const real = new MockClient();
  const { mirror } = createOrderClient(real, SUBS);
  real.positions[PRIMARY] = [];        // primary FLAT
  real.workingOrders[PRIMARY] = [];
  real.positions[SUBS[1].id] = [{ contractId: CONTRACT_ID, netPos: 1 }]; // secondary still holding
  real.workingOrders[SUBS[1].id] = [];
  real.positions[SUBS[2].id] = [];

  await mirror.reconcileSecondaries(CONTRACT_ID, 'MNQH6');

  ok(by(real.calls, 'liquidatePosition').some(l => l.accountId === SUBS[1].id && l.netPos === 1),
    'leftover secondary position flattened to match the flat primary');
}

// ── (m) SPARSE fields: a healthy ocoId-paired bracket is NOT churned in-trade ──
// This is the regression for the live bug: /order/list returns sparse orders (no
// orderType/stopPrice/price) so the old price-based gate saw null prices, decided
// the primary was "mid-entry", and bailed — making reconcile a no-op while any
// position was open AND (if it had proceeded) misclassifying healthy brackets as
// "missing a leg". The price-free count/ocoId test must keep healthy brackets intact.
async function testReconcileSparseHealthyNoChurn() {
  console.log('\n(m) SPARSE /order/list: healthy ocoId-paired brackets are inspected but NOT churned');
  const real = new MockClient();
  const { mirror } = createOrderClient(real, SUBS);
  const sparseOco = (idA, idB) => ([
    { id: idA, contractId: CONTRACT_ID, action: 'Sell', ordStatus: 'Working', ocoId: idB },
    { id: idB, contractId: CONTRACT_ID, action: 'Sell', ordStatus: 'Working', ocoId: idA },
  ]);
  // Primary + both secondaries: holding, each with a healthy SPARSE 2-leg bracket.
  real.positions[PRIMARY] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  real.workingOrders[PRIMARY] = sparseOco(7001, 7002);
  real.positions[SUBS[1].id] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  real.workingOrders[SUBS[1].id] = sparseOco(7011, 7012);
  real.positions[SUBS[2].id] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  real.workingOrders[SUBS[2].id] = sparseOco(7021, 7022);

  await mirror.reconcileSecondaries(CONTRACT_ID, 'MNQH6');

  eq(by(real.calls, 'liquidatePosition').length, 0, 'no flatten on healthy sparse brackets (no false flatten)');
  eq(by(real.calls, 'placeOCO').length, 0, 'no re-bracket on healthy sparse brackets (no churn)');
  eq(by(real.calls, 'cancelOrder').length, 0, 'no cancels on healthy sparse brackets');
  // Proof it did NOT early-return during the trade: it actually read the secondaries.
  ok(by(real.calls, 'getOpenPositions').some(c => c.accountId === SUBS[1].id), 'reconcile DID inspect secondary 1 (no in-trade early-return)');
  ok(by(real.calls, 'getOpenPositions').some(c => c.accountId === SUBS[2].id), 'reconcile DID inspect secondary 2');
}

// ── (n) SPARSE fields: a secondary that LOST a protective leg is flattened ──────
async function testReconcileSparseUnprotectedFlattens() {
  console.log('\n(n) SPARSE /order/list: a secondary missing a leg is flattened-to-protect (prices unreadable)');
  const real = new MockClient();
  const { mirror } = createOrderClient(real, SUBS);
  // Primary holds with a healthy sparse bracket.
  real.positions[PRIMARY] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  real.workingOrders[PRIMARY] = [
    { id: 8001, contractId: CONTRACT_ID, action: 'Sell', ordStatus: 'Working', ocoId: 8002 },
    { id: 8002, contractId: CONTRACT_ID, action: 'Sell', ordStatus: 'Working', ocoId: 8001 },
  ];
  // SUBS[1]: holds, but only ONE leg remains (its OCO partner was cancelled) → under-protected.
  real.positions[SUBS[1].id] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  real.workingOrders[SUBS[1].id] = [
    { id: 8011, contractId: CONTRACT_ID, action: 'Sell', ordStatus: 'Working', ocoId: 8012 /* partner gone */ },
  ];
  // SUBS[2]: holds with a healthy sparse bracket (must be left alone).
  real.positions[SUBS[2].id] = [{ contractId: CONTRACT_ID, netPos: 1 }];
  real.workingOrders[SUBS[2].id] = [
    { id: 8021, contractId: CONTRACT_ID, action: 'Sell', ordStatus: 'Working', ocoId: 8022 },
    { id: 8022, contractId: CONTRACT_ID, action: 'Sell', ordStatus: 'Working', ocoId: 8021 },
  ];
  const events = [];
  mirror.setDivergenceHandler((info) => events.push(info));

  await mirror.reconcileSecondaries(CONTRACT_ID, 'MNQH6');

  ok(by(real.calls, 'cancelOrder').some(c => c.orderId === 8011), 'the lone remaining leg was cancelled first');
  ok(by(real.calls, 'liquidatePosition').some(l => l.accountId === SUBS[1].id && l.netPos === 1), 'under-protected secondary flattened to protect');
  eq(by(real.calls, 'placeOCO').length, 0, 'no re-bracket attempted (no readable primary prices on sparse data)');
  ok(!by(real.calls, 'liquidatePosition').some(l => l.accountId === SUBS[2].id), 'the HEALTHY secondary was NOT flattened');
  ok(events.some(e => e.accountId === SUBS[1].id && e.naked === true), 'flatten surfaced as a naked-divergence alert');
}

// ── run all ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(64));
  console.log('OrderMirror unit tests (mock client, no network)');
  console.log('═'.repeat(64));
  const tests = [
    testSingleAccountPassthrough,
    testEntryFanout,
    testOwnerOfOrder,
    testOcoAndModifyCancel,
    testLiquidate,
    testEntryDivergence,
    testNakedOcoFlatten,
    testModifyCancelAwaitsPendingPlacement,
    testOcoSkipsFlatSecondary,
    testReconcileSecondaries,
    testReconcileFlattensLeftover,
    testReconcileSparseHealthyNoChurn,
    testReconcileSparseUnprotectedFlattens,
  ];
  for (const t of tests) {
    try { await t(); }
    catch (e) { failures++; console.error(`  ✗ THREW in ${t.name}: ${e.stack || e.message}`); }
  }
  console.log('\n' + '─'.repeat(64));
  console.log(`${checks} checks, ${failures} failure(s)`);
  if (failures === 0) console.log('✅ ALL ORDERMIRROR TESTS PASSED');
  else console.log('❌ ORDERMIRROR TESTS FAILED');
  console.log('─'.repeat(64));
  process.exit(failures === 0 ? 0 : 1);
}

main();
