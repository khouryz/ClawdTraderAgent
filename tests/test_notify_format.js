/**
 * Notification wording tests.
 *
 * These messages are the only thing the operator sees when away from the
 * screen, so a wrong or self-contradictory one is a real defect — two were
 * caught this way before shipping ("risk now ZERO" printed next to "total open
 * risk $81", and a filled target still listed as "still working").
 *
 * Run: node tests/test_notify_format.js
 */

const assert = require('assert');
const NF = require('../src/utils/notify_format');

const strip = (s) => s.replace(/<[^>]+>/g, '');
const PV = 2; // MNQ $/point

function shortPos(overrides = {}) {
  return {
    side: 'Sell', quantity: 2, entryPrice: 29231.75, stopLoss: 29252, target: 29094.5,
    bracketLegs: [
      { orderId: 1, ocoId: 2, qty: 1, targetPrice: 29094.5, stopPrice: 29252 },
      { orderId: 3, ocoId: 4, qty: 1, targetPrice: 29012.25, stopPrice: 29252 },
    ],
    ...overrides,
  };
}

// ── identity: never make the reader resolve an order id ──────────────

function testDescribeOrderNamesTheLeg() {
  const p = shortPos();
  const stopLeg2 = NF.describeOrder(3, p);
  assert.strictEqual(stopLeg2.role, 'stop');
  assert.strictEqual(stopLeg2.legNo, 2);
  assert.strictEqual(stopLeg2.legCount, 2);

  const targetLeg1 = NF.describeOrder(2, p);
  assert.strictEqual(targetLeg1.role, 'target');
  assert.strictEqual(targetLeg1.legNo, 1);

  const unknown = NF.describeOrder(9999, p);
  assert.strictEqual(unknown.role, 'order', 'unknown ids must degrade gracefully');
  console.log('✓ describeOrder names the leg and role');
}

function testLegLabelHiddenWhenSingleLeg() {
  const single = { bracketLegs: [{ orderId: 1, ocoId: 2, qty: 2, targetPrice: 29094.5 }] };
  assert.strictEqual(NF.legLabel(NF.describeOrder(1, single)), '', 'no "leg 1 of 1" noise');
  assert.match(NF.legLabel(NF.describeOrder(3, shortPos())), /leg 2 of 2/);
  console.log('✓ leg label only appears when there is more than one leg');
}

// ── every target, not just T1 ────────────────────────────────────────

function testTargetListShowsAllTargets() {
  const out = NF.targetList(shortPos());
  assert.match(out, /T1 29094\.50/);
  assert.match(out, /T2 29012\.25/, 'must list EVERY target, not just the first');
  console.log('✓ target list shows all targets');
}

function testTargetListExcludesFilledLegs() {
  const p = shortPos();
  p.bracketLegs[0].filled = true;
  const out = NF.targetList(p);
  assert.ok(!/T1 29094\.50/.test(out), 'a filled target must not be advertised as working');
  assert.match(out, /T2 29012\.25/);

  p.bracketLegs[1].filled = true;
  assert.match(NF.targetList(p), /all targets filled/);
  console.log('✓ target list drops legs already filled');
}

// ── risk maths, signed from the trader's point of view ───────────────

function testOpenRiskSignsAndExclusions() {
  const p = shortPos();
  // both legs 20.25pt away, 1 contract each, $2/pt => $40.50 each
  assert.ok(Math.abs(NF.openRisk(p, PV) - 81) < 0.01, 'full risk on both legs');

  p.bracketLegs[0].filled = true;
  assert.ok(Math.abs(NF.openRisk(p, PV) - 40.5) < 0.01, 'filled legs are no longer at risk');

  // short with stop BELOW entry = locked-in profit, must be negative
  const locked = shortPos({ bracketLegs: [{ orderId: 1, ocoId: 2, qty: 2, targetPrice: 29012.25, stopPrice: 29200 }] });
  assert.ok(NF.openRisk(locked, PV) < 0, 'a stop past breakeven is locked profit, not risk');

  // long direction
  const longPos = { side: 'Buy', quantity: 1, entryPrice: 100, stopLoss: 90, bracketLegs: [] };
  assert.strictEqual(NF.openRisk(longPos, 1), 10);
  console.log('✓ open risk is signed correctly and skips filled legs');
}

// ── stop moved: the headline is the risk, not the price ──────────────

