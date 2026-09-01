/**
 * Backtest harness for TrendPullback strategy.
 *
 * Feeds 1m bars to the strategy, simulates stop-entry fills on 1m bar highs/lows,
 * then tracks the position through subsequent bars checking stop/target/BE/time exits.
 *
 * Usage:
 *   node scripts/backtest_trend_pullback.js --data <file.json> --instrument MNQ
 *
 * Data file format: JSON array of { timestamp, open, high, low, close, volume }
 * (1m bars, UTC timestamps, sorted ascending)
 *
 * Or reads from Databento historical pull if available on server.
 */

const fs = require('fs');
const path = require('path');
const TrendPullback = require('../src/strategies/trend_pullback');
const { CONTRACTS } = require('../src/utils/constants');

// ── Parse CLI args ──
function parseArgs() {
  const args = {};
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        const k = arg.slice(2, eqIdx);
        const v = arg.slice(eqIdx + 1);
        args[k] = v;
      } else {
        const k = arg.slice(2);
        if (i + 1 < raw.length && !raw[i + 1].startsWith('--')) {
          args[k] = raw[i + 1];
          i++;
        } else {
          args[k] = true;
        }
      }
    }
  }
  return args;
}

// ── Contract specs ──
function getSpecs(instrument) {
  const base = String(instrument).substring(0, 3);
  return CONTRACTS[base] || CONTRACTS.MES;
}

// ── Simulate a single trade ──
function simulateTrade(signal, dayBars, entryIdx, config, specs) {
  const dir = signal.type === 'buy' ? 1 : -1;
  const slippageTicks = config.slippageTicks || 2;
  const slippage = slippageTicks * specs.tickSize;
  const entry = signal.type === 'buy'
    ? signal.price + slippage
    : signal.price - slippage;

  const stop = signal.stopLoss;
  const target = signal.targetPrice;
  const stopDist = Math.abs(entry - stop);
  const targetDist = Math.abs(target - entry);

  // BE config
  const beEnabled = signal.moveStopToBE !== false;
  const beTriggerR = signal.beActivationR || 1.0;
  const beTriggerPts = stopDist * beTriggerR;

  // Time stop
  const timeStopBars = config.timeStopBars || 12; // 5m bars
  const maxHold1mBars = timeStopBars * 5;

  let beActivated = false;
  let beStop = null;

  for (let i = entryIdx + 1; i < dayBars.length; i++) {
    const bar = dayBars[i];
    const barsHeld = i - entryIdx;

    // ── Check BE activation ──
    if (beEnabled && !beActivated) {
      const profitPts = dir === 1 ? (bar.high - entry) : (entry - bar.low);
      if (profitPts >= beTriggerPts) {
        beActivated = true;
        beStop = entry;
        // If target hit on same bar, count as win
        const targetHitSameBar = dir === 1 ? bar.high >= target : bar.low <= target;
        if (targetHitSameBar) {
          return makeResult('win', entry, target, barsHeld, signal, specs, config);
        }
      }
    }

    const effectiveStop = beActivated ? beStop : stop;

    // ── Stop and target checks ──
    const stopHit = dir === 1 ? bar.low <= effectiveStop : bar.high >= effectiveStop;
    const targetHit = dir === 1 ? bar.high >= target : bar.low <= target;

    if (stopHit && targetHit) {
      // Conservative: assume stop first
      if (beActivated) {
        return makeResult('breakeven', entry, beStop, barsHeld, signal, specs, config);
      }
      return makeResult('loss', entry, stop, barsHeld, signal, specs, config);
    }

    if (targetHit) {
      return makeResult('win', entry, target, barsHeld, signal, specs, config);
    }

    if (stopHit) {
      if (beActivated) {
        return makeResult('breakeven', entry, beStop, barsHeld, signal, specs, config);
      }
      return makeResult('loss', entry, stop, barsHeld, signal, specs, config);
    }

    // ── Time stop ──
    if (barsHeld >= maxHold1mBars) {
      const exitPrice = bar.close;
      const pnlPts = dir * (exitPrice - entry);
      const pnl = pnlPts * specs.pointValue - (config.commissionRT || 1.34);
      if (pnl > 0) return makeResult('win', entry, exitPrice, barsHeld, signal, specs, config, true);
      if (pnl < 0) return makeResult('loss', entry, exitPrice, barsHeld, signal, specs, config, true);
      return makeResult('breakeven', entry, exitPrice, barsHeld, signal, specs, config, true);
    }
  }

  // ── End of day exit ──
  const lastBar = dayBars[dayBars.length - 1];
  const exitPrice = lastBar.close;
  const pnlPts = dir * (exitPrice - entry);
  const pnl = pnlPts * specs.pointValue - (config.commissionRT || 1.34);
  if (pnl > 0) return makeResult('win', entry, exitPrice, dayBars.length - entryIdx, signal, specs, config, true);
  if (pnl < 0) return makeResult('loss', entry, exitPrice, dayBars.length - entryIdx, signal, specs, config, true);
  return makeResult('breakeven', entry, exitPrice, dayBars.length - entryIdx, signal, specs, config, true);
}

