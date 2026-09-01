/**
 * VWAP Scalper Backtest
 *
 * Tests the VWAP Reversion Scalper strategy on MNQ 1m data.
 * Supports JSONL (one bar per line) and JSON array formats.
 *
 * Usage:
 *   node scripts/backtest_scalper.js --data=research/data/mnq_1m_2025_2026.jsonl
 *   node scripts/backtest_scalper.js --data=research/data/mnq_1m_2025_2026.jsonl --start=2025-06-01 --end=2026-01-01
 *   node scripts/backtest_scalper.js --data=research/data/mnq_1m_2025_2026.jsonl --slippage=0.5 --commission=0.62
 *
 * Data format: JSONL (one JSON object per line) or JSON array, each with:
 *   { timestamp, open, high, low, close, volume }
 *   timestamp: ISO string or "YYYY-MM-DD HH:MM:SS+00:00"
 */

const fs = require('fs');
const path = require('path');

const VWAPScalper = require('../src/strategies/vwap_scalper');

// ── Constants ──
const MNQ = { tickSize: 0.25, tickValue: 0.50, pointValue: 2.0 };
const COMMISSION_PER_RT = 0.62;
const DEFAULT_SLIPPAGE = 0.5; // points

// ── CLI Args ──
function parseArgs() {
  const args = {};
  for (const arg of process.argv.slice(2)) {
    const [k, v] = arg.split('=');
    args[k.replace(/^--/, '')] = v !== undefined ? v : true;
  }
  return args;
}

// ── Time Helpers ──
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
  if (p.time < 390 || p.time >= 780) return false; // 6:30 AM – 1:00 PM PST
  return true;
}

