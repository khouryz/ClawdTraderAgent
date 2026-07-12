/**
 * Inter-Market Divergence Backtest
 *
 * Tests the DIVERGE strategy by running two correlated instruments (e.g. MES + MNQ)
 * simultaneously through the actual MNQMomentumStrategyV2 with divergenceEnabled=true.
 * The DivergenceDetector monitors session extremes across both instruments and fires
 * onDivergence() on the laggard when the leader makes a new session extreme.
 *
 * Usage:
 *   node scripts/backtest_divergence.js --leader=mes_1m.json --lagger=mnq_1m.json
 *   node scripts/backtest_divergence.js --leader=mes_1m.json --lagger=mnq_1m.json --start=2025-06-01
 *
 * Data files: JSON arrays of 1m OHLCV bars with .timestamp (ISO string),
 *             .open, .high, .low, .close, .volume
 *             Place in backtest/ dir or pass full paths.
 */

const fs = require('fs');
const path = require('path');

const MNQMomentumStrategyV2 = require('../src/strategies/mnq_momentum_strategy_v2');
const VWAPEngine = require('../src/indicators/VWAPEngine');
const DivergenceDetector = require('../src/indicators/DivergenceDetector');

const MNQ = { tickSize: 0.25, tickValue: 0.50, pointValue: 2.0 };
const MES = { tickSize: 0.25, tickValue: 1.25, pointValue: 5.0 };
const COMMISSION_PER_RT = 0.62;

// ── Time / Session helpers ──

function toPST(timestamp) {
  const d = new Date(timestamp);
  const s = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  const [dp, tp] = s.split(', ');
  const [mo, dy, yr] = dp.split('/');
  const [h, m] = tp.split(':').map(Number);
  const ds = yr + '-' + String(mo).padStart(2, '0') + '-' + String(dy).padStart(2, '0');
  return { hour: h, min: m, time: h * 60 + m, date: ds, dow: new Date(ds + 'T12:00:00Z').getDay() };
}

function isInSession(p) {
  if (p.dow === 0 || p.dow === 6) return false;
  if (p.time < 390 || p.time >= 780) return false;
  return true;
}

// ── Console suppression ──

function muteConsole() {
  const orig = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  return orig;
}

function restoreConsole(orig) {
  console.log = orig.log;
  console.warn = orig.warn;
}

// ── Trade simulator ──

function simulateTrade(signal, dayBars, entryBarIdx, config, contractSpec) {
  const dir = signal.type === 'buy' ? 1 : -1;
  const slippagePts = (config.slippageEnabled !== false) ? Math.random() * 0.75 : 0;
  const entry = signal.type === 'buy'
    ? signal.price + slippagePts
    : signal.price - slippagePts;
  let stop = signal.stopLoss;
  const target = signal.targetPrice
    ? signal.targetPrice
    : (signal.type === 'buy'
        ? entry + signal.stopDistance * (config.divergenceTargetR || 1.5)
        : entry - signal.stopDistance * (config.divergenceTargetR || 1.5));

  for (let i = entryBarIdx + 1; i < dayBars.length; i++) {
    const bar = dayBars[i];
    const pst = toPST(bar.timestamp);

    let stopHit = false, targetHit = false;
    if (signal.type === 'buy') {
      stopHit = bar.low <= stop;
      targetHit = bar.high >= target;
    } else {
      stopHit = bar.high >= stop;
      targetHit = bar.low <= target;
    }

    if (stopHit && targetHit) {
      const distToStop = Math.abs(bar.open - stop);
      const distToTarget = Math.abs(bar.open - target);
      if (distToStop <= distToTarget) {
        return { exitPrice: stop, reason: 'stop', exitIdx: i, exitTime: pst, _simEntry: entry };
      } else {
        return { exitPrice: target, reason: 'target', exitIdx: i, exitTime: pst, _simEntry: entry };
      }
    }
    if (stopHit) return { exitPrice: stop, reason: 'stop', exitIdx: i, exitTime: pst, _simEntry: entry };
    if (targetHit) return { exitPrice: target, reason: 'target', exitIdx: i, exitTime: pst, _simEntry: entry };
    if (pst.time >= 775) return { exitPrice: bar.close, reason: 'eod', exitIdx: i, exitTime: pst, _simEntry: entry };
  }

  const lastBar = dayBars[dayBars.length - 1];
  return { exitPrice: lastBar.close, reason: 'eod', exitIdx: dayBars.length - 1, exitTime: toPST(lastBar.timestamp), _simEntry: entry };
}

