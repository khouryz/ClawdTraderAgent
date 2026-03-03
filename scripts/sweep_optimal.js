/**
 * Targeted Sweep — Find optimal config for:
 *   - Max P&L with min DD%
 *   - High win rate (>40%)
 *   - 1-2 trades/day frequency
 *   - 1 trade at a time
 *
 * Tests maxStopPoints=32 + deeper pullbacks as requested,
 * plus a broader sweep around the most impactful parameters.
 */

const { runBacktest, loadData, getCurrentConfig, printRow, printDetailed } = require('../backtest/backtest_engine');

// ═══════════════════════════════════════════════════════════════
//  HELPER
// ═══════════════════════════════════════════════════════════════

function cartesian(grid) {
  const sweepKeys = [], sweepVals = [], fixed = {};
  for (const [k, v] of Object.entries(grid)) {
    if (Array.isArray(v)) { sweepKeys.push(k); sweepVals.push(v); }
    else fixed[k] = v;
  }
  const configs = [];
  const indices = new Array(sweepKeys.length).fill(0);
  while (true) {
    const obj = { ...fixed };
    for (let i = 0; i < sweepKeys.length; i++) obj[sweepKeys[i]] = sweepVals[i][indices[i]];
    configs.push(obj);
    let carry = true;
    for (let i = indices.length - 1; i >= 0 && carry; i--) {
      indices[i]++;
      if (indices[i] < sweepVals[i].length) carry = false;
      else indices[i] = 0;
    }
    if (carry) break;
  }
  return configs;
}

function rankScore(r) {
  // Composite score: maximize P&L per trade, WR, PF; minimize DD and consec losses
  // Weight WR heavily since user wants high WR
  const wrScore = r.winRate / 100;                    // 0-1
  const pfScore = Math.min(r.profitFactor / 10, 1);   // 0-1, cap at PF 10
  const ddPenalty = Math.min(r.maxDD / 100, 1);       // 0-1
  const pnlScore = Math.min(r.totalPnl / 5000, 1);    // 0-1, cap at $5k
  const freqScore = Math.min(r.tradesPerDay / 2, 1);   // 0-1, cap at 2/day
  const consecPenalty = Math.min(r.maxConsecLosses / 20, 1); // 0-1

  return (wrScore * 3 + pfScore * 2 + pnlScore * 2 + freqScore * 1) - (ddPenalty * 2 + consecPenalty * 1);
}

