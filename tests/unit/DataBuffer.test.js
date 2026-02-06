/**
 * Unit Tests for DataBuffer Module
 * 
 * Run with: npm test
 * Or: node tests/unit/DataBuffer.test.js
 */

const assert = require('assert');
const { DataBuffer, BarsTransformer, QuoteTransformer } = require('../../src/data');

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

function assertDeepEqual(actual, expected, message = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message} Objects not equal`);
  }
}

// Run tests
console.log('\n📦 DataBuffer Module Tests\n');

console.log('Basic Operations:');
test('creates empty buffer', () => {
  const buffer = new DataBuffer();
  assertEqual(buffer.length, 0);
});

test('creates buffer with initial data', () => {
  const buffer = new DataBuffer(null, [1, 2, 3]);
  assertEqual(buffer.length, 3);
});

test('push adds items', () => {
  const buffer = new DataBuffer();
  buffer.push([{ timestamp: '2024-01-01T10:00:00Z', value: 1 }]);
  assertEqual(buffer.length, 1);
});

test('pushRaw adds item directly', () => {
  const buffer = new DataBuffer();
  buffer.pushRaw({ value: 1 });
  buffer.pushRaw({ value: 2 });
  assertEqual(buffer.length, 2);
});

console.log('\nMax Length:');
test('setMaxLength limits buffer size', () => {
  const buffer = new DataBuffer();
  buffer.setMaxLength(3);
  for (let i = 0; i < 5; i++) {
    buffer.pushRaw({ value: i });
  }
  assertEqual(buffer.length, 3);
  assertEqual(buffer.first().value, 2); // First 2 items removed
});

console.log('\nDeduplication:');
test('deduplicates by timestamp', () => {
  const buffer = new DataBuffer();
  buffer.push([{ timestamp: '2024-01-01T10:00:00Z', value: 1 }]);
  buffer.push([{ timestamp: '2024-01-01T10:00:00Z', value: 2 }]); // Same timestamp
  assertEqual(buffer.length, 1);
  assertEqual(buffer.last().value, 2); // Updated value
});

test('adds new timestamps', () => {
  const buffer = new DataBuffer();
  buffer.push([{ timestamp: '2024-01-01T10:00:00Z', value: 1 }]);
  buffer.push([{ timestamp: '2024-01-01T10:05:00Z', value: 2 }]);
  assertEqual(buffer.length, 2);
});

console.log('\nArray-like Methods:');
test('last() returns last item', () => {
  const buffer = new DataBuffer(null, [1, 2, 3]);
  assertEqual(buffer.last(), 3);
});

test('last(n) returns last n items', () => {
  const buffer = new DataBuffer(null, [1, 2, 3, 4, 5]);
  assertDeepEqual(buffer.last(3), [3, 4, 5]);
});

test('first() returns first item', () => {
  const buffer = new DataBuffer(null, [1, 2, 3]);
  assertEqual(buffer.first(), 1);
});

test('slicePeriod returns last n items', () => {
  const buffer = new DataBuffer(null, [1, 2, 3, 4, 5]);
  assertDeepEqual(buffer.slicePeriod(3), [3, 4, 5]);
});

test('slicePeriod(null) returns all', () => {
  const buffer = new DataBuffer(null, [1, 2, 3]);
  assertDeepEqual(buffer.slicePeriod(null), [1, 2, 3]);
});

test('map works correctly', () => {
  const buffer = new DataBuffer(null, [1, 2, 3]);
  const doubled = buffer.map(x => x * 2);
  assertDeepEqual(doubled, [2, 4, 6]);
});

test('filter works correctly', () => {
  const buffer = new DataBuffer(null, [1, 2, 3, 4, 5]);
  const evens = buffer.filter(x => x % 2 === 0);
  assertDeepEqual(evens, [2, 4]);
});

test('reduce works correctly', () => {
  const buffer = new DataBuffer(null, [1, 2, 3, 4, 5]);
  const sum = buffer.reduce((acc, x) => acc + x, 0);
  assertEqual(sum, 15);
});

test('forEach iterates all items', () => {
  const buffer = new DataBuffer(null, [1, 2, 3]);
  let sum = 0;
  buffer.forEach(x => sum += x);
  assertEqual(sum, 6);
});

test('find returns matching item', () => {
  const buffer = new DataBuffer(null, [
    { id: 1, name: 'a' },
    { id: 2, name: 'b' },
    { id: 3, name: 'c' }
  ]);
  const found = buffer.find(x => x.id === 2);
  assertEqual(found.name, 'b');
});

console.log('\nIterator:');
test('supports for...of iteration', () => {
  const buffer = new DataBuffer(null, [1, 2, 3]);
  const items = [];
  for (const item of buffer) {
    items.push(item);
  }
  assertDeepEqual(items, [1, 2, 3]);
});

console.log('\nTransformers:');
test('BarsTransformer transforms Tradovate response', () => {
  const response = {
    bars: [
      { timestamp: '2024-01-01T10:00:00Z', open: 100, high: 101, low: 99, close: 100.5, upVolume: 500, downVolume: 300 }
    ]
  };
  const result = BarsTransformer(response);
  assertEqual(result.length, 1);
  assertEqual(result[0].open, 100);
  assertEqual(result[0].volume, 800); // upVolume + downVolume
});

test('BarsTransformer handles empty response', () => {
  const result = BarsTransformer({});
  assertEqual(result.length, 0);
});

test('QuoteTransformer standardizes quote', () => {
  const quote = {
    contractId: 123,
    bid: 100.25,
    ask: 100.50,
    last: 100.375,
    totalVolume: 10000
  };
  const result = QuoteTransformer(quote);
  assertEqual(result.contractId, 123);
  assertEqual(result.bid, 100.25);
  assertEqual(result.volume, 10000);
});

console.log('\nClear:');
test('clear empties buffer', () => {
  const buffer = new DataBuffer(null, [1, 2, 3]);
  buffer.clear();
  assertEqual(buffer.length, 0);
});

// Summary
console.log('\n' + '─'.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('─'.repeat(40) + '\n');

if (failed > 0) {
  process.exit(1);
}
