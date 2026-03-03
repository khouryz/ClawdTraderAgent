/**
 * Survival Backtest — $1,000 Account Focus
 *
 * Tracks absolute equity curve against starting capital.
 * Key metrics: account blow-up probability, max $ drawdown,
 * days to recover from worst DD, and survival rate.
 */

const { runBacktest, loadData, getCurrentConfig, printRow, printDetailed } = require('../backtest/backtest_engine');

const STARTING_CAPITAL = 1000;
const BLOW_UP_THRESHOLD = 0.50; // 50% DD = $500 loss = likely margin call on MNQ

function survivalAnalysis(result, startingCapital) {
  const trades = result.tradeList;
  if (!trades || trades.length === 0) return null;

  let equity = startingCapital;
  let peak = startingCapital;
  let maxDDDollars = 0;
  let maxDDPct = 0;
  let blownUp = false;
  let blowUpTrade = null;
  let minEquity = startingCapital;
  let recoveryDays = 0;
  let inDrawdown = false;
  let ddStartDay = null;
  let longestDDDays = 0;

  const equityCurve = [];
  const dailyPnL = {};

  for (const t of trades) {
    equity += t.pnl;
    if (!dailyPnL[t.day]) dailyPnL[t.day] = 0;
    dailyPnL[t.day] += t.pnl;

    if (equity > peak) {
      peak = equity;
      if (inDrawdown) {
        // Recovered
        const days = Object.keys(dailyPnL).filter(d => d >= ddStartDay && d <= t.day).length;
        if (days > longestDDDays) longestDDDays = days;
        inDrawdown = false;
      }
    }

    const ddDollars = peak - equity;
    const ddPct = peak > 0 ? (ddDollars / startingCapital) * 100 : 0; // DD as % of STARTING capital

    if (ddDollars > maxDDDollars) {
      maxDDDollars = ddDollars;
      maxDDPct = ddPct;
    }

    if (equity < minEquity) minEquity = equity;

    if (!inDrawdown && ddDollars > 0) {
      inDrawdown = true;
      ddStartDay = t.day;
    }

    if (!blownUp && (startingCapital - equity + startingCapital) / startingCapital >= BLOW_UP_THRESHOLD) {
      // Check if equity dropped below blow-up threshold
      if (equity <= startingCapital * (1 - BLOW_UP_THRESHOLD)) {
        blownUp = true;
        blowUpTrade = t;
      }
    }

    equityCurve.push({
      day: t.day,
      trade: trades.indexOf(t) + 1,
      pnl: t.pnl,
      equity,
      ddFromPeak: ddDollars,
      ddPctOfCapital: ddPct,
    });
  }

  // Consecutive loss streaks in dollar terms
  let streakLoss = 0, maxStreakLoss = 0, streakCount = 0, maxStreakCount = 0;
  for (const t of trades) {
    if (t.pnl < -4) { // real loss, not BE
      streakLoss += Math.abs(t.pnl);
      streakCount++;
      if (streakLoss > maxStreakLoss) maxStreakLoss = streakLoss;
      if (streakCount > maxStreakCount) maxStreakCount = streakCount;
    } else {
      streakLoss = 0;
      streakCount = 0;
    }
  }

  // Risk of ruin estimate (simplified)
  const wins = trades.filter(t => t.pnl > 4);
  const losses = trades.filter(t => t.pnl < -4);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 1;
  const winRate = (wins.length + losses.length) > 0 ? wins.length / (wins.length + losses.length) : 0;
  // Risk of ruin formula: ((1-edge)/(1+edge))^(units)
  // where edge = WR * (avgWin/avgLoss) - (1-WR)
  const edge = winRate * (avgWin / avgLoss) - (1 - winRate);
  const unitsToRuin = Math.floor(startingCapital / avgLoss);
  let riskOfRuin;
  if (edge <= 0) {
    riskOfRuin = 100; // negative edge = certain ruin
  } else {
    const r = avgWin / avgLoss;
    const q = 1 - winRate;
    const p = winRate;
    riskOfRuin = Math.min(100, Math.pow(q / p, unitsToRuin) * 100);
  }

  return {
    startingCapital,
    finalEquity: equity,
    totalPnl: equity - startingCapital,
    returnPct: ((equity - startingCapital) / startingCapital * 100),
    maxDDDollars,
    maxDDPctOfCapital: maxDDPct,
    minEquity,
    blownUp,
    blowUpTrade,
    maxStreakLoss,
    maxStreakCount,
    longestDDDays,
    avgWin,
    avgLoss,
    winRate: winRate * 100,
    edge,
    riskOfRuin,
    equityCurve,
  };
}

