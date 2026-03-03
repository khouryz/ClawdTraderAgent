/**
 * Low-R Sweep — Testing 2.5R and 3R targets for higher WR + more trades
 * 
 * Hypothesis: Lower R-multiple = closer target = higher fill rate = higher WR
 * Combined with $60 risk, looser filters to get more trades, and BE stop
 * to protect against reversals.
 *
 * Also tests: minTargetPoints reduction (current 50pt is very restrictive
 * at 3R — requires 16.7pt stop minimum. At 2.5R requires 20pt stop minimum.)
 */

const { runBacktest, loadData, getCurrentConfig, printRow, printDetailed } = require('../backtest/backtest_engine');

const STARTING_CAPITAL = 1000;

function survivalMetrics(result) {
  const trades = result.tradeList;
  if (!trades || trades.length === 0) return null;
  let equity = STARTING_CAPITAL, peak = STARTING_CAPITAL, maxDD = 0, minEq = STARTING_CAPITAL;
  let streakLoss = 0, maxStreakLoss = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
    if (equity < minEq) minEq = equity;
    if (t.pnl < -4) { streakLoss += Math.abs(t.pnl); if (streakLoss > maxStreakLoss) maxStreakLoss = streakLoss; }
    else streakLoss = 0;
  }
  return { finalEquity: equity, maxDD, minEquity: minEq, maxStreakLoss, returnPct: ((equity - STARTING_CAPITAL) / STARTING_CAPITAL * 100) };
}

function printSurvivalRow(label, r, s) {
  const pnl = r.totalPnl >= 0 ? `+$${r.totalPnl.toFixed(0)}` : `-$${Math.abs(r.totalPnl).toFixed(0)}`;
  const dd = s ? `-$${s.maxDD.toFixed(0)}` : 'N/A';
  const minEq = s ? `$${s.minEquity.toFixed(0)}` : 'N/A';
  const status = s && s.maxDD > 500 ? '💀' : (s && s.maxDD > 300 ? '⚠️' : '✅');
  console.log(
    `${status} ${label.padEnd(50)}| ${String(r.trades).padStart(4)} trades | ` +
    `WR ${r.winRate.toFixed(1).padStart(5)}% | PF ${r.profitFactor.toFixed(2).padStart(5)} | ` +
    `${pnl.padStart(8)} | DD ${dd.padStart(6)} | MinEq ${minEq.padStart(6)} | ` +
    `ConsecL ${r.maxConsecLosses} | ${r.tradesPerDay.toFixed(2)}/day`
  );
}

