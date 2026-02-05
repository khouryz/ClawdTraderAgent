#!/usr/bin/env node

/**
 * Backtest Runner
 * Fetches historical data from Tradovate and runs backtest
 * 
 * Usage:
 *   node backtest.js                    - Run with defaults (3 months, MES, $1000)
 *   node backtest.js --months 6         - Run with 6 months of data
 *   node backtest.js --balance 5000     - Start with $5000
 *   node backtest.js --symbol MNQH6     - Use MNQ contract
 */

require('dotenv').config();
const TradovateAuth = require('./src/api/auth');
const TradovateClient = require('./src/api/client');
const Backtester = require('./src/backtest/backtester');
const fs = require('fs').promises;

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    months: 3,
    balance: 1000,
    symbol: process.env.CONTRACT_SYMBOL || 'MESH6'
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--months' && args[i + 1]) {
      config.months = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--balance' && args[i + 1]) {
      config.balance = parseFloat(args[i + 1]);
      i++;
    } else if (args[i] === '--symbol' && args[i + 1]) {
      config.symbol = args[i + 1];
      i++;
    }
  }

  return config;
}

async function runBacktest() {
  const args = parseArgs();
  
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('              TRADOVATE STRATEGY BACKTESTER');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`\n🔧 Configuration:`);
  console.log(`   Symbol: ${args.symbol}`);
  console.log(`   Period: ${args.months} months`);
  console.log(`   Starting Balance: $${args.balance}`);

  // Check credentials
  if (!process.env.TRADOVATE_USERNAME || !process.env.TRADOVATE_PASSWORD) {
    console.error('\n❌ Error: Missing Tradovate credentials in .env file');
    process.exit(1);
  }

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

    const client = new TradovateClient(auth);

    // Find contract
    console.log(`\n📋 Finding contract ${args.symbol}...`);
    const contract = await client.findContract(args.symbol);
    
    if (!contract) {
      console.error(`   ❌ Contract not found: ${args.symbol}`);
      console.log('\n   Try one of these symbols:');
      console.log('   - MESH6 (MES March 2026)');
      console.log('   - MESM6 (MES June 2026)');
      console.log('   - MNQH6 (MNQ March 2026)');
      process.exit(1);
    }
    
    console.log(`   ✓ Found: ${contract.name} (ID: ${contract.id})`);

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - args.months);

    console.log(`\n📊 Fetching historical data...`);
    console.log(`   From: ${startDate.toISOString().split('T')[0]}`);
    console.log(`   To:   ${endDate.toISOString().split('T')[0]}`);

    // Fetch historical bars (5-minute bars)
    // Tradovate limits to ~10000 bars per request, so we may need multiple requests
    const allBars = [];
    let currentStart = startDate;
    const barsPerRequest = 5000;
    
    while (currentStart < endDate) {
      const response = await client.getBars(contract.id, {
        underlyingType: 'MinuteBar',
        elementSize: 5,
        elementSizeUnit: 'UnderlyingUnits',
        startTime: currentStart.toISOString(),
        endTime: endDate.toISOString(),
        count: barsPerRequest
      });

      if (response && response.bars && response.bars.length > 0) {
        // Transform bars to standard format
        const bars = response.bars.map(bar => ({
          timestamp: bar.timestamp,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volume: bar.upVolume + bar.downVolume
        }));

        allBars.push(...bars);
        console.log(`   Fetched ${bars.length} bars (total: ${allBars.length})`);

        // Move start date forward
        if (bars.length < barsPerRequest) {
          break; // No more data
        }
        
        const lastBar = bars[bars.length - 1];
        currentStart = new Date(lastBar.timestamp);
        currentStart.setMinutes(currentStart.getMinutes() + 5);
      } else {
        console.log('   No more data available');
        break;
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (allBars.length === 0) {
      console.error('\n❌ No historical data available for this contract');
      console.log('   This may be because:');
      console.log('   - The contract is too new');
      console.log('   - Market data subscription is not active');
      console.log('   - The symbol is incorrect');
      process.exit(1);
    }

    // Sort bars by timestamp
    allBars.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    // Remove duplicates
    const uniqueBars = [];
    let lastTimestamp = null;
    for (const bar of allBars) {
      if (bar.timestamp !== lastTimestamp) {
        uniqueBars.push(bar);
        lastTimestamp = bar.timestamp;
      }
    }

    console.log(`   ✓ Total unique bars: ${uniqueBars.length}`);

    // Load strategy config from .env
    const backtestConfig = {
      startingBalance: args.balance,
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

    // Run backtest
    const backtester = new Backtester(backtestConfig);
    const report = backtester.run(uniqueBars);

    if (!report) {
      console.error('\n❌ Backtest failed');
      process.exit(1);
    }

    // Print report
    console.log(Backtester.formatReport(report));

    // Save report to file
    const reportPath = `./data/backtest_${args.symbol}_${Date.now()}.json`;
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
    if (error.response?.data) {
      console.error('   API Response:', JSON.stringify(error.response.data, null, 2));
    }
    process.exit(1);
  }
}

runBacktest();
