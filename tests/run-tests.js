#!/usr/bin/env node

/**
 * Test Runner
 * Runs all unit tests in the tests/unit directory
 * 
 * Usage: node tests/run-tests.js
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const testsDir = path.join(__dirname, 'unit');

console.log('═══════════════════════════════════════════════════════════════');
console.log('                    RUNNING UNIT TESTS');
console.log('═══════════════════════════════════════════════════════════════\n');

// Find all test files
const testFiles = fs.readdirSync(testsDir)
  .filter(f => f.endsWith('.test.js'))
  .map(f => path.join(testsDir, f));

if (testFiles.length === 0) {
  console.log('No test files found in tests/unit/');
  process.exit(0);
}

console.log(`Found ${testFiles.length} test file(s)\n`);

let totalPassed = 0;
let totalFailed = 0;
const results = [];

// Run each test file
for (const testFile of testFiles) {
  const fileName = path.basename(testFile);
  console.log(`\n▶ Running ${fileName}...`);
  console.log('─'.repeat(50));
  
  try {
    execSync(`node "${testFile}"`, { 
      stdio: 'inherit',
      cwd: path.join(__dirname, '..')
    });
    results.push({ file: fileName, status: 'passed' });
  } catch (error) {
    results.push({ file: fileName, status: 'failed', error: error.message });
    totalFailed++;
  }
}

// Summary
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('                       TEST SUMMARY');
console.log('═══════════════════════════════════════════════════════════════\n');

for (const result of results) {
  const icon = result.status === 'passed' ? '✅' : '❌';
  console.log(`${icon} ${result.file}: ${result.status.toUpperCase()}`);
}

console.log('\n' + '─'.repeat(50));
if (totalFailed === 0) {
  console.log('✅ All tests passed!');
} else {
  console.log(`❌ ${totalFailed} test file(s) failed`);
}
console.log('─'.repeat(50) + '\n');

process.exit(totalFailed > 0 ? 1 : 0);
