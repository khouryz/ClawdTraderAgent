/**
 * SetupLogger — Structured trade setup logging for research pipeline
 * 
 * Logs every detected setup (not just filled trades) to JSONL files.
 * Each row contains full feature set for quantitative analysis.
 * 
 * Output: research/results/<experiment_name>_setups.jsonl
 */

const fs = require('fs');
const path = require('path');

class SetupLogger {
  constructor(experimentName, outputDir) {
    this.experimentName = experimentName;
    this.outputDir = outputDir || path.join(__dirname, 'results');
    this.setups = [];
    this._ensureDir();
  }

  _ensureDir() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Log a detected setup with full feature set.
   * Called when a PB or VR pattern is detected, regardless of whether it fills.
   * 
   * @param {Object} setup
   * @param {string} setup.date - YYYY-MM-DD
   * @param {string} setup.session_time - HH:MM PST
   * @param {string} setup.sub_strategy - 'PB' or 'VR'
   * @param {string} setup.direction - 'long' or 'short'
   * 
   * Setup features:
   * @param {number} setup.impulse_range - Impulse bar range in points
   * @param {number} setup.retrace_pct - Retrace % (0-1)
   * @param {number} setup.stop_distance - Stop distance in points
   * @param {number} setup.target_distance - Target distance in points
   * @param {number} setup.entry_price - Signal entry price
   * @param {number} setup.stop_price - Stop price
   * @param {number} setup.target_price - Target price
   * @param {number} setup.volume_ratio - Bar volume / 20-bar avg volume
   * @param {number} setup.atr - Current ATR(14)
   * @param {number} setup.vwap_distance - Distance from VWAP in points
   * @param {number} setup.sigma_stretch - Distance from VWAP in σ units
   * @param {number} setup.confluence_score - Confluence score
   * @param {Array}  setup.confluence_factors - Individual confluence factors
   * 
   * Market structure context:
   * @param {number} setup.distance_from_session_vwap
   * @param {number} setup.distance_from_session_high
   * @param {number} setup.distance_from_session_low
   * @param {number} setup.distance_from_prior_day_vah
   * @param {number} setup.distance_from_prior_day_val
   * @param {number} setup.distance_from_prior_day_poc
   * @param {string} setup.price_location_vs_prior_value - 'above_VAH' | 'inside_value' | 'below_VAL' | 'no_data'
   * 
   * Volatility regime:
   * @param {number} setup.atr_percentile_30d - ATR percentile vs 30-day lookback
   * @param {number} setup.range_percentile_today - Today's range vs 30-day lookback
   * @param {number} setup.session_range_so_far - Session range at time of setup
   * @param {string} setup.volatility_regime_label - 'low' | 'normal' | 'high'
   * 
   * Fill info (set after execution simulation):
   * @param {string} setup.fill_type - 'market' | 'limit' | 'missed' | 'timeout' | 'invalidated'
   * @param {number} setup.fill_price - Actual fill price (null if missed)
   * 
   * Trade outcome (set after trade completes or forward-simulated):
   * @param {number} setup.mae - Maximum Adverse Excursion (worst drawdown in R)
   * @param {number} setup.mfe - Maximum Favorable Excursion (best unrealized in R)
   * @param {string} setup.exit_reason - 'stop' | 'target' | 'eod' | 'time' | 'simulated_stop' | 'simulated_target'
   * @param {number} setup.realized_R - Realized R-multiple
   * @param {number} setup.bars_in_trade - Number of bars in trade
   * @param {number} setup.duration_minutes - Duration in minutes
   */
  logSetup(setup) {
    // Round numeric fields to reasonable precision
    const rounded = { ...setup };
    const numFields = [
      'impulse_range', 'retrace_pct', 'stop_distance', 'target_distance',
      'entry_price', 'stop_price', 'target_price', 'fill_price',
      'volume_ratio', 'atr', 'vwap_distance', 'sigma_stretch',
      'distance_from_session_vwap', 'distance_from_session_high',
      'distance_from_session_low', 'distance_from_prior_day_vah',
      'distance_from_prior_day_val', 'distance_from_prior_day_poc',
      'atr_percentile_30d', 'range_percentile_today', 'session_range_so_far',
      'mae', 'mfe', 'realized_R'
    ];
    for (const f of numFields) {
      if (rounded[f] !== null && rounded[f] !== undefined && typeof rounded[f] === 'number') {
        rounded[f] = Math.round(rounded[f] * 10000) / 10000;
      }
    }

    this.setups.push(rounded);
  }

  /**
   * Write all logged setups to JSONL file
   */
  flush() {
    const filePath = path.join(this.outputDir, `${this.experimentName}_setups.jsonl`);
    const lines = this.setups.map(s => JSON.stringify(s)).join('\n');
    fs.writeFileSync(filePath, lines + '\n', 'utf8');
    console.log(`[SetupLogger] Wrote ${this.setups.length} setups to ${filePath}`);
    return filePath;
  }

