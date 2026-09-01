#!/usr/bin/env node

/**
 * Execution Bot - Entry Point
 * Receives trade signals via webhook, executes through Tradovate API.
 */

require('dotenv').config();
const ExecutionBot = require('./bot/ExecutionBot');
const logger = require('./utils/logger');

async function main() {
  try {
    const bot = new ExecutionBot();
    await bot.start();
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = ExecutionBot;