// ═══════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  const base = getCurrentConfig();

  // ── PHASE 1: Quick A/B test — current vs user-requested changes ──
  console.log('\n' + '='.repeat(70));
  console.log('  PHASE 1: A/B TEST — Current vs maxStop=32 + deeper pullbacks');
  console.log('='.repeat(70));

  const bars6m = loadData('2025-08-20');
  const bars3m = loadData('2025-11-20');
  const bars12m = loadData('2025-02-20');
  console.log(`  6M: ${bars6m.length} bars | 3M: ${bars3m.length} bars | 12M: ${bars12m.length} bars\n`);

  const variants = [
    { label: 'Current (baseline)',       config: { ...base } },
    { label: 'maxStop=32, retMax=0.80',  config: { ...base, maxStopPoints: 32, pbRetraceMax: 0.80 } },
    { label: 'maxStop=32, retMax=0.90',  config: { ...base, maxStopPoints: 32, pbRetraceMax: 0.90 } },
    { label: 'maxStop=40, retMax=0.80',  config: { ...base, maxStopPoints: 40, pbRetraceMax: 0.80 } },
    { label: 'maxStop=40, retMax=0.90',  config: { ...base, maxStopPoints: 40, pbRetraceMax: 0.90 } },
    { label: 'maxStop=32, retMax=0.80, bodyRatio=0.15', config: { ...base, maxStopPoints: 32, pbRetraceMax: 0.80, pbMinImpBodyRatio: 0.15 } },
    { label: 'maxStop=32, retMax=0.80, retMin=0.15',    config: { ...base, maxStopPoints: 32, pbRetraceMax: 0.80, pbRetraceMin: 0.15 } },
    { label: 'maxStop=32, retMax=0.80, imp=12',         config: { ...base, maxStopPoints: 32, pbRetraceMax: 0.80, pbMinImpulse: 12 } },
    { label: 'maxStop=32, retMax=0.80, minConf=2',      config: { ...base, maxStopPoints: 32, pbRetraceMax: 0.80, minConfluence: 2 } },
    { label: 'maxStop=32, retMax=0.80, R=4',            config: { ...base, maxStopPoints: 32, pbRetraceMax: 0.80, profitTargetR: 4 } },
    { label: 'maxStop=32, retMax=0.80, R=6',            config: { ...base, maxStopPoints: 32, pbRetraceMax: 0.80, profitTargetR: 6 } },
    { label: 'maxStop=32, retMax=0.80, noBE',           config: { ...base, maxStopPoints: 32, pbRetraceMax: 0.80, moveStopToBE: false } },
  ];

  console.log('  6-MONTH RESULTS:');
  console.log('-'.repeat(100));
  const phase1Results = [];
  for (const v of variants) {
    const r = runBacktest(bars6m, v.config);
    r.config = v.config;
    r.label = v.label;
    phase1Results.push(r);
    printRow(v.label.padEnd(45), r);
  }

  console.log('\n  3-MONTH RESULTS:');
  console.log('-'.repeat(100));
  for (const v of variants.slice(0, 5)) {
    const r = runBacktest(bars3m, v.config);
    printRow(v.label.padEnd(45), r);
  }

  console.log('\n  12-MONTH RESULTS:');
  console.log('-'.repeat(100));
  for (const v of variants.slice(0, 5)) {
    const r = runBacktest(bars12m, v.config);
    printRow(v.label.padEnd(45), r);
  }

  // ── PHASE 2: Fine-grained sweep around the most promising variant ──
  console.log('\n\n' + '='.repeat(70));
  console.log('  PHASE 2: GRID SWEEP — Optimizing for WR + P&L + low DD');
  console.log('='.repeat(70));

  const grid = {
    // Sweep these
    maxStopPoints:      [25, 28, 32, 36, 40],
    pbRetraceMax:       [0.65, 0.70, 0.75, 0.80, 0.90],
    pbMinImpBodyRatio:  [0.10, 0.15, 0.20],
    profitTargetR:      [4, 5, 6],
    minConfluence:      [2, 3],
    moveStopToBE:       [true, false],
    // Fixed from base
    emaxEnabled: false, emaxEmaFast: 9, emaxEmaSlow: 21, emaxMinBarRange: 5,
    emaxMinBodyRatio: 0.5, emaxMaxTime: 480, emaxUseZLEMA: false,
    pbMinImpulse: 15, pbRetraceMin: 0.20, pbMaxTime: 570,
    pbEntryMode: 'limit_structural', pbLimitRetracePct: 0.6,
    pbLimitTimeoutBars: 5, pbConfirmBars: 5, pbTrendFilterEnabled: false,
    vrEnabled: true, vrMinTime: 510, vrMaxTime: 660, vrMinSigma: 1.3,
    vrEntrySigmaMax: 1.0, vrStopBeyondBand: 3, vrTargetMode: 'fixed',
    vrTargetR: 4, vrMinBarVolRatio: 0.8, vrMaxStopPoints: 20,
    vrMinStopPoints: 4, vrCooldownBars: 10,
    minStopPoints: 5, stopBuffer: 2, minTargetPoints: 50,
    volumeAvgPeriod: 20, momentumBars: 5, priorLevelTolerance: 5,
    partialProfitEnabled: false, beActivationR: 2.0,
    riskPerTradeMax: 65, maxLossesPerDay: 2, maxConsecutiveLosses: 3,
    volumeFilterEnabled: true, volumeFilterMin: 0.9, volumeFilterPeriod: 20,
  };

  const configs = cartesian(grid);
  console.log(`  Testing ${configs.length} configurations on 6M data...\n`);

  const allResults = [];
  const t0 = Date.now();

  for (let i = 0; i < configs.length; i++) {
    const r = runBacktest(bars6m, configs[i]);
    r.config = configs[i];
    // Filter: at least 30 trades over 6 months, positive P&L
    if (r.trades >= 30 && r.totalPnl > 0) {
      r.rankScore = rankScore(r);
      allResults.push(r);
    }

    if ((i + 1) % 200 === 0 || i === configs.length - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = ((i + 1) / ((Date.now() - t0) / 1000)).toFixed(1);
      process.stdout.write(`\r  [${i + 1}/${configs.length}] ${rate}/s | ${elapsed}s | Valid: ${allResults.length}     `);
    }
  }

  console.log('\n');

  // Sort by composite rank score
  allResults.sort((a, b) => b.rankScore - a.rankScore);

  // ── TOP 10 by rank score ──
  console.log('  TOP 10 BY COMPOSITE SCORE (WR×3 + PF×2 + P&L×2 + Freq×1 - DD×2 - ConsecL×1):');
  console.log('-'.repeat(110));
  const top10 = allResults.slice(0, 10);
  for (let i = 0; i < top10.length; i++) {
    const r = top10[i];
    const c = r.config;
    const changes = [];
    if (c.maxStopPoints !== base.maxStopPoints) changes.push(`maxStop=${c.maxStopPoints}`);
    if (c.pbRetraceMax !== base.pbRetraceMax) changes.push(`retMax=${c.pbRetraceMax}`);
    if (c.pbMinImpBodyRatio !== base.pbMinImpBodyRatio) changes.push(`body=${c.pbMinImpBodyRatio}`);
    if (c.profitTargetR !== base.profitTargetR) changes.push(`R=${c.profitTargetR}`);
    if (c.minConfluence !== base.minConfluence) changes.push(`conf=${c.minConfluence}`);
    if (c.moveStopToBE !== base.moveStopToBE) changes.push(`BE=${c.moveStopToBE}`);
    const label = `#${i+1} ${changes.join(' ')}`;
    printRow(label.padEnd(55), r);
  }

  // ── TOP 5 by win rate (min 40 trades) ──
  console.log('\n  TOP 5 BY WIN RATE (min 40 trades):');
  console.log('-'.repeat(110));
  const byWR = allResults.filter(r => r.trades >= 40).sort((a, b) => b.winRate - a.winRate).slice(0, 5);
  for (let i = 0; i < byWR.length; i++) {
    const r = byWR[i];
    const c = r.config;
    const changes = [];
    if (c.maxStopPoints !== base.maxStopPoints) changes.push(`maxStop=${c.maxStopPoints}`);
    if (c.pbRetraceMax !== base.pbRetraceMax) changes.push(`retMax=${c.pbRetraceMax}`);
    if (c.pbMinImpBodyRatio !== base.pbMinImpBodyRatio) changes.push(`body=${c.pbMinImpBodyRatio}`);
    if (c.profitTargetR !== base.profitTargetR) changes.push(`R=${c.profitTargetR}`);
    if (c.minConfluence !== base.minConfluence) changes.push(`conf=${c.minConfluence}`);
    if (c.moveStopToBE !== base.moveStopToBE) changes.push(`BE=${c.moveStopToBE}`);
    const label = `#${i+1} ${changes.join(' ')}`;
    printRow(label.padEnd(55), r);
  }

  // ── TOP 5 by P&L ──
  console.log('\n  TOP 5 BY TOTAL P&L:');
  console.log('-'.repeat(110));
  const byPnL = [...allResults].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 5);
  for (let i = 0; i < byPnL.length; i++) {
    const r = byPnL[i];
    const c = r.config;
    const changes = [];
    if (c.maxStopPoints !== base.maxStopPoints) changes.push(`maxStop=${c.maxStopPoints}`);
    if (c.pbRetraceMax !== base.pbRetraceMax) changes.push(`retMax=${c.pbRetraceMax}`);
    if (c.pbMinImpBodyRatio !== base.pbMinImpBodyRatio) changes.push(`body=${c.pbMinImpBodyRatio}`);
    if (c.profitTargetR !== base.profitTargetR) changes.push(`R=${c.profitTargetR}`);
    if (c.minConfluence !== base.minConfluence) changes.push(`conf=${c.minConfluence}`);
    if (c.moveStopToBE !== base.moveStopToBE) changes.push(`BE=${c.moveStopToBE}`);
    const label = `#${i+1} ${changes.join(' ')}`;
    printRow(label.padEnd(55), r);
  }

  // ── TOP 5 by lowest DD (min positive P&L) ──
  console.log('\n  TOP 5 BY LOWEST DRAWDOWN (min $500 P&L):');
  console.log('-'.repeat(110));
  const byDD = allResults.filter(r => r.totalPnl >= 500).sort((a, b) => a.maxDD - b.maxDD).slice(0, 5);
  for (let i = 0; i < byDD.length; i++) {
    const r = byDD[i];
    const c = r.config;
    const changes = [];
    if (c.maxStopPoints !== base.maxStopPoints) changes.push(`maxStop=${c.maxStopPoints}`);
    if (c.pbRetraceMax !== base.pbRetraceMax) changes.push(`retMax=${c.pbRetraceMax}`);
    if (c.pbMinImpBodyRatio !== base.pbMinImpBodyRatio) changes.push(`body=${c.pbMinImpBodyRatio}`);
    if (c.profitTargetR !== base.profitTargetR) changes.push(`R=${c.profitTargetR}`);
    if (c.minConfluence !== base.minConfluence) changes.push(`conf=${c.minConfluence}`);
    if (c.moveStopToBE !== base.moveStopToBE) changes.push(`BE=${c.moveStopToBE}`);
    const label = `#${i+1} ${changes.join(' ')}`;
    printRow(label.padEnd(55), r);
  }

  // ── PHASE 3: Validate #1 across all timeframes ──
  console.log('\n\n' + '='.repeat(70));
  console.log('  PHASE 3: VALIDATION — Top Rank Config on All Timeframes');
  console.log('='.repeat(70));

  const winner = top10[0];
  const periods = [
    { label: '1 Month',   bars: loadData('2026-01-20') },
    { label: '3 Months',  bars: bars3m },
    { label: '6 Months',  bars: bars6m },
    { label: '12 Months', bars: bars12m },
  ];

  console.log('\n  Current config:');
  for (const p of periods) {
    const r = runBacktest(p.bars, base);
    printRow(`    ${p.label}`.padEnd(20), r);
  }

  console.log('\n  Winner config:');
  for (const p of periods) {
    const r = runBacktest(p.bars, winner.config);
    printRow(`    ${p.label}`.padEnd(20), r);
  }

  // Print detailed 3-month view of winner
  const r3mWinner = runBacktest(bars3m, winner.config);
  printDetailed('WINNER — 3-MONTH DETAILED VIEW', r3mWinner);

  // Print winner config changes
  console.log('\n  WINNER CONFIG CHANGES:');
  const c = winner.config;
  const diffs = [];
  for (const k of Object.keys(c)) {
    if (base[k] !== c[k] && typeof c[k] !== 'object') diffs.push(`  ${k}: ${base[k]} → ${c[k]}`);
  }
  for (const d of diffs) console.log(d);
}

main().catch(console.error);
