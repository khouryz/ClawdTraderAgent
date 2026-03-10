/**
 * ResearchBacktester — Offline PB+VR research backtester
 * 
 * Feeds historical 1-min MNQ bars through the actual MNQMomentumStrategyV2 class.
 * Logs every detected setup with full feature set.
 * Simulates trades with configurable execution modes.
 * Calculates MAE/MFE on forward bars for all setups (filled or not).
 * 
 * Usage:
 *   node research/research_backtester.js --data research/data/mnq_1m_2025_2026.jsonl
 * 
 * Experiment modes:
 *   --experiment pb_baseline    (Phase 2: market entry, no BE, 2R)
 *   --experiment exec_test      (Phase 3: compare market vs limit entries)
 *   --experiment exit_test      (Phase 4: compare BE/ratchet/none)
 *   --experiment vr_validation  (Phase 6: simplified VR)
 */

const fs = require('fs');
const path = require('path');
const MNQMomentumStrategyV2 = require('../src/strategies/mnq_momentum_strategy_v2');
const VWAPEngine = require('../src/indicators/VWAPEngine');
const { calcATR } = require('../src/indicators/zlema');
const SetupLogger = require('./setup_logger');

// ═══════════════════════════════════════════════════════════════
//  DATA LOADING
// ═══════════════════════════════════════════════════════════════

function loadBars(filePath) {
  console.log(`[Data] Loading bars from ${filePath}...`);
  const ext = path.extname(filePath).toLowerCase();

  if (ext === '.jsonl') {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    const bars = lines.map(line => {
      const r = JSON.parse(line);
      return {
        timestamp: r.timestamp || r.ts,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume || 0,
      };
    });
    console.log(`[Data] Loaded ${bars.length} bars from JSONL`);
    return bars;
  }

  if (ext === '.csv') {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    const header = lines[0].split(',').map(h => h.trim());
    const bars = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',');
      const row = {};
      header.forEach((h, idx) => { row[h] = vals[idx]?.trim(); });
      bars.push({
        timestamp: row.timestamp || row.ts,
        open: parseFloat(row.open),
        high: parseFloat(row.high),
        low: parseFloat(row.low),
        close: parseFloat(row.close),
        volume: parseInt(row.volume) || 0,
      });
    }
    console.log(`[Data] Loaded ${bars.length} bars from CSV`);
    return bars;
  }

  if (ext === '.json') {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const arr = Array.isArray(data) ? data : data.records || data.bars || [];
    const bars = arr.map(r => ({
      timestamp: r.timestamp || r.ts,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume || 0,
    }));
    console.log(`[Data] Loaded ${bars.length} bars from JSON`);
    return bars;
  }

  throw new Error(`Unsupported file format: ${ext}`);
}

// ═══════════════════════════════════════════════════════════════
//  UTILITY: Session day grouping
// ═══════════════════════════════════════════════════════════════

function getPSTDate(timestamp) {
  const d = new Date(timestamp);
  const pst = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  const parts = pst.split(', ');
  return parts[0]; // MM/DD/YYYY
}

function getPSTTime(timestamp) {
  const d = new Date(timestamp);
  const pst = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  const parts = pst.split(', ');
  return parts[1]; // HH:MM:SS
}

function getPSTMinutes(timestamp) {
  const d = new Date(timestamp);
  const pstStr = d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  const timeParts = pstStr.split(', ')[1].split(':');
  return parseInt(timeParts[0]) * 60 + parseInt(timeParts[1]);
}

function groupBarsBySession(bars) {
  // Group bars by PST date for session-based processing
  // CME session: roughly 5PM previous day to 4PM CT
  // For simplicity, group by PST calendar date
  const sessions = {};
  for (const bar of bars) {
    const dateKey = getPSTDate(bar.timestamp);
    if (!sessions[dateKey]) sessions[dateKey] = [];
    sessions[dateKey].push(bar);
  }
  return sessions;
}

// ═══════════════════════════════════════════════════════════════
//  MARKET STRUCTURE CONTEXT
// ═══════════════════════════════════════════════════════════════

function getMarketStructureContext(price, vwapEngine) {
  const ctx = {
    distance_from_session_vwap: null,
    distance_from_session_high: null,
    distance_from_session_low: null,
    distance_from_prior_day_vah: null,
    distance_from_prior_day_val: null,
    distance_from_prior_day_poc: null,
    price_location_vs_prior_value: 'no_data',
  };

  if (vwapEngine.vwap) {
    ctx.distance_from_session_vwap = price - vwapEngine.vwap;
  }
  if (vwapEngine.sessionHigh !== null) {
    ctx.distance_from_session_high = price - vwapEngine.sessionHigh;
  }
  if (vwapEngine.sessionLow !== null) {
    ctx.distance_from_session_low = price - vwapEngine.sessionLow;
  }
  if (vwapEngine.priorDayVAH !== null) {
    ctx.distance_from_prior_day_vah = price - vwapEngine.priorDayVAH;
  }
  if (vwapEngine.priorDayVAL !== null) {
    ctx.distance_from_prior_day_val = price - vwapEngine.priorDayVAL;
  }
  if (vwapEngine.priorDayPOC !== null) {
    ctx.distance_from_prior_day_poc = price - vwapEngine.priorDayPOC;
  }

  // Price location vs prior day value area
  if (vwapEngine.priorDayVAH !== null && vwapEngine.priorDayVAL !== null) {
    if (price > vwapEngine.priorDayVAH) {
      ctx.price_location_vs_prior_value = 'above_VAH';
    } else if (price < vwapEngine.priorDayVAL) {
      ctx.price_location_vs_prior_value = 'below_VAL';
    } else {
      ctx.price_location_vs_prior_value = 'inside_value';
    }
  }

  return ctx;
}

