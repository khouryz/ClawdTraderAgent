/**
 * JsonlRecorder — append-only, daily-rotated JSONL sink.
 *
 * The single foundation under every structured journal (orders / signals / trades /
 * market-data). Design rules, in priority order:
 *   1. NEVER block the trading hot path — records are buffered in memory and flushed
 *      asynchronously on a timer; callers return immediately.
 *   2. NEVER throw into the caller — a bad record or a disk error is swallowed and
 *      surfaced on the console, but trading continues untouched.
 *   3. NEVER silently lose data on shutdown — a synchronous final flush runs on
 *      process 'exit'.
 *
 * One file per (stream, UTC-date): `<dir>/<stream>_<YYYY-MM-DD>.jsonl`, one JSON
 * object per line. Disable an instance with { enabled: false } (or let the owner
 * gate it on an env var).
 */

const fs = require('fs');
const path = require('path');

class JsonlRecorder {
  /**
   * @param {Object} opts
   * @param {string} opts.dir      - directory to write into (created if missing)
   * @param {string} opts.stream   - stream name → filename prefix
   * @param {boolean} [opts.enabled=true]
   * @param {number} [opts.flushMs=1000]
   * @param {number} [opts.maxBuffer=10000] - hard cap; forces a flush if exceeded
   */
  constructor(opts = {}) {
    this.dir = opts.dir || './data/journals';
    this.stream = opts.stream || 'events';
    this.enabled = opts.enabled !== false;
    this._flushMs = opts.flushMs || 1000;
    this._maxBuffer = opts.maxBuffer || 10000;

    this._buffer = [];
    this._flushing = false;
    this._timer = null;
    this._closed = false;
    this._dropped = 0; // count of records dropped due to overflow (observability)

    if (this.enabled) {
      try { fs.mkdirSync(this.dir, { recursive: true }); } catch (_) { /* best-effort */ }
      this._timer = setInterval(() => this._flush(), this._flushMs);
      if (this._timer.unref) this._timer.unref(); // never keep the process alive
      this._onExit = () => this._flushSync();
      process.once('exit', this._onExit);
    }
  }

  _filePath() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.dir, `${this.stream}_${date}.jsonl`);
  }

  /**
   * Append one record. Returns true if buffered, false if dropped/disabled.
   * Stringification is guarded so a circular/odd object can never throw upstream.
   */
  record(obj) {
    if (!this.enabled || this._closed) return false;
    let line;
    try {
      line = JSON.stringify(obj);
    } catch (e) {
      // Last-ditch: record the failure itself rather than throw.
      try { line = JSON.stringify({ _recorderError: e.message, stream: this.stream }); }
      catch (_) { return false; }
    }
    if (this._buffer.length >= this._maxBuffer) {
      this._flush(); // try to drain (swaps the buffer synchronously unless a flush is already in flight)
      if (this._buffer.length >= this._maxBuffer) {
        this._dropped++; // genuinely could not drain (disk stuck / flush in progress) → drop
        return false;
      }
    }
    this._buffer.push(line);
    return true;
  }

  /** Async flush. Re-schedules itself if more arrives while writing. */
  _flush() {
    if (this._flushing || this._buffer.length === 0) return;
    this._flushing = true;
    const lines = this._buffer;
    this._buffer = [];
    const data = lines.join('\n') + '\n';
    fs.appendFile(this._filePath(), data, (err) => {
      this._flushing = false;
      if (err) {
        // Re-queue (bounded) so a transient error doesn't lose data.
        this._buffer = lines.concat(this._buffer).slice(-this._maxBuffer);
        console.error(`[JsonlRecorder:${this.stream}] flush failed: ${err.message}`);
        return;
      }
      if (this._buffer.length) setImmediate(() => this._flush());
    });
  }

  /** Synchronous flush — used on process exit / explicit close. Never throws. */
  _flushSync() {
    if (!this._buffer.length) return;
    try {
      fs.appendFileSync(this._filePath(), this._buffer.join('\n') + '\n');
      this._buffer = [];
    } catch (_) { /* shutting down */ }
  }

  /** Force a flush and resolve when the bytes are on disk (used by tests). */
  flush() {
    return new Promise((resolve) => {
      if (!this.enabled || this._buffer.length === 0) return resolve();
      const lines = this._buffer;
      this._buffer = [];
      fs.appendFile(this._filePath(), lines.join('\n') + '\n', () => resolve());
    });
  }

  /** Stop the timer and flush synchronously. Safe to call multiple times. */
  close() {
    if (this._closed) return;
    this._closed = true;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._onExit) { process.removeListener('exit', this._onExit); this._onExit = null; }
    this._flushSync();
  }

  stats() {
    return { stream: this.stream, buffered: this._buffer.length, dropped: this._dropped, enabled: this.enabled };
  }
}

module.exports = JsonlRecorder;
