/**
 * The shared daily loss cap must be a HARD cap.
 *
 * Before this guard, dailyLossRemaining was display-only: canTrade() blocks
 * only once isHalted is set, and the halt is raised AFTER a trade closes. So
 * the cap stopped the NEXT trade rather than the one that breached it — and
 * with two instruments trading concurrently against one budget, both could open
 * full-size positions on a nearly-spent budget (realized -$200, two $150-risk
 * entries allowed, -$500 against a "$300 limit").
 *
 * A live probe on the server could not reach this code: the entry-cutoff check
 * fires first and blocked the test trade, proving nothing. Hence a unit test.
 */

process.env.LOG_DIR = process.env.LOG_DIR || './logs/test';

const assert = require('assert');
const SignalHandler = require('../src/bot/SignalHandler');

let passed = 0;
const ok = (n) => { console.log(`✓ ${n}`); passed++; };

function makeHandler({ dailyLossRemaining, siblingRisk = 0 }) {
  const h = new SignalHandler({
    client: { getCashBalance: async () => ({ cashBalance: 25000 }) },
    riskManager: {
      getContractSpecs: () => ({ tickSize: 0.25, tickValue: 0.5, pointValue: 2, commissionPerRT: 1.82 }),
      validateTrade: () => ({ valid: true }),
    },
    lossLimits: {
      canTrade: () => ({ allowed: true }),
      getStatus: () => ({ dailyLossRemaining, isHalted: false }),
    },
    sessionFilter: null,
    marketHours: { isMarketOpen: () => true, getStatus: () => ({ isOpen: true, open: true, message: 'open' }) },
    notifications: { send: async () => {} },
  }, { maxTradesPerDay: 3, profitTargetR: 2.5 });

  h.account = { id: 1 };
  h.contract = { id: 2, name: 'MNQU6' };
  h.getSiblingOpenRisk = () => siblingRisk;
  // Anything past the budget gate reaches the broker client; make that fail
  // loudly so a trade we expected REFUSED cannot quietly succeed.
  for (const m of ['placeMarketOrder', 'placeOrder', 'placeOCOOrder', 'placeOSO']) {
    h.client[m] = async () => { throw new Error('REACHED_ORDER_PATH despite the budget gate'); };
  }
  return h;
}

// 25pt stop x 2 contracts x $2 = $100 of risk.
const SIGNAL = { type: 'buy', price: 30000, stopLoss: 29975, targetPrice: 30100, quantity: 2 };

(async () => {
  // 1. Plenty of budget -> the gate must NOT be what stops it.
  {
    const h = makeHandler({ dailyLossRemaining: 300 });
    const r = await h.handleSignal({ ...SIGNAL });
    // Must reach the ORDER path (our throwing stub), proving it cleared the
    // gate — not merely fail somewhere earlier for an unrelated reason, which
    // is how this assertion passed spuriously on a bad mock.
    assert.ok(
      !(r.reason || '').includes('shared daily budget'),
      `budget gate fired with $300 available: ${r.reason}`
    );
    // Reaching the ORDER path proves it cleared the gate. An exception there
    // surfaces on r.error, not r.reason.
    const detail = r.reason || r.error?.message || '';
    assert.ok(
      /REACHED_ORDER_PATH/.test(detail) || r.executed,
      `expected to reach the order path with $300 available, got: ${detail}`
    );
    ok('a $100 trade clears the budget gate when $300 remains');
  }

  // 2. Not enough budget -> REFUSED. This is the case that used to slip through.
  {
    const h = makeHandler({ dailyLossRemaining: 30 });
    const r = await h.handleSignal({ ...SIGNAL });
    assert.strictEqual(r.executed, false, 'trade should not execute');
    assert.ok(r.blocked, 'should be flagged blocked');
    assert.match(r.reason, /shared daily budget/, `wrong reason: ${r.reason}`);
    assert.match(r.reason, /\$100\.00/, 'reason should state the risk it wanted');
    assert.match(r.reason, /\$30\.00/, 'reason should state what was left');
    ok('a $100 trade is REFUSED when only $30 of the shared budget remains');
  }

  // 3. Budget is fine on its own, but a SIBLING already has money at risk.
  //    This is the two-instrument case the guard exists for.
  {
    const h = makeHandler({ dailyLossRemaining: 150, siblingRisk: 100 });
    const r = await h.handleSignal({ ...SIGNAL });
    assert.strictEqual(r.executed, false, 'should not execute — only $50 of headroom');
    assert.match(r.reason, /already at risk/, `wrong reason: ${r.reason}`);
    ok('a trade is REFUSED when a sibling instrument has already committed the budget');
  }

  // 4. A guard that throws must REFUSE, never pass the trade through.
  {
    const h = makeHandler({ dailyLossRemaining: 300 });
    h.getSiblingOpenRisk = () => { throw new Error('registry unreadable'); };
    const r = await h.handleSignal({ ...SIGNAL });
    assert.strictEqual(r.executed, false, 'a failing guard must not let the trade through');
    assert.match(r.reason, /daily-budget check failed/, `wrong reason: ${r.reason}`);
    ok('a failing budget check refuses the trade rather than passing it');
  }

  console.log(`\n✅ All ${passed} budget-gate tests passed!`);
})().catch(err => { console.error('❌', err.message); process.exit(1); });
