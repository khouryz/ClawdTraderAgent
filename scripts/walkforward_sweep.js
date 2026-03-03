/**
 * Walk-Forward Optimization — The Right Way to Backtest
 *
 * Instead of optimizing on the same data we test on (overfitting),
 * this script:
 *   1. Splits 12M data into rolling windows (train 4M → test 2M, roll 2M)
 *   2. For each window, runs a grid search on TRAIN data
 *   3. Takes the best config and tests it on unseen TEST data
 *   4. Aggregates out-of-sample results across all windows
 *
 * This mimics real trading: you'd optimize monthly, then trade the next month.
 * The aggregated out-of-sample P&L is the realistic expected performance.
 */

const { runBacktest, loadData, getCurrentConfig, printRow, printDetailed, generateConfigs } = require('../backtest/backtest_engine');

function rankScore(r) {
  const wrScore = r.winRate / 100;
  const pfScore = Math.min(r.profitFactor / 10, 1);
  const ddPenalty = Math.min(r.maxDD / 100, 1);
  const pnlScore = Math.min(r.totalPnl / 3000, 1);
  const freqScore = Math.min(r.tradesPerDay / 2, 1);
  const consecPenalty = Math.min(r.maxConsecLosses / 15, 1);
  return (wrScore * 3 + pfScore * 2 + pnlScore * 2 + freqScore * 1) - (ddPenalty * 2 + consecPenalty * 1);
}

