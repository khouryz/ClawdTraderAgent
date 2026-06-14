/**
 * MarketDataRecorder — records the live feed the bot ACTUALLY saw (⑥).
 *
 * Owned by SharedPriceProvider (shared across all accounts — the feed is shared).
 * Appends, per parent symbol, every emitted 1s bar, every synthesized/native 1m
 * bar, and the data-layer events (contract lock, roll, gap) to a daily JSONL so a
 * session can be replayed deterministically (reproduce a bug exactly) and so a
 * real, survivorship-free dataset accrues that matches live exactly — no Databento
 * re-fetch drift. High-volume but tiny per line; gate off with RECORD_MARKET_DATA=
 * false. One file per (symbol, date): `<dir>/md_<symbol>_<date>.jsonl`.
 *
 * Each line carries `k` (kind): '1s' | '1m' | 'lock' | 'roll' | 'gap'.
 */

const JsonlRecorder = require('./JsonlRecorder');

class MarketDataRecorder {
  constructor(opts = {}) {
    this.dir = opts.dir || './data/marketdata';
    this.enabled = opts.enabled !== false;
    // 1s bars are high-volume AND re-fetchable from Databento historical, so we do
    // NOT persist them by default (waste of disk). 1m bars + lock/roll events are
    // tiny and the events are bot-internal (not in Databento), so those stay on.
    // Flip RECORD_MARKET_DATA_1S=true to capture the full 1s stream for replay.
    this.record1s = opts.record1s === true;
    this._recorders = new Map(); // symbol -> JsonlRecorder
  }

  _rec(symbol) {
    let r = this._recorders.get(symbol);
    if (!r) {
      const safe = String(symbol).replace(/[^A-Za-z0-9._-]/g, '_');
      // Larger buffer: 1s bars are frequent. Still async + bounded.
      r = new JsonlRecorder({ dir: this.dir, stream: `md_${safe}`, enabled: this.enabled, maxBuffer: 20000 });
      this._recorders.set(symbol, r);
    }
    return r;
  }

  /** A 1-second bar — only persisted when record1s is explicitly enabled (off by default). */
  bar1s(symbol, bar) {
    if (!this.enabled || !this.record1s) return;
    this._rec(symbol).record({ k: '1s', ...bar });
  }

  /** A 1-minute bar (native or synthesized — whichever drives the strategy). */
  bar1m(symbol, bar) {
    if (!this.enabled) return;
    this._rec(symbol).record({ k: '1m', ...bar });
  }

  /** A data-layer event: 'lock' | 'roll' | 'gap'. */
  event(symbol, kind, data) {
    if (!this.enabled) return;
    this._rec(symbol).record({ k: kind, t: new Date().toISOString(), ...(data || {}) });
  }

  flushAll() { return Promise.all([...this._recorders.values()].map(r => r.flush())); }
  closeAll() { for (const r of this._recorders.values()) r.close(); this._recorders.clear(); }
  stats() { return [...this._recorders.entries()].map(([s, r]) => ({ symbol: s, ...r.stats() })); }
}

module.exports = MarketDataRecorder;
