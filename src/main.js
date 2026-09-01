#!/usr/bin/env node

/**
 * Execution Bot - Main Entry Point
 *
 * Starts the execution-only bot that receives trade signals via webhook
 * and executes them through the Tradovate API.
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
    console.error(JSON.stringify({ error: error.message }, null, 2));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = ExecutionBot;
