/**
 * Journals — per-account façade over the structured recorders + incident tracker.
 *
 * This is the single object the live code calls. It owns:
 *   • orders  journal (JSONL)  — full order lifecycle (③)
 *   • signals journal (JSONL)  — every signal, taken AND rejected, with context (④)
 *   • trades  journal (JSONL)  — entry decision-trace + exit w/ R, P&L, MAE/MFE (⑤)
 *   • IncidentTracker          — session tally → EOD digest (②)
 *   • newTradeId()             — correlation id threaded through a whole trade
 *
 * Every method is fire-and-forget and never throws (the recorders swallow errors),
 * so a logging fault can never disturb trading. Disable the whole account's
 * journals with { enabled: false }.
 */

const JsonlRecorder = require('./JsonlRecorder');
const IncidentTracker = require('./IncidentTracker');

class Journals {
  constructor(opts = {}) {
    this.accountId = opts.accountId || 'unknown';
    const dir = opts.dir || './data/journals';
    const enabled = opts.enabled !== false;
    this.enabled = enabled;

    this.incidents = new IncidentTracker({ accountId: this.accountId });
    this._orders = new JsonlRecorder({ dir, stream: 'orders', enabled });
    this._signals = new JsonlRecorder({ dir, stream: 'signals', enabled });
    this._trades = new JsonlRecorder({ dir, stream: 'trades', enabled });
    this._seq = 0;
  }

  /** Correlation id threaded through one trade: signal → orders → fills → exit. */
  newTradeId() {
    this._seq = (this._seq + 1) % 1e6;
    return `${this.accountId}-${Date.now().toString(36)}-${this._seq.toString(36)}`;
  }

  _stamp(obj) { return { t: new Date().toISOString(), account: this.accountId, ...obj }; }

  // ── signals (④) ──────────────────────────────────────────────────────────
  /** A signal that passed all gates and an entry was initiated. */
  signalTaken(rec) {
    this.incidents.signalTaken();
    this._signals.record(this._stamp({ outcome: 'taken', ...rec }));
  }

  /**
   * A signal that was rejected. `reason` is a stable key
   * (slippage|cooldown|session|confluence|lossLimit|maxPositions|paused|...).
   */
  signalRejected(reason, rec) {
    this.incidents.signalRejected(reason, rec || null);
    if (reason === 'slippage') this.incidents.incident('slippageBlocked');
    this._signals.record(this._stamp({ outcome: 'rejected', reason, ...rec }));
  }

  // ── orders (③) ───────────────────────────────────────────────────────────
  /**
   * One order lifecycle event.
   * `rec.event` ∈ submit|accept|fill|partial|cancel|reject|modify.
   * Include rec.tradeId (correlation), rec.subAccount, rec.orderId, prices, qty,
   * and any computed latencyMs / slippagePt.
   */
  order(rec) {
    if (rec && rec.event === 'reject') {
      this.incidents.incident('orderRejected', { orderId: rec.orderId, reason: rec.reason });
    }
    this._orders.record(this._stamp(rec || {}));
  }

  // ── trades (⑤) ───────────────────────────────────────────────────────────
  /** Entry decision-trace (why we took it). */
  tradeOpened(rec) {
    this._trades.record(this._stamp({ kind: 'entry', ...rec }));
  }

  /** Completed trade (exit). Classifies outcome for the incident tally. */
  tradeClosed(rec) {
    const r = rec || {};
    const reason = String(r.exitReason || '').toLowerCase();
    let outcome = r.outcome;
    if (!outcome) {
      if (reason.includes('breakeven') || reason.includes('break-even') || reason.includes('be stop')) outcome = 'breakeven';
      else if (typeof r.pnl === 'number') outcome = r.pnl > 0 ? 'win' : r.pnl < 0 ? 'loss' : 'breakeven';
      else outcome = 'breakeven';
    }
    this.incidents.tradeClosed(outcome, r.pnl);
    this._trades.record(this._stamp({ kind: 'exit', outcome, ...r }));
  }

  // ── connectivity / protection (②) ────────────────────────────────────────
  /** Generic incident with no JSONL stream (disconnect/gap/cooldown/beSafetyNet/…). */
  incident(category, data) { this.incidents.incident(category, data); }

  // ── lifecycle ────────────────────────────────────────────────────────────
  /** EOD: persist the digest. Returns { digest, file, text, notable }. */
  writeDigest(dir) {
    const res = this.incidents.writeDigest(dir);
    return { ...res, text: this.incidents.textSummary(), notable: this.incidents.hasNotableIncidents() };
  }

  dailyReset() { this.incidents.reset(); }

  flushAll() { return Promise.all([this._orders.flush(), this._signals.flush(), this._trades.flush()]); }
  closeAll() { this._orders.close(); this._signals.close(); this._trades.close(); }

  stats() { return { orders: this._orders.stats(), signals: this._signals.stats(), trades: this._trades.stats() }; }
}

module.exports = Journals;