function main() {
  console.log('='.repeat(120));
  console.log('  LOW-R TARGET SWEEP — Higher WR + More Trades ($1,000 account, realistic slippage + commissions)');
  console.log('='.repeat(120));

  const base = getCurrentConfig();

  // ── Configs to test ──
  // Key insight: minTargetPoints=50 at R=3 requires stopDist >= 16.7pt
  //              minTargetPoints=50 at R=2.5 requires stopDist >= 20pt
  //              Lowering minTargetPoints opens up more trades with tighter stops
  const configs = [
    // Baselines
    { label: 'BASELINE: Current (R=5, risk=$65)', config: { ...base } },
    { label: 'BASELINE: R=5, risk=$60', config: { ...base, riskPerTradeMax: 60 } },

    // ── R=3 variants ──
    { label: 'R=3, risk=$60, minTgt=30', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 30 } },
    { label: 'R=3, risk=$60, minTgt=30, BE@1.5R', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 30, moveStopToBE: true, beActivationR: 1.5 } },
    { label: 'R=3, risk=$60, minTgt=30, BE@1.5R, 1loss/day', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 30, moveStopToBE: true, beActivationR: 1.5, maxLossesPerDay: 1 } },
    { label: 'R=3, risk=$60, minTgt=25, body=0.15', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 25, pbMinImpBodyRatio: 0.15 } },
    { label: 'R=3, risk=$60, minTgt=25, body=0.15, BE@1.5R', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 25, pbMinImpBodyRatio: 0.15, moveStopToBE: true, beActivationR: 1.5 } },
    { label: 'R=3, risk=$60, minTgt=25, ret=0.15-0.75', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 25, pbRetraceMin: 0.15, pbRetraceMax: 0.75 } },
    { label: 'R=3, risk=$60, minTgt=25, ret=0.15-0.75, BE@1.5R', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 25, pbRetraceMin: 0.15, pbRetraceMax: 0.75, moveStopToBE: true, beActivationR: 1.5 } },
    { label: 'R=3, risk=$60, minTgt=25, ret=0.15-0.75, body=0.15, BE@1.5R', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 25, pbRetraceMin: 0.15, pbRetraceMax: 0.75, pbMinImpBodyRatio: 0.15, moveStopToBE: true, beActivationR: 1.5 } },

    // ── R=2.5 variants ──
    { label: 'R=2.5, risk=$60, minTgt=25', config: { ...base, profitTargetR: 2.5, riskPerTradeMax: 60, minTargetPoints: 25 } },
    { label: 'R=2.5, risk=$60, minTgt=25, BE@1.2R', config: { ...base, profitTargetR: 2.5, riskPerTradeMax: 60, minTargetPoints: 25, moveStopToBE: true, beActivationR: 1.2 } },
    { label: 'R=2.5, risk=$60, minTgt=25, BE@1.2R, 1loss/day', config: { ...base, profitTargetR: 2.5, riskPerTradeMax: 60, minTargetPoints: 25, moveStopToBE: true, beActivationR: 1.2, maxLossesPerDay: 1 } },
    { label: 'R=2.5, risk=$60, minTgt=20, body=0.15', config: { ...base, profitTargetR: 2.5, riskPerTradeMax: 60, minTargetPoints: 20, pbMinImpBodyRatio: 0.15 } },
    { label: 'R=2.5, risk=$60, minTgt=20, body=0.15, BE@1.2R', config: { ...base, profitTargetR: 2.5, riskPerTradeMax: 60, minTargetPoints: 20, pbMinImpBodyRatio: 0.15, moveStopToBE: true, beActivationR: 1.2 } },
    { label: 'R=2.5, risk=$60, minTgt=20, ret=0.15-0.75, body=0.15', config: { ...base, profitTargetR: 2.5, riskPerTradeMax: 60, minTargetPoints: 20, pbRetraceMin: 0.15, pbRetraceMax: 0.75, pbMinImpBodyRatio: 0.15 } },
    { label: 'R=2.5, risk=$60, minTgt=20, ret=0.15-0.75, body=0.15, BE@1.2R', config: { ...base, profitTargetR: 2.5, riskPerTradeMax: 60, minTargetPoints: 20, pbRetraceMin: 0.15, pbRetraceMax: 0.75, pbMinImpBodyRatio: 0.15, moveStopToBE: true, beActivationR: 1.2 } },

    // ── R=3 with maxStop increase (more trades) ──
    { label: 'R=3, risk=$60, minTgt=25, maxStop=30, BE@1.5R', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 25, maxStopPoints: 30, moveStopToBE: true, beActivationR: 1.5 } },
    { label: 'R=3, risk=$60, minTgt=25, maxStop=30, ret=0.15-0.75, BE@1.5R', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 25, maxStopPoints: 30, pbRetraceMin: 0.15, pbRetraceMax: 0.75, moveStopToBE: true, beActivationR: 1.5 } },
    { label: 'R=3, risk=$60, minTgt=25, maxStop=30, ret=0.15-0.75, body=0.15, BE@1.5R', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 25, maxStopPoints: 30, pbRetraceMin: 0.15, pbRetraceMax: 0.75, pbMinImpBodyRatio: 0.15, moveStopToBE: true, beActivationR: 1.5 } },

    // ── R=3 with confluence=2 (more trades) ──
    { label: 'R=3, risk=$60, minTgt=25, conf=2, BE@1.5R', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 25, minConfluence: 2, moveStopToBE: true, beActivationR: 1.5 } },
    { label: 'R=3, risk=$60, minTgt=25, conf=2, ret=0.15-0.75, BE@1.5R', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 25, minConfluence: 2, pbRetraceMin: 0.15, pbRetraceMax: 0.75, moveStopToBE: true, beActivationR: 1.5 } },
    { label: 'R=3, risk=$60, minTgt=25, conf=2, ret=0.15-0.75, body=0.15, maxStop=30, BE@1.5R', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 25, minConfluence: 2, pbRetraceMin: 0.15, pbRetraceMax: 0.75, pbMinImpBodyRatio: 0.15, maxStopPoints: 30, moveStopToBE: true, beActivationR: 1.5 } },

    // ── Kitchen sink: max trades + low R + safety ──
    { label: 'R=3, risk=$60, minTgt=20, conf=2, ret=0.15-0.80, body=0.15, maxStop=30, BE@1.5R', config: { ...base, profitTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 20, minConfluence: 2, pbRetraceMin: 0.15, pbRetraceMax: 0.80, pbMinImpBodyRatio: 0.15, maxStopPoints: 30, moveStopToBE: true, beActivationR: 1.5 } },
    { label: 'R=2.5, risk=$60, minTgt=20, conf=2, ret=0.15-0.80, body=0.15, maxStop=30, BE@1.2R', config: { ...base, profitTargetR: 2.5, riskPerTradeMax: 60, minTargetPoints: 20, minConfluence: 2, pbRetraceMin: 0.15, pbRetraceMax: 0.80, pbMinImpBodyRatio: 0.15, maxStopPoints: 30, moveStopToBE: true, beActivationR: 1.2 } },

    // ── Same but with VR also at lower R ──
    { label: 'R=3, VR_R=3, risk=$60, minTgt=25, conf=2, BE@1.5R', config: { ...base, profitTargetR: 3, vrTargetR: 3, riskPerTradeMax: 60, minTargetPoints: 25, minConfluence: 2, moveStopToBE: true, beActivationR: 1.5 } },
  ];

  // Test on 3M, 6M, 12M
  const periods = [
    { label: '3M', start: '2025-11-20' },
    { label: '6M', start: '2025-08-20' },
    { label: '12M', start: '2025-02-20' },
  ];

  for (const period of periods) {
    console.log(`\n${'═'.repeat(120)}`);
    console.log(`  ${period.label} RESULTS ($${STARTING_CAPITAL} account)`);
    console.log(`${'═'.repeat(120)}`);

    const bars = loadData(period.start);
    console.log(`  (${bars.length} bars)\n`);

    for (const { label, config } of configs) {
      const r = runBacktest(bars, config);
      const s = survivalMetrics(r);
      printSurvivalRow(`${period.label} | ${label}`, r, s);
    }
  }

  // ── Find top 5 across all configs for 6M (balanced timeframe) ──
  console.log(`\n\n${'═'.repeat(120)}`);
  console.log('  TOP PERFORMERS — Ranked by (WR × PF × trades) / DD');
  console.log(`${'═'.repeat(120)}`);

  const bars6m = loadData('2025-08-20');
  const scored = [];
  for (const { label, config } of configs) {
    const r = runBacktest(bars6m, config);
    const s = survivalMetrics(r);
    if (!s || r.trades < 10) continue;
    // Score: prioritize WR, PF, trade count; penalize DD
    const score = (r.winRate / 100) * r.profitFactor * Math.sqrt(r.trades) / Math.max(s.maxDD / STARTING_CAPITAL, 0.01);
    scored.push({ label, r, s, score });
  }
  scored.sort((a, b) => b.score - a.score);

  console.log('\n  Rank | Score | Config');
  console.log('  ' + '-'.repeat(115));
  for (let i = 0; i < Math.min(10, scored.length); i++) {
    const { label, r, s, score } = scored[i];
    console.log(`  #${i+1}  | ${score.toFixed(2).padStart(6)} |`);
    printSurvivalRow(`     ${label}`, r, s);
  }

  // ── Detailed view of #1 ──
  if (scored.length > 0) {
    const best = scored[0];
    // Run on all timeframes
    console.log(`\n\n${'═'.repeat(120)}`);
    console.log(`  DETAILED — #1: ${best.label}`);
    console.log(`${'═'.repeat(120)}`);

    for (const period of periods) {
      const bars = loadData(period.start);
      const r = runBacktest(bars, best.r.config || configs.find(c => c.label === best.label)?.config);
      if (r) {
        printDetailed(`${period.label}`, r);
        const s = survivalMetrics(r);
        if (s) {
          console.log(`  $1000 Account: Final=$${s.finalEquity.toFixed(0)} | MaxDD=-$${s.maxDD.toFixed(0)} (${(s.maxDD/STARTING_CAPITAL*100).toFixed(1)}%) | Min=$${s.minEquity.toFixed(0)} | WorstStreak=-$${s.maxStreakLoss.toFixed(0)}`);
        }
      }
    }
  }

  console.log('\n✅ Low-R sweep complete');
}

main();
