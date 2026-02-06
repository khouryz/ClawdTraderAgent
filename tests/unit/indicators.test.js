/**
 * Unit Tests for Indicators Module
 * 
 * Run with: npm test
 * Or: node tests/unit/indicators.test.js
 */

const assert = require('assert');
const indicators = require('../../src/indicators');

// Test data
const sampleBars = [
  { timestamp: '2024-01-01T09:30:00Z', open: 100, high: 102, low: 99, close: 101, volume: 1000 },
  { timestamp: '2024-01-01T09:35:00Z', open: 101, high: 103, low: 100, close: 102, volume: 1200 },
  { timestamp: '2024-01-01T09:40:00Z', open: 102, high: 104, low: 101, close: 103, volume: 1100 },
  { timestamp: '2024-01-01T09:45:00Z', open: 103, high: 105, low: 102, close: 104, volume: 1300 },
  { timestamp: '2024-01-01T09:50:00Z', open: 104, high: 106, low: 103, close: 105, volume: 1400 },
  { timestamp: '2024-01-01T09:55:00Z', open: 105, high: 107, low: 104, close: 106, volume: 1500 },
  { timestamp: '2024-01-01T10:00:00Z', open: 106, high: 108, low: 105, close: 107, volume: 1600 },
  { timestamp: '2024-01-01T10:05:00Z', open: 107, high: 109, low: 106, close: 108, volume: 1700 },
  { timestamp: '2024-01-01T10:10:00Z', open: 108, high: 110, low: 107, close: 109, volume: 1800 },
  { timestamp: '2024-01-01T10:15:00Z', open: 109, high: 111, low: 108, close: 110, volume: 1900 },
  { timestamp: '2024-01-01T10:20:00Z', open: 110, high: 112, low: 109, close: 111, volume: 2000 },
  { timestamp: '2024-01-01T10:25:00Z', open: 111, high: 113, low: 110, close: 112, volume: 2100 },
  { timestamp: '2024-01-01T10:30:00Z', open: 112, high: 114, low: 111, close: 113, volume: 2200 },
  { timestamp: '2024-01-01T10:35:00Z', open: 113, high: 115, low: 112, close: 114, volume: 2300 },
  { timestamp: '2024-01-01T10:40:00Z', open: 114, high: 116, low: 113, close: 115, volume: 2400 },
];

// Test results
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (error) {
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${error.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message} Expected ${expected}, got ${actual}`);
  }
}

function assertClose(actual, expected, tolerance = 0.01, message = '') {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message} Expected ~${expected}, got ${actual}`);
  }
}

function assertNotNull(value, message = '') {
  if (value === null || value === undefined) {
    throw new Error(`${message} Expected non-null value`);
  }
}

function assertNull(value, message = '') {
  if (value !== null) {
    throw new Error(`${message} Expected null, got ${value}`);
  }
}

// Run tests
console.log('\n📊 Indicators Module Tests\n');

console.log('SMA Tests:');
test('SMA returns null for insufficient data', () => {
  const result = indicators.SMA(sampleBars.slice(0, 2), 5);
  assertNull(result);
});

test('SMA calculates correctly', () => {
  const result = indicators.SMA(sampleBars.slice(0, 5), 5);
  // Average of 101, 102, 103, 104, 105 = 103
  assertClose(result, 103, 0.01);
});

test('SMA works with price array', () => {
  const prices = [100, 102, 104, 106, 108];
  const result = indicators.SMA(prices, 5);
  assertClose(result, 104, 0.01);
});

console.log('\nEMA Tests:');
test('EMA returns null for insufficient data', () => {
  const result = indicators.EMA(sampleBars.slice(0, 2), 5);
  assertNull(result);
});

test('EMA calculates correctly', () => {
  const result = indicators.EMA(sampleBars, 5);
  assertNotNull(result);
  // EMA should be close to recent prices
  assert(result > 110 && result < 116, 'EMA should be near recent prices');
});

console.log('\nATR Tests:');
test('ATR returns null for insufficient data', () => {
  const result = indicators.ATR(sampleBars.slice(0, 5), 14);
  assertNull(result);
});

test('ATR calculates correctly', () => {
  const result = indicators.ATR(sampleBars, 5);
  assertNotNull(result);
  // With consistent 3-point ranges, ATR should be around 3
  assertClose(result, 3, 0.5);
});

console.log('\nRSI Tests:');
test('RSI returns null for insufficient data', () => {
  const result = indicators.RSI(sampleBars.slice(0, 5), 14);
  assertNull(result);
});

test('RSI calculates correctly for uptrend', () => {
  const result = indicators.RSI(sampleBars, 10);
  assertNotNull(result);
  // Consistent uptrend should have high RSI
  assert(result > 70, `RSI should be high in uptrend, got ${result}`);
});

test('RSI returns 100 when no losses', () => {
  const upOnly = sampleBars.slice(0, 10);
  const result = indicators.RSI(upOnly, 5);
  assertEqual(result, 100);
});

console.log('\nBollinger Bands Tests:');
test('BollingerBands returns null for insufficient data', () => {
  const result = indicators.BollingerBands(sampleBars.slice(0, 5), 20);
  assertNull(result);
});

test('BollingerBands calculates correctly', () => {
  const result = indicators.BollingerBands(sampleBars, 10);
  assertNotNull(result);
  assertNotNull(result.upper);
  assertNotNull(result.middle);
  assertNotNull(result.lower);
  assertNotNull(result.bandwidth);
  assert(result.upper > result.middle, 'Upper should be > middle');
  assert(result.middle > result.lower, 'Middle should be > lower');
});

console.log('\nHighestHigh/LowestLow Tests:');
test('HighestHigh finds correct value', () => {
  const result = indicators.HighestHigh(sampleBars, 5);
  // Last 5 bars have highs: 112, 113, 114, 115, 116
  assertEqual(result, 116);
});

test('LowestLow finds correct value', () => {
  const result = indicators.LowestLow(sampleBars, 5);
  // Last 5 bars have lows: 109, 110, 111, 112, 113
  assertEqual(result, 109);
});

console.log('\nAvgVolume Tests:');
test('AvgVolume calculates correctly', () => {
  const result = indicators.AvgVolume(sampleBars, 5);
  // Last 5 volumes: 2000, 2100, 2200, 2300, 2400 = avg 2200
  assertClose(result, 2200, 1);
});

console.log('\nTrend Detection Tests:');
test('detectTrend identifies bullish trend', () => {
  const result = indicators.detectTrend(sampleBars, 10);
  assertEqual(result, 'bullish');
});

// Summary
console.log('\n' + '─'.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(40) + '\n');

if (failed > 0) {
  process.exit(1);
}
