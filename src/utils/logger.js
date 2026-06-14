/**
 * Simple logger utility.
 *
 * Console output is immediate (pm2 captures stdout → logs/pm2-out.log). The
 * redundant per-day file used to be written with a SYNCHRONOUS fs.appendFileSync
 * on EVERY log call, which blocks the event loop on the trading hot path. It is
 * now BUFFERED and flushed asynchronously on a timer, with a synchronous final
 * flush on process exit so nothing is lost on shutdown/crash. Public API is
 * unchanged (info/warn/error/success/trade/debug).
 */

const fs = require('fs');
const path = require('path');

class Logger {
  constructor(logDir = process.env.LOG_DIR || './logs') {
    this.logDir = logDir;
    this.ensureLogDir();

    // ── Async write buffer ──
    this._buffer = [];
    this._flushing = false;
    this._maxBuffer = 5000;          // hard cap: force a flush if we ever exceed it
    this._flushIntervalMs = parseInt(process.env.LOG_FLUSH_MS, 10) || 1000;
    // Allow disabling the file sink entirely (pm2 already persists stdout).
    this._fileSink = process.env.LOG_TO_FILE !== 'false';

    if (this._fileSink) {
      this._timer = setInterval(() => this._flush(), this._flushIntervalMs);
      if (this._timer.unref) this._timer.unref(); // never keep the process alive
      // Final, synchronous flush so a clean shutdown never drops buffered lines.
      process.once('exit', () => this._flushSync());
    }
  }

  ensureLogDir() {
    try {
      if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
    } catch (_) { /* best-effort */ }
  }

  getLogFilePath() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `bot-${date}.log`);
  }

  formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level}] ${message}`;
  }

  write(level, message) {
    const formatted = this.formatMessage(level, message);
    console.log(formatted);

    if (!this._fileSink) return;
    this._buffer.push(formatted);
    // Safety valve: if the buffer grows pathologically (flush failing), force one.
    if (this._buffer.length >= this._maxBuffer) this._flush();
  }

  /** Async flush of the current buffer. Re-schedules if more arrives mid-write. */
  _flush() {
    if (this._flushing || this._buffer.length === 0) return;
    this._flushing = true;
    const lines = this._buffer;
    this._buffer = [];
    const data = lines.join('\n') + '\n';
    fs.appendFile(this.getLogFilePath(), data, (err) => {
      this._flushing = false;
      if (err) {
        // Re-queue the lines so they aren't lost; cap to avoid unbounded growth.
        this._buffer = lines.concat(this._buffer).slice(-this._maxBuffer);
        console.error(`[Logger] flush failed: ${err.message}`);
        return;
      }
      if (this._buffer.length) setImmediate(() => this._flush());
    });
  }

  /** Synchronous flush — used only on process exit (best-effort, never throws). */
  _flushSync() {
    if (!this._buffer.length) return;
    try {
      fs.appendFileSync(this.getLogFilePath(), this._buffer.join('\n') + '\n');
      this._buffer = [];
    } catch (_) { /* shutting down — nothing more we can do */ }
  }

  info(message) { this.write('INFO', message); }
  warn(message) { this.write('WARN', message); }
  error(message) { this.write('ERROR', message); }
  success(message) { this.write('SUCCESS', message); }
  trade(message) { this.write('TRADE', message); }

  debug(message) {
    if (process.env.DEBUG === 'true') this.write('DEBUG', message);
  }
}

const instance = new Logger();
instance.Logger = Logger; // exposed for tests / explicit instantiation
module.exports = instance;
