/**
 * AI Confirmation Integration Test
 * 
 * Tests the AI confirmation flow with 3 different trade scenarios
 * using REAL AI analysis and sends Telegram notifications.
 * 
 * Run: node tests/test-ai-confirmation.js
 */

require('dotenv').config();

const AIConfirmation = require('../src/ai/AIConfirmation');
const Notifications = require('../src/utils/notifications');

// ═══════════════════════════════════════════════════════════
// 3 TEST SCENARIOS
// ═══════════════════════════════════════════════════════════

const testScenarios = [
  {
    name: 'STRONG BULLISH BREAKOUT',
    description: 'Clean breakout with all confirmations - should CONFIRM',
    signal: {
      type: 'buy',
      price: 5245.50,
      stopLoss: 5240.00,
      filterResults: {
        trendFilter: true,
        volumeFilter: true,
        rsiFilter: true,
        sessionFilter: true
      }
    },
    position: {
      contracts: 1,
      totalRisk: 27.50,
      stopPrice: 5240.00,
      targetPrice: 5256.50,
      riskRewardRatio: '2.0'
    },
    marketStructure: {
      trend: 'bullish',
      session: 'regular_hours',
      breakoutHigh: 5244.75,
      breakoutLow: 5235.25,
      emaDistance: 3.25,
      priceVsEma: 0.85,
      rsi: 58.5,
      atr: 4.25,
      volumeRatio: 1.45
    },
    indicators: {
      atr: 4.25,
      rsi: 58.5,
      ema: 5242.25,
      sma: 5240.50,
      volumeRatio: 1.45
    },
    bars: [
      { open: 5230.00, high: 5233.50, low: 5228.25, close: 5232.75, volume: 1250 },
      { open: 5232.75, high: 5236.00, low: 5231.50, close: 5235.25, volume: 1380 },
      { open: 5235.25, high: 5238.75, low: 5234.00, close: 5237.50, volume: 1420 },
      { open: 5237.50, high: 5240.00, low: 5236.25, close: 5239.25, volume: 1350 },
      { open: 5239.25, high: 5241.50, low: 5238.00, close: 5240.75, volume: 1480 },
      { open: 5240.75, high: 5243.25, low: 5239.50, close: 5242.50, volume: 1520 },
      { open: 5242.50, high: 5244.00, low: 5241.25, close: 5243.25, volume: 1380 },
      { open: 5243.25, high: 5245.50, low: 5242.00, close: 5244.75, volume: 1650 },
      { open: 5244.75, high: 5246.25, low: 5243.50, close: 5245.50, volume: 1720 },
      { open: 5245.50, high: 5247.00, low: 5244.25, close: 5246.25, volume: 1580 }
    ]
  },
  {
    name: 'OVERBOUGHT CHASING',
    description: 'Extended price, overbought RSI, low volume - should REJECT',
    signal: {
      type: 'buy',
      price: 5295.00,
      stopLoss: 5287.00,
      filterResults: {
        trendFilter: true,
        volumeFilter: false,
        rsiFilter: false,
        sessionFilter: true
      }
    },
    position: {
      contracts: 1,
      totalRisk: 40.00,
      stopPrice: 5287.00,
      targetPrice: 5311.00,
      riskRewardRatio: '2.0'
    },
    marketStructure: {
      trend: 'bullish',
      session: 'regular_hours',
      breakoutHigh: 5294.25,
      breakoutLow: 5275.00,
      emaDistance: 12.50,
      priceVsEma: 2.85,
      rsi: 76.5,
      atr: 6.50,
      volumeRatio: 0.72
    },
    indicators: {
      atr: 6.50,
      rsi: 76.5,
      ema: 5282.50,
      sma: 5278.25,
      volumeRatio: 0.72
    },
    bars: [
      { open: 5275.00, high: 5278.50, low: 5274.25, close: 5277.75, volume: 1450 },
      { open: 5277.75, high: 5281.00, low: 5276.50, close: 5280.25, volume: 1380 },
      { open: 5280.25, high: 5284.75, low: 5279.00, close: 5283.50, volume: 1250 },
      { open: 5283.50, high: 5287.00, low: 5282.25, close: 5286.25, volume: 1120 },
      { open: 5286.25, high: 5289.50, low: 5285.00, close: 5288.75, volume: 980 },
      { open: 5288.75, high: 5291.25, low: 5287.50, close: 5290.50, volume: 850 },
      { open: 5290.50, high: 5293.00, low: 5289.25, close: 5292.25, volume: 780 },
      { open: 5292.25, high: 5294.50, low: 5291.00, close: 5293.75, volume: 720 },
      { open: 5293.75, high: 5295.25, low: 5292.50, close: 5294.50, volume: 680 },
      { open: 5294.50, high: 5296.00, low: 5293.25, close: 5295.00, volume: 650 }
    ]
  },
  {
    name: 'BEARISH BREAKDOWN',
    description: 'Strong breakdown with trend confirmation - should CONFIRM',
    signal: {
      type: 'sell',
      price: 5185.25,
      stopLoss: 5192.00,
      filterResults: {
        trendFilter: true,
        volumeFilter: true,
        rsiFilter: true,
        sessionFilter: true
      }
    },
    position: {
      contracts: 1,
      totalRisk: 33.75,
      stopPrice: 5192.00,
      targetPrice: 5171.75,
      riskRewardRatio: '2.0'
    },
    marketStructure: {
      trend: 'bearish',
      session: 'regular_hours',
      breakoutHigh: 5205.50,
      breakoutLow: 5186.00,
      emaDistance: -4.75,
      priceVsEma: -1.25,
      rsi: 38.5,
      atr: 5.25,
      volumeRatio: 1.65
    },
    indicators: {
      atr: 5.25,
      rsi: 38.5,
      ema: 5190.00,
      sma: 5192.50,
      volumeRatio: 1.65
    },
    bars: [
      { open: 5210.00, high: 5212.50, low: 5207.25, close: 5208.75, volume: 1350 },
      { open: 5208.75, high: 5210.00, low: 5205.50, close: 5206.25, volume: 1480 },
      { open: 5206.25, high: 5208.75, low: 5203.00, close: 5204.50, volume: 1520 },
      { open: 5204.50, high: 5206.00, low: 5200.25, close: 5201.75, volume: 1620 },
      { open: 5201.75, high: 5203.50, low: 5197.00, close: 5198.25, volume: 1750 },
      { open: 5198.25, high: 5200.00, low: 5194.50, close: 5195.75, volume: 1680 },
      { open: 5195.75, high: 5197.25, low: 5191.00, close: 5192.50, volume: 1820 },
      { open: 5192.50, high: 5194.00, low: 5188.25, close: 5189.75, volume: 1950 },
      { open: 5189.75, high: 5191.50, low: 5185.00, close: 5186.25, volume: 2100 },
      { open: 5186.25, high: 5188.00, low: 5184.50, close: 5185.25, volume: 2250 }
    ]
  }
];

