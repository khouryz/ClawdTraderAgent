#!/usr/bin/env node

/**
 * Replay Backtest Runner
 * Uses Tradovate's Market Replay API for realistic backtesting
 * 
 * Usage:
 *   node replay-backtest.js                           - Run with default periods
 *   node replay-backtest.js --start "2024-01-15"      - Start from specific date
 *   node replay-backtest.js --days 5                  - Run for N days
 *   node replay-backtest.js --balance 5000            - Start with $5000
 *   node replay-backtest.js --speed 800               - 800x replay speed
 */

require('dotenv').config();
const TradovateAuth = require('./src/api/auth');
const ReplayBacktester = require('./src/backtest/ReplayBacktester');
const fs = require('fs').promises;

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    startDate: null,
    days: 1,
    balance: 1000,
    speed: 400,
    symbol: process.env.CONTRACT_SYMBOL || 'MES'
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start' && args[i + 1]) {
      config.startDate = args[i + 1];
      i++;
    } else if (args[i] === '--days' && args[i + 1]) {
      config.days = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--balance' && args[i + 1]) {
      config.balance = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--speed' && args[i + 1]) {
      config.speed = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--symbol' && args[i + 1]) {
      config.symbol = args[i + 1];
      i++;
    } else if (args[i] === '--help') {
      printHelp();
      process.exit(0);
    }
  }

  return config;
}

function printHelp() {
  console.log(`
Replay Backtest Runner - Uses Tradovate Market Replay API

Usage:
  node replay-backtest.js [options]

Options:
  --start <date>    Start date (YYYY-MM-DD format, default: yesterday)
  --days <n>        Number of trading days to replay (default: 1)
  --balance <n>     Starting balance in dollars (default: 1000)
  --speed <n>       Replay speed multiplier (default: 400)
  --symbol <sym>    Contract symbol (default: from .env or MES)
  --help            Show this help message

Examples:
  node replay-backtest.js --start "2024-01-15" --days 5
  node replay-backtest.js --balance 5000 --speed 800
  node replay-backtest.js --symbol MNQ --days 3

Note: Market Replay requires a Tradovate subscription with replay access.
`);
}

/**
 * Generate replay periods for trading days
 * @param {string|null} startDate - Start date or null for yesterday
 * @param {number} days - Number of trading days
 */
function generateReplayPeriods(startDate, days) {
  const periods = [];
  
  // Default to yesterday if no start date
  let current = startDate ? new Date(startDate) : new Date();
  if (!startDate) {
    current.setDate(current.getDate() - 1);
  }

  let daysAdded = 0;
  while (daysAdded < days) {
    const dayOfWeek = current.getDay();
    
    // Skip weekends
    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      // Trading session: 9:30 AM - 4:00 PM ET
      const sessionStart = new Date(current);
      sessionStart.setHours(9, 30, 0, 0);
      
      const sessionEnd = new Date(current);
      sessionEnd.setHours(16, 0, 0, 0);

      periods.push({
        start: sessionStart.toISOString(),
        stop: sessionEnd.toISOString()
      });

      daysAdded++;
    }

    current.setDate(current.getDate() - 1); // Go backwards in time
  }

  // Reverse to get chronological order
  return periods.reverse();
}

async function runReplayBacktest() {
  const args = parseArgs();

  console.log('═══════════════════════════════════════════════════════════════');
  console.log('         TRADOVATE MARKET REPLAY BACKTESTER');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`\n🔧 Configuration:`);
  console.log(`   Symbol: ${args.symbol}`);
  console.log(`   Days: ${args.days}`);
  console.log(`   Starting Balance: $${args.balance}`);
  console.log(`   Replay Speed: ${args.speed}x`);

  // Check credentials
  if (!process.env.TRADOVATE_USERNAME || !process.env.TRADOVATE_PASSWORD) {
    console.error('\n❌ Error: Missing Tradovate credentials in .env file');
    process.exit(1);
  }

  // Generate replay periods
  const periods = generateReplayPeriods(args.startDate, args.days);
  console.log(`\n📅 Replay Periods:`);
  periods.forEach((p, i) => {
    const start = new Date(p.start);
    console.log(`   ${i + 1}. ${start.toLocaleDateString()} (${start.toLocaleTimeString()} - ${new Date(p.stop).toLocaleTimeString()})`);
  });

  try {
    // Authenticate
    console.log('\n📡 Connecting to Tradovate...');
    const auth = new TradovateAuth({
      env: process.env.TRADOVATE_ENV || 'demo',
      username: process.env.TRADOVATE_USERNAME,
      password: process.env.TRADOVATE_PASSWORD,
      cid: process.env.TRADOVATE_CID ? parseInt(process.env.TRADOVATE_CID) : null,
      secret: process.env.TRADOVATE_SECRET
    });

    await auth.authenticate();
    console.log('   ✓ Authenticated');

    // Load strategy config from .env
    const backtestConfig = {
      speed: args.speed,
      initialBalance: args.balance,
      contractSymbol: args.symbol,
      riskPerTrade: {
        min: parseFloat(process.env.RISK_PER_TRADE_MIN) || 30,
        max: parseFloat(process.env.RISK_PER_TRADE_MAX) || 60
      },
      profitTargetR: parseFloat(process.env.PROFIT_TARGET_R) || 2,
      lookbackPeriod: parseInt(process.env.LOOKBACK_PERIOD) || 20,
      atrMultiplier: parseFloat(process.env.ATR_MULTIPLIER) || 1.5,
      trendEMAPeriod: parseInt(process.env.TREND_EMA_PERIOD) || 50,
      useTrendFilter: process.env.USE_TREND_FILTER !== 'false',
      useVolumeFilter: process.env.USE_VOLUME_FILTER !== 'false',
      useRSIFilter: process.env.USE_RSI_FILTER !== 'false',
      tradingStartHour: parseInt(process.env.TRADING_START_HOUR) || 9,
      tradingStartMinute: parseInt(process.env.TRADING_START_MINUTE) || 30,
      tradingEndHour: parseInt(process.env.TRADING_END_HOUR) || 16,
      tradingEndMinute: parseInt(process.env.TRADING_END_MINUTE) || 0,
      avoidLunch: process.env.AVOID_LUNCH !== 'false'
    };

    // Run replay backtest
    const backtester = new ReplayBacktester(auth, backtestConfig);
    const report = await backtester.run(periods);

    // Save report to file
    const reportPath = `./data/replay_backtest_${args.symbol}_${Date.now()}.json`;
    await fs.mkdir('./data', { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n📁 Full report saved to: ${reportPath}`);

    // Summary
    console.log('\n═══════════════════════════════════════════════════════════════');
    if (report.summary.totalPnL >= 0) {
      console.log(`✅ PROFITABLE: $${args.balance} → $${report.summary.endingBalance.toFixed(2)} (+${report.summary.returnPercent.toFixed(1)}%)`);
    } else {
      console.log(`❌ UNPROFITABLE: $${args.balance} → $${report.summary.endingBalance.toFixed(2)} (${report.summary.returnPercent.toFixed(1)}%)`);
    }
    console.log('═══════════════════════════════════════════════════════════════\n');

  } catch (error) {
    console.error('\n❌ Error:', error.message);
    
    if (error.message.includes('Replay not available')) {
      console.log('\n💡 Tip: Market Replay requires:');
      console.log('   1. A Tradovate subscription with Market Replay access');
      console.log('   2. Valid historical data for the requested time period');
      console.log('   3. Dates within the available replay range (usually last 2 years)');
    }
    
    process.exit(1);
  }
}

runReplayBacktest();