function makeResult(outcome, entryPrice, exitPrice, barsHeld, signal, specs, config, isTimeExit) {
  const dir = signal.type === 'buy' ? 1 : -1;
  const pnlPts = dir * (exitPrice - entryPrice);
  const grossPnL = pnlPts * specs.pointValue;
  const commission = (config.commissionRT || 1.34);
  const netPnL = grossPnL - commission;
  return {
    outcome, entryPrice, exitPrice, barsHeld,
    pnlPts, grossPnL, commission, netPnL,
    strategy: signal.strategy,
    side: signal.type,
    stopDist: signal.stopDistance,
    targetDist: signal.targetDistance,
    rMultiple: pnlPts / signal.stopDistance,
    timestamp: signal.timestamp,
    isTimeExit: !!isTimeExit,
  };
}

// ── Split bars by trading day (UTC date) ──
function splitByDay(bars) {
  const days = new Map();
  for (const bar of bars) {
    const d = new Date(bar.timestamp).toISOString().slice(0, 10);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(bar);
  }
  return [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// ── Main backtest runner ──
function runBacktest(bars, config, specs) {
  const strategy = new TrendPullback({
    tickSize: specs.tickSize,
    pointValue: specs.pointValue,
    ...config,
  });
  strategy.initialize();

  const trades = [];
  const dayChunks = splitByDay(bars);

  // Warm up with first day (no trading, just indicator building)
  if (dayChunks.length > 0) {
    for (const bar of dayChunks[0][1]) {
      strategy.onBar(bar);
    }
    strategy.resetDay();
  }

  for (let di = 1; di < dayChunks.length; di++) {
    const [dateStr, dayBars] = dayChunks[di];
    let pendingSignal = null;
    let inPosition = false;

    // Wire signal handler — signals are emitted either:
    // 1. By _emitNativeArm() at arm time (nativeStopEntry=true) — signal.price = trigger price
    // 2. By onTick() when trigger is hit (nativeStopEntry=false) — signal.price = fill price
    strategy.removeAllListeners('signal');
    strategy.on('signal', (signal) => {
      pendingSignal = signal;
    });

    // Feed bars to strategy, simulating ticks from each 1m bar
    for (let i = 0; i < dayBars.length; i++) {
      const bar = dayBars[i];

      // If we have a pending signal from a previous bar's onTick, simulate the trade
      if (pendingSignal && !inPosition) {
        const result = simulateTrade(pendingSignal, dayBars, i, config, specs);
        trades.push({ date: dateStr, ...result });
        strategy.setPosition({ side: pendingSignal.type === 'buy' ? 'long' : 'short' });
        strategy.onTradeResult(result);
        inPosition = true;
        pendingSignal = null;
      }

      // Feed the 1m bar to the strategy (aggregates to 5m, checks setups on 5m close)
      strategy.onBar(bar);

      // After onBar, if strategy armed a new signal (nativeStopEntry), capture it
      // For non-native: simulate a tick from this bar's OHLC to check if armed trigger fires
      if (!inPosition && strategy._armed && !pendingSignal) {
        // Create a synthetic tick from the 1m bar
        const tick = {
          price: bar.close,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          timestamp: bar.timestamp,
        };
        strategy.onTick(tick);
        // onTick may have emitted a signal and set pendingSignal
        // It will be processed on the next bar iteration
      }

      // Check if a native stop signal was emitted during onBar (5m close arm)
      if (pendingSignal && !inPosition) {
        // For native stop entries, signal.price is the trigger price
        // Check if this bar already triggered the stop
        const triggered = pendingSignal.type === 'buy'
          ? bar.high >= pendingSignal.price
          : bar.low <= pendingSignal.price;
        if (triggered) {
          const result = simulateTrade(pendingSignal, dayBars, i, config, specs);
          trades.push({ date: dateStr, ...result });
          strategy.setPosition({ side: pendingSignal.type === 'buy' ? 'long' : 'short' });
          strategy.onTradeResult(result);
          inPosition = true;
          pendingSignal = null;
        }
      }
    }

    // End of day: clear position for next day
    strategy.setPosition(null);
    strategy.resetDay();
    inPosition = false;
    pendingSignal = null;
  }

  return trades;
}

// ── Print results ──
function printResults(trades, config, specs) {
  const wins = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');
  const bes = trades.filter(t => t.outcome === 'breakeven');

  const totalPnL = trades.reduce((s, t) => s + t.netPnL, 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnL, 0);
  const grossLoss = losses.reduce((s, t) => s + t.netPnL, 0);
  const pf = grossLoss !== 0 ? Math.abs(grossWin / grossLoss) : Infinity;

  const wr = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : '0';
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.netPnL, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.netPnL, 0) / losses.length : 0;

  // Drawdown
  let peak = 0, dd = 0, maxDD = 0, cumPnL = 0;
  for (const t of trades) {
    cumPnL += t.netPnL;
    if (cumPnL > peak) peak = cumPnL;
    dd = peak - cumPnL;
    if (dd > maxDD) maxDD = dd;
  }

  // Per-day breakdown
  const byDay = new Map();
  for (const t of trades) {
    if (!byDay.has(t.date)) byDay.set(t.date, []);
    byDay.get(t.date).push(t);
  }

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('         TREND PULLBACK BACKTEST RESULTS');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Instrument:      ${config.instrument || 'N/A'}`);
  console.log(`  Total trades:    ${trades.length}`);
  console.log(`  Wins:            ${wins.length} (${wr}% WR)`);
  console.log(`  Losses:          ${losses.length}`);
  console.log(`  Breakevens:      ${bes.length}`);
  console.log(`  Net P&L:         $${totalPnL.toFixed(2)}`);
  console.log(`  Profit Factor:   ${pf.toFixed(2)}`);
  console.log(`  Avg Win:         $${avgWin.toFixed(2)}`);
  console.log(`  Avg Loss:        $${avgLoss.toFixed(2)}`);
  console.log(`  Max Drawdown:    $${maxDD.toFixed(2)}`);
  console.log(`  Trades/day:      ${(trades.length / Math.max(1, byDay.size)).toFixed(1)}`);
  console.log(`  Green days:      ${[...byDay.values()].filter(d => d.reduce((s, t) => s + t.netPnL, 0) > 0).length}/${byDay.size}`);

  console.log('\n  ── Per-day breakdown ──');
  for (const [date, dayTrades] of byDay) {
    const dayPnL = dayTrades.reduce((s, t) => s + t.netPnL, 0);
    const dayWins = dayTrades.filter(t => t.outcome === 'win').length;
    const symbol = dayPnL > 0 ? '✅' : dayPnL < 0 ? '❌' : '➖';
    console.log(`    ${date}: ${dayTrades.length}t, ${dayWins}W, $${dayPnL.toFixed(2)} ${symbol}`);
  }

  // R-multiple distribution
  const rMultiples = trades.map(t => t.rMultiple);
  const avgR = rMultiples.reduce((s, r) => s + r, 0) / Math.max(1, rMultiples.length);
  console.log(`\n  Avg R-multiple:  ${avgR.toFixed(2)}R`);
  console.log(`  Time exits:      ${trades.filter(t => t.isTimeExit).length}/${trades.length}`);

  console.log('═══════════════════════════════════════════════════════════════\n');
}

// ── Main ──
async function main() {
  const args = parseArgs();
  const instrument = args.instrument || 'MNQ';
  const specs = getSpecs(instrument);

  const config = {
    instrument,
    tickSize: specs.tickSize,
    pointValue: specs.pointValue,
    // Strategy params
    emaFastPeriod: parseInt(args.emaFast || '9'),
    emaMidPeriod: parseInt(args.emaMid || '21'),
    emaSlowPeriod: parseInt(args.emaSlow || '50'),
    atrPeriod: 14,
    atrStopMult: parseFloat(args.atrStopMult || '1.5'),
    maxStopPoints: parseFloat(args.maxStop || '20'),
    minStopPoints: parseFloat(args.minStop || '3'),
    minTargetPoints: parseFloat(args.minTarget || '5'),
    profitTargetR: parseFloat(args.targetR || '2.0'),
    beActivationR: parseFloat(args.beR || '1.0'),
    moveStopToBE: true,
    pullbackZoneATR: parseFloat(args.pbZoneATR || '0.5'),
    sessionStartMin: 390,
    hardEntryCutoff: parseInt(args.cutoff || '630'),
    cooldownBars: parseInt(args.cooldown || '2'),
    maxTradesPerDay: parseInt(args.maxTrades || '4'),
    timeStopBars: parseInt(args.timeStop || '12'),
    timeStopEnabled: true,
    stopEntryOffsetTicks: 1,
    stopEntryCancelBars: 3,
    nativeStopEntry: false,
    entryOrderType: 'Market',
    skipDows: args.skipDows ? args.skipDows.split(',').map(Number) : [],
    // Backtest params
    slippageTicks: parseInt(args.slippageTicks || '2'),
    commissionRT: parseFloat(args.commission || '1.34'),
  };

  let bars;
  if (args.data) {
    console.log(`Loading data from ${args.data}...`);
    const raw = fs.readFileSync(args.data, 'utf8');
    bars = JSON.parse(raw);
    console.log(`Loaded ${bars.length} bars`);
  } else {
    console.error('No --data file specified. Usage: node scripts/backtest_trend_pullback.js --data <file.json> --instrument MNQ');
    process.exit(1);
  }

  console.log(`Running backtest: ${instrument} (${specs.tickSize} tick, $${specs.pointValue}/pt)`);
  console.log(`  EMA: ${config.emaFastPeriod}/${config.emaMidPeriod}/${config.emaSlowPeriod}`);
  console.log(`  ATR stop: ${config.atrStopMult}x | Target: ${config.profitTargetR}R | BE: ${config.beActivationR}R`);
  console.log(`  Slippage: ${config.slippageTicks} ticks | Commission: $${config.commissionRT}/RT`);

  const trades = runBacktest(bars, config, specs);
  printResults(trades, config, specs);
}

main().catch(err => {
  console.error('Backtest error:', err);
  process.exit(1);
});
