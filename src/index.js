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
let _shutdownRequested = false;
async function gracefulShutdown(signal) {
  if (_shutdownRequested) return;      // a second Ctrl+C must not race the first
  _shutdownRequested = true;
  logger.info(`${signal} received — shutting down...`);
  if (bot) {
    // Pass the signal through so the Telegram alert says WHY it stopped.
    await bot.shutdown(`${signal} received`).catch(err => {
      logger.error(`Shutdown failed: ${err.message}`);
      process.exit(1);
    });
  } else {
    process.exit(0);
  }
}

// Every catchable stop signal. SIGBREAK is Windows' Ctrl+Break and SIGHUP
// arrives when a terminal closes — both previously killed the bot with no
// offline alert at all. SIGKILL / taskkill /F cannot be caught by ANY process;
// the restart scripts send the alert on our behalf when they must force.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => gracefulShutdown(sig));
  } catch (_) { /* not every signal exists on every platform */ }
}

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
