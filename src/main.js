#!/usr/bin/env node

/**
 * Tradovate Trading Bot - Main Entry Point
 * 
 * Commands:
 *   node src/main.js              - Start continuous trading mode
 *   node src/main.js --status     - Get current status (JSON output)
 *   node src/main.js --check      - Check for trade signals once
 *   node src/main.js --balance    - Get account balance
 *   node src/main.js --positions  - Get open positions
 *   node src/main.js --report     - Get performance report
 *   node src/main.js --help       - Show help
 */

require('dotenv').config();
const { TradovateBot } = require('./bot');
const { executeCommand } = require('./cli/commands');

async function main() {
  const bot = new TradovateBot();

  try {
    // Check for CLI commands
    const result = await executeCommand(bot);
    
    if (result) {
      // Command was executed, output result and exit
      if (result.exit) {
        process.exit(0);
      }
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }

    // No command - start continuous trading mode
    await bot.start();

  } catch (error) {
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  }
}

// Start if run directly
if (require.main === module) {
  main();
}

module.exports = { main };