// ═══════════════════════════════════════════════════════════════
//  VOLATILITY REGIME
// ═══════════════════════════════════════════════════════════════

function getVolatilityRegime(currentATR, atrHistory, sessionRange) {
  const regime = {
    atr_percentile_30d: null,
    range_percentile_today: null,
    session_range_so_far: sessionRange || 0,
    volatility_regime_label: 'normal',
  };

  if (atrHistory.length >= 10 && currentATR) {
    // ATR percentile: what % of historical ATR values is current ATR below
    const sorted = [...atrHistory].sort((a, b) => a - b);
    const rank = sorted.filter(a => a <= currentATR).length;
    regime.atr_percentile_30d = rank / sorted.length;

    // Label
    if (regime.atr_percentile_30d < 0.25) {
      regime.volatility_regime_label = 'low';
    } else if (regime.atr_percentile_30d > 0.75) {
      regime.volatility_regime_label = 'high';
    }
  }

  return regime;
}

// ═══════════════════════════════════════════════════════════════
//  MAE / MFE CALCULATOR
// ═══════════════════════════════════════════════════════════════

/**
 * Calculate MAE and MFE using forward bars from the setup point.
 * Works for both filled trades and unfilled setups (forward simulation).
 * 
 * @param {Object} params
 * @param {string} params.direction - 'long' or 'short'
 * @param {number} params.entryPrice - Entry price
 * @param {number} params.stopPrice - Stop price
 * @param {number} params.targetPrice - Target price
 * @param {Array}  params.forwardBars - Bars after entry
 * @param {Object} params.exitConfig - { beEnabled, beR, ratchetEnabled, ratchetLevels }
 * @param {number} params.eodMinutes - PST minutes to force-close (default 780 = 1:00 PM)
 * @returns {{ mae, mfe, exit_reason, realized_R, bars_in_trade, duration_minutes, exit_price }}
 */
function simulateTrade(params) {
  const {
    direction, entryPrice, stopPrice, targetPrice, forwardBars,
    exitConfig = {}, eodMinutes = 780
  } = params;

  const isLong = direction === 'long';
  const riskAmount = Math.abs(entryPrice - stopPrice);
  if (riskAmount === 0) {
    return { mae: 0, mfe: 0, exit_reason: 'invalid', realized_R: 0, bars_in_trade: 0, duration_minutes: 0, exit_price: entryPrice };
  }

  let currentStop = stopPrice;
  let mae = 0; // Worst adverse excursion in R
  let mfe = 0; // Best favorable excursion in R
  let exitReason = null;
  let exitPrice = null;
  let barsInTrade = 0;
  let beApplied = false;

  // Ratchet levels: array of { triggerR, stopR }
  const ratchetLevels = exitConfig.ratchetEnabled ? (exitConfig.ratchetLevels || [
    { triggerR: 1.5, stopR: 0.25 },
    { triggerR: 2.0, stopR: 0.75 },
    { triggerR: 2.5, stopR: 1.5 },
  ]) : [];
  let highestRatchetApplied = -1;

  for (let i = 0; i < forwardBars.length; i++) {
    const bar = forwardBars[i];
    barsInTrade++;

    // Check EOD close
    const barMinutes = getPSTMinutes(bar.timestamp);
    if (barMinutes >= eodMinutes) {
      exitPrice = bar.close;
      exitReason = 'eod';
      break;
    }

    // Calculate excursions using bar extremes
    const adversePrice = isLong ? bar.low : bar.high;
    const favorablePrice = isLong ? bar.high : bar.low;

    // Cap adverse excursion at stop level (trade exits there, can't go worse)
    const rawAdverseR = isLong
      ? (entryPrice - adversePrice) / riskAmount
      : (adversePrice - entryPrice) / riskAmount;
    const adverseR = Math.min(rawAdverseR, 1.0); // Cap at 1R (stop)
    const favorableR = isLong
      ? (favorablePrice - entryPrice) / riskAmount
      : (entryPrice - favorablePrice) / riskAmount;

    if (adverseR > mae) mae = adverseR;
    if (favorableR > mfe) mfe = favorableR;

    // Check stop hit (use current stop, which may have moved)
    const stopHit = isLong ? bar.low <= currentStop : bar.high >= currentStop;
    if (stopHit) {
      exitPrice = currentStop;
      exitReason = beApplied || highestRatchetApplied >= 0 ? 'be_stop' : 'stop';
      break;
    }

    // Check target hit
    const targetHit = isLong ? bar.high >= targetPrice : bar.low <= targetPrice;
    if (targetHit) {
      exitPrice = targetPrice;
      exitReason = 'target';
      break;
    }

    // Apply break-even if configured
    if (exitConfig.beEnabled && !beApplied && !exitConfig.ratchetEnabled) {
      const currentR = isLong
        ? (bar.high - entryPrice) / riskAmount
        : (entryPrice - bar.low) / riskAmount;
      if (currentR >= (exitConfig.beR || 2.0)) {
        const beOffset = 0.25;
        currentStop = isLong ? entryPrice + beOffset : entryPrice - beOffset;
        beApplied = true;
      }
    }

    // Apply ratchet stop if configured
    if (exitConfig.ratchetEnabled) {
      const currentR = isLong
        ? (bar.high - entryPrice) / riskAmount
        : (entryPrice - bar.low) / riskAmount;
      for (const level of ratchetLevels) {
        if (currentR >= level.triggerR && level.triggerR > highestRatchetApplied) {
          const newStop = isLong
            ? entryPrice + (level.stopR * riskAmount)
            : entryPrice - (level.stopR * riskAmount);
          // Only move stop in favorable direction
          if (isLong ? newStop > currentStop : newStop < currentStop) {
            currentStop = newStop;
            highestRatchetApplied = level.triggerR;
          }
        }
      }
    }
  }

  // If no exit within forward bars, mark as simulated
  if (!exitReason) {
    exitPrice = forwardBars.length > 0 ? forwardBars[forwardBars.length - 1].close : entryPrice;
    exitReason = 'end_of_data';
  }

  const realizedR = isLong
    ? (exitPrice - entryPrice) / riskAmount
    : (entryPrice - exitPrice) / riskAmount;

  const durationMinutes = barsInTrade; // 1-min bars, so bars ≈ minutes

  return {
    mae: -mae, // Convention: negative MAE
    mfe,
    exit_reason: exitReason,
    realized_R: realizedR,
    bars_in_trade: barsInTrade,
    duration_minutes: durationMinutes,
    exit_price: exitPrice,
  };
}

