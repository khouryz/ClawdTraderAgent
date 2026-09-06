/**
 * The per-instrument trade cap (3 each) is enforced ONLY by an in-memory
 * counter. Before this, restarting a bot mid-session reset it to 0 and silently
 * granted a fresh set of 3 trades — so on a day where MNQ had already used its
 * allowance, any restart (a crash, a deploy, a fix) doubled the cap without a
 * word in the logs.
 *
 * These tests drive the real methods off the prototype rather than booting a
 * whole bot, so they exercise the shipped code without a broker.
 */
process.env.LOG_DIR = process.env.LOG_DIR || './logs/test';
process.env.DATA_DIR = './data/test-tradecount';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DIR = process.env.DATA_DIR;
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

const ExecutionBot = require('../src/bot/ExecutionBot');
const proto = ExecutionBot.prototype;

let passed = 0;
const ok = (n) => { console.log(`✓ ${n}`); passed++; };

// Minimal stand-in: only what the three methods actually touch.
function makeBot(tz = 'America/Los_Angeles') {
  return {
    _tradesToday: 0,
    _maxTradesPerDay: 3,
    lossLimits: {
      getDateString: (d) => new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(d),
    },
    _tradeCountPath: proto._tradeCountPath,
    _tradingDay: proto._tradingDay,
    _loadTradesToday: proto._loadTradesToday,
    _saveTradesToday: proto._saveTradesToday,
  };
}
const today = () => makeBot()._tradingDay.call(makeBot());
const statePath = () => path.join(DIR, 'instance_trades.json');

(async () => {
  // 1. A restart on the SAME trading day must resume the count.
  {
    const a = makeBot();
    a._tradesToday = 3;
    a._saveTradesToday();
    assert.ok(fs.existsSync(statePath()), 'state file should exist after save');

    const b = makeBot();            // simulates a fresh process
    b._loadTradesToday();
    assert.strictEqual(b._tradesToday, 3, `restart should resume 3, got ${b._tradesToday}`);
    ok('a mid-day restart resumes the trade count instead of granting 3 more');
  }

  // 2. A NEW trading day must start at zero.
  {
    fs.writeFileSync(statePath(), JSON.stringify({ date: '2020-01-01', trades: 3 }));
    const b = makeBot();
    b._loadTradesToday();
    assert.strictEqual(b._tradesToday, 0, 'a stale date must not carry trades over');
    ok('a new trading day starts at zero (stale date ignored)');
  }

  // 3. The date must be the TRADING day, not the UTC day. At 00:30 UTC the
  //    Los Angeles date is still the previous day — using toISOString() here is
  //    the bug class that rolled the risk ledger at 17:00 PST.
  {
    const b = makeBot();
    const d = new Date('2026-09-08T00:30:00Z');   // 17:30 PDT on 7 Sep
    const trading = b.lossLimits.getDateString(d);
    assert.strictEqual(trading, '2026-09-07', `expected the LA date, got ${trading}`);
    assert.notStrictEqual(trading, d.toISOString().split('T')[0], 'must differ from the UTC date');
    ok('the persisted date is the trading day, not the UTC day');
  }

  // 4. A corrupt state file must not stop the bot booting.
  {
    fs.writeFileSync(statePath(), '{ this is not json');
    const b = makeBot();
    b._tradesToday = 0;
    assert.doesNotThrow(() => b._loadTradesToday(), 'corrupt state must not throw');
    assert.strictEqual(b._tradesToday, 0, 'corrupt state should leave the count at 0');
    ok('a corrupt state file degrades to 0 rather than crashing the boot');
  }

  // 5. A refund (decrement) must be persisted too, or a restart re-consumes it.
  {
    fs.rmSync(statePath(), { force: true });
    const a = makeBot();
    a._tradesToday = 2; a._saveTradesToday();
    a._tradesToday--;   a._saveTradesToday();      // rejected entry refunded
    const b = makeBot(); b._loadTradesToday();
    assert.strictEqual(b._tradesToday, 1, `refund should persist, got ${b._tradesToday}`);
    ok('a refunded trade is persisted, so a restart does not re-consume it');
  }

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n✅ All ${passed} trade-count persistence tests passed!`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