function testStopMovedToBreakevenSaysZeroRiskOnce() {
  const p = shortPos();
  p.bracketLegs[1].stopPrice = 29231.75;   // leg 2 to BE
  p.bracketLegs[0].filled = true;          // leg 1 already took profit
  const msg = strip(NF.stopMoved({
    symbol: 'MNQ', position: p, from: 29252, to: 29231.75,
    desc: NF.describeOrder(3, p), pointValue: PV,
  }));
  assert.match(msg, /29252\.00 → 29231\.75/, 'must show the change, not just the new value');
  assert.match(msg, /breakeven/);
  // The bug this guards: "Risk now ZERO" printed above "Total open risk $81".
  assert.ok(!/Total still at risk/.test(msg), 'must not contradict the zero-risk line');
  console.log('✓ BE stop move states zero risk once, without contradiction');
}

function testStopMovedPastBreakevenReportsLockedProfit() {
  const p = shortPos({ bracketLegs: [{ orderId: 1, ocoId: 2, qty: 2, targetPrice: 29012.25, stopPrice: 29200 }] });
  const msg = strip(NF.stopMoved({
    symbol: 'MNQ', position: p, from: 29231.75, to: 29200,
    desc: NF.describeOrder(1, p), pointValue: PV,
  }));
  assert.match(msg, /Locked in/, 'past BE is locked profit, not risk');
  assert.ok(!/Risk now/.test(msg));
  console.log('✓ stop past breakeven reports locked profit');
}

function testStopMovedStillAtRiskShowsDollars() {
  const p = shortPos();
  p.bracketLegs[1].stopPrice = 29245;
  const msg = strip(NF.stopMoved({
    symbol: 'MNQ', position: p, from: 29252, to: 29245,
    desc: NF.describeOrder(3, p), pointValue: PV,
  }));
  assert.match(msg, /Risk now 13\.25pt/);
  assert.match(msg, /\$26\.50/, 'risk must be given in money, not only points');
  console.log('✓ stop move reports remaining risk in points and dollars');
}

// ── lifecycle ───────────────────────────────────────────────────────

function testSetupArmedCarriesEverythingNeededToJudgeIt() {
  const msg = strip(NF.setupArmed({
    symbol: 'MNQ', side: 'Sell', entry: 29232, stop: 29252,
    exits: [{ qty: 1, targetPrice: 29094.5 }, { qty: 1, targetPrice: 29012.25 }],
    qty: 2, pointValue: PV, timeoutSec: 900, orderType: 'Stop',
  }));
  assert.match(msg, /Setup armed/);
  assert.match(msg, /SHORT/);
  assert.match(msg, /fills only if price trades through it/, 'must say it is resting, not filled');
  assert.match(msg, /Stop {2}29252\.00/);
  assert.match(msg, /-\$80/, 'risk must be in money');
  assert.match(msg, /T1 {2}1 @ 29094\.50 {3}\+\$275 {2}\(6\.9R\)/, 'per-leg reward in dollars AND R');
  assert.match(msg, /T2 {2}1 @ 29012\.25/);
  assert.match(msg, /Max reward \$715 vs \$80 risk/, 'total must come from the real legs, not risk x 2.5');
  assert.match(msg, /15m/);
  console.log('✓ setup-armed message carries direction, level, risk, R and expiry');
}

function testFilledDoesNotRepeatTheArmedTable() {
  // The "armed" message already carried the full table. When the fill lands
  // where it was supposed to, repeating it verbatim is noise — observed on the
  // 2 Sep scalp, where "armed" and "filled" were identical below the headline.
  const p = shortPos({ side: 'Buy', entryPrice: 29184.25, stopLoss: 29172.75,
    bracketLegs: [
      { orderId: 1, ocoId: 2, qty: 1, targetPrice: 29196, stopPrice: 29172.75 },
      { orderId: 3, ocoId: 4, qty: 1, targetPrice: 29211.75, stopPrice: 29172.75 },
    ] });
  const clean = strip(NF.positionOpened({
    symbol: 'MNQ', side: 'Buy', qty: 2, fillPrice: 29184.25, stop: 29172.75,
    position: p, pointValue: PV, slippage: 0,
  }));
  assert.match(clean, /Brackets live as planned/);
  assert.ok(!/\+\$24/.test(clean), 'no per-leg table when nothing moved');
  assert.ok(clean.split(String.fromCharCode(10)).length <= 3, 'a clean fill is a 3-line confirmation');

  // Slippage DID move the maths — the table must come back, recalculated.
  const slipped = strip(NF.positionOpened({
    symbol: 'MNQ', side: 'Buy', qty: 2, fillPrice: 29180, stop: 29172.75,
    position: p, pointValue: PV, slippage: -4.25,
  }));
  assert.match(slipped, /Slippage moved the maths/);
  assert.match(slipped, /T1 {2}1 @ 29196\.00/, 'table returns when numbers changed');
  console.log('✓ filled message stays short unless slippage moved the numbers');
}