function main() {
  console.log('='.repeat(80));
  console.log('  WALK-FORWARD OPTIMIZATION (Realistic Backtest with Slippage + Commissions)');
  console.log('='.repeat(80));

  // Load all data
  const allBars = loadData('2025-02-20'); // 12 months
  console.log(`\n  Total bars: ${allBars.length}`);

  // Group by trading day
  const { toPST, isInSession } = (() => {
    function toPST(timestamp) {
      const d = new Date(timestamp);
      const s = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
      const [dp, tp] = s.split(', ');
      const [mo, dy, yr] = dp.split('/');
      const [h, m] = tp.split(':').map(Number);
      const ds = yr+'-'+String(mo).padStart(2,'0')+'-'+String(dy).padStart(2,'0');
      return { hour: h, min: m, time: h*60+m, date: ds, dow: new Date(ds+'T12:00:00Z').getDay() };
    }
    function isInSession(p) {
      if (p.dow === 0 || p.dow === 6) return false;
      return p.time >= 390 && p.time < 780;
    }
    return { toPST, isInSession };
  })();

  const dayMap = {};
  for (const bar of allBars) {
    const pst = toPST(bar.timestamp);
    if (!isInSession(pst)) continue;
    const d = pst.date;
    if (!dayMap[d]) dayMap[d] = [];
    dayMap[d].push(bar);
  }
  const allDays = Object.keys(dayMap).sort();
  console.log(`  Trading days: ${allDays.length}`);

  // ── Walk-Forward Windows ──
  // Train: ~80 days (4 months), Test: ~40 days (2 months), Step: ~40 days
  const TRAIN_DAYS = 80;
  const TEST_DAYS = 40;
  const STEP_DAYS = 40;

  const windows = [];
  for (let start = 0; start + TRAIN_DAYS + TEST_DAYS <= allDays.length; start += STEP_DAYS) {
    const trainDays = allDays.slice(start, start + TRAIN_DAYS);
    const testDays = allDays.slice(start + TRAIN_DAYS, start + TRAIN_DAYS + TEST_DAYS);
    windows.push({
      trainStart: trainDays[0],
      trainEnd: trainDays[trainDays.length - 1],
      testStart: testDays[0],
      testEnd: testDays[testDays.length - 1],
      trainBars: allBars.filter(b => {
        const d = b.timestamp.slice(0, 10);
        return d >= trainDays[0] && d <= trainDays[trainDays.length - 1];
      }),
      testBars: allBars.filter(b => {
        const d = b.timestamp.slice(0, 10);
        return d >= testDays[0] && d <= testDays[testDays.length - 1];
      }),
    });
  }

  console.log(`  Walk-forward windows: ${windows.length}\n`);
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    console.log(`    Window ${i+1}: Train ${w.trainStart}→${w.trainEnd} (${w.trainBars.length} bars) | Test ${w.testStart}→${w.testEnd} (${w.testBars.length} bars)`);
  }

  // ── Optimization Grid (focused, ~1200 configs) ──
  const base = getCurrentConfig();
  const grid = {
    maxStopPoints:      [25, 28, 32, 36],
    pbRetraceMax:       [0.65, 0.75, 0.80, 0.90],
    pbRetraceMin:       [0.15, 0.20],
    pbMinImpBodyRatio:  [0.15, 0.20],
    profitTargetR:      [4, 5, 6],
    minConfluence:      [2, 3],
    moveStopToBE:       [true, false],
    // Fixed
    emaxEnabled: false, emaxEmaFast: 9, emaxEmaSlow: 21, emaxMinBarRange: 5,
    emaxMinBodyRatio: 0.5, emaxMaxTime: 480, emaxUseZLEMA: false,
    pbMinImpulse: 15, pbMaxTime: 570,
    pbEntryMode: 'limit_structural', pbLimitRetracePct: 0.6,
    pbLimitTimeoutBars: 5, pbConfirmBars: 5, pbTrendFilterEnabled: false,
    vrEnabled: true, vrMinTime: 510, vrMaxTime: 660, vrMinSigma: 1.3,
    vrEntrySigmaMax: 1.0, vrStopBeyondBand: 3, vrTargetMode: 'fixed',
    vrTargetR: 4, vrMinBarVolRatio: 0.8, vrMaxStopPoints: 20,
    vrMinStopPoints: 4, vrCooldownBars: 10,
    minStopPoints: 5, stopBuffer: 2, minTargetPoints: 40,
    beActivationR: 2.0,
    volumeAvgPeriod: 20, momentumBars: 5, priorLevelTolerance: 5,
    partialProfitEnabled: false,
    riskPerTradeMax: 65, maxLossesPerDay: 2, maxConsecutiveLosses: 3,
    volumeFilterEnabled: true, volumeFilterMin: 0.9, volumeFilterPeriod: 20,
  };

  const configs = generateConfigs(grid);
  console.log(`\n  Grid size: ${configs.length} configs per window`);

  // ── Run Walk-Forward ──
  console.log('\n' + '='.repeat(80));
  console.log('  WALK-FORWARD RESULTS');
  console.log('='.repeat(80));

  const oosResults = []; // out-of-sample results
  const baselineOOS = []; // baseline out-of-sample for comparison

  for (let wi = 0; wi < windows.length; wi++) {
    const w = windows[wi];
    console.log(`\n  ── Window ${wi+1}: Train ${w.trainStart}→${w.trainEnd} | Test ${w.testStart}→${w.testEnd} ──`);

    // 1. Optimize on training data
    const t0 = Date.now();
    let bestRank = -Infinity, bestConfig = null, bestTrainResult = null;
    let validCount = 0;

    for (let i = 0; i < configs.length; i++) {
      const r = runBacktest(w.trainBars, configs[i]);
      if (r.trades >= 5 && r.totalPnl > 0) {
        const score = rankScore(r);
        if (score > bestRank) {
          bestRank = score;
          bestConfig = configs[i];
          bestTrainResult = r;
        }
        validCount++;
      }
      if ((i + 1) % 200 === 0) {
        process.stdout.write(`\r    Optimizing: [${i+1}/${configs.length}] valid=${validCount}     `);
      }
    }
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    process.stdout.write(`\r    Optimizing: [${configs.length}/${configs.length}] done in ${elapsed}s, ${validCount} valid configs     \n`);

    if (!bestConfig) {
      console.log(`    ⚠️ No valid config found for this window`);
      continue;
    }

    // 2. Print best config found for this window
    const diffs = [];
    for (const k of Object.keys(bestConfig)) {
      if (base[k] !== bestConfig[k] && typeof bestConfig[k] !== 'object') {
        diffs.push(`${k}=${bestConfig[k]}`);
      }
    }
    console.log(`    Best train config: ${diffs.join(' | ')}`);
    printRow('    Train result', bestTrainResult);

    // 3. Test on unseen test data
    const testResult = runBacktest(w.testBars, bestConfig);
    printRow('    TEST (OOS) ', testResult);
    testResult.config = bestConfig;
    testResult.window = wi + 1;
    oosResults.push(testResult);

    // 4. Also test baseline on test data for comparison
    const baseTest = runBacktest(w.testBars, base);
    printRow('    Baseline   ', baseTest);
    baselineOOS.push(baseTest);
  }

  // ── Aggregate Out-of-Sample Results ──
  console.log('\n\n' + '='.repeat(80));
  console.log('  AGGREGATED OUT-OF-SAMPLE RESULTS');
  console.log('='.repeat(80));

  if (oosResults.length > 0) {
    const totalTrades = oosResults.reduce((s, r) => s + r.trades, 0);
    const totalPnl = oosResults.reduce((s, r) => s + r.totalPnl, 0);
    const totalWins = oosResults.reduce((s, r) => s + r.wins, 0);
    const totalLosses = oosResults.reduce((s, r) => s + r.losses, 0);
    const totalBEs = oosResults.reduce((s, r) => s + r.bes, 0);
    const wr = (totalTrades - totalBEs) > 0 ? (totalWins / (totalTrades - totalBEs) * 100) : 0;
    const avgDD = oosResults.reduce((s, r) => s + r.maxDD, 0) / oosResults.length;
    const worstDD = Math.max(...oosResults.map(r => r.maxDD));
    const allProfitable = oosResults.every(r => r.totalPnl > 0);

    console.log(`\n  Walk-Forward Optimized (OUT-OF-SAMPLE):`);
    console.log(`    Windows:        ${oosResults.length}`);
    console.log(`    Total trades:   ${totalTrades}`);
    console.log(`    Total P&L:      $${totalPnl.toFixed(2)}`);
    console.log(`    Win/Loss/BE:    ${totalWins}W / ${totalLosses}L / ${totalBEs}BE`);
    console.log(`    Win Rate:       ${wr.toFixed(1)}%`);
    console.log(`    Avg DD:         ${avgDD.toFixed(1)}%`);
    console.log(`    Worst DD:       ${worstDD.toFixed(1)}%`);
    console.log(`    All windows +?: ${allProfitable ? 'YES ✅' : 'NO ❌'}`);

    // Baseline comparison
    const baseTotalPnl = baselineOOS.reduce((s, r) => s + r.totalPnl, 0);
    const baseTotalTrades = baselineOOS.reduce((s, r) => s + r.trades, 0);
    const baseTotalWins = baselineOOS.reduce((s, r) => s + r.wins, 0);
    const baseTotalLosses = baselineOOS.reduce((s, r) => s + r.losses, 0);
    const baseTotalBEs = baselineOOS.reduce((s, r) => s + r.bes, 0);
    const baseWR = (baseTotalTrades - baseTotalBEs) > 0 ? (baseTotalWins / (baseTotalTrades - baseTotalBEs) * 100) : 0;

    console.log(`\n  Baseline (current config, same test periods):`);
    console.log(`    Total trades:   ${baseTotalTrades}`);
    console.log(`    Total P&L:      $${baseTotalPnl.toFixed(2)}`);
    console.log(`    Win Rate:       ${baseWR.toFixed(1)}%`);

    console.log(`\n  Improvement: $${(totalPnl - baseTotalPnl).toFixed(2)} (${((totalPnl/Math.max(baseTotalPnl,1) - 1)*100).toFixed(0)}%)`);
  }

  // ── Most Frequently Selected Params ──
  console.log('\n' + '='.repeat(80));
  console.log('  PARAMETER STABILITY (which values were selected most often?)');
  console.log('='.repeat(80));

  const paramFreq = {};
  for (const r of oosResults) {
    if (!r.config) continue;
    for (const [k, v] of Object.entries(r.config)) {
      if (base[k] !== v && typeof v !== 'object') {
        const key = `${k}=${v}`;
        paramFreq[key] = (paramFreq[key] || 0) + 1;
      }
    }
  }

  const sorted = Object.entries(paramFreq).sort((a, b) => b[1] - a[1]);
  for (const [param, count] of sorted.slice(0, 15)) {
    const pct = (count / oosResults.length * 100).toFixed(0);
    console.log(`    ${param.padEnd(35)} selected ${count}/${oosResults.length} windows (${pct}%)`);
  }

  // ── Final Recommendation ──
  // Use the most frequently selected values as the "robust" config
  console.log('\n' + '='.repeat(80));
  console.log('  RECOMMENDED ROBUST CONFIG');
  console.log('='.repeat(80));

  // For each swept param, pick the value selected most often across windows
  const sweepParams = ['maxStopPoints', 'pbRetraceMax', 'pbRetraceMin', 'pbMinImpBodyRatio', 'profitTargetR', 'minConfluence', 'moveStopToBE'];
  const robustConfig = { ...base };
  for (const param of sweepParams) {
    const freq = {};
    for (const r of oosResults) {
      if (!r.config) continue;
      const v = r.config[param];
      freq[v] = (freq[v] || 0) + 1;
    }
    const best = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
    if (best) {
      const val = best[0];
      robustConfig[param] = val === 'true' ? true : val === 'false' ? false : parseFloat(val);
    }
  }
  robustConfig.minTargetPoints = 40;

  console.log('\n  Changes from current production:');
  for (const k of Object.keys(robustConfig)) {
    if (base[k] !== robustConfig[k] && typeof robustConfig[k] !== 'object') {
      console.log(`    ${k}: ${base[k]} → ${robustConfig[k]}`);
    }
  }

  // Validate robust config on all timeframes
  console.log('\n  Validation on all timeframes:');
  for (const p of [
    { l: '3M', s: '2025-11-20' },
    { l: '6M', s: '2025-08-20' },
    { l: '12M', s: '2025-02-20' },
  ]) {
    const bars = loadData(p.s);
    const rc = runBacktest(bars, robustConfig);
    const rb = runBacktest(bars, base);
    printRow(`    ${p.l} Robust `, rc);
    printRow(`    ${p.l} Current`, rb);
  }

  console.log('\n✅ Walk-forward optimization complete');
}

main();