  /**
   * Get summary statistics
   */
  getSummary() {
    const total = this.setups.length;
    const filled = this.setups.filter(s => s.fill_type === 'market' || s.fill_type === 'limit');
    const missed = this.setups.filter(s => s.fill_type === 'missed' || s.fill_type === 'timeout');
    const wins = filled.filter(s => s.realized_R > 0);
    const losses = filled.filter(s => s.realized_R < 0);
    const be = filled.filter(s => s.realized_R === 0);

    const totalR = filled.reduce((sum, s) => sum + (s.realized_R || 0), 0);
    const grossWinR = wins.reduce((sum, s) => sum + s.realized_R, 0);
    const grossLossR = losses.reduce((sum, s) => sum + Math.abs(s.realized_R), 0);

    // Impulse size buckets
    const pbSetups = this.setups.filter(s => s.sub_strategy === 'PB');
    const buckets = {
      '15-20': pbSetups.filter(s => s.impulse_range >= 15 && s.impulse_range < 20),
      '20-30': pbSetups.filter(s => s.impulse_range >= 20 && s.impulse_range < 30),
      '30-50': pbSetups.filter(s => s.impulse_range >= 30 && s.impulse_range < 50),
      '50+':   pbSetups.filter(s => s.impulse_range >= 50),
    };

    const bucketStats = {};
    for (const [name, setups] of Object.entries(buckets)) {
      const bf = setups.filter(s => s.fill_type === 'market' || s.fill_type === 'limit');
      const bw = bf.filter(s => s.realized_R > 0);
      bucketStats[name] = {
        setups: setups.length,
        filled: bf.length,
        win_rate: bf.length > 0 ? (bw.length / bf.length * 100).toFixed(1) + '%' : 'N/A',
        avg_R: bf.length > 0 ? (bf.reduce((s, x) => s + (x.realized_R || 0), 0) / bf.length).toFixed(3) : 'N/A',
        expectancy_per_setup: setups.length > 0
          ? (bf.reduce((s, x) => s + (x.realized_R || 0), 0) / setups.length).toFixed(3)
          : 'N/A',
      };
    }

    return {
      total_setups: total,
      total_trades: filled.length,
      missed: missed.length,
      fill_rate: total > 0 ? (filled.length / total * 100).toFixed(1) + '%' : 'N/A',
      wins: wins.length,
      losses: losses.length,
      breakeven: be.length,
      win_rate: filled.length > 0 ? (wins.length / filled.length * 100).toFixed(1) + '%' : 'N/A',
      profit_factor: grossLossR > 0 ? (grossWinR / grossLossR).toFixed(2) : (grossWinR > 0 ? 'Inf' : '0'),
      expectancy_R: filled.length > 0 ? (totalR / filled.length).toFixed(3) : 'N/A',
      expectancy_per_setup: total > 0 ? (totalR / total).toFixed(3) : 'N/A',
      total_R: totalR.toFixed(2),
      avg_MAE: filled.length > 0 ? (filled.reduce((s, x) => s + (x.mae || 0), 0) / filled.length).toFixed(3) : 'N/A',
      avg_MFE: filled.length > 0 ? (filled.reduce((s, x) => s + (x.mfe || 0), 0) / filled.length).toFixed(3) : 'N/A',
      max_drawdown_R: this._calcMaxDrawdownR(filled),
      impulse_buckets: bucketStats,
    };
  }

  _calcMaxDrawdownR(trades) {
    let peak = 0;
    let cumR = 0;
    let maxDD = 0;
    for (const t of trades) {
      cumR += (t.realized_R || 0);
      if (cumR > peak) peak = cumR;
      const dd = peak - cumR;
      if (dd > maxDD) maxDD = dd;
    }
    return maxDD.toFixed(2);
  }

  /**
   * Print formatted summary to console
   */
  printSummary() {
    const s = this.getSummary();
    console.log(`
${'='.repeat(60)}
  RESEARCH RESULTS: ${this.experimentName}
${'='.repeat(60)}

  SETUP STATISTICS
  ─────────────────────────────
  Total Setups:       ${s.total_setups}
  Total Trades:       ${s.total_trades}
  Missed/Timeout:     ${s.missed}
  Fill Rate:          ${s.fill_rate}

  TRADE PERFORMANCE
  ─────────────────────────────
  Wins:               ${s.wins}
  Losses:             ${s.losses}
  Breakeven:          ${s.breakeven}
  Win Rate:           ${s.win_rate}
  Profit Factor:      ${s.profit_factor}
  Expectancy (R):     ${s.expectancy_R}
  Exp/Setup (R):      ${s.expectancy_per_setup}
  Total R:            ${s.total_R}
  Max Drawdown (R):   ${s.max_drawdown_R}

  MAE/MFE
  ─────────────────────────────
  Avg MAE:            ${s.avg_MAE} R
  Avg MFE:            ${s.avg_MFE} R

  IMPULSE SIZE BUCKETS (PB only)
  ─────────────────────────────`);
    for (const [name, bs] of Object.entries(s.impulse_buckets)) {
      console.log(`  ${name.padEnd(8)} | setups: ${String(bs.setups).padEnd(4)} | filled: ${String(bs.filled).padEnd(4)} | WR: ${String(bs.win_rate).padEnd(7)} | avgR: ${String(bs.avg_R).padEnd(7)} | exp/setup: ${bs.expectancy_per_setup}`);
    }
    console.log(`\n${'='.repeat(60)}`);
  }
}

module.exports = SetupLogger;
