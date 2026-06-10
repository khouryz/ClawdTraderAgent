#!/usr/bin/env node
/**
 * run-tests.js — offline unit-test runner (the target of `npm test`).
 *
 * Runs ONLY the pure, mock-based unit tests that need no auth/network/live
 * account. Integration tests that place real orders (tests/test_bracket_be.js,
 * test/test_multi_orders.js, test/test_eod_close.js) are intentionally EXCLUDED
 * here — run those manually against a demo account.
 *
 * Each child test exits non-zero on failure; this runner aggregates them and
 * exits non-zero if any failed.
 */
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
  'test_order_mirror.js',          // OrderMirror fanout/reconcile (mock client)
  'test_client_account_filter.js', // cross-account leak filter (mock request)
];

let failed = 0;
for (const suite of SUITES) {
  const file = path.join(__dirname, suite);
  console.log(`\n${'='.repeat(70)}\nRUNNING: ${suite}\n${'='.repeat(70)}`);
  const res = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (res.status !== 0) { failed++; console.log(`\n>>> ${suite} FAILED (exit ${res.status})`); }
}

console.log(`\n${'#'.repeat(70)}`);
console.log(failed === 0
  ? `ALL ${SUITES.length} UNIT SUITES PASSED`
  : `${failed}/${SUITES.length} UNIT SUITE(S) FAILED`);
console.log(`${'#'.repeat(70)}`);
process.exit(failed === 0 ? 0 : 1);