/**
 * Forward-simulate MAE/MFE for an UNFILLED setup.
 * Assumes market entry at setup price.
 */
function forwardSimulateSetup(setup, forwardBars, exitConfig) {
  return simulateTrade({
    direction: setup.direction,
    entryPrice: setup.entry_price,
    stopPrice: setup.stop_price,
    targetPrice: setup.target_price,
    forwardBars,
    exitConfig,
  });
}

// ═══════════════════════════════════════════════════════════════
//  LIMIT ORDER SIMULATION
// ═══════════════════════════════════════════════════════════════

/**
 * Simulate a limit order fill on forward bars.
 * Returns the fill bar index and fill price, or null if not filled.
 * 
 * @param {Object} params
 * @param {string} params.direction - 'long' or 'short'
 * @param {number} params.limitPrice - Limit order price
 * @param {number} params.stopPrice - Invalidation stop price
 * @param {Array}  params.forwardBars - Bars to check for fill
 * @param {number} params.maxBars - Max bars to wait (timeout)
 * @returns {{ filled, fillBarIndex, fillPrice } | null}
 */
function simulateLimitFill(params) {
  const { direction, limitPrice, stopPrice, forwardBars, maxBars = 5 } = params;
  const isLong = direction === 'long';

  for (let i = 0; i < Math.min(forwardBars.length, maxBars); i++) {
    const bar = forwardBars[i];

    // Check invalidation first
    if (isLong && bar.low <= stopPrice) {
      return { filled: false, reason: 'invalidated' };
    }
    if (!isLong && bar.high >= stopPrice) {
      return { filled: false, reason: 'invalidated' };
    }

    // Check limit fill
    const limitHit = isLong
      ? bar.low <= limitPrice && bar.close > limitPrice
      : bar.high >= limitPrice && bar.close < limitPrice;

    if (limitHit) {
      return { filled: true, fillBarIndex: i, fillPrice: limitPrice };
    }
  }

  return { filled: false, reason: 'timeout' };
}

// ═══════════════════════════════════════════════════════════════
//  MAIN BACKTESTER
// ═══════════════════════════════════════════════════════════════

class ResearchBacktester {
  /**
   * @param {Object} config
   * @param {string} config.dataPath - Path to historical bar data
   * @param {string} config.experiment - Experiment name
   * @param {Object} config.strategyConfig - Override strategy parameters
   * @param {Object} config.executionConfig - { entryMode, limitRetracePct, limitTimeoutBars }
   * @param {Object} config.exitConfig - { beEnabled, beR, ratchetEnabled, ratchetLevels }
   * @param {boolean} config.pbEnabled - Enable PB signals (default true)
   * @param {boolean} config.vrEnabled - Enable VR signals (default true)
   * @param {number} config.targetR - Override target R-multiple
   */
  constructor(config) {
    this.config = config;
    this.bars = loadBars(config.dataPath);
    this.logger = new SetupLogger(config.experiment);

    // ATR history for percentile calculation
    this._atrHistory = [];
    this._dailyRanges = [];
  }

