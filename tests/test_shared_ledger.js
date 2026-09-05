/**
 * Shared risk-ledger concurrency tests.
 *
 * With one bot process per instrument (MES and MNQ) sharing ONE daily loss
 * budget, recordTrade() is a read-modify-write across processes. Unguarded,
 * both read -$100, both write -$150, and $100 of loss disappears from the cap
 * that exists to stop you trading. These tests spawn real child processes,
 * because an in-process test cannot reproduce that race at all.
 */

process.env.LOG_DIR = process.env.LOG_DIR || './logs/test';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const LossLimits = require('../src/risk/loss_limits');

// ── child mode ───────────────────────────────────────────────────────────────
// Re-runs this same file as a worker so the race is between real OS processes.
if (process.env.LEDGER_CHILD === '1') {
  const dir = process.env.LEDGER_DIR;
  const tag = process.env.LEDGER_TAG;
  const n = parseInt(process.env.LEDGER_N, 10);
  const ll = new LossLimits({ dailyLossLimit: 100000, weeklyLossLimit: 100000, dataDir: dir, lossLimitsDir: dir });
  for (let i = 0; i < n; i++) {
    ll.recordTrade(1, { symbol: tag, quantity: 1, tradeId: `${tag}-${i}` });
  }
  process.exit(0);
}

// ── helpers ──────────────────────────────────────────────────────────────────
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
}

function readState(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'loss_limits_state.json'), 'utf8'));
}

function runChildren(dir, specs) {
  return Promise.all(specs.map(({ tag, n }) => new Promise((resolve, reject) => {
    const child = fork(__filename, [], {
      env: { ...process.env, LEDGER_CHILD: '1', LEDGER_DIR: dir, LEDGER_TAG: tag, LEDGER_N: String(n) },
      stdio: process.env.LEDGER_DEBUG ? 'inherit' : 'ignore',
    });
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${tag} exited ${code}`)));
    child.on('error', reject);
  })));
}

let passed = 0;
function ok(name) { console.log(`✓ ${name}`); passed++; }

// ── tests ────────────────────────────────────────────────────────────────────
async function main() {
  // 1. Concurrent writers must not lose a single trade.
  {
    const dir = tmpDir();
    // Contention has to be high enough to catch a lock that only mostly works.
    // At 30 each, a Windows EPERM lock-acquisition bug slipped through 4 runs
    // in 5; at 75 it shows up far more reliably.
    const perChild = 75;
    await runChildren(dir, [{ tag: 'MNQ', n: perChild }, { tag: 'MES', n: perChild }, { tag: 'MYM', n: perChild }]);
    const st = readState(dir);
    assert.strictEqual(
      st.dailyPnL, perChild * 3,
      `lost updates: dailyPnL ${st.dailyPnL}, expected ${perChild * 3} — the lock is not holding`
    );
    assert.strictEqual(st.tradesToday, perChild * 3, 'trade count lost updates');
    ok(`three processes x ${perChild} trades: no lost updates (dailyPnL ${st.dailyPnL})`);
  }

  // 2. One process must SEE what the other recorded, or it trades against a
  //    budget that is already spent.
  {
    const dir = tmpDir();
    await runChildren(dir, [{ tag: 'MES', n: 10 }]);
    const mine = new LossLimits({ dailyLossLimit: 100000, dataDir: dir, lossLimitsDir: dir });
    // Simulate this process having been started before the sibling traded.
    mine.state.dailyPnL = 0;
    const seen = mine.getStatus().dailyPnL;
    assert.strictEqual(seen, 10, `stale read: saw ${seen}, sibling had recorded 10`);
    ok('sibling P&L is visible to the other process on a fresh read');
  }

  // 3. A halt raised by one process must stop the other.
  {
    const dir = tmpDir();
    const a = new LossLimits({ dailyLossLimit: 100000, dataDir: dir, lossLimitsDir: dir });
    // Record a trade FIRST so lastTradeDate is today. Without it the ledger
    // looks like a fresh day to the next process, which then correctly clears
    // the daily halt — right behaviour, wrong test.
    a.recordTrade(-1, { symbol: 'MES', quantity: 1, tradeId: 'halt-setup' });
    a.halt('DAILY_LOSS_LIMIT', 'test halt');
    const b = new LossLimits({ dailyLossLimit: 100000, dataDir: dir, lossLimitsDir: dir });
    b.state.isHalted = false;             // pretend b never saw it
    const res = b.canTrade();
    assert.ok(!res.allowed, 'sibling halt did not stop the other process');
    ok('a halt in one process blocks trading in the other');
  }

  // 4. A stale lock from a crashed process must not deadlock the ledger.
  {
    const dir = tmpDir();
    const ll = new LossLimits({ dailyLossLimit: 100000, dataDir: dir, lossLimitsDir: dir });
    fs.writeFileSync(ll.lockFilePath, '');
    // Age it past the 10s staleness window.
    const old = new Date(Date.now() - 60000);
    fs.utimesSync(ll.lockFilePath, old, old);
    const t0 = Date.now();
    ll.recordTrade(5, { symbol: 'MNQ', quantity: 1, tradeId: 'stale-1' });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 4000, `stale lock blocked for ${elapsed}ms — should be broken immediately`);
    assert.strictEqual(readState(dir).dailyPnL, 5, 'trade lost while breaking a stale lock');
    assert.ok(!fs.existsSync(ll.lockFilePath), 'lock file left behind');
    ok(`stale lock broken and trade recorded (${elapsed}ms)`);
  }

  console.log(`\n✅ All ${passed} shared-ledger tests passed!`);
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
