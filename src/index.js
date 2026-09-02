#!/usr/bin/env node

/**
 * Execution Bot - Entry Point
 * Receives trade signals via webhook, executes through Tradovate API.
 */

require('dotenv').config();
const ExecutionBot = require('./bot/ExecutionBot');
const logger = require('./utils/logger');

let bot = null;

async function main() {
  try {
    bot = new ExecutionBot();
    await bot.start();
  } catch (error) {
    logger.error(`Fatal error: ${error.message}`);
    // Try to notify before exiting
    if (bot && bot.notifications) {
      await bot.notifications.send(`🚨 <b>BOT CRASHED</b>\nFatal error: ${error.message}\nBot is OFFLINE.`).catch(() => {});
    }
    process.exit(1);
  }
}

// Handle graceful shutdown signals
async function gracefulShutdown(signal) {
  logger.info(`\n${signal} received — shutting down...`);
  if (bot) {
    await bot.shutdown().catch(() => {});
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Handle uncaught errors — notify before crashing
process.on('uncaughtException', async (err) => {
  logger.error(`Uncaught exception: ${err.message}\n${err.stack}`);
  if (bot && bot.notifications) {
    await bot.notifications.send(`🚨 <b>BOT CRASHED</b>\nUncaught exception: ${err.message}\nBot is OFFLINE — restart required.`).catch(() => {});
  }
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
  if (bot && bot.notifications) {
    await bot.notifications.send(`🚨 <b>BOT ERROR</b>\nUnhandled rejection: ${String(reason)}\nBot may be unstable.`).catch(() => {});
  }
});

if (require.main === module) {
  main();
}

module.exports = ExecutionBot;
