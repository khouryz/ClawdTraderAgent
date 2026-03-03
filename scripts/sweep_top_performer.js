/**
 * Deep Sweep around top performer: maxStop=32, retMax=0.80, retMin=0.15
 * 
 * This does a fine-grained grid around that config, varying:
 *   - maxStopPoints: 28-36 (fine steps)
 *   - pbRetraceMax: 0.70-0.90 (fine steps)
 *   - pbRetraceMin: 0.10-0.25 (fine steps)
 *   - pbMinImpBodyRatio: 0.10-0.25
 *   - profitTargetR: 3-7
 *   - minConfluence: 2, 3
 *   - moveStopToBE: true, false
 *   - pbMinImpulse: 12-18
 *   - beActivationR: 1.5-3.0
 *   - minTargetPoints: 30-50
 *
 * Tests on 3M, 6M, 12M to check robustness.
 */

const { runBacktest, loadData, getCurrentConfig, printRow, printDetailed } = require('../backtest/backtest_engine');

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
  const wrScore = r.winRate / 100;
  const pfScore = Math.min(r.profitFactor / 10, 1);
  const ddPenalty = Math.min(r.maxDD / 100, 1);
  const pnlScore = Math.min(r.totalPnl / 5000, 1);
  const freqScore = Math.min(r.tradesPerDay / 2, 1);
  const consecPenalty = Math.min(r.maxConsecLosses / 20, 1);
  return (wrScore * 3 + pfScore * 2 + pnlScore * 2 + freqScore * 1) - (ddPenalty * 2 + consecPenalty * 1);
}