// ── Data Loading ──
function loadData(filepath) {
  if (!fs.existsSync(filepath)) {
    // Try relative to project root
    filepath = path.resolve(process.cwd(), filepath);
  }
  if (!fs.existsSync(filepath)) {
    // Try in backtest/ dir
    const alt = path.join(process.cwd(), 'backtest', filepath);
    if (fs.existsSync(alt)) filepath = alt;
  }
  if (!fs.existsSync(filepath)) {
    console.error(`Data file not found: ${filepath}`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filepath, 'utf8').trim();

  let bars;
  // Try JSON array first
  if (raw.startsWith('[')) {
    bars = JSON.parse(raw);
  } else {
    // JSONL format
    const lines = raw.split('\n').filter(l => l.trim());
    bars = lines.map(line => JSON.parse(line));
  }

  // Price sanity + same-timestamp dedup (mirrors SharedPriceProvider contract lock):
  //   1. Skip corrupt bars (close < 5000 — bad data ticks where price jumps to ~200)
  //   2. Dedup by timestamp: keep the higher-volume bar (front month wins, same as live)
  const byTs = {};
  for (const bar of bars) {
    if (bar.close < 5000) continue;  // corrupt bar filter
    if (!byTs[bar.timestamp] || bar.volume > byTs[bar.timestamp].volume) {
      byTs[bar.timestamp] = bar;
    }
  }
  return Object.values(byTs).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

// ── Console Suppression ──
function muteConsole() {
  const orig = { log: console.log, warn: console.warn, info: console.info };
  console.log = () => {};
  console.warn = () => {};
  console.info = () => {};
  return orig;
}

function restoreConsole(orig) {
  console.log = orig.log;
  console.warn = orig.warn;
  console.info = orig.info;
}

// ── Trade Simulation ──
function simulateTrade(signal, dayBars, entryBarIdx, config) {
  const dir = signal.type === 'buy' ? 1 : -1;
  const slippagePts = config.slippageEnabled !== false ? (Math.random() * config.slippage) : 0;
  const entry = signal.type === 'buy'
    ? signal.price + slippagePts
    : signal.price - slippagePts;

  const stop = signal.stopLoss;
  const target = signal.targetPrice;
  const contracts = signal.contracts || 1;
  const maxHoldBars = signal.maxHoldBars || 15;
  const timeStopEnabled = signal.timeStopEnabled !== false;
  const beTriggerR = signal.beTriggerR || 0.5;
  const beEnabled = signal.moveStopToBE !== false;

  let beStop = null;
  let beActivated = false;
  const stopDist = Math.abs(entry - stop);
  const beTriggerPts = stopDist * beTriggerR;

  for (let i = entryBarIdx + 1; i < dayBars.length; i++) {
    const bar = dayBars[i];
    const barsHeld = i - entryBarIdx;

    // Check BE activation
    if (beEnabled && !beActivated) {
      const profitPts = dir === 1 ? (bar.high - entry) : (entry - bar.low);
      if (profitPts >= beTriggerPts) {
        beActivated = true;
        beStop = entry; // Move stop to entry
        // If target is also hit on THIS bar, count it as a win (target takes priority)
        let targetHitSameBar = false;
        if (dir === 1 && bar.high >= target) targetHitSameBar = true;
        if (dir === -1 && bar.low <= target) targetHitSameBar = true;
        if (targetHitSameBar) {
          return result('win', entry, target, contracts, barsHeld, signal, config, bar.timestamp);
        }
      }
    }

    // Determine effective stop (BE if activated, else original)
    const effectiveStop = beActivated ? beStop : stop;

    // Check stop hit
    let stopHit = false;
    if (dir === 1 && bar.low <= effectiveStop) stopHit = true;
    if (dir === -1 && bar.high >= effectiveStop) stopHit = true;

    // Check target hit
    let targetHit = false;
    if (dir === 1 && bar.high >= target) targetHit = true;
    if (dir === -1 && bar.low <= target) targetHit = true;

    // Both hit in same bar — assume stop first (conservative)
    if (stopHit && targetHit) {
      // If BE activated, it's a breakeven; else it's a loss
      if (beActivated) {
        return result('breakeven', entry, beStop, contracts, barsHeld, signal, config, bar.timestamp);
      }
      return result('loss', entry, stop, contracts, barsHeld, signal, config, bar.timestamp);
    }

    if (targetHit) {
      return result('win', entry, target, contracts, barsHeld, signal, config, bar.timestamp);
    }

    if (stopHit) {
      if (beActivated) {
        return result('breakeven', entry, beStop, contracts, barsHeld, signal, config, bar.timestamp);
      }
      return result('loss', entry, stop, contracts, barsHeld, signal, config, bar.timestamp);
    }

    // Time stop
    if (timeStopEnabled && barsHeld >= maxHoldBars) {
      const exitPrice = bar.close;
      const pnlPts = dir === 1 ? (exitPrice - entry) : (entry - exitPrice);
      const pnl = pnlPts * MNQ.pointValue * contracts - (COMMISSION_PER_RT * contracts);
      if (pnl > 0) return result('win', entry, exitPrice, contracts, barsHeld, signal, config, bar.timestamp, true);
      if (pnl < 0) return result('loss', entry, exitPrice, contracts, barsHeld, signal, config, bar.timestamp, true);
      return result('breakeven', entry, exitPrice, contracts, barsHeld, signal, config, bar.timestamp, true);
    }
  }

  // End of day — exit at last bar close
  const lastBar = dayBars[dayBars.length - 1];
  const exitPrice = lastBar.close;
  const pnlPts = dir === 1 ? (exitPrice - entry) : (entry - exitPrice);
  const pnl = pnlPts * MNQ.pointValue * contracts - (COMMISSION_PER_RT * contracts);
  if (pnl > 0) return result('win', entry, exitPrice, contracts, dayBars.length - entryBarIdx, signal, config, lastBar.timestamp, true);
  if (pnl < 0) return result('loss', entry, exitPrice, contracts, dayBars.length - entryBarIdx, signal, config, lastBar.timestamp, true);
  return result('breakeven', entry, exitPrice, contracts, dayBars.length - entryBarIdx, signal, config, lastBar.timestamp, true);

  function result(outcome, entryPrice, exitPrice, qty, barsHeld, sig, cfg, exitTime, isTimeExit) {
    const pnlPts = dir === 1 ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
    const grossPnL = pnlPts * MNQ.pointValue * qty;
    const commission = COMMISSION_PER_RT * qty;
    const netPnL = grossPnL - commission;
    return {
      outcome, entryPrice, exitPrice, qty, barsHeld,
      pnlPts, grossPnL, commission, netPnL,
      strategy: sig.strategy, side: sig.type,
      stopDist: sig.stopDistance, targetDist: sig.targetDistance,
      rMultiple: pnlPts / sig.stopDistance,
      timestamp: sig.timestamp,
      exitTime: exitTime || exitPrice,
      isTimeExit: !!isTimeExit,
      contracts: qty,
    };
  }
}

// ── Main Backtest ──
async function main() {
  const args = parseArgs();
  const dataFile = args.data || 'research/data/mnq_1m_2025_2026.jsonl';
  const startDate = args.start;
  const endDate = args.end;
  const slippage = parseFloat(args.slippage !== undefined ? args.slippage : DEFAULT_SLIPPAGE);
  const commission = parseFloat(args.commission !== undefined ? args.commission : COMMISSION_PER_RT);
  const verbose = args.verbose === true || args.v === true;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('  VWAP Reversion Scalper — Backtest');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Data:     ${dataFile}`);
  console.log(`  Slippage: ${slippage} pts`);
  console.log(`  Commission: $${commission}/RT`);
  console.log(`  MNQ:      tick=${MNQ.tickSize}, pointValue=$${MNQ.pointValue}`);
  if (startDate) console.log(`  Start:    ${startDate}`);
  if (endDate) console.log(`  End:      ${endDate}`);
  console.log('');

  // Load data
  console.log('Loading data...');
  const allBars = loadData(dataFile);
  console.log(`Loaded ${allBars.length} bars`);

  // Filter by date range
  let bars = allBars;
  if (startDate) {
    const startMs = new Date(startDate + 'T00:00:00Z').getTime();
    bars = bars.filter(b => new Date(b.timestamp).getTime() >= startMs);
  }
  if (endDate) {
    const endMs = new Date(endDate + 'T23:59:59Z').getTime();
    bars = bars.filter(b => new Date(b.timestamp).getTime() <= endMs);
  }

  // Group by day
  const dayMap = new Map();
  for (const bar of bars) {
    const p = toPST(bar.timestamp);
    if (!isInSession(p)) continue;
    if (!dayMap.has(p.date)) dayMap.set(p.date, []);
    dayMap.get(p.date).push(bar);
  }

  const sortedDays = [...dayMap.keys()].sort();
  console.log(`Session days: ${sortedDays.length}`);
  console.log(`Date range: ${sortedDays[0]} to ${sortedDays[sortedDays.length - 1]}`);
  console.log('');

  // Strategy config
  const strategyConfig = {
    instrumentLabel: 'MNQ',
    pointValue: MNQ.pointValue,
    tickSize: MNQ.tickSize,
    riskPerTrade: 60,
    maxContracts: 10,
    stretchSigma: 0.7,
    reversionTargetR: 1.5,
    maxStopPoints: 12,
    minStopPoints: 4,
    stopBuffer: 1.0,
    minTargetPoints: 5,
    maxTargetPoints: 20,
    beEnabled: true,
    beTriggerR: 0.75,
    timeStopEnabled: true,
    maxHoldBars: 15,
    minBarsBeforeSignal: 30,
    sessionStartMin: 390,
    sessionEndMin: 660,
    volumeFilterEnabled: true,
    volumeFilterMin: 0.5,
    volumeFilterPeriod: 20,
    rsiEnabled: true,
    rsiPeriod: 7,
    rsiOversold: 45,
    rsiOverbought: 55,
    maxTradesPerDay: 8,
    cooldownBars: 3,
    maxConsecLosses: 3,
    entryOrderType: 'Market',
  };

  const backtestConfig = {
    slippageEnabled: true,
    slippage: slippage,
  };

  // Results
  const trades = [];
  const dailyResults = [];
  let accountBalance = 1000;
  let peakBalance = 1000;
  let maxDrawdown = 0;
  let maxDrawdownPct = 0;

  const orig = muteConsole();

  for (const day of sortedDays) {
    const dayBars = dayMap.get(day);
    if (dayBars.length < 30) continue;

    // Create fresh strategy instance for each day
    const strategy = new VWAPScalper({ ...strategyConfig });

    // Seed prior day levels from previous day's bars
    const dayIdx = sortedDays.indexOf(day);
    if (dayIdx > 0) {
      const prevDay = sortedDays[dayIdx - 1];
      const prevBars = dayMap.get(prevDay);
      if (prevBars && prevBars.length > 0) {
        const dailyHLC = [{
          high: Math.max(...prevBars.map(b => b.high)),
          low: Math.min(...prevBars.map(b => b.low)),
          close: prevBars[prevBars.length - 1].close,
        }];
        strategy.seedDailyLevels(dailyHLC);
      }
    }

    // Collect signals
    const daySignals = [];
    strategy.on('signal', (signal) => {
      // Find the bar index for entry
      const entryBarIdx = dayBars.findIndex(b => b.timestamp === signal.timestamp.getTime() ||
        new Date(b.timestamp).getTime() === new Date(signal.timestamp).getTime());
      if (entryBarIdx === -1) return;

      // Simulate the trade
      const trade = simulateTrade(signal, dayBars, entryBarIdx, backtestConfig);
      if (trade) {
        trade.date = day;
        trades.push(trade);

        // Update strategy state
        strategy.setPosition(null);
        strategy.onTradeResult(trade.outcome);

        // Update account
        accountBalance += trade.netPnL;
        if (accountBalance > peakBalance) peakBalance = accountBalance;
        const dd = peakBalance - accountBalance;
        const ddPct = (dd / peakBalance) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
        if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct;

        if (verbose) {
          restoreConsole(orig);
          console.log(`  ${day} ${trade.side === 'buy' ? 'LONG ' : 'SHORT'} | ${trade.outcome.toUpperCase().padEnd(9)} | ${trade.pnlPts >= 0 ? '+' : ''}${trade.pnlPts.toFixed(1)}pt | $${trade.netPnL >= 0 ? '+' : ''}${trade.netPnL.toFixed(2)} | ${trade.barsHeld}bars | bal $${accountBalance.toFixed(0)}`);
          muteConsole();
        }
      }
    });

    // Feed bars to strategy
    for (const bar of dayBars) {
      strategy.onBar(bar);
    }

    // Daily summary
    const dayTrades = trades.filter(t => t.date === day);
    if (dayTrades.length > 0) {
      const dayPnL = dayTrades.reduce((s, t) => s + t.netPnL, 0);
      const wins = dayTrades.filter(t => t.outcome === 'win').length;
      const losses = dayTrades.filter(t => t.outcome === 'loss').length;
      const bes = dayTrades.filter(t => t.outcome === 'breakeven').length;
      dailyResults.push({ date: day, trades: dayTrades.length, wins, losses, bes, pnl: dayPnL });
    }
  }

  restoreConsole(orig);

  // ═══════════════════════════════════════════════════════════════
  //  RESULTS
  // ═══════════════════════════════════════════════════════════════

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BACKTEST RESULTS');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');

  const totalTrades = trades.length;
  const wins = trades.filter(t => t.outcome === 'win').length;
  const losses = trades.filter(t => t.outcome === 'loss').length;
  const bes = trades.filter(t => t.outcome === 'breakeven').length;
  const winRate = totalTrades > 0 ? (wins / totalTrades * 100).toFixed(1) : '0.0';
  const lossRate = totalTrades > 0 ? (losses / totalTrades * 100).toFixed(1) : '0.0';
  const beRate = totalTrades > 0 ? (bes / totalTrades * 100).toFixed(1) : '0.0';

  const totalPnL = trades.reduce((s, t) => s + t.netPnL, 0);
  const grossProfit = trades.filter(t => t.netPnL > 0).reduce((s, t) => s + t.netPnL, 0);
  const grossLoss = Math.abs(trades.filter(t => t.netPnL < 0).reduce((s, t) => s + t.netPnL, 0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞';

  const avgWin = wins > 0 ? (grossProfit / wins).toFixed(2) : '0.00';
  const avgLoss = losses > 0 ? (grossLoss / losses).toFixed(2) : '0.00';
  const avgRMultiple = totalTrades > 0 ? (trades.reduce((s, t) => s + t.rMultiple, 0) / totalTrades).toFixed(2) : '0.00';
  const avgBarsHeld = totalTrades > 0 ? (trades.reduce((s, t) => s + t.barsHeld, 0) / totalTrades).toFixed(1) : '0';

  const longTrades = trades.filter(t => t.side === 'buy');
  const shortTrades = trades.filter(t => t.side === 'sell');
  const longPnL = longTrades.reduce((s, t) => s + t.netPnL, 0);
  const shortPnL = shortTrades.reduce((s, t) => s + t.netPnL, 0);
  const longWR = longTrades.length > 0 ? (longTrades.filter(t => t.outcome === 'win').length / longTrades.length * 100).toFixed(1) : '0.0';
  const shortWR = shortTrades.length > 0 ? (shortTrades.filter(t => t.outcome === 'win').length / shortTrades.length * 100).toFixed(1) : '0.0';

  // Consecutive losses
  let maxConsecLosses = 0;
  let currentConsecLosses = 0;
  for (const t of trades) {
    if (t.outcome === 'loss') {
      currentConsecLosses++;
      if (currentConsecLosses > maxConsecLosses) maxConsecLosses = currentConsecLosses;
    } else {
      currentConsecLosses = 0;
    }
  }

  // Consecutive wins
  let maxConsecWins = 0;
  let currentConsecWins = 0;
  for (const t of trades) {
    if (t.outcome === 'win') {
      currentConsecWins++;
      if (currentConsecWins > maxConsecWins) maxConsecWins = currentConsecWins;
    } else {
      currentConsecWins = 0;
    }
  }

  // Time exits
  const timeExits = trades.filter(t => t.isTimeExit).length;
  const timeExitPct = totalTrades > 0 ? (timeExits / totalTrades * 100).toFixed(1) : '0.0';

  // Best/worst trades
  const bestTrade = trades.length > 0 ? Math.max(...trades.map(t => t.netPnL)) : 0;
  const worstTrade = trades.length > 0 ? Math.min(...trades.map(t => t.netPnL)) : 0;

  // Daily stats
  const profitableDays = dailyResults.filter(d => d.pnl > 0).length;
  const losingDays = dailyResults.filter(d => d.pnl < 0).length;
  const flatDays = dailyResults.filter(d => d.pnl === 0).length;
  const noTradeDays = sortedDays.length - dailyResults.length;
  const avgDailyPnL = dailyResults.length > 0 ? (totalPnL / dailyResults.length).toFixed(2) : '0.00';
  const bestDay = dailyResults.length > 0 ? Math.max(...dailyResults.map(d => d.pnl)).toFixed(2) : '0.00';
  const worstDay = dailyResults.length > 0 ? Math.min(...dailyResults.map(d => d.pnl)).toFixed(2) : '0.00';

  // Return
  const totalReturn = ((totalPnL / 1000) * 100).toFixed(1);

  console.log(`  Total Trades:        ${totalTrades}`);
  console.log(`  Wins:                ${wins} (${winRate}%)`);
  console.log(`  Losses:              ${losses} (${lossRate}%)`);
  console.log(`  Breakevens:          ${bes} (${beRate}%)`);
  console.log('');
  console.log(`  Net P&L:             $${totalPnL.toFixed(2)}`);
  console.log(`  Gross Profit:        $${grossProfit.toFixed(2)}`);
  console.log(`  Gross Loss:          $${grossLoss.toFixed(2)}`);
  console.log(`  Profit Factor:       ${profitFactor}`);
  console.log(`  Return:              ${totalReturn}% (on $1,000)`);
  console.log('');
  console.log(`  Avg Win:             $${avgWin}`);
  console.log(`  Avg Loss:            $${avgLoss}`);
  console.log(`  Avg R Multiple:      ${avgRMultiple}R`);
  console.log(`  Avg Bars Held:       ${avgBarsHeld} (min)`);
  console.log('');
  console.log(`  Max Consec Wins:     ${maxConsecWins}`);
  console.log(`  Max Consec Losses:   ${maxConsecLosses}`);
  console.log(`  Best Trade:          $${bestTrade.toFixed(2)}`);
  console.log(`  Worst Trade:         $${worstTrade.toFixed(2)}`);
  console.log('');
  console.log(`  Longs:               ${longTrades.length} trades, ${longWR}% WR, $${longPnL.toFixed(2)}`);
  console.log(`  Shorts:              ${shortTrades.length} trades, ${shortWR}% WR, $${shortPnL.toFixed(2)}`);
  console.log('');
  console.log(`  Time Exits:          ${timeExits} (${timeExitPct}%)`);
  console.log('');
  console.log(`  Peak Balance:        $${peakBalance.toFixed(2)}`);
  console.log(`  Final Balance:       $${accountBalance.toFixed(2)}`);
  console.log(`  Max Drawdown:        $${maxDrawdown.toFixed(2)} (${maxDrawdownPct.toFixed(1)}%)`);
  console.log('');
  console.log(`  Trading Days:        ${dailyResults.length} (with trades)`);
  console.log(`  No-Trade Days:       ${noTradeDays}`);
  console.log(`  Profitable Days:     ${profitableDays}`);
  console.log(`  Losing Days:         ${losingDays}`);
  console.log(`  Avg Daily P&L:       $${avgDailyPnL}`);
  console.log(`  Best Day:            $${bestDay}`);
  console.log(`  Worst Day:           $${worstDay}`);
  console.log('');

  // Monthly breakdown
  const monthlyMap = new Map();
  for (const t of trades) {
    const month = t.date.substring(0, 7);
    if (!monthlyMap.has(month)) monthlyMap.set(month, { trades: 0, wins: 0, losses: 0, bes: 0, pnl: 0 });
    const m = monthlyMap.get(month);
    m.trades++;
    if (t.outcome === 'win') m.wins++;
    else if (t.outcome === 'loss') m.losses++;
    else m.bes++;
    m.pnl += t.netPnL;
  }

  console.log('  ── Monthly Breakdown ──');
  console.log('  Month       Trades  W/L/BE    WR%     P&L');
  console.log('  ───────────────────────────────────────────');
  for (const [month, m] of monthlyMap) {
    const wr = m.trades > 0 ? (m.wins / m.trades * 100).toFixed(0) : '0';
    console.log(`  ${month}    ${String(m.trades).padStart(5)}   ${String(m.wins).padStart(2)}/${String(m.losses).padStart(2)}/${String(m.bes).padStart(2)}    ${wr.padStart(3)}%   $${m.pnl.toFixed(2).padStart(8)}`);
  }
  console.log('');

  // Sample trades
  if (trades.length > 0 && !verbose) {
    console.log('  ── First 10 Trades ──');
    for (const t of trades.slice(0, 10)) {
      console.log(`  ${t.date} ${t.side === 'buy' ? 'LONG ' : 'SHORT'} | ${t.outcome.toUpperCase().padEnd(9)} | ${t.pnlPts >= 0 ? '+' : ''}${t.pnlPts.toFixed(1)}pt | $${t.netPnL >= 0 ? '+' : ''}${t.netPnL.toFixed(2)} | ${t.barsHeld}bars${t.isTimeExit ? ' (time)' : ''}`);
    }
    console.log('');
    console.log('  ── Last 10 Trades ──');
    for (const t of trades.slice(-10)) {
      console.log(`  ${t.date} ${t.side === 'buy' ? 'LONG ' : 'SHORT'} | ${t.outcome.toUpperCase().padEnd(9)} | ${t.pnlPts >= 0 ? '+' : ''}${t.pnlPts.toFixed(1)}pt | $${t.netPnL >= 0 ? '+' : ''}${t.netPnL.toFixed(2)} | ${t.barsHeld}bars${t.isTimeExit ? ' (time)' : ''}`);
    }
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
}

main().catch(err => {
  console.error('Backtest error:', err);
  process.exit(1);
});