// ── Data loading ──

function loadData(filePath, startDate, endDate) {
  if (!filePath) {
    console.error('Missing data file. Use --leader= and --lagger= to specify.');
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    // Try relative to backtest dir
    const alt = path.join(__dirname, '..', 'backtest', filePath);
    if (fs.existsSync(alt)) filePath = alt;
    else { console.error(`Data file not found: ${filePath}`); process.exit(1); }
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const byTs = {};
  for (const bar of raw) {
    if (bar.close < 5000) continue;
    const dateStr = bar.timestamp.slice(0, 10);
    if (startDate && dateStr < startDate) continue;
    if (endDate && dateStr > endDate) continue;
    if (!byTs[bar.timestamp] || bar.volume > byTs[bar.timestamp].volume)
      byTs[bar.timestamp] = bar;
  }
  return Object.values(byTs).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// ── Core backtest ──

function runDivergenceBacktest(leaderBars, laggerBars, config) {
  const orig = muteConsole();
  try {
    const leaderSpec = config.leaderSpec || MES;
    const laggerSpec = config.laggerSpec || MNQ;

    // Group both by day
    function groupByDay(bars) {
      const dayMap = {};
      for (const bar of bars) {
        const pst = toPST(bar.timestamp);
        if (!isInSession(pst)) continue;
        if (!dayMap[pst.date]) dayMap[pst.date] = [];
        dayMap[pst.date].push({ ...bar, _pst: pst });
      }
      return dayMap;
    }

    const leaderDayMap = groupByDay(leaderBars);
    const laggerDayMap = groupByDay(laggerBars);
    const tradingDays = Object.keys(leaderDayMap).filter(d => laggerDayMap[d]).sort();

    const allTrades = [];
    let equity = config.startingEquity || 1000;
    let peakEquity = equity, maxDD = 0;
    let divergenceSignals = 0;

    // Pre-compute daily H/L/C for seeding
    function dailyHLC(dayMap, days) {
      return days.map(d => {
        const db = dayMap[d];
        return {
          date: d,
          high: Math.max(...db.map(b => b.high)),
          low: Math.min(...db.map(b => b.low)),
          close: db[db.length - 1].close,
        };
      });
    }
    const leaderHLC = dailyHLC(leaderDayMap, tradingDays);
    const laggerHLC = dailyHLC(laggerDayMap, tradingDays);

    // Create persistent strategy instances (single instance across all days)
    const laggerVwap = new VWAPEngine();
    const laggerStrategy = new MNQMomentumStrategyV2({
      ...config,
      vwapEngine: laggerVwap,
      pbEnabled: false, emaxEnabled: false, vrEnabled: false,
      orbEnabled: false, fadeEnabled: false, lbEnabled: false,
      emaPbEnabled: false, vpbEnabled: false, seEnabled: false,
      fthEnabled: false, rangeFadeEnabled: false, bopbEnabled: false,
      drEnabled: false,
      divergenceEnabled: true,
      stopEntryEnabled: true,
      tickSize: laggerSpec.tickSize,
      pointValue: laggerSpec.pointValue,
    });
    laggerStrategy.isActive = true;

    const leaderVwap = new VWAPEngine();
    const leaderStrategy = new MNQMomentumStrategyV2({
      ...config,
      vwapEngine: leaderVwap,
      pbEnabled: false, emaxEnabled: false, vrEnabled: false,
      orbEnabled: false, fadeEnabled: false, lbEnabled: false,
      emaPbEnabled: false, vpbEnabled: false, seEnabled: false,
      fthEnabled: false, rangeFadeEnabled: false, bopbEnabled: false,
      drEnabled: false,
      divergenceEnabled: false,
      tickSize: leaderSpec.tickSize,
      pointValue: leaderSpec.pointValue,
    });
    leaderStrategy.isActive = true;

    // Seed initial daily levels
    const seedCount = Math.min(config.gapAtrPeriod || 14, tradingDays.length - 1);
    if (seedCount > 0) {
      leaderStrategy.seedDailyLevels(leaderHLC.slice(0, seedCount));
      laggerStrategy.seedDailyLevels(laggerHLC.slice(0, seedCount));
    }

    // Create divergence detector (persistent across days)
    const detector = new DivergenceDetector({
      cooldownMs: config.cooldownMs || 300000,
      minBarsBeforeSignal: config.minBarsBeforeSignal || 10,
    });
    detector.register('LEADER', leaderStrategy);
    detector.register('LAGGER', laggerStrategy);

    const signals = [];
    laggerStrategy.on('signal', s => signals.push(s));

    for (let dayIdx = seedCount; dayIdx < tradingDays.length; dayIdx++) {
      const day = tradingDays[dayIdx];
      const leaderDayBars = leaderDayMap[day];
      const laggerDayBars = laggerDayMap[day];
      if (leaderDayBars.length < 10 || laggerDayBars.length < 10) continue;

      // Reset for new day
      laggerVwap.resetDay();
      leaderVwap.resetDay();
      laggerStrategy.resetDay();
      leaderStrategy.resetDay();
      detector.resetDay();
      laggerStrategy.isActive = true;
      leaderStrategy.isActive = true;

      let leaderIdx = 0;
      for (let barIdx = 0; barIdx < laggerDayBars.length; barIdx++) {
        const laggerBar = laggerDayBars[barIdx];
        const laggerTs = new Date(laggerBar.timestamp).getTime();

        // Feed all leader bars up to this timestamp
        while (leaderIdx < leaderDayBars.length) {
          const leaderBar = leaderDayBars[leaderIdx];
          const leaderTs = new Date(leaderBar.timestamp).getTime();
          if (leaderTs > laggerTs) break;
          leaderStrategy.onBar(leaderBar);
          leaderStrategy.onTick({
            price: leaderBar.close, open: leaderBar.open,
            high: leaderBar.high, low: leaderBar.low,
            timestamp: leaderBar.timestamp,
          });
          if (leaderStrategy._dayHigh != null && leaderStrategy._dayLow != null) {
            detector.updateExtreme('LEADER', leaderStrategy._dayHigh, leaderStrategy._dayLow, leaderTs);
          }
          leaderIdx++;
        }

        // Feed lagger bar
        laggerStrategy.onBar(laggerBar);
        laggerStrategy.onTick({
          price: laggerBar.close, open: laggerBar.open,
          high: laggerBar.high, low: laggerBar.low,
          timestamp: laggerBar.timestamp,
        });
        if (laggerStrategy._dayHigh != null && laggerStrategy._dayLow != null) {
          detector.updateExtreme('LAGGER', laggerStrategy._dayHigh, laggerStrategy._dayLow, laggerTs);
        }

        // Process any signals
        while (signals.length > 0) {
          const sig = signals.shift();
          if (sig.strategy !== 'DIVERGE') continue;
          divergenceSignals++;

          const dollarRiskPerContract = sig.stopDistance * laggerSpec.pointValue;
          const maxRisk = config.riskPerTradeMax || 60;
          if (dollarRiskPerContract > maxRisk) {
            laggerStrategy.onSignalRejected();
            continue;
          }

          const numContracts = Math.max(1, Math.min(Math.floor(maxRisk / dollarRiskPerContract), 10));
          const result = simulateTrade(sig, laggerDayBars, barIdx, config, laggerSpec);
          if (!result) continue;

          const simEntry = result._simEntry || sig.price;
          const commission = (config.commissionsEnabled !== false) ? COMMISSION_PER_RT * numContracts : 0;
          const pnlPerContract = (sig.type === 'buy' ? result.exitPrice - simEntry : simEntry - result.exitPrice) * laggerSpec.pointValue;
          const pnl = (pnlPerContract * numContracts) - commission;
          equity += pnl;
          if (equity > peakEquity) peakEquity = equity;
          const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity * 100 : 0;
          if (dd > maxDD) maxDD = dd;

          allTrades.push({
            day, strat: 'DIVERGE', signal: sig.type,
            entry: sig.price, stop: sig.stopLoss, target: sig.targetPrice,
            exit: result.exitPrice, stopDist: sig.stopDistance,
            pnl, reason: result.reason,
            contracts: numContracts,
            equity, dd,
            entryTime: toPST(sig.timestamp).time,
            exitTime: result.exitTime.time,
            rMultiple: sig.stopDistance > 0 ? pnl / (dollarRiskPerContract * numContracts) : 0,
          });

          laggerStrategy.onTradeResult(pnl > 0 ? 'win' : 'loss');
          laggerStrategy.setPosition(null);
          barIdx = result.exitIdx;
        }
      }
    }

    return { trades: allTrades, tradingDays: tradingDays.length - seedCount, divergenceSignals, maxDD, equity };
  } finally {
    restoreConsole(orig);
  }
}

// ── Metrics ──

function computeMetrics(trades, tradingDays, divergenceSignals, maxDD, equity) {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const avgWin = wins.length > 0 ? grossWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;

  const byReason = {};
  for (const t of trades) {
    if (!byReason[t.reason]) byReason[t.reason] = { count: 0, pnl: 0 };
    byReason[t.reason].count++;
    byReason[t.reason].pnl += t.pnl;
  }

  const monthlyPnl = {};
  for (const t of trades) {
    const m = t.day.slice(0, 7);
    if (!monthlyPnl[m]) monthlyPnl[m] = { trades: 0, pnl: 0 };
    monthlyPnl[m].trades++;
    monthlyPnl[m].pnl += t.pnl;
  }

  let maxConsec = 0, cur = 0;
  for (const t of trades) {
    if (t.pnl < 0) { cur++; maxConsec = Math.max(maxConsec, cur); }
    else cur = 0;
  }

  return {
    trades: trades.length,
    tradingDays,
    divergenceSignals,
    signalToTradeRatio: divergenceSignals > 0 ? trades.length / divergenceSignals : 0,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    totalPnl,
    avgWin,
    avgLoss,
    profitFactor: pf,
    maxDD,
    finalEquity: equity,
    maxConsecLosses: maxConsec,
    byReason,
    monthlyPnl,
    period: trades.length > 0 ? `${trades[0].day} to ${trades[trades.length - 1].day}` : 'N/A',
  };
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  let leaderFile = null, laggerFile = null, startDate = null, endDate = null;

  for (const arg of args) {
    if (arg.startsWith('--leader=')) leaderFile = arg.slice(9);
    if (arg.startsWith('--lagger=')) laggerFile = arg.slice(9);
    if (arg.startsWith('--start=')) startDate = arg.slice(8);
    if (arg.startsWith('--end=')) endDate = arg.slice(8);
  }

  if (!leaderFile || !laggerFile) {
    console.error('Usage: node backtest_divergence.js --leader=mes_1m.json --lagger=mnq_1m.json');
    process.exit(1);
  }

  const leaderBars = loadData(leaderFile, startDate, endDate);
  const laggerBars = loadData(laggerFile, startDate, endDate);
  console.log(`Loaded leader: ${leaderBars.length} bars | lagger: ${laggerBars.length} bars`);

  const config = {
    // Divergence config
    divergenceEnabled: true,
    divergenceTargetR: 1.5,
    divergenceMaxTime: 660,
    divergenceMinGapATR: 0.1,
    // Shared config
    gapAtrPeriod: 14,
    maxStopPoints: 35,
    minStopPoints: 5,
    stopBuffer: 2,
    profitTargetR: 1.5,
    minTargetPoints: 10,
    stopEntryEnabled: true,
    stopEntryOffsetTicks: 1,
    stopEntryCancelBars: 3,
    // DivergenceDetector config
    cooldownMs: 300000,
    minBarsBeforeSignal: 10,
    // Contract specs
    leaderSpec: MES,
    laggerSpec: MNQ,
    riskPerTradeMax: 60,
    maxLossesPerDay: 3,
    startingEquity: 1000,
    slippageEnabled: true,
    commissionsEnabled: true,
  };

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  INTER-MARKET DIVERGENCE BACKTEST');
  console.log('  Leader: MES → Lagger: MNQ');
  console.log('═══════════════════════════════════════════════════\n');

  const { trades, tradingDays, divergenceSignals, maxDD, equity } = runDivergenceBacktest(leaderBars, laggerBars, config);
  const metrics = computeMetrics(trades, tradingDays, divergenceSignals, maxDD, equity);

  console.log(`\nPeriod:              ${metrics.period}`);
  console.log(`Trading days:        ${metrics.tradingDays}`);
  console.log(`Divergence signals:  ${metrics.divergenceSignals}`);
  console.log(`Signals → trades:    ${metrics.signalToTradeRatio.toFixed(2)} (ratio)`);
  console.log(`\nTrades:              ${metrics.trades}`);
  console.log(`Wins:                ${metrics.wins}`);
  console.log(`Losses:              ${metrics.losses}`);
  console.log(`Win rate:            ${metrics.winRate.toFixed(1)}%`);
  console.log(`\nTotal P&L:           $${metrics.totalPnl.toFixed(2)}`);
  console.log(`Avg win:             $${metrics.avgWin.toFixed(2)}`);
  console.log(`Avg loss:            $${metrics.avgLoss.toFixed(2)}`);
  console.log(`Profit factor:       ${metrics.profitFactor.toFixed(2)}`);
  console.log(`Max DD:              ${metrics.maxDD.toFixed(1)}%`);
  console.log(`Max consec losses:   ${metrics.maxConsecLosses}`);
  console.log(`Final equity:        $${metrics.finalEquity.toFixed(2)}`);

  console.log('\n── Exit reasons ──');
  for (const [reason, stats] of Object.entries(metrics.byReason)) {
    console.log(`  ${reason}: ${stats.count} trades, $${stats.pnl.toFixed(2)}`);
  }

  console.log('\n── Monthly P&L ──');
  for (const [month, stats] of Object.entries(metrics.monthlyPnl).sort()) {
    const bar = stats.pnl >= 0 ? '🟢' : '🔴';
    console.log(`  ${bar} ${month}: ${stats.trades} trades, $${stats.pnl.toFixed(2)}`);
  }

  if (trades.length > 0 && args.includes('--verbose')) {
    console.log('\n── Trade detail ──');
    console.log('  Day       Dir    Entry    Stop    Target   Exit     P&L      Reason');
    for (const t of trades) {
      console.log(`  ${t.day}  ${t.signal === 'buy' ? 'BUY ' : 'SELL'}  ${t.entry.toFixed(2)}  ${t.stop.toFixed(2)}  ${t.target.toFixed(2)}  ${t.exit.toFixed(2)}  ${t.pnl.toFixed(2).padStart(7)}  ${t.reason}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════════');
  console.log(`  ${metrics.totalPnl > 0 ? '✅ PROFITABLE' : '❌ NOT PROFITABLE'}`);
  console.log('═══════════════════════════════════════════════════\n');
}

main();
