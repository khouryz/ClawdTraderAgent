/**
 * IncidentTracker — per-account, in-memory session tally → end-of-day digest.
 *
 * Aggregates everything you'd want to glance at when a bug is reported: how many
 * signals fired vs were rejected (and why), trade outcomes, connectivity events
 * (disconnects/downtime/dropped bars/reconnect cooldowns), and protection events
 * (BE safety-net fires, mirror divergences, order rejections, halts, slippage
 * blocks, deferred-entry outcomes). Purely in-memory + counters — zero hot-path
 * cost. `writeDigest()` serialises one `incidents_<date>.json` at EOD and returns a
 * compact text summary for Telegram.
 *
 * Sample lists are capped (default 200/category) so a pathological day can't grow
 * memory unbounded; the overflow count is preserved so the digest stays honest.
 */

class IncidentTracker {
  constructor(opts = {}) {
    this.accountId = opts.accountId || 'unknown';
    this._maxSamples = opts.maxSamples || 200;
    this.reset();
  }

  /** Clear all counters (called on the daily reset so each session starts clean). */
  reset() {
    this.dayStart = new Date().toISOString();
    this._counts = {};      // category -> count
    this._samples = {};     // category -> [{ at, ...data }] (capped)
    this._overflow = {};    // category -> dropped-sample count

    this.signals = { taken: 0, rejected: 0, byReason: {} };
    this.trades = { count: 0, wins: 0, losses: 0, breakeven: 0, pnl: 0 };
    this.connectivity = { disconnects: 0, downtimeMs: 0, barsDropped: 0, reconnectCooldowns: 0 };
    this.deferred = { started: 0, filled: 0, timedOut: 0 };
    this.protection = { beSafetyNet: 0, mirrorDivergence: 0, orderRejected: 0, halts: 0, slippageBlocked: 0 };
  }

  _add(category, data) {
    this._counts[category] = (this._counts[category] || 0) + 1;
    if (data !== undefined && data !== null) {
      if (!this._samples[category]) this._samples[category] = [];
      if (this._samples[category].length < this._maxSamples) {
        this._samples[category].push({ at: new Date().toISOString(), ...data });
      } else {
        this._overflow[category] = (this._overflow[category] || 0) + 1;
      }
    }
  }

  /**
   * Generic incident hook. `category` is one of the connectivity/protection event
   * names; `data` is an optional detail object captured as a (capped) sample.
   * Recognised categories also bump the typed aggregates below.
   */
  incident(category, data) {
    this._add(category, data);
    switch (category) {
      case 'disconnect':
        this.connectivity.disconnects++;
        if (data && data.downtimeMs) this.connectivity.downtimeMs += data.downtimeMs;
        break;
      case 'gap':
        if (data && data.dropped) this.connectivity.barsDropped += data.dropped;
        break;
      case 'reconnectCooldown': this.connectivity.reconnectCooldowns++; break;
      case 'deferredStart':   this.deferred.started++; break;
      case 'deferredFilled':  this.deferred.filled++; break;
      case 'deferredTimeout': this.deferred.timedOut++; break;
      case 'beSafetyNet':     this.protection.beSafetyNet++; break;
      case 'mirrorDivergence':this.protection.mirrorDivergence++; break;
      case 'orderRejected':   this.protection.orderRejected++; break;
      case 'halt':            this.protection.halts++; break;
      case 'slippageBlocked': this.protection.slippageBlocked++; break;
      default: break;
    }
  }

  signalTaken() { this.signals.taken++; }

  signalRejected(reason, data) {
    this.signals.rejected++;
    const key = reason || 'unknown';
    this.signals.byReason[key] = (this.signals.byReason[key] || 0) + 1;
    if (data) this._add(`reject:${key}`, data);
  }

  /** @param {'win'|'loss'|'breakeven'} outcome */
  tradeClosed(outcome, pnl) {
    this.trades.count++;
    if (outcome === 'win') this.trades.wins++;
    else if (outcome === 'loss') this.trades.losses++;
    else this.trades.breakeven++;
    this.trades.pnl += (typeof pnl === 'number' ? pnl : 0);
  }

  /** Structured digest object (also persisted to disk). */
  buildDigest() {
    const wr = this.trades.count > 0 ? Math.round((this.trades.wins / this.trades.count) * 100) : 0;
    return {
      accountId: this.accountId,
      date: this.dayStart.split('T')[0],
      dayStart: this.dayStart,
      generatedAt: new Date().toISOString(),
      signals: { ...this.signals },
      trades: { ...this.trades, winRatePct: wr, pnl: Number(this.trades.pnl.toFixed(2)) },
      connectivity: { ...this.connectivity, downtimeSec: Number((this.connectivity.downtimeMs / 1000).toFixed(1)) },
      deferredEntries: { ...this.deferred },
      protection: { ...this.protection },
      counts: { ...this._counts },
      samples: this._samples,
      sampleOverflow: this._overflow,
    };
  }

  /** Compact, human-readable summary for Telegram / console. */
  textSummary() {
    const d = this.buildDigest();
    const reasons = Object.entries(d.signals.byReason)
      .sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}:${n}`).join(', ') || 'none';
    const pnlStr = d.trades.pnl >= 0 ? `+$${d.trades.pnl.toFixed(2)}` : `-$${Math.abs(d.trades.pnl).toFixed(2)}`;
    const lines = [
      `📋 <b>INCIDENT DIGEST</b> — ${d.accountId} (${d.date})`,
      `Signals: ${d.signals.taken} taken / ${d.signals.rejected} rejected [${reasons}]`,
      `Trades: ${d.trades.count} (${d.trades.wins}W/${d.trades.losses}L/${d.trades.breakeven}BE) ${pnlStr} ${d.trades.winRatePct}%WR`,
      `Connectivity: ${d.connectivity.disconnects} disconnect(s), ${d.connectivity.downtimeSec}s down, ${d.connectivity.barsDropped} bar(s) dropped, ${d.connectivity.reconnectCooldowns} cooldown(s)`,
      `Protection: ${d.protection.beSafetyNet} BE-net, ${d.protection.slippageBlocked} slippage-block, ${d.protection.mirrorDivergence} mirror-div, ${d.protection.orderRejected} order-rej, ${d.protection.halts} halt(s)`,
      `Deferred entries: ${d.deferredEntries.started} started → ${d.deferredEntries.filled} filled / ${d.deferredEntries.timedOut} timed-out`,
    ];
    return lines.join('\n');
  }

  /** True if anything noteworthy happened (used to decide whether to alert). */
  hasNotableIncidents() {
    const p = this.protection, c = this.connectivity;
    return (p.beSafetyNet + p.mirrorDivergence + p.orderRejected + p.halts + p.slippageBlocked +
            c.disconnects + c.barsDropped + this.deferred.timedOut) > 0;
  }

  /** Persist the digest. Synchronous write (called once/day at EOD — not hot path). */
  writeDigest(dir) {
    const fs = require('fs');
    const path = require('path');
    const digest = this.buildDigest();
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `incidents_${digest.date}.json`);
      fs.writeFileSync(file, JSON.stringify(digest, null, 2));
      return { digest, file };
    } catch (e) {
      return { digest, file: null, error: e.message };
    }
  }
}

module.exports = IncidentTracker;
