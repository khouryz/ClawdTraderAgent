/**
 * Gap-Fill Fade Backtest
 *
 * Tests the GAPFILL strategy in isolation by running the actual
 * MNQMomentumStrategyV2 with only gapFillEnabled=true and all other
 * sub-strategies disabled. Uses the same simulateTrade / session model
 * as the production backtest engine.
 *
 * Usage:
 *   node scripts/backtest_gapfill.js                    # default 12-month range
 *   node scripts/backtest_gapfill.js --data=mnq_1m.json # custom data file
 *   node scripts/backtest_gapfill.js --start=2025-06-01 --end=2026-02-28
 *
 * Data file: JSON array of 1m OHLCV bars with .timestamp (ISO string),
 *            .open, .high, .low, .close, .volume
 *            Place in backtest/ dir or pass --data=/path/to/file.json
 */

const fs = require('fs');
const path = require('path');

// Resolve strategy from the CTA-fanout src
const MNQMomentumStrategyV2 = require('../src/strategies/mnq_momentum_strategy_v2');
const VWAPEngine = require('../src/indicators/VWAPEngine');

const MNQ = { tickSize: 0.25, tickValue: 0.50, pointValue: 2.0 };
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

function simulateTrade(signal, dayBars, entryBarIdx, config) {
  const dir = signal.type === 'buy' ? 1 : -1;
  const slippagePts = (config.slippageEnabled !== false) ? Math.random() * 0.75 : 0;
  const entry = signal.type === 'buy'
    ? signal.price + slippagePts
    : signal.price - slippagePts;
  let stop = signal.stopLoss;
  const target = signal.targetPrice
    ? signal.targetPrice
    : (signal.type === 'buy'
        ? entry + signal.stopDistance * (config.profitTargetR || 1.5)
        : entry - signal.stopDistance * (config.profitTargetR || 1.5));

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

function loadData(startDate, endDate, dataFile) {
  const candidates = dataFile
    ? [dataFile]
    : [
        path.join(__dirname, '..', 'backtest', 'mnq_1m_12months.json'),
        path.join(__dirname, '..', 'backtest', 'mnq_1m_feb2_13.json'),
        path.join(__dirname, '..', 'backtest', 'mnq_last35_fresh.json'),
      ];
  let file;
  for (const f of candidates) {
    if (fs.existsSync(f)) { file = f; break; }
  }
  if (!file) {
    console.error('No data file found. Place a JSON 1m bar file in backtest/ or pass --data=/path/to/file.json');
    process.exit(1);
  }
  console.log(`Loading data from: ${file}`);

  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
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

function runGapFillBacktest(bars, config) {
  const orig = muteConsole();
  try {
    const vwapEngine = new VWAPEngine();
    const allTrades = [];
    const startingEquity = config.startingEquity || 1000;
    let equity = startingEquity, peakEquity = startingEquity, maxDD = 0;

    // Group by day
    const dayMap = {};
    for (const bar of bars) {
      const pst = toPST(bar.timestamp);
      if (!isInSession(pst)) continue;
      if (!dayMap[pst.date]) dayMap[pst.date] = [];
      dayMap[pst.date].push({ ...bar, _pst: pst });
    }

    const tradingDays = Object.keys(dayMap).sort();
    let gapDays = 0, tradeableGapDays = 0;

    // Pre-compute daily H/L/C for seeding prior-day levels
    const dailyHLC = tradingDays.map(d => {
      const db = dayMap[d];
      return {
        date: d,
        high: Math.max(...db.map(b => b.high)),
        low: Math.min(...db.map(b => b.low)),
        close: db[db.length - 1].close,
      };
    });

    // Use a single strategy instance across all days so resetDay() rolls
    // _dayHigh/_dayLow/_dayClose into _pdh/_pdl/_pdc and accumulates _dailyATR.
    const strategy = new MNQMomentumStrategyV2({
      ...config,
      vwapEngine,
      // Disable ALL other strategies — isolate gap-fill
      pbEnabled: false,
      emaxEnabled: false,
      vrEnabled: false,
      orbEnabled: false,
      fadeEnabled: false,
      lbEnabled: false,
      emaPbEnabled: false,
      vpbEnabled: false,
      seEnabled: false,
      fthEnabled: false,
      rangeFadeEnabled: false,
      bopbEnabled: false,
      drEnabled: false,
      // Enable gap-fill
      gapFillEnabled: true,
      stopEntryEnabled: true,
    });
    strategy.isActive = true;

    const signals = [];
    strategy.on('signal', s => signals.push(s));

    // Seed initial daily levels from first gapAtrPeriod days so _pdc/_dailyATR
    // are available from the very first tradeable day
    const seedCount = Math.min(config.gapAtrPeriod || 14, dailyHLC.length - 1);
    if (seedCount > 0) {
      strategy.seedDailyLevels(dailyHLC.slice(0, seedCount));
    }

    // Start trading after the seed days
    for (let dayIdx = seedCount; dayIdx < tradingDays.length; dayIdx++) {
      const day = tradingDays[dayIdx];
      const dayBars = dayMap[day];
      if (dayBars.length < 10) continue;

      // Reset strategy for new day (rolls prior session's H/L/C into _pdh/_pdl/_pdc)
      vwapEngine.resetDay();
      strategy.resetDay();
      strategy.isActive = true;

      for (let barIdx = 0; barIdx < dayBars.length; barIdx++) {
        strategy.onBar(dayBars[barIdx]);
        // Call onTick with 1m bar OHLC so armed stop-entries can trigger
        // (matches production InstrumentRunner which calls both onBar + onTick)
        strategy.onTick({
          price: dayBars[barIdx].close,
          open: dayBars[barIdx].open,
          high: dayBars[barIdx].high,
          low: dayBars[barIdx].low,
          timestamp: dayBars[barIdx].timestamp,
        });

        if (signals.length > 0) {
          const sig = signals.shift();
          if (sig.strategy !== 'GAPFILL') { signals.length = 0; continue; }

          const dollarRiskPerContract = sig.stopDistance * MNQ.pointValue;
          const maxRisk = config.riskPerTradeMax || 60;
          if (dollarRiskPerContract > maxRisk) {
            strategy.onSignalRejected();
            signals.length = 0;
            continue;
          }

          const numContracts = Math.max(1, Math.min(Math.floor(maxRisk / dollarRiskPerContract), 10));
          const result = simulateTrade(sig, dayBars, barIdx, config);
          if (!result) { signals.length = 0; continue; }

          const simEntry = result._simEntry || sig.price;
          const commission = (config.commissionsEnabled !== false) ? COMMISSION_PER_RT * numContracts : 0;
          const pnlPerContract = (sig.type === 'buy' ? result.exitPrice - simEntry : simEntry - result.exitPrice) * MNQ.pointValue;
          const pnl = (pnlPerContract * numContracts) - commission;
          equity += pnl;
          if (equity > peakEquity) peakEquity = equity;
          const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity * 100 : 0;
          if (dd > maxDD) maxDD = dd;

          allTrades.push({
            day, strat: 'GAPFILL', signal: sig.type,
            entry: sig.price, stop: sig.stopLoss, target: sig.targetPrice,
            exit: result.exitPrice, stopDist: sig.stopDistance,
            pnl, reason: result.reason,
            contracts: numContracts,
            equity, dd,
            entryTime: toPST(sig.timestamp).time,
            exitTime: result.exitTime.time,
            rMultiple: sig.stopDistance > 0 ? pnl / (dollarRiskPerContract * numContracts) : 0,
          });

          strategy.onTradeResult(pnl > 0 ? 'win' : 'loss');
          strategy.setPosition(null);
          barIdx = result.exitIdx;
          signals.length = 0;
        }
      }

      // Track gap stats
      if (strategy._todayGapATR != null && Math.abs(strategy._todayGapATR) > 0.01) {
        gapDays++;
        if (Math.abs(strategy._todayGapATR) >= config.gapFillMinATR &&
            Math.abs(strategy._todayGapATR) <= config.gapFillMaxATR) {
          tradeableGapDays++;
        }
      }
    }

    return { trades: allTrades, tradingDays: tradingDays.length - seedCount, gapDays, tradeableGapDays, maxDD, equity };
  } finally {
    restoreConsole(orig);
  }
}

// ── Metrics ──

function computeMetrics(trades, tradingDays, gapDays, tradeableGapDays, maxDD, equity) {
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
    gapDays,
    tradeableGapDays,
    tradesPerGapDay: tradeableGapDays > 0 ? trades.length / tradeableGapDays : 0,
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
  let dataFile = null, startDate = null, endDate = null;

  for (const arg of args) {
    if (arg.startsWith('--data=')) dataFile = arg.slice(7);
    if (arg.startsWith('--start=')) startDate = arg.slice(8);
    if (arg.startsWith('--end=')) endDate = arg.slice(8);
  }

  const bars = loadData(startDate, endDate, dataFile);
  console.log(`Loaded ${bars.length} bars`);

  const config = {
    // Gap-Fill config
    gapFillEnabled: true,
    gapFillMinATR: 0.25,
    gapFillMaxATR: 1.5,
    gapFillTargetR: 1.5,
    gapFillMaxTime: 600,
    gapFillMaxStopPts: 0,
    gapFillRequireExtend: true,
    gapFillMinExtendATR: 0.15,
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
    tickSize: MNQ.tickSize,
    pointValue: MNQ.pointValue,
    riskPerTradeMax: 60,
    maxLossesPerDay: 3,
    startingEquity: 1000,
    slippageEnabled: true,
    commissionsEnabled: true,
  };

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  GAP-FILL FADE BACKTEST');
  console.log('═══════════════════════════════════════════════════\n');

  const { trades, tradingDays, gapDays, tradeableGapDays, maxDD, equity } = runGapFillBacktest(bars, config);
  const metrics = computeMetrics(trades, tradingDays, gapDays, tradeableGapDays, maxDD, equity);

  console.log(`\nPeriod:              ${metrics.period}`);
  console.log(`Trading days:        ${metrics.tradingDays}`);
  console.log(`Gap days (any):      ${metrics.gapDays}`);
  console.log(`Tradeable gap days:  ${metrics.tradeableGapDays} (gap in [${config.gapFillMinATR}, ${config.gapFillMaxATR}] ATR)`);
  console.log(`\nTrades:              ${metrics.trades}`);
  console.log(`Trades/gap day:      ${metrics.tradesPerGapDay.toFixed(2)}`);
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

  // Per-trade detail
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