async function runTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           AI CONFIRMATION INTEGRATION TEST');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Initialize AI
  const ai = new AIConfirmation({
    enabled: true,
    provider: process.env.AI_PROVIDER || 'openai',
    apiKey: process.env.AI_API_KEY,
    model: process.env.AI_MODEL || null,
    confidenceThreshold: parseInt(process.env.AI_CONFIDENCE_THRESHOLD) || 70,
    timeout: parseInt(process.env.AI_TIMEOUT) || 10000
  });

  // Initialize notifications
  const notifications = new Notifications();
  
  console.log(`AI Provider: ${process.env.AI_PROVIDER || 'openai'}`);
  console.log(`AI Model: ${process.env.AI_MODEL || 'default'}`);
  console.log(`Telegram: ${notifications.enabled ? 'ENABLED' : 'DISABLED'}\n`);

  const results = [];

  for (let i = 0; i < testScenarios.length; i++) {
    const scenario = testScenarios[i];
    
    console.log('───────────────────────────────────────────────────────────');
    console.log(`TEST ${i + 1}: ${scenario.name}`);
    console.log(`${scenario.description}`);
    console.log('───────────────────────────────────────────────────────────\n');

    console.log('📊 Input Signal:');
    console.log(`   Type: ${scenario.signal.type.toUpperCase()}`);
    console.log(`   Entry: $${scenario.signal.price}`);
    console.log(`   Stop Loss: $${scenario.signal.stopLoss}`);
    console.log(`   Risk: $${scenario.position.totalRisk}`);
    console.log(`   Target: $${scenario.position.targetPrice}`);
    console.log('');

    console.log('📈 Market Context:');
    console.log(`   Trend: ${scenario.marketStructure.trend}`);
    console.log(`   RSI: ${scenario.indicators.rsi}`);
    console.log(`   ATR: ${scenario.indicators.atr}`);
    console.log(`   Volume Ratio: ${scenario.indicators.volumeRatio}x`);
    console.log(`   Price vs EMA: ${scenario.marketStructure.priceVsEma}%`);
    console.log('');

    console.log('🤖 Calling AI for analysis...\n');

    const startTime = Date.now();
    
    const aiDecision = await ai.analyzeSignal({
      signal: scenario.signal,
      marketStructure: scenario.marketStructure,
      position: scenario.position,
      filterResults: scenario.signal.filterResults,
      recentBars: scenario.bars,
      indicators: scenario.indicators,
      accountInfo: { balance: 1000.00, dailyPnL: 0 },
      sessionInfo: { session: 'regular_hours', canTrade: true }
    });

    const elapsed = Date.now() - startTime;

    console.log('🤖 AI DECISION:');
    console.log(`   Action: ${aiDecision.action === 'CONFIRM' ? '✅ CONFIRM' : '❌ REJECT'}`);
    console.log(`   Confidence: ${aiDecision.confidence}%`);
    console.log(`   Risk Assessment: ${aiDecision.riskAssessment}`);
    console.log(`   Latency: ${elapsed}ms`);
    console.log('');
    console.log('📝 Reasoning:');
    console.log(`   ${aiDecision.reasoning}`);
    console.log('');
    
    if (aiDecision.keyFactors && aiDecision.keyFactors.length > 0) {
      console.log('🔑 Key Factors:');
      aiDecision.keyFactors.forEach((factor, j) => {
        console.log(`   ${j + 1}. ${factor}`);
      });
      console.log('');
    }

    // Send Telegram notification
    if (notifications.enabled) {
      if (aiDecision.action === 'CONFIRM') {
        console.log('📱 Sending trade entry notification...');
        await notifications.tradeEntryDetailed({
          signal: scenario.signal,
          position: scenario.position,
          marketStructure: scenario.marketStructure,
          filterResults: scenario.signal.filterResults,
          aiDecision
        });
      } else {
        console.log('📱 Sending AI rejection notification...');
        await notifications.aiTradeRejected({
          signal: scenario.signal,
          aiDecision,
          position: scenario.position,
          marketStructure: scenario.marketStructure
        });
      }
      console.log('✓ Notification sent!\n');
    }

    results.push({
      scenario: scenario.name,
      decision: aiDecision.action,
      confidence: aiDecision.confidence,
      latency: elapsed
    });

    // Small delay between API calls
    if (i < testScenarios.length - 1) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Summary
  console.log('═══════════════════════════════════════════════════════════');
  console.log('                      TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════════\n');
  
  results.forEach((r, i) => {
    const icon = r.decision === 'CONFIRM' ? '✅' : '❌';
    console.log(`${i + 1}. ${r.scenario}`);
    console.log(`   ${icon} ${r.decision} (${r.confidence}% confidence) - ${r.latency}ms`);
  });

  console.log('\n📱 Check your Telegram for the notifications!');
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('                    TEST COMPLETE');
  console.log('═══════════════════════════════════════════════════════════\n');
}

// Run tests
runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
