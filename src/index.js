#!/usr/bin/env node

/**
 * Tradovate Trading Bot
 * Main entry point - Designed for Clawdbot cron job execution
 * 
 * Commands:
 *   node src/index.js              - Start continuous trading mode
 *   node src/index.js --status     - Get current status (JSON output)
 *   node src/index.js --check      - Check for trade signals once
 *   node src/index.js --balance    - Get account balance
 *   node src/index.js --positions  - Get open positions
 *   node src/index.js --report     - Get performance report
 * 
 * NOTE: This file uses the modular TradovateBot from ./bot/TradovateBot.js
 * to ensure consistent P&L calculations and proper tick value handling.
 * 
 * CRITICAL FIX (2026-02-05): Removed duplicate TradovateBot class that had
 * incorrect P&L calculations (missing tick value multiplier). Now uses the
 * modular version which correctly multiplies by tickValue.
 */

require('dotenv').config();
const fs = require('fs');
const TradovateBot = require('./bot/TradovateBot');
const MultiInstrumentBot = require('./bot/MultiInstrumentBot');
const AccountManager = require('./bot/AccountManager');
const { executeCommand } = require('./cli/commands');
const logger = require('./utils/logger');

// CLI Command Handler
async function main() {
  const args = process.argv.slice(2);

  try {
    // Check for CLI commands first
    if (args.length > 0 && args[0].startsWith('--')) {
      // Use CLI command handler for commands
      await executeCommand(args);
    } else if (process.env.ACCOUNTS_DIR || fs.existsSync('./accounts')) {
      // Multi-account mode: accounts/ directory exists or ACCOUNTS_DIR env var set
      const accountsDir = process.env.ACCOUNTS_DIR || './accounts';
      logger.info(`Multi-account mode detected (accounts dir: ${accountsDir})`);
      const mgr = new AccountManager({ accountsDir });
      await mgr.start();
    } else if (process.env.INSTRUMENTS) {
      // Multi-instrument mode: INSTRUMENTS=MNQ,MES,M2K
      logger.info('Multi-instrument mode detected (INSTRUMENTS env var set)');
      const bot = new MultiInstrumentBot();
      await bot.start();
    } else {
      // Single-instrument mode (backward compatible)
      const bot = new TradovateBot();
      await bot.start();
    }
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  }
}

// Start if run directly
if (require.main === module) {
  main();
}

// Export the modular TradovateBot for external use
module.exports = TradovateBot;
