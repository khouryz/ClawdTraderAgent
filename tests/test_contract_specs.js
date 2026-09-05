/**
 * Contract-spec integrity tests.
 *
 * Contract specs live in TWO places: src/utils/constants.js (used by the bot
 * for sizing and P&L) and config/contracts.json (used by the webhook to
 * validate an inbound symbol). Nothing keeps them in step, so they can drift
 * silently — and a wrong pointValue does not throw, it just sizes the trade
 * wrong. These tests fail loudly on drift instead.
 */

process.env.LOG_DIR = process.env.LOG_DIR || './logs/test';

const assert = require('assert');
const path = require('path');
const { CONTRACTS, TRADING } = require('../src/utils/constants');
const fileContracts = require('../config/contracts.json');
const RiskManager = require('../src/risk/manager');

let passed = 0;
const ok = (n) => { console.log(`✓ ${n}`); passed++; };

// The fields that change money if they disagree.
const MONEY_FIELDS = ['tickSize', 'tickValue', 'pointValue', 'commissionPerRT'];

// 1. Shared symbols must agree on every money field.
{
  const shared = Object.keys(fileContracts).filter(s => CONTRACTS[s]);
  assert.ok(shared.length > 0, 'no symbols in common — one of the tables is empty?');
  for (const sym of shared) {
    for (const f of MONEY_FIELDS) {
      assert.strictEqual(
        fileContracts[sym][f], CONTRACTS[sym][f],
        `${sym}.${f} disagrees: contracts.json=${fileContracts[sym][f]} constants.js=${CONTRACTS[sym][f]}`
      );
    }
  }
  ok(`contracts.json and constants.js agree on ${MONEY_FIELDS.length} money fields for: ${shared.join(', ')}`);
}

// 2. Every contract the bot can size must carry a commission rate, or P&L
//    silently reverts to gross.
{
  for (const [sym, spec] of Object.entries(CONTRACTS)) {
    assert.ok(Number.isFinite(spec.pointValue) && spec.pointValue > 0, `${sym} has no usable pointValue`);
    assert.ok(Number.isFinite(spec.commissionPerRT), `${sym} is missing commissionPerRT — P&L would be reported gross`);
  }
  ok(`all ${Object.keys(CONTRACTS).length} contracts have pointValue and commissionPerRT`);
}

// 3. An unknown symbol must be REFUSED, never silently given another
//    contract's specs. This used to fall back to MES ($5/pt), so an unlisted
//    symbol sized an MNQ ($2/pt) trade at 2.5x the intended risk.
{
  const rm = new RiskManager({ riskPerTrade: { min: 10, max: 150 } });
  assert.strictEqual(rm.getContractSpecs('MNQU6').pointValue, 2, 'MNQ pointValue wrong');
  assert.strictEqual(rm.getContractSpecs('MESU6').pointValue, 5, 'MES pointValue wrong');
  assert.throws(() => rm.getContractSpecs('XYZ99'), /Unknown contract/, 'unknown symbol was not refused');
  assert.throws(() => rm.getContractSpecs(''), /Unknown contract/, 'empty symbol was not refused');
  ok('unknown symbols are refused rather than silently substituted');
}

// 4. The auto-target default must be the SAME on both paths. They disagreed
//    (5 vs 2.5), so one signal got two different targets depending only on
//    whether the webhook supplied a quantity.
{
  const rm = new RiskManager({ riskPerTrade: { min: 10, max: 150 } });
  assert.strictEqual(
    rm.profitTargetR, TRADING.DEFAULT_PROFIT_TARGET_R,
    `RiskManager default ${rm.profitTargetR} != DEFAULT_PROFIT_TARGET_R ${TRADING.DEFAULT_PROFIT_TARGET_R}`
  );
  const sh = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'bot', 'SignalHandler.js'), 'utf8');
  const m = sh.match(/profitTargetR\s*\|\|\s*([\d.]+)/);
  if (m) {
    assert.strictEqual(
      Number(m[1]), TRADING.DEFAULT_PROFIT_TARGET_R,
      `SignalHandler falls back to ${m[1]} but DEFAULT_PROFIT_TARGET_R is ${TRADING.DEFAULT_PROFIT_TARGET_R}`
    );
  }
  ok(`auto-target default is ${TRADING.DEFAULT_PROFIT_TARGET_R}R on every path`);
}

console.log(`\n✅ All ${passed} contract-spec tests passed!`);