function printSurvival(label, s) {
  const status = s.blownUp ? '💀 BLOWN UP' : (s.maxDDPctOfCapital > 40 ? '⚠️ HIGH RISK' : '✅ SURVIVED');
  console.log(`\n  ${label} — ${status}`);
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  Starting Capital:    $${s.startingCapital}`);
  console.log(`  Final Equity:        $${s.finalEquity.toFixed(2)} (${s.returnPct >= 0 ? '+' : ''}${s.returnPct.toFixed(1)}%)`);
  console.log(`  Max DD (dollars):    -$${s.maxDDDollars.toFixed(2)}`);
  console.log(`  Max DD (% of cap):   ${s.maxDDPctOfCapital.toFixed(1)}%`);
  console.log(`  Lowest Equity:       $${s.minEquity.toFixed(2)}`);
  console.log(`  Worst Loss Streak:   ${s.maxStreakCount} trades, -$${s.maxStreakLoss.toFixed(2)}`);
  console.log(`  Avg Win / Avg Loss:  $${s.avgWin.toFixed(2)} / $${s.avgLoss.toFixed(2)} (${(s.avgWin/Math.max(s.avgLoss,1)).toFixed(1)}:1)`);
  console.log(`  Win Rate:            ${s.winRate.toFixed(1)}%`);
  console.log(`  Edge:                ${(s.edge * 100).toFixed(1)}%`);
  console.log(`  Risk of Ruin:        ${s.riskOfRuin.toFixed(1)}%`);
}

function main() {
  console.log('='.repeat(80));
  console.log('  $1,000 ACCOUNT SURVIVAL ANALYSIS');
  console.log('  (Realistic: slippage + commissions + intra-bar ambiguity)');
  console.log('='.repeat(80));

  const base = getCurrentConfig();

  // ── Configs to test ──
  const configs = [
    { label: 'Current Production', config: { ...base } },
    { label: 'Current + risk=$40', config: { ...base, riskPerTradeMax: 40 } },
    { label: 'Current + risk=$30', config: { ...base, riskPerTradeMax: 30 } },
    { label: 'Tight: risk=$40, maxStop=20, R=5', config: { ...base, riskPerTradeMax: 40, maxStopPoints: 20 } },
    { label: 'Tight: risk=$30, maxStop=18, R=6', config: { ...base, riskPerTradeMax: 30, maxStopPoints: 18, profitTargetR: 6 } },
    { label: 'Conservative: risk=$30, body=0.15, minTgt=40', config: { ...base, riskPerTradeMax: 30, pbMinImpBodyRatio: 0.15, minTargetPoints: 40 } },
    { label: 'Conservative: risk=$25, maxStop=15, R=6, conf=3', config: { ...base, riskPerTradeMax: 25, maxStopPoints: 15, profitTargetR: 6, minConfluence: 3, maxLossesPerDay: 1 } },
    { label: 'Ultra-safe: risk=$20, maxStop=12, R=7, 1 loss/day', config: { ...base, riskPerTradeMax: 20, maxStopPoints: 12, profitTargetR: 7, maxLossesPerDay: 1, minConfluence: 3 } },
    // Wider filter variants with reduced risk
    { label: 'Wider+safe: retMax=0.80, risk=$30', config: { ...base, riskPerTradeMax: 30, pbRetraceMax: 0.80, pbMinImpBodyRatio: 0.15, minTargetPoints: 40 } },
    { label: 'Wider+safe: maxStop=32, retMax=0.80, risk=$30', config: { ...base, riskPerTradeMax: 30, maxStopPoints: 32, pbRetraceMax: 0.80, pbMinImpBodyRatio: 0.15, minTargetPoints: 40 } },
  ];

  // Test on 3M, 6M, 12M
  const periods = [
    { label: '3 Months', start: '2025-11-20' },
    { label: '6 Months', start: '2025-08-20' },
    { label: '12 Months', start: '2025-02-20' },
  ];

  for (const period of periods) {
    console.log(`\n\n${'═'.repeat(80)}`);
    console.log(`  ${period.label.toUpperCase()} — Survival Analysis ($${STARTING_CAPITAL} account)`);
    console.log(`${'═'.repeat(80)}`);

    const bars = loadData(period.start);

    for (const { label, config } of configs) {
      const r = runBacktest(bars, config);
      const s = survivalAnalysis(r, STARTING_CAPITAL);
      if (s) {
        printSurvival(`${period.label} | ${label}`, s);
        printRow(`  Backtest`, r);
      }
    }
  }

  // ── Monte Carlo survival check on best candidate ──
  console.log(`\n\n${'═'.repeat(80)}`);
  console.log('  MONTE CARLO SURVIVAL — 2000 iterations on best candidates');
  console.log(`${'═'.repeat(80)}`);

  const bars6m = loadData('2025-08-20');
  const candidates = [
    { label: 'Current Production', config: { ...base } },
    { label: 'Conservative: risk=$30, body=0.15, minTgt=40', config: { ...base, riskPerTradeMax: 30, pbMinImpBodyRatio: 0.15, minTargetPoints: 40 } },
    { label: 'Tight: risk=$30, maxStop=18, R=6', config: { ...base, riskPerTradeMax: 30, maxStopPoints: 18, profitTargetR: 6 } },
  ];

  for (const { label, config } of candidates) {
    const r = runBacktest(bars6m, config);
    const trades = r.tradeList;
    if (!trades || trades.length < 5) continue;

    const pnls = trades.map(t => t.pnl);
    let survivals = 0, blowups = 0;
    const finalEquities = [];
    const maxDDs = [];
    const ITERATIONS = 2000;

    for (let iter = 0; iter < ITERATIONS; iter++) {
      // Shuffle trade order
      const shuffled = [...pnls];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      let eq = STARTING_CAPITAL, peak = STARTING_CAPITAL, maxDD = 0;
      let blown = false;
      for (const p of shuffled) {
        eq += p;
        if (eq > peak) peak = eq;
        const dd = peak - eq;
        if (dd > maxDD) maxDD = dd;
        if (eq <= STARTING_CAPITAL * (1 - BLOW_UP_THRESHOLD)) { blown = true; break; }
      }

      if (blown) blowups++;
      else survivals++;
      finalEquities.push(eq);
      maxDDs.push(maxDD);
    }

    finalEquities.sort((a, b) => a - b);
    maxDDs.sort((a, b) => a - b);

    console.log(`\n  ${label}`);
    console.log(`  ${'─'.repeat(60)}`);
    console.log(`  Survival rate:     ${(survivals / ITERATIONS * 100).toFixed(1)}%`);
    console.log(`  Blow-up rate:      ${(blowups / ITERATIONS * 100).toFixed(1)}%`);
    console.log(`  Median final eq:   $${finalEquities[Math.floor(ITERATIONS * 0.5)].toFixed(0)}`);
    console.log(`  5th %ile equity:   $${finalEquities[Math.floor(ITERATIONS * 0.05)].toFixed(0)}`);
    console.log(`  95th %ile equity:  $${finalEquities[Math.floor(ITERATIONS * 0.95)].toFixed(0)}`);
    console.log(`  Median max DD:     $${maxDDs[Math.floor(ITERATIONS * 0.5)].toFixed(0)}`);
    console.log(`  95th %ile max DD:  $${maxDDs[Math.floor(ITERATIONS * 0.95)].toFixed(0)}`);
  }

  console.log('\n✅ Survival analysis complete');
}

main();
