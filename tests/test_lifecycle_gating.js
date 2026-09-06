/**
 * The daily lifecycle used to fire on every calendar day. On Sunday 6 Sep the
 * bots announced "New trading day - execution bot reset" and, at session end,
 * "Bot off for the day. Resumes tomorrow 6:30 AM PST" — on a closed market, and
 * twice each because both instruments send independently.
 *
 * Routine noise on a day nothing can happen is not harmless: it trains you to
 * ignore the identical message on a day that matters.
 */
process.env.LOG_DIR = process.env.LOG_DIR || './logs/test';
process.env.DATA_DIR = './data/test-lifecycle';
process.env.LOSS_LIMITS_DIR = './data/test-lifecycle';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ExecutionBot = require('../src/bot/ExecutionBot');
const MarketHours = require('../src/utils/market_hours');

const DIR = process.env.LOSS_LIMITS_DIR;
fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

let passed = 0;
const ok = (n) => { console.log(`✓ ${n}`); passed++; };

const MH = MarketHours.MarketHours || MarketHours;
function botAt(iso) {
  const fixed = new Date(iso);
  const mh = (typeof MH === 'function') ? new MH('America/Los_Angeles') : MH;
  return {
    config: { timezone: 'America/Los_Angeles' },
    marketHours: { getNow: () => fixed, isHoliday: (d) => mh.isHoliday(d) },
    _isTradingDayNow: ExecutionBot.prototype._isTradingDayNow,
    _isAnnouncer: ExecutionBot.prototype._isAnnouncer,
  };
}

(async () => {
  // Sunday — the day that produced the noise.
  assert.strictEqual(botAt('2026-09-06T12:00:00-07:00')._isTradingDayNow(), false);
  ok('Sunday is not a trading day');

  assert.strictEqual(botAt('2026-09-05T12:00:00-07:00')._isTradingDayNow(), false);
  ok('Saturday is not a trading day');

  // Labor Day — a weekday the market is shut.
  assert.strictEqual(botAt('2026-09-07T12:00:00-07:00')._isTradingDayNow(), false);
  ok('Labor Day (a Monday) is not a trading day');

  assert.strictEqual(botAt('2026-09-08T12:00:00-07:00')._isTradingDayNow(), true);
  ok('Tuesday 8 Sep IS a trading day');

  // A broken calendar must never silence a real alert.
  {
    const b = botAt('2026-09-08T12:00:00-07:00');
    b.marketHours = { getNow: () => { throw new Error('boom'); }, isHoliday: () => { throw new Error('boom'); } };
    b.config = null;
    assert.strictEqual(b._isTradingDayNow(), true, 'must fail OPEN, not silent');
    ok('a calendar error fails open (alerts still send)');
  }

  // Single announcer: only the poller-lock holder speaks for the account.
  {
    const lock = path.join(DIR, '.telegram_poller.lock');
    const b = botAt('2026-09-08T12:00:00-07:00');

    fs.writeFileSync(lock, String(process.pid));
    assert.strictEqual(b._isAnnouncer(), true, 'lock holder should announce');
    ok('the poller-lock holder is the announcer');

    fs.writeFileSync(lock, '999999');
    assert.strictEqual(b._isAnnouncer(), false, 'non-holder must stay quiet');
    ok('the other instrument stays quiet (no duplicate messages)');

    fs.rmSync(lock, { force: true });
    assert.strictEqual(b._isAnnouncer(), true, 'unknown owner must not silence');
    ok('an unreadable lock fails open — a duplicate beats a missing alert');
  }

  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n✅ All ${passed} lifecycle-gating tests passed!`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