async function main() {
  const base = getCurrentConfig();
  const bars3m = loadData('2025-11-20');
  const bars6m = loadData('2025-08-20');
  const bars12m = loadData('2025-02-20');
  console.log(`Data: 3M=${bars3m.length} bars | 6M=${bars6m.length} bars | 12M=${bars12m.length} bars\n`);

  // ── PHASE 1: Fine-grained sweep around the top performer ──
  console.log('='.repeat(80));
  console.log('  DEEP SWEEP around maxStop=32, retMax=0.80, retMin=0.15');
  console.log('='.repeat(80));

  const grid = {
    // Core 4 params — fine-grained around top performer
    maxStopPoints:      [28, 32, 36, 40],
    pbRetraceMax:       [0.70, 0.75, 0.80, 0.85, 0.90],
    pbRetraceMin:       [0.10, 0.15, 0.18, 0.20],
    profitTargetR:      [3, 4, 5, 6],
    // Secondary params — 2 values each
    pbMinImpBodyRatio:  [0.15, 0.20],
    minConfluence:      [2, 3],
    moveStopToBE:       [true, false],
    // Fixed at best guesses
    pbMinImpulse:       15,
    beActivationR:      2.0,
    minTargetPoints:    40,
    // Fixed
    emaxEnabled: false, emaxEmaFast: 9, emaxEmaSlow: 21, emaxMinBarRange: 5,
    emaxMinBodyRatio: 0.5, emaxMaxTime: 480, emaxUseZLEMA: false,
    pbMaxTime: 570,
    pbEntryMode: 'limit_structural', pbLimitRetracePct: 0.6,
    pbLimitTimeoutBars: 5, pbConfirmBars: 5, pbTrendFilterEnabled: false,
    vrEnabled: true, vrMinTime: 510, vrMaxTime: 660, vrMinSigma: 1.3,
    vrEntrySigmaMax: 1.0, vrStopBeyondBand: 3, vrTargetMode: 'fixed',
    vrTargetR: 4, vrMinBarVolRatio: 0.8, vrMaxStopPoints: 20,
    vrMinStopPoints: 4, vrCooldownBars: 10,
    minStopPoints: 5, stopBuffer: 2,
    volumeAvgPeriod: 20, momentumBars: 5, priorLevelTolerance: 5,
    partialProfitEnabled: false,
    riskPerTradeMax: 65, maxLossesPerDay: 2, maxConsecutiveLosses: 3,
    volumeFilterEnabled: true, volumeFilterMin: 0.9, volumeFilterPeriod: 20,
  };

  const configs = cartesian(grid);
  console.log(`  Total configs: ${configs.length}`);
  console.log(`  Running on 6M data first, then validating top 20 on 3M + 12M...\n`);

  const allResults = [];
  const t0 = Date.now();

  for (let i = 0; i < configs.length; i++) {
    const r = runBacktest(bars6m, configs[i]);
    r.config = configs[i];
    // Must have positive P&L and minimum trades
    if (r.trades >= 20 && r.totalPnl > 0) {
      r.rankScore = rankScore(r);
      allResults.push(r);
    }
    if ((i + 1) % 500 === 0 || i === configs.length - 1) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = ((i + 1) / ((Date.now() - t0) / 1000)).toFixed(1);
      process.stdout.write(`\r  [${i + 1}/${configs.length}] ${rate}/s | ${elapsed}s | Valid: ${allResults.length}     `);
    }
  }

  console.log('\n');

  // Sort by rank
  allResults.sort((a, b) => b.rankScore - a.rankScore);

  // ── TOP 20 by rank ──
  console.log('  TOP 20 BY COMPOSITE SCORE (6M):');
  console.log('-'.repeat(120));
  const top20 = allResults.slice(0, 20);
  for (let i = 0; i < top20.length; i++) {
    const r = top20[i];
    const c = r.config;
    const label = `#${i+1} mxS=${c.maxStopPoints} retMax=${c.pbRetraceMax} retMin=${c.pbRetraceMin} body=${c.pbMinImpBodyRatio} R=${c.profitTargetR} conf=${c.minConfluence} BE=${c.moveStopToBE} imp=${c.pbMinImpulse} beR=${c.beActivationR} minT=${c.minTargetPoints}`;
    printRow(label.padEnd(110), r);
  }

  // ── TOP 10 by WR (min 50 trades) ──
  console.log('\n  TOP 10 BY WIN RATE (min 50 trades, 6M):');
  console.log('-'.repeat(120));
  const byWR = allResults.filter(r => r.trades >= 50).sort((a, b) => b.winRate - a.winRate).slice(0, 10);
  for (let i = 0; i < byWR.length; i++) {
    const r = byWR[i];
    const c = r.config;
    const label = `#${i+1} mxS=${c.maxStopPoints} retMax=${c.pbRetraceMax} retMin=${c.pbRetraceMin} body=${c.pbMinImpBodyRatio} R=${c.profitTargetR} conf=${c.minConfluence} BE=${c.moveStopToBE} imp=${c.pbMinImpulse} beR=${c.beActivationR} minT=${c.minTargetPoints}`;
    printRow(label.padEnd(110), r);
  }

  // ── TOP 10 by P&L ──
  console.log('\n  TOP 10 BY P&L (6M):');
  console.log('-'.repeat(120));
  const byPnL = [...allResults].sort((a, b) => b.totalPnl - a.totalPnl).slice(0, 10);
  for (let i = 0; i < byPnL.length; i++) {
    const r = byPnL[i];
    const c = r.config;
    const label = `#${i+1} mxS=${c.maxStopPoints} retMax=${c.pbRetraceMax} retMin=${c.pbRetraceMin} body=${c.pbMinImpBodyRatio} R=${c.profitTargetR} conf=${c.minConfluence} BE=${c.moveStopToBE} imp=${c.pbMinImpulse} beR=${c.beActivationR} minT=${c.minTargetPoints}`;
    printRow(label.padEnd(110), r);
  }

  // ── TOP 10 lowest DD (min $1000 P&L) ──
  console.log('\n  TOP 10 BY LOWEST DD (min $1000 P&L, 6M):');
  console.log('-'.repeat(120));
  const byDD = allResults.filter(r => r.totalPnl >= 1000).sort((a, b) => a.maxDD - b.maxDD).slice(0, 10);
  for (let i = 0; i < byDD.length; i++) {
    const r = byDD[i];
    const c = r.config;
    const label = `#${i+1} mxS=${c.maxStopPoints} retMax=${c.pbRetraceMax} retMin=${c.pbRetraceMin} body=${c.pbMinImpBodyRatio} R=${c.profitTargetR} conf=${c.minConfluence} BE=${c.moveStopToBE} imp=${c.pbMinImpulse} beR=${c.beActivationR} minT=${c.minTargetPoints}`;
    printRow(label.padEnd(110), r);
  }

  // ── PHASE 2: Validate top 20 on 3M and 12M ──
  console.log('\n\n' + '='.repeat(80));
  console.log('  CROSS-VALIDATION: Top 20 on 3M and 12M');
  console.log('='.repeat(80));

  console.log('\n  BASELINE for reference:');
  const base3m = runBacktest(bars3m, base);
  const base6m = runBacktest(bars6m, base);
  const base12m = runBacktest(bars12m, base);
  console.log(`    3M:  `); printRow('    3M  baseline'.padEnd(30), base3m);
  console.log(`    6M:  `); printRow('    6M  baseline'.padEnd(30), base6m);
  console.log(`    12M: `); printRow('    12M baseline'.padEnd(30), base12m);

  console.log('\n  TOP 20 CROSS-VALIDATED (6M rank → 3M → 12M):');
  console.log('-'.repeat(130));
  console.log('  Rank | Config Summary'.padEnd(80) + '| 3M WR   P&L     DD  | 6M WR   P&L     DD  | 12M WR  P&L     DD');
  console.log('-'.repeat(130));

  for (let i = 0; i < top20.length; i++) {
    const c = top20[i].config;
    const r3 = runBacktest(bars3m, c);
    const r6 = top20[i]; // already computed
    const r12 = runBacktest(bars12m, c);

    const cfgStr = `mxS=${c.maxStopPoints} rMax=${c.pbRetraceMax} rMin=${c.pbRetraceMin} body=${c.pbMinImpBodyRatio} R=${c.profitTargetR} conf=${c.minConfluence} BE=${c.moveStopToBE?'Y':'N'} imp=${c.pbMinImpulse} beR=${c.beActivationR} minT=${c.minTargetPoints}`;
    const fmt = (r) => `${r.winRate.toFixed(0).padStart(3)}% $${r.totalPnl.toFixed(0).padStart(5)} ${r.maxDD.toFixed(0).padStart(4)}%`;
    console.log(`  #${String(i+1).padStart(2)}  | ${cfgStr.padEnd(95)} | ${fmt(r3)} | ${fmt(r6)} | ${fmt(r12)}`);
  }

  // ── PHASE 3: Print detailed view of absolute #1 ──
  console.log('\n\n' + '='.repeat(80));
  console.log('  DETAILED VIEW — #1 RANKED CONFIG');
  console.log('='.repeat(80));

  const winner = top20[0];
  const wc = winner.config;
  console.log('\n  Config changes vs baseline:');
  for (const k of Object.keys(wc)) {
    if (base[k] !== wc[k] && typeof wc[k] !== 'object') {
      console.log(`    ${k}: ${base[k]} → ${wc[k]}`);
    }
  }

  const w3m = runBacktest(bars3m, wc);
  printDetailed('Winner — 3-Month', w3m);
  const w6m = runBacktest(bars6m, wc);
  printDetailed('Winner — 6-Month', w6m);

  console.log('\n✅ Deep sweep complete');
}

main().catch(console.error);
