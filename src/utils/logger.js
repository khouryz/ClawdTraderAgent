/**
 * Simple logger utility
 */

const fs = require('fs');
const path = require('path');

class Logger {
  constructor(logDir = './logs') {
    this.logDir = logDir;
    this.ensureLogDir();
  }

  ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
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

    // Also write to file
    fs.appendFileSync(this.getLogFilePath(), formatted + '\n');
  }

  info(message) {
    this.write('INFO', message);
  }

  warn(message) {
    this.write('WARN', message);
  }

  error(message) {
    this.write('ERROR', message);
  }

  success(message) {
    this.write('SUCCESS', message);
  }

  trade(message) {
    this.write('TRADE', message);
  }

  debug(message) {
    // Only log debug in development
    if (process.env.DEBUG === 'true') {
      this.write('DEBUG', message);
    }
  }
}

module.exports = new Logger();