function testBotOfflineWarnsWhenNotFlat() {
  const clean = strip(NF.botOffline({ reason: 'Shutting down cleanly', flat: true, workingOrders: 0 }));
  assert.match(clean, /Flat, no open orders/);

  const dirty = strip(NF.botOffline({ reason: 'Shutting down cleanly', flat: false, workingOrders: 4 }));
  assert.match(dirty, /NOT FLAT/, 'leaving orders behind is the thing worth shouting about');
  assert.match(dirty, /4 order/);
  console.log('✓ offline message says whether you are still exposed');
}

function testBotOnlineFlagsUncleanRestart() {
  const ok = strip(NF.botOnline({
    symbol: 'MNQU6', env: 'demo', windowStart: '06:30', windowEnd: '13:00', entryCutoff: '12:30',
    tradesToday: 0, maxTrades: 3, lossBudget: 300, uncleanRestart: false, openPosition: null,
  }));
  assert.ok(!/not clean/.test(ok));

  const bad = strip(NF.botOnline({
    symbol: 'MNQU6', env: 'demo', windowStart: '06:30', windowEnd: '13:00', entryCutoff: '12:30',
    tradesToday: 1, maxTrades: 3, lossBudget: 220, uncleanRestart: true,
    openPosition: { side: 'Sell', quantity: 2, entryPrice: 29231.75 },
  }));
  assert.match(bad, /not clean/, 'a crash or sleep must be surfaced on the next start');
  assert.match(bad, /Re-adopted an open position/);
  assert.match(bad, /1\/3 trades/);
  console.log('✓ online message flags unclean restarts and adopted positions');
}

function testPartialExitDoesNotRelistTheFilledTarget() {
  const p = shortPos();
  p.bracketLegs[0].filled = true;
  const msg = strip(NF.partialExit({
    symbol: 'MNQ', position: p, legNo: 1, qty: 1, price: 29094.5,
    pnlUsd: 274.5, pnlPts: 137.25, remainingQty: 1, stopNow: null, movingToBE: true,
  }));
  assert.match(msg, /T1 hit/);
  assert.match(msg, /\+137\.25pt/);
  assert.match(msg, /moving stop to breakeven/);
  assert.match(msg, /Still working: T2 29012\.25/);
  assert.ok(!/Still working:.*T1/.test(msg), 'the target that just filled must not be listed as working');
  console.log('✓ partial exit lists only the targets still live');
}

function testStopOutNeverReadsAsATargetHit() {
  // Observed live 2 Sep: a stop fill was labelled "T1" and rendered as
  // "🎯 T1 hit" on a LOSING trade. Good news wording for a loss.
  const p = shortPos();
  const msg = strip(NF.partialStopOut({
    symbol: 'MNQ', position: p, qty: 1, price: 29165.25,
    pnlUsd: -29.5, pnlPts: -14.75, remainingQty: 1,
  }));
  assert.match(msg, /Stopped out/, 'must say stopped out');
  assert.ok(!/T1 hit/.test(msg), 'a stop-out must never render as a target hit');
  assert.ok(!/🎯/.test(msg), 'no target emoji on a loss');
  assert.match(msg, /-\$29\.50/);
  assert.match(msg, /stop unchanged/, 'the remaining stop must NOT be described as moved');
  console.log('✓ stop-out never reads as a target hit');
}

function testPositionClosedCarriesDayState() {
  const msg = strip(NF.positionClosed({
    symbol: 'MNQ', position: shortPos(), qty: 2, avgExit: 29053,
    pnlUsd: 715, pnlPts: 178.75, rMult: 4.4, reason: 'Both targets hit',
    dayTrades: 1, maxTrades: 3, dayPnl: 715, lossBudgetLeft: 300,
  }));
  assert.match(msg, /4\.40R/);
  assert.match(msg, /1\/3 trades/, 'must say how much of the day budget is gone');
  assert.match(msg, /loss budget left/);
  console.log('✓ closed message carries R and remaining day budget');
}