  run() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  RESEARCH BACKTESTER: ${this.config.experiment}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`  Bars: ${this.bars.length}`);
    console.log(`  Entry mode: ${this.config.executionConfig?.entryMode || 'market'}`);
    console.log(`  Exit config: BE=${this.config.exitConfig?.beEnabled || false}, Ratchet=${this.config.exitConfig?.ratchetEnabled || false}`);
    console.log(`  Target R: ${this.config.targetR || 2.0}`);
    console.log(`${'='.repeat(60)}\n`);

    // Group bars by session day
    const sessions = groupBarsBySession(this.bars);
    const sessionDates = Object.keys(sessions).sort();

    console.log(`[Backtester] ${sessionDates.length} session days found`);

    let totalSetups = 0;

    for (let dayIdx = 0; dayIdx < sessionDates.length; dayIdx++) {
      const dateKey = sessionDates[dayIdx];
      const dayBars = sessions[dateKey];

      // Filter to trading session (6:30 AM - 1:00 PM PST = 390-780 minutes)
      const sessionBars = dayBars.filter(b => {
        const mins = getPSTMinutes(b.timestamp);
        return mins >= 390 && mins < 780; // 6:30 AM to 1:00 PM PST
      });

      if (sessionBars.length < 20) continue; // Skip short sessions

      // Create fresh strategy for each day
      const vwapEngine = new VWAPEngine();

      // If we have prior day data, feed it to VWAP engine for prior day levels
      if (dayIdx > 0) {
        const prevDayBars = sessions[sessionDates[dayIdx - 1]] || [];
        const prevSessionBars = prevDayBars.filter(b => {
          const mins = getPSTMinutes(b.timestamp);
          return mins >= 390 && mins < 780;
        });
        for (const bar of prevSessionBars) {
          vwapEngine.onBar(bar);
        }
        vwapEngine.resetDay(); // Saves prior day levels and resets
      }

      const targetR = this.config.targetR || 2.0;

      // Determine if this is a production-accurate run
      const isProduction = this.config.productionAccurate === true;

      const strategyConfig = {
        // PB config
        pbMinImpulse: 15,
        pbMinImpBodyRatio: 0.15,
        pbRetraceMin: 0.10,
        pbRetraceMax: 0.85,
        pbMaxTime: 570,     // 9:30 AM PST
        pbEntryMode: 'immediate', // Signal detection always uses immediate; execution mode handled by simulateTrade
        pbTrendFilterEnabled: false,
        pbConfirmBars: 5,
        pbLimitRetracePct: 0.6,
        pbLimitTimeoutBars: 5,
        // VR config
        vrEnabled: this.config.vrEnabled !== false,
        vrMinTime: 510,
        vrMaxTime: 660,
        vrMinSigma: 1.5,
        vrEntrySigmaMax: 1.0,
        vrStopBeyondBand: 3,
        vrTargetMode: 'fixed',
        vrTargetR: 4,
        vrMinBarVolRatio: 0.8,
        vrMaxStopPoints: 20,
        vrMinStopPoints: 4,
        vrCooldownBars: 10,
        // Shared
        maxStopPoints: 35,
        minStopPoints: 5,
        stopBuffer: 2,
        profitTargetR: targetR,
        minTargetPoints: 20,
        maxLossesPerDay: isProduction ? 3 : 99,
        minConfluence: 0,
        volumeFilterEnabled: isProduction ? true : false,
        volumeFilterMin: 0.9,
        volumeFilterPeriod: 20,
        emaxEnabled: false,
        // VWAP
        vwapEngine,
        // Overrides from config
        ...(this.config.strategyConfig || {}),
      };

      const strategy = new MNQMomentumStrategyV2(strategyConfig);
      strategy.dayStarted = true;
      strategy.isActive = true;

      // Collect signals from this day
      const daySignals = [];
      strategy.on('signal', (signal) => {
        daySignals.push({ ...signal, _barIndex: currentBarIdx });
      });

      // Warm up: feed prior session bars through strategy.bars for indicator calculation
      // For production-accurate mode, also feed through onBar to build 2m/5m bars and
      // compute RSI/ATR, matching InstrumentRunner._loadInitialData()
      if (dayIdx > 0) {
        const prevDayBars = sessions[sessionDates[dayIdx - 1]] || [];
        const prevSessionBars = prevDayBars.filter(b => {
          const mins = getPSTMinutes(b.timestamp);
          return mins >= 390 && mins < 780;
        });
        if (isProduction) {
          // Production-accurate: feed bars through onBar (builds 5m bars, indicators)
          // but suppress signal emission during warmup
          const savedActive = strategy.isActive;
          strategy.isActive = false;
          for (const bar of prevSessionBars) {
            strategy.onBar(bar);
          }
          strategy.isActive = savedActive;
          // Reset day state (preserves indicator caches like bars, 5m history)
          strategy.signalFired = false;
          strategy.sessionBarCount = 0;
          strategy._tradeCountToday = 0;
          strategy._lossCountToday = 0;
          strategy._pbWatch = null;
          strategy._vrWatching = null;
          strategy._vrWatchPrice = null;
          strategy._vrCooldownCount = 0;
          strategy._vrTradeCount = 0;
          // Clear built bars from prior day so fresh bars start from today
          strategy.twoMinBars = [];
          strategy.threeMinBars = [];
          strategy.fiveMinBars = [];
          strategy.current2mBar = null;
          strategy.current3mBar = null;
          strategy.current5mBar = null;
          strategy._current2mBucket = null;
          strategy._current3mBucket = null;
          strategy._current5mBucket = null;
        } else {
          // Research mode: just add to strategy.bars for indicator warmup
          for (const bar of prevSessionBars) {
            strategy.bars.push(bar);
          }
          if (strategy.bars.length > 500) {
            strategy.bars = strategy.bars.slice(-500);
          }
        }
      }

      // Compute session range for this day (used for volatility tracking)
      const daySessionHigh = Math.max(...sessionBars.map(b => b.high));
      const daySessionLow = Math.min(...sessionBars.map(b => b.low));
      const daySessionRange = daySessionHigh - daySessionLow;

      // Feed session bars one by one, simulating trades INLINE
      // This matches the real bot: signalFired stays true for the trade duration,
      // then resets when the trade closes, allowing new signals to fire.
      let currentBarIdx = 0;
      let tradeExitBarIdx = -1; // Bar index where current trade exits
      let lossCount = 0;
      const maxLossesPerDay = this.config.strategyConfig?.maxLossesPerDay ?? 3;

      for (let i = 0; i < sessionBars.length; i++) {
        currentBarIdx = i;

        // When the current trade has exited, reset signalFired to allow new signals
        if (tradeExitBarIdx >= 0 && i > tradeExitBarIdx) {
          strategy.signalFired = false;
          strategy._pbWatch = null;
          // Don't reset VR watch — real bot only resets on position close via setPosition
          strategy._vrWatching = null;
          strategy._vrWatchPrice = null;
          tradeExitBarIdx = -1;
        }

        strategy.onBar(sessionBars[i]);

        // Check if a new signal just fired
        if (daySignals.length > 0) {
          const latestSignal = daySignals[daySignals.length - 1];
          if (latestSignal._barIndex === i && !latestSignal._processed) {
            latestSignal._processed = true;
            totalSetups++;

            const signal = latestSignal;
            const signalBarIdx = signal._barIndex;
            const forwardBars = sessionBars.slice(signalBarIdx + 1);

            // Get ATR at signal time
            const currentATR = strategy._lastATR;
            if (currentATR) {
              this._atrHistory.push(currentATR);
              if (this._atrHistory.length > 390 * 30) {
                this._atrHistory.shift();
              }
            }

            // Session range at signal time
            const sessionRange = vwapEngine.sessionHigh !== null && vwapEngine.sessionLow !== null
              ? vwapEngine.sessionHigh - vwapEngine.sessionLow : daySessionRange;

            // Market structure context
            const mktCtx = getMarketStructureContext(signal.price, vwapEngine);

            // Volatility regime
            const volRegime = getVolatilityRegime(currentATR, this._atrHistory, sessionRange);

            // Sigma stretch
            const sigmaStretch = vwapEngine.isReady() ? vwapEngine.getVWAPDistance(signal.price) : null;

            // Volume ratio
            const recentBars = strategy.bars.slice(-20);
            const avgVol = recentBars.reduce((s, b) => s + (b.volume || 0), 0) / Math.max(recentBars.length, 1);
            const barVol = sessionBars[signalBarIdx]?.volume || 0;
            const volumeRatio = avgVol > 0 ? barVol / avgVol : 0;

            // Impulse range (PB only) — extract from filterResults since raw objects aren't on signal
            let impulseRange = null;
            let retracePctVal = null;
            if (signal.filterResults && signal.strategy === 'PB') {
              const impMatch = signal.filterResults[0]?.reason?.match(/([\d.]+)pt range/);
              if (impMatch) impulseRange = parseFloat(impMatch[1]);
              const retMatch = signal.filterResults[1]?.reason?.match(/([\d.]+)% retrace/);
              if (retMatch) retracePctVal = parseFloat(retMatch[1]) / 100;
            }

            const direction = signal.type === 'buy' ? 'long' : 'short';

            // Base setup record
            const setupRecord = {
              date: dateKey,
              session_time: getPSTTime(signal.timestamp || sessionBars[signalBarIdx]?.timestamp),
              sub_strategy: signal.strategy || 'PB',
              direction,
              impulse_range: impulseRange,
              retrace_pct: retracePctVal,
              stop_distance: signal.stopDistance,
              target_distance: signal.targetDistance,
              entry_price: signal.price,
              stop_price: signal.stopLoss,
              target_price: signal.targetPrice,
              volume_ratio: volumeRatio,
              atr: currentATR,
              vwap_distance: vwapEngine.vwap ? signal.price - vwapEngine.vwap : null,
              sigma_stretch: sigmaStretch,
              confluence_score: signal.confluenceScore || 0,
              confluence_factors: signal.vwapState ? JSON.stringify(signal.vwapState) : null,
              ...mktCtx,
              ...volRegime,
            };

            // Simulate execution based on configured entry mode
            const entryMode = this.config.executionConfig?.entryMode || 'market';

            if (entryMode === 'market') {
              const result = simulateTrade({
                direction,
                entryPrice: signal.price,
                stopPrice: signal.stopLoss,
                targetPrice: signal.targetPrice,
                forwardBars,
                exitConfig: this.config.exitConfig || {},
              });

              setupRecord.fill_type = 'market';
              setupRecord.fill_price = signal.price;
              setupRecord.mae = result.mae;
              setupRecord.mfe = result.mfe;
              setupRecord.exit_reason = result.exit_reason;
              setupRecord.realized_R = result.realized_R;
              setupRecord.bars_in_trade = result.bars_in_trade;
              setupRecord.duration_minutes = result.duration_minutes;

              // Set trade exit bar so signalFired stays locked until trade closes
              tradeExitBarIdx = signalBarIdx + result.bars_in_trade;

              // Track losses for maxLossesPerDay
              if (result.exit_reason === 'stop') {
                lossCount++;
                strategy._lossCountToday = lossCount;
              }

            } else {
              // Limit entry simulation
              const retracePctConfig = this.config.executionConfig?.limitRetracePct || 0.6;
              const timeoutBars = this.config.executionConfig?.limitTimeoutBars || 5;

              const pbBar = signal.pb || sessionBars[signalBarIdx];
              let limitPrice;
              if (direction === 'long') {
                limitPrice = pbBar.low + (pbBar.close - pbBar.low) * retracePctConfig;
              } else {
                limitPrice = pbBar.high - (pbBar.high - pbBar.close) * retracePctConfig;
              }

              const limitResult = simulateLimitFill({
                direction,
                limitPrice,
                stopPrice: signal.stopLoss,
                forwardBars,
                maxBars: timeoutBars,
              });

              if (limitResult.filled) {
                const fillBars = forwardBars.slice(limitResult.fillBarIndex + 1);
                const fillPrice = limitResult.fillPrice;

                const tradeResult = simulateTrade({
                  direction,
                  entryPrice: fillPrice,
                  stopPrice: signal.stopLoss,
                  targetPrice: direction === 'long'
                    ? fillPrice + signal.stopDistance * targetR
                    : fillPrice - signal.stopDistance * targetR,
                  forwardBars: fillBars,
                  exitConfig: this.config.exitConfig || {},
                });

                setupRecord.fill_type = 'limit';
                setupRecord.fill_price = fillPrice;
                setupRecord.mae = tradeResult.mae;
                setupRecord.mfe = tradeResult.mfe;
                setupRecord.exit_reason = tradeResult.exit_reason;
                setupRecord.realized_R = tradeResult.realized_R;
                setupRecord.bars_in_trade = tradeResult.bars_in_trade;
                setupRecord.duration_minutes = tradeResult.duration_minutes;

                // Trade exit bar = signal bar + fill wait + trade duration
                tradeExitBarIdx = signalBarIdx + limitResult.fillBarIndex + 1 + tradeResult.bars_in_trade;

                if (tradeResult.exit_reason === 'stop') {
                  lossCount++;
                  strategy._lossCountToday = lossCount;
                }

              } else {
                const hypo = forwardSimulateSetup(setupRecord, forwardBars, this.config.exitConfig || {});

                setupRecord.fill_type = limitResult.reason === 'invalidated' ? 'invalidated' : 'timeout';
                setupRecord.fill_price = null;
                setupRecord.mae = hypo.mae;
                setupRecord.mfe = hypo.mfe;
                setupRecord.exit_reason = 'simulated_' + hypo.exit_reason;
                setupRecord.realized_R = hypo.realized_R;
                setupRecord.bars_in_trade = hypo.bars_in_trade;
                setupRecord.duration_minutes = hypo.duration_minutes;

                // Unfilled limit — unlock immediately (real bot resets signalFired on rejection)
                tradeExitBarIdx = signalBarIdx;
              }
            }

            this.logger.logSetup(setupRecord);
          }
        }
      }

      // Track daily range for volatility percentile
      if (daySessionRange > 0) {
        this._dailyRanges.push(daySessionRange);
        if (this._dailyRanges.length > 60) this._dailyRanges.shift();
      }

      // Progress logging every 20 days
      if (dayIdx % 20 === 0 && dayIdx > 0) {
        console.log(`  [Day ${dayIdx}/${sessionDates.length}] ${dateKey} | setups so far: ${totalSetups}`);
      }
    }

    // Write results
    const outputPath = this.logger.flush();
    this.logger.printSummary();

    // Also write summary JSON
    const summary = this.logger.getSummary();
    const summaryPath = path.join(this.logger.outputDir, `${this.config.experiment}_summary.json`);
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`[Summary] Written to ${summaryPath}`);

    return summary;
  }
}

