/**
 * DivergenceDetector — Inter-market divergence signal for correlated index futures.
 *
 * When correlated instruments (MES, MNQ, MYM) diverge — one makes a new session
 * high/low but the other hasn't — the laggard tends to catch up. This detector
 * monitors each runner's session extremes and fires divergence signals to the
 * laggard's strategy via `strategy.onDivergence()`.
 *
 * Architecture:
 *  - AccountInstance creates one DivergenceDetector shared across all its runners
 *  - Each runner calls `updateExtreme(symbol, high, low, timestamp)` on every 1m bar
 *  - When a runner makes a NEW session extreme, the detector checks all other
 *    runners: if they haven't made a matching extreme, fire onDivergence() on them
 *  - Cooldown per pair to avoid spamming (default 5 min)
 *  - Only fires for instruments with divergenceEnabled=true in their strategy config
 */

const logger = require('../utils/logger');

class DivergenceDetector {
  /**
   * @param {Object} opts
   * @param {number} opts.cooldownMs - Min time between divergence signals for the same pair (default 300000 = 5min)
   * @param {number} opts.minBarsBeforeSignal - Min bars since session start before firing (default 10)
   */
  constructor(opts = {}) {
    this.cooldownMs = opts.cooldownMs || 900000;       // 15 min (up from 5 — reduces signal spam)
    this.minBarsBeforeSignal = opts.minBarsBeforeSignal || 24;  // 2 hours (up from 10 — need real session data)
    this.minDivergenceATR = opts.minDivergenceATR || 0;  // min leader-vs-lagger distance in ATR units (0=off)

    // symbol -> { high, low, highTime, lowTime, barCount, strategy }
    this._instruments = new Map();
    // pair cooldowns: "LEADER->LAGGARD" -> lastFireMs
    this._cooldowns = new Map();
  }

  /**
   * Register an instrument for divergence monitoring.
   * @param {string} symbol - Instrument base symbol (e.g. 'MES', 'MNQ')
   * @param {Object} strategy - The strategy instance (must have onDivergence method)
   */
  register(symbol, strategy) {
    this._instruments.set(symbol, {
      high: null,
      low: null,
      highTime: null,
      lowTime: null,
      barCount: 0,
      strategy,
    });
  }

  /**
   * Update an instrument's session extreme. Called by each runner on every 1m bar close.
   * If a new extreme is made, check for divergence against all other registered instruments.
   * @param {string} symbol - Instrument symbol
   * @param {number} high - Current session high
   * @param {number} low - Current session low
   * @param {number} timestamp - Bar timestamp (ms epoch)
   */
  updateExtreme(symbol, high, low, timestamp) {
    const inst = this._instruments.get(symbol);
    if (!inst) return;

    inst.barCount++;
    const madeNewHigh = inst.high === null || high > inst.high;
    const madeNewLow = inst.low === null || low < inst.low;

    if (madeNewHigh) {
      inst.high = high;
      inst.highTime = timestamp;
    }
    if (madeNewLow) {
      inst.low = low;
      inst.lowTime = timestamp;
    }

    // Need enough bars before signaling (avoid noise at session open)
    if (inst.barCount < this.minBarsBeforeSignal) return;

    // Check for divergence: we made a new high, did the others?
    if (madeNewHigh) {
      this._checkDivergence(symbol, 'long', high, timestamp);
    }
    if (madeNewLow) {
      this._checkDivergence(symbol, 'short', low, timestamp);
    }
  }

  /**
   * Check if the leader's new extreme creates a divergence with other instruments.
   * @param {string} leaderSymbol - The instrument that made the new extreme
   * @param {string} direction - 'long' (new high) or 'short' (new low)
   * @param {number} leaderExtreme - The new extreme value
   * @param {number} timestamp - Timestamp of the new extreme
   * @private
   */
  _checkDivergence(leaderSymbol, direction, leaderExtreme, timestamp) {
    const leader = this._instruments.get(leaderSymbol);
    if (!leader) return;

    for (const [laggerSymbol, lagger] of this._instruments) {
      if (laggerSymbol === leaderSymbol) continue;
      if (!lagger.strategy) continue;
      if (!lagger.strategy.divergenceEnabled) continue;

      // Cooldown check
      const pairKey = `${leaderSymbol}->${laggerSymbol}:${direction}`;
      const lastFire = this._cooldowns.get(pairKey);
      if (lastFire && (timestamp - lastFire) < this.cooldownMs) continue;

      // Check if the lagger has NOT made a matching extreme recently
      // (i.e. the leader is ahead). We use a time-based heuristic: if the leader's
      // extreme is more recent than the lagger's, the lagger is behind.
      let laggerExtreme, laggerTime;
      if (direction === 'long') {
        laggerExtreme = lagger.high;
        laggerTime = lagger.highTime;
      } else {
        laggerExtreme = lagger.low;
        laggerTime = lagger.lowTime;
      }

      if (laggerExtreme == null || laggerTime == null) continue;

      // The lagger must not have made a new extreme in the last 3 minutes
      // (if they both broke at nearly the same time, it's not a divergence)
      const recentMs = 180000;
      if ((timestamp - laggerTime) < recentMs) continue;

      // Fire divergence signal to the lagger
      const signal = {
        direction,
        leaderSymbol,
        leaderExtreme,
        leaderTime: timestamp,
        laggerSymbol,
        laggerExtreme,
      };

      try {
        if (typeof lagger.strategy.onDivergence === 'function') {
          lagger.strategy.onDivergence(signal);
          this._cooldowns.set(pairKey, timestamp);
          logger.info(`[DIVERGENCE] ${leaderSymbol} new ${direction === 'long' ? 'HIGH' : 'LOW'} ${leaderExtreme.toFixed(2)} → signaled ${laggerSymbol} (last extreme ${laggerExtreme.toFixed(2)} ${((timestamp - laggerTime) / 1000).toFixed(0)}s ago)`);
        }
      } catch (e) {
        logger.error(`[DIVERGENCE] Error calling onDivergence on ${laggerSymbol}: ${e.message}`);
      }
    }
  }

  /**
   * Reset all session tracking (called on daily reset).
   */
  resetDay() {
    for (const inst of this._instruments.values()) {
      inst.high = null;
      inst.low = null;
      inst.highTime = null;
      inst.lowTime = null;
      inst.barCount = 0;
    }
    this._cooldowns.clear();
  }
}

module.exports = DivergenceDetector;