function testPositionClosedWithPerLegBreakdown() {
  // T1 target hit, then T2 stopped out — the message must show each leg.
  const msg = strip(NF.positionClosed({
    symbol: 'MNQ', position: shortPos(), qty: 2, avgExit: 29133,
    pnlUsd: 197, pnlPts: 49.25, rMult: 1.22, reason: 'T1 target, T2 stopped',
    dayTrades: 1, maxTrades: 3, dayPnl: 197, lossBudgetLeft: 300,
    legs: [
      { kind: 'target', legNo: 1, qty: 1, price: 29094.5, pnl: 274.5 },
      { kind: 'stop', legNo: 2, qty: 1, price: 29172.75, pnl: -77.5 },
    ],
  }));
  assert.match(msg, /T1 hit/, 'must label the target leg');
  assert.match(msg, /T2 stopped/, 'must label the stop leg');
  assert.match(msg, /\+\$275/, 'T1 pnl must show');
  assert.match(msg, /-\$77\.50/, 'T2 pnl must show');
  assert.match(msg, /1\.22R/, 'total R must still show');
  console.log('✓ closed message shows per-leg breakdown when legs differ');
}

function testPositionClosedNoBreakdownWhenSamePrice() {
  // Both legs stopped at the same price — no per-leg breakdown, just the total.
  const msg = strip(NF.positionClosed({
    symbol: 'MNQ', position: shortPos(), qty: 2, avgExit: 29252,
    pnlUsd: -80, pnlPts: -20.25, rMult: -0.5, reason: 'Stopped out',
    dayTrades: 1, maxTrades: 3, dayPnl: -80, lossBudgetLeft: 220,
    legs: [
      { kind: 'stop', legNo: 1, qty: 1, price: 29252, pnl: -40 },
      { kind: 'stop', legNo: 2, qty: 1, price: 29252, pnl: -40 },
    ],
  }));
  assert.ok(!/T1 stopped/.test(msg), 'same-price legs must not get a per-leg breakdown');
  assert.match(msg, /-\$80/, 'total must still show');
  console.log('✓ closed message skips breakdown when legs filled at same price');
}

function testEntryRejectedSaysBudgetRefunded() {
  const msg = strip(NF.entryRejected({
    symbol: 'MNQ', side: 'Sell', reason: 'stop too close to market', tradesToday: 0, maxTrades: 3,
  }));
  assert.match(msg, /rejected/i);
  assert.match(msg, /stop too close to market/, 'the reason must be verbatim, not a code');
  assert.match(msg, /refunded/);
  console.log('✓ rejection message gives the reason and confirms the refund');
}

function testNoNaNsOrUndefinedLeakIntoAnyMessage() {
  // Missing/garbage data must degrade to "—", never print NaN or undefined.
  const bare = { side: 'Buy', quantity: 1 };
  const msgs = [
    NF.positionOpened({ symbol: 'MNQ', side: 'Buy', qty: 1, fillPrice: NaN, stop: undefined, position: bare, pointValue: PV }),
    NF.stopMoved({ symbol: 'MNQ', position: bare, from: undefined, to: NaN, desc: NF.describeOrder(1, bare), pointValue: PV }),
    NF.targetList(bare),
    NF.positionClosed({ symbol: 'MNQ', position: bare, qty: 1, avgExit: undefined, pnlUsd: NaN, pnlPts: null, rMult: null, reason: '', dayTrades: 0, maxTrades: 3, dayPnl: null, lossBudgetLeft: undefined }),
  ];
  for (const m of msgs) {
    assert.ok(!/NaN/.test(m), `NaN leaked: ${m}`);
    assert.ok(!/undefined/.test(m), `undefined leaked: ${m}`);
  }
  console.log('✓ missing data degrades to "—" without leaking NaN/undefined');
}

async function main() {
  testDescribeOrderNamesTheLeg();
  testLegLabelHiddenWhenSingleLeg();
  testTargetListShowsAllTargets();
  testTargetListExcludesFilledLegs();
  testOpenRiskSignsAndExclusions();
  testStopMovedToBreakevenSaysZeroRiskOnce();
  testStopMovedPastBreakevenReportsLockedProfit();
  testStopMovedStillAtRiskShowsDollars();
  testSetupArmedCarriesEverythingNeededToJudgeIt();
  testFilledDoesNotRepeatTheArmedTable();
  testBotOfflineWarnsWhenNotFlat();
  testBotOnlineFlagsUncleanRestart();
  testPartialExitDoesNotRelistTheFilledTarget();
  testStopOutNeverReadsAsATargetHit();
  testPositionClosedCarriesDayState();
  testPositionClosedWithPerLegBreakdown();
  testPositionClosedNoBreakdownWhenSamePrice();
  testEntryRejectedSaysBudgetRefunded();
  testNoNaNsOrUndefinedLeakIntoAnyMessage();
  console.log('\n✅ All notification tests passed!');
}

main().catch((err) => { console.error('\n❌ FAILED:', err.message); process.exit(1); });
