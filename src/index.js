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
const TradovateBot = require('./bot/TradovateBot');
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
    } else {
      // Default: start continuous trading mode using modular TradovateBot
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
