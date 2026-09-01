#!/usr/bin/env node

/**
 * 30s Breakout — isolated demo launcher.
 *
 * Loads .env.s30 (NOT the production .env) and starts the MultiInstrumentBot
 * directly in INSTRUMENTS mode. This keeps the 30s breakout deployment fully
 * isolated from the live MNQ momentum bot (which runs via `node src/index.js`
 * in MULTI_ACCOUNT mode off .env).
 *
 * Usage:  node start_s30.js
 */

const path = require('path');

// Load the dedicated env file before anything reads process.env.
require('dotenv').config({ path: path.join(__dirname, '.env.s30') });

const MultiInstrumentBot = require('./src/bot/MultiInstrumentBot');
const logger = require('./src/utils/logger');

async function main() {
  if (process.env.TRADOVATE_ENV !== 'demo') {
    logger.error(`Refusing to start: .env.s30 must have TRADOVATE_ENV=demo (got "${process.env.TRADOVATE_ENV}")`);
    process.exit(1);
  }
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  logger.info('🚀 30s Breakout Bot (DEMO) starting from .env.s30');
  logger.info(`   Instruments: ${process.env.INSTRUMENTS}`);
  logger.info(`   Strategy:    ${process.env.MNQ_STRATEGY}`);
  logger.info(`   R-target:    ${process.env.MNQ_PROFIT_TARGET_R} | Max risk: $${process.env.MNQ_RISK_PER_TRADE_MAX} | DLL: $${process.env.MNQ_DAILY_LOSS_LIMIT}`);
  logger.info(`   Max hold:    ${process.env.MNQ_MAX_HOLD_MINUTES}min`);
  logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  const bot = new MultiInstrumentBot();
  await bot.start();
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  console.error(err);
  process.exit(1);
});