// ═══════════════════════════════════════════════════════════════
//  CLI RUNNER
// ═══════════════════════════════════════════════════════════════

function runExperiments() {
  const args = process.argv.slice(2);
  const dataPathIdx = args.indexOf('--data');
  const experimentIdx = args.indexOf('--experiment');

  if (dataPathIdx === -1 || !args[dataPathIdx + 1]) {
    console.log('Usage: node research/research_backtester.js --data <path> [--experiment <name>]');
    console.log('');
    console.log('Experiments:');
    console.log('  production       Production-accurate: limit_structural, BE, vol filter, 3 loss limit');
    console.log('  freq_imp_cap40   Freq test: cap impulse at 40pt');
    console.log('  freq_market_entry Freq test: market entry instead of limit');
    console.log('  freq_lookback3   Freq test: 3-bar lookback for impulse');
    console.log('  freq_combo       Freq test: cap40 + market + lookback3 combined');
    console.log('  pb_baseline      Phase 2: PB market entry, no BE, 2R target');
    console.log('  exec_market      Phase 3a: Market entry');
    console.log('  exec_limit_40    Phase 3b: 40% limit entry');
    console.log('  exec_limit_50    Phase 3c: 50% limit entry');
    console.log('  exec_limit_60    Phase 3d: 60% limit entry');
    console.log('  exit_none        Phase 4a: No BE, no trailing');
    console.log('  exit_be2r        Phase 4b: BE at 2R');
    console.log('  exit_ratchet     Phase 4c: Ratchet stop');
    console.log('  vr_validation    Phase 6: Simplified VR test');
    console.log('  all              Run all experiments sequentially');
    process.exit(1);
  }

  const dataPath = args[dataPathIdx + 1];
  const experiment = experimentIdx !== -1 ? args[experimentIdx + 1] : 'pb_baseline';

  // Verify data file exists
  if (!fs.existsSync(dataPath)) {
    console.error(`ERROR: Data file not found: ${dataPath}`);
    process.exit(1);
  }

  const experiments = {
    // Production-accurate: matches real bot .env config exactly
    production: {
      experiment: 'production',
      dataPath,
      productionAccurate: true,
      vrEnabled: true,
      targetR: 2.5,
      executionConfig: { entryMode: 'limit', limitRetracePct: 0.6, limitTimeoutBars: 5 },
      exitConfig: { beEnabled: true, beR: 1.2, ratchetEnabled: false },
    },

    // ── FREQUENCY EXPERIMENTS (all production-accurate) ──

    // Freq test 1: Cap impulse at 40pt (kill the 50+ bucket that's net negative)
    freq_imp_cap40: {
      experiment: 'freq_imp_cap40',
      dataPath,
      productionAccurate: true,
      vrEnabled: false,
      targetR: 2.5,
      strategyConfig: { pbMaxImpulse: 40 },
      executionConfig: { entryMode: 'limit', limitRetracePct: 0.6, limitTimeoutBars: 5 },
      exitConfig: { beEnabled: true, beR: 1.2, ratchetEnabled: false },
    },

    // Freq test 2: Market entry instead of limit_structural (100% fill rate)
    freq_market_entry: {
      experiment: 'freq_market_entry',
      dataPath,
      productionAccurate: true,
      vrEnabled: false,
      targetR: 2.5,
      executionConfig: { entryMode: 'market' },
      exitConfig: { beEnabled: true, beR: 1.2, ratchetEnabled: false },
    },

    // Freq test 3: Multi-bar pullback (lookback 3 bars instead of 1)
    freq_lookback3: {
      experiment: 'freq_lookback3',
      dataPath,
      productionAccurate: true,
      vrEnabled: false,
      targetR: 2.5,
      strategyConfig: { pbLookbackBars: 3 },
      executionConfig: { entryMode: 'limit', limitRetracePct: 0.6, limitTimeoutBars: 5 },
      exitConfig: { beEnabled: true, beR: 1.2, ratchetEnabled: false },
    },

    // Freq test 4: COMBO — impulse cap 40 + market entry + lookback 3
    freq_combo: {
      experiment: 'freq_combo',
      dataPath,
      productionAccurate: true,
      vrEnabled: false,
      targetR: 2.5,
      strategyConfig: { pbMaxImpulse: 40, pbLookbackBars: 3 },
      executionConfig: { entryMode: 'market' },
      exitConfig: { beEnabled: true, beR: 1.2, ratchetEnabled: false },
    },

    // ── 3m TIMEFRAME EXPERIMENTS (all production-accurate) ──

    // 3m only: PB on 3-minute bars with scaled params
    freq_3m_only: {
      experiment: 'freq_3m_only',
      dataPath,
      productionAccurate: true,
      vrEnabled: false,
      targetR: 2.5,
      strategyConfig: {
        pb3mEnabled: true,
        pb3mMinImpulse: 10,
        pb3mMaxImpulse: 30,
        pb3mLookbackBars: 3,
        pb3mMaxStopPoints: 25,
        pb3mMinStopPoints: 3,
        pb3mMinTargetPoints: 15,
        pbMaxTime: 0,  // Disable 5m PB (set cutoff to 0)
      },
      executionConfig: { entryMode: 'market' },
      exitConfig: { beEnabled: true, beR: 1.2, ratchetEnabled: false },
    },

    // 5m+3m combo: both timeframes with best settings from freq_combo
    freq_5m_3m: {
      experiment: 'freq_5m_3m',
      dataPath,
      productionAccurate: true,
      vrEnabled: false,
      targetR: 2.5,
      strategyConfig: {
        pbMaxImpulse: 40,
        pbLookbackBars: 3,
        pb3mEnabled: true,
        pb3mMinImpulse: 10,
        pb3mMaxImpulse: 30,
        pb3mLookbackBars: 3,
        pb3mMaxStopPoints: 25,
        pb3mMinStopPoints: 3,
        pb3mMinTargetPoints: 15,
      },
      executionConfig: { entryMode: 'market' },
      exitConfig: { beEnabled: true, beR: 1.2, ratchetEnabled: false },
    },

    // 2m only: PB on 2-minute bars with scaled params
    freq_2m_only: {
      experiment: 'freq_2m_only',
      dataPath,
      productionAccurate: true,
      vrEnabled: false,
      targetR: 2.5,
      strategyConfig: {
        pb2mEnabled: true,
        pb2mMinImpulse: 8,
        pb2mMaxImpulse: 25,
        pb2mLookbackBars: 3,
        pb2mMaxStopPoints: 20,
        pb2mMinStopPoints: 2,
        pb2mMinTargetPoints: 10,
        pbMaxTime: 0,   // Disable 5m PB
        pb3mEnabled: false,
      },
      executionConfig: { entryMode: 'market' },
      exitConfig: { beEnabled: true, beR: 1.2, ratchetEnabled: false },
    },

    // 5m+3m+2m: all three timeframes with best settings
    freq_5m_3m_2m: {
      experiment: 'freq_5m_3m_2m',
      dataPath,
      productionAccurate: true,
      vrEnabled: false,
      targetR: 2.5,
      strategyConfig: {
        pbMaxImpulse: 40,
        pbLookbackBars: 3,
        pb3mEnabled: true,
        pb3mMinImpulse: 10,
        pb3mMaxImpulse: 30,
        pb3mLookbackBars: 3,
        pb3mMaxStopPoints: 25,
        pb3mMinStopPoints: 3,
        pb3mMinTargetPoints: 15,
        pb2mEnabled: true,
        pb2mMinImpulse: 8,
        pb2mMaxImpulse: 25,
        pb2mLookbackBars: 3,
        pb2mMaxStopPoints: 20,
        pb2mMinStopPoints: 2,
        pb2mMinTargetPoints: 10,
      },
      executionConfig: { entryMode: 'market' },
      exitConfig: { beEnabled: true, beR: 1.2, ratchetEnabled: false },
    },

    // Phase 2: Raw PB edge test
    pb_baseline: {
      experiment: 'pb_baseline',
      dataPath,
      vrEnabled: false,
      targetR: 2.0,
      executionConfig: { entryMode: 'market' },
      exitConfig: { beEnabled: false, ratchetEnabled: false },
    },

    // Phase 3: Execution variants
    exec_market: {
      experiment: 'exec_market',
      dataPath,
      vrEnabled: false,
      targetR: 2.5,
      executionConfig: { entryMode: 'market' },
      exitConfig: { beEnabled: false, ratchetEnabled: false },
    },
    exec_limit_40: {
      experiment: 'exec_limit_40',
      dataPath,
      vrEnabled: false,
      targetR: 2.5,
      executionConfig: { entryMode: 'limit', limitRetracePct: 0.4, limitTimeoutBars: 5 },
      exitConfig: { beEnabled: false, ratchetEnabled: false },
    },
    exec_limit_50: {
      experiment: 'exec_limit_50',
      dataPath,
      vrEnabled: false,
      targetR: 2.5,
      executionConfig: { entryMode: 'limit', limitRetracePct: 0.5, limitTimeoutBars: 5 },
      exitConfig: { beEnabled: false, ratchetEnabled: false },
    },
    exec_limit_60: {
      experiment: 'exec_limit_60',
      dataPath,
      vrEnabled: false,
      targetR: 2.5,
      executionConfig: { entryMode: 'limit', limitRetracePct: 0.6, limitTimeoutBars: 5 },
      exitConfig: { beEnabled: false, ratchetEnabled: false },
    },

    // Phase 4: Exit variants (will use best entry from Phase 3)
    exit_none: {
      experiment: 'exit_none',
      dataPath,
      vrEnabled: false,
      targetR: 2.5,
      executionConfig: { entryMode: 'market' },
      exitConfig: { beEnabled: false, ratchetEnabled: false },
    },
    exit_be2r: {
      experiment: 'exit_be2r',
      dataPath,
      vrEnabled: false,
      targetR: 2.5,
      executionConfig: { entryMode: 'market' },
      exitConfig: { beEnabled: true, beR: 2.0, ratchetEnabled: false },
    },
    exit_ratchet: {
      experiment: 'exit_ratchet',
      dataPath,
      vrEnabled: false,
      targetR: 2.5,
      executionConfig: { entryMode: 'market' },
      exitConfig: {
        beEnabled: false,
        ratchetEnabled: true,
        ratchetLevels: [
          { triggerR: 1.5, stopR: 0.25 },
          { triggerR: 2.0, stopR: 0.75 },
          { triggerR: 2.5, stopR: 1.5 },
        ],
      },
    },

    // Phase 6: VR validation
    vr_validation: {
      experiment: 'vr_validation',
      dataPath,
      vrEnabled: true,
      pbEnabled: false,
      targetR: 4.0,
      strategyConfig: {
        vrMinSigma: 1.5,
        vrTargetMode: 'vwap',
      },
      executionConfig: { entryMode: 'market' },
      exitConfig: { beEnabled: false, ratchetEnabled: false },
    },
  };

  if (experiment === 'all') {
    console.log(`\nRunning ALL experiments...\n`);
    const results = {};
    for (const [name, config] of Object.entries(experiments)) {
      console.log(`\n${'#'.repeat(60)}`);
      console.log(`  EXPERIMENT: ${name}`);
      console.log(`${'#'.repeat(60)}`);
      const bt = new ResearchBacktester(config);
      results[name] = bt.run();
    }

    // Print comparison table
    console.log(`\n${'='.repeat(80)}`);
    console.log(`  EXPERIMENT COMPARISON`);
    console.log(`${'='.repeat(80)}`);
    console.log(`${'Name'.padEnd(18)} | ${'Setups'.padEnd(7)} | ${'Trades'.padEnd(7)} | ${'WR'.padEnd(7)} | ${'PF'.padEnd(6)} | ${'ExpR'.padEnd(7)} | ${'Exp/Setup'.padEnd(9)} | ${'MaxDD'.padEnd(6)}`);
    console.log(`${'-'.repeat(80)}`);
    for (const [name, s] of Object.entries(results)) {
      console.log(`${name.padEnd(18)} | ${String(s.total_setups).padEnd(7)} | ${String(s.total_trades).padEnd(7)} | ${String(s.win_rate).padEnd(7)} | ${String(s.profit_factor).padEnd(6)} | ${String(s.expectancy_R).padEnd(7)} | ${String(s.expectancy_per_setup).padEnd(9)} | ${String(s.max_drawdown_R).padEnd(6)}`);
    }
    console.log(`${'='.repeat(80)}`);

    // Save comparison
    const compPath = path.join(__dirname, 'results', 'comparison.json');
    fs.writeFileSync(compPath, JSON.stringify(results, null, 2));
    console.log(`\n[Comparison] Written to ${compPath}`);

  } else {
    const config = experiments[experiment];
    if (!config) {
      console.error(`Unknown experiment: ${experiment}`);
      console.error(`Available: ${Object.keys(experiments).join(', ')}, all`);
      process.exit(1);
    }
    const bt = new ResearchBacktester(config);
    bt.run();
  }
}

// Suppress strategy console.log spam during backtesting
const originalLog = console.log;
const originalWarn = console.warn;
let suppressStrategyLogs = false;

const _origLog = console.log;
console.log = function (...args) {
  const msg = args[0];
  if (typeof msg === 'string' && (
    msg.startsWith('[1m #') ||
    msg.startsWith('[5m #') ||
    msg.startsWith('[PB #') && msg.includes('SKIP') ||
    msg.startsWith('[PB3m #') ||
    msg.startsWith('[PB2m #') ||
    msg.startsWith('[Strategy:') ||
    msg.startsWith('[VR]') && !msg.includes('SIGNAL') ||
    msg.startsWith('[PB WATCH]') && msg.includes('TIMEOUT') ||
    msg.startsWith('[VOL_FILTER]')
  )) {
    return; // Suppress noisy strategy logs
  }
  _origLog.apply(console, args);
};

runExperiments();
