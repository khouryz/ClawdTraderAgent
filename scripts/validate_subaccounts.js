#!/usr/bin/env node
/**
 * validate_subaccounts.js — live validation of the sub-account mirror setup.
 *
 * Run this ON THE SERVER, where the account .env (credentials) lives. It is
 * READ-ONLY by default — it places NO orders. It validates exactly the things
 * the mirror feature depends on and that can only be proven against the real
 * Tradovate API: authentication, comma-list sub-account resolution, and the
 * per-sub-account read endpoints used by /status and reconcileSecondaries.
 *
 * Usage:
 *   node scripts/validate_subaccounts.js
 *       Read-only checks: auth, resolve sub-accounts, per-account
 *       balance/positions/working-orders, contract resolution, mirror wiring.
 *
 *   node scripts/validate_subaccounts.js --accounts-dir ./accounts
 *       Use a specific accounts directory (defaults to $ACCOUNTS_DIR, else the
 *       single .env via process.env).
 *
 *   node scripts/validate_subaccounts.js --limit-test --limit-price <PX> [--qty 1]
 *       OPT-IN, fill-SAFE order-fanout test. Places ONE Buy LIMIT at YOUR chosen
 *       price PX on the primary via the mirror, confirms it mirrored to every
 *       secondary, classifies the orderIds, then CANCELS it on all accounts.
 *       YOU pick PX so it is safely NON-MARKETABLE (far below market) — the
 *       script never guesses. It always cleans up and reports any leftover.
 *
 * SAFETY:
 *   • Credentials (username/password/secret/cid/API keys) are NEVER printed.
 *   • Default mode places no orders. --limit-test requires an explicit price.
 *   • The real entry+OCO+BE flow should be validated at MARKET OPEN (Phase 4).
 */

'use strict';
const path = require('path');
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const TradovateAuth = require('../src/api/auth');
const TradovateClient = require('../src/api/client');
const { createOrderClient } = require('../src/api/OrderMirror');
const { loadAccountConfigs, parseAccountNames } = require('../src/utils/account_config_loader');

// ── args ────────────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const argVal = (f, d) => { const i = ARGS.indexOf(f); return (i >= 0 && ARGS[i + 1] != null) ? ARGS[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── tiny report harness ───────────────────────────────────────────────────────
let pass = 0, fail = 0, warn = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log(`  ✓ ${msg}`); } else { fail++; console.log(`  ✗ ${msg}`); } };
const note = (msg) => console.log(`      · ${msg}`);
const warnMsg = (msg) => { warn++; console.log(`  ⚠ ${msg}`); };
const hdr = (msg) => console.log(`\n${'─'.repeat(64)}\n${msg}\n${'─'.repeat(64)}`);

// ── config loading (mirrors the bot's own loader; no credential printing) ─────
function buildConfigs() {
  const dir = argVal('--accounts-dir', process.env.ACCOUNTS_DIR);
  if (dir) {
    const cfgs = loadAccountConfigs(dir);
    if (cfgs.length) { console.log(`Loaded ${cfgs.length} account config(s) from ${dir}`); return cfgs; }
    console.log(`No .env files in ${dir} — falling back to process.env`);
  }
  const accountNames = parseAccountNames(process.env.TRADOVATE_ACCOUNT_NAME);
  const baseSymbol = (process.env.INSTRUMENTS || 'MNQ').split(',')[0].trim().toUpperCase();
  return [{
    accountId: 'env',
    credentials: {
      env: process.env.TRADOVATE_ENV || 'demo',
      username: process.env.TRADOVATE_USERNAME,
      password: process.env.TRADOVATE_PASSWORD,
      cid: process.env.TRADOVATE_CID ? parseInt(process.env.TRADOVATE_CID, 10) : null,
      secret: process.env.TRADOVATE_SECRET,
      accountNames,
      accountName: accountNames[0] || null,
    },
    instruments: [{
      baseSymbol,
      symbol: process.env[`${baseSymbol}_SYMBOL`] || process.env.SYMBOL || null,
      autoRollover: (process.env[`${baseSymbol}_AUTO_ROLLOVER`] || process.env.AUTO_ROLLOVER || 'true') !== 'false',
    }],
  }];
}

function resolveSubAccounts(accounts, creds, label) {
  const names = (Array.isArray(creds.accountNames) && creds.accountNames.length)
    ? creds.accountNames
    : (creds.accountName ? [creds.accountName] : []);
  if (!names.length) throw new Error(`${label}: no TRADOVATE_ACCOUNT_NAME configured`);
  return names.map((n) => {
    const a = accounts.find((x) => x.name === n);
    if (!a) throw new Error(`${label}: sub-account "${n}" not found. Available: ${accounts.map((x) => x.name).join(', ')}`);
    return a;
  });
}

// Best-effort live market reference (used ONLY as a safety guard for the limit
// test — to refuse a price that could fill). Defensive: returns null if unsure.
async function getReferencePrice(client, contractId) {
  try {
    const q = await client.getQuote(contractId);
    const p = q && (q.last ?? (q.entries && q.entries.Trade && q.entries.Trade.price)
                    ?? (q.entries && q.entries.Bid && q.entries.Bid.price));
    if (p != null && Number.isFinite(Number(p)) && Number(p) > 0) return Number(p);
  } catch (_) { /* MD quote may be unavailable */ }
  try {
    const resp = await client.getBars(contractId, { count: 5 });
    const bars = (resp && (resp.bars || (resp.charts && resp.charts[0] && resp.charts[0].bars))) || [];
    const last = bars.length ? bars[bars.length - 1] : null;
    const p = last && (last.close ?? last.c ?? last.price);
    if (p != null && Number.isFinite(Number(p)) && Number(p) > 0) return Number(p);
  } catch (_) { /* chart may be unavailable */ }
  return null;
}

async function resolveContract(client, ic) {
  if (ic.symbol) {
    try { const c = await client.findContract(ic.symbol); if (c && c.id) return c; } catch (_) {}
  }
  try { return await client.getFrontMonthContract(ic.baseSymbol); } catch (e) { return null; }
}

// ── per-sub-account read checks (these power /status + reconcileSecondaries) ──
async function readChecks(client, sub, isPrimary) {
  console.log(`\n  ── ${isPrimary ? 'PRIMARY' : 'SECONDARY'}: ${sub.name} (ID ${sub.id}) ──`);
  ok(sub.active !== false, `account active`);
  try {
    const bal = await client.getRealTimeBalance(sub.id);
    ok(bal && typeof bal.equity === 'number', `getRealTimeBalance ok (equity=$${bal && bal.equity != null ? Number(bal.equity).toFixed(2) : '?'})`);
  } catch (e) { ok(false, `getRealTimeBalance failed: ${e.message}`); }
  try {
    const pos = await client.getOpenPositions(sub.id);
    ok(Array.isArray(pos), `getOpenPositions ok (${Array.isArray(pos) ? pos.length : '?'} open)`);
    for (const p of (pos || [])) note(`open: contractId=${p.contractId} netPos=${p.netPos}`);
  } catch (e) { ok(false, `getOpenPositions failed: ${e.message}`); }
  try {
    const wo = await client.getWorkingOrders(sub.id);
    ok(Array.isArray(wo), `getWorkingOrders ok (${Array.isArray(wo) ? wo.length : '?'} working)`);
    for (const o of (wo || [])) note(`working: id=${o.id} ${o.ordType} ${o.action} @ ${o.stopPrice ?? o.price ?? '?'} (contract ${o.contractId})`);
  } catch (e) { ok(false, `getWorkingOrders failed: ${e.message}`); }
}

// ── opt-in, fill-SAFE order-fanout test (user supplies a non-marketable price) ─
async function limitFanoutTest(client, proxy, mirror, subs, contract) {
  hdr('LIMIT FANOUT TEST (opt-in; places + cancels ONE non-marketable Buy limit)');
  const priceStr = argVal('--limit-price', null);
  if (priceStr == null) {
    warnMsg('--limit-test requires --limit-price <PX>. Refusing to guess a price.');
    warnMsg('Pick a Buy limit price FAR BELOW the market (non-marketable) for your instrument, e.g. --limit-price 1000');
    return;
  }
  const price = parseFloat(priceStr);
  const qty = parseInt(argVal('--qty', '1'), 10) || 1;
  if (!Number.isFinite(price) || price <= 0) { warnMsg(`invalid --limit-price "${priceStr}"`); return; }
  if (!contract || !contract.id) { warnMsg('no resolved contract — skipping limit test'); return; }

  // ── SAFETY GUARD: refuse a price that could fill ──
  // A Buy limit at/above market fills instantly (a real position). Fetch a live
  // reference and refuse anything not clearly below it. If we can't verify, warn
  // but trust the operator's deliberate (far-below) choice.
  const ref = await getReferencePrice(client, contract.id);
  if (ref != null) {
    if (price >= ref * 0.97) {
      warnMsg(`REFUSING: --limit-price ${price} is NOT safely below market (~${ref}). A Buy limit at/near market can FILL.`);
      warnMsg(`Pick a price well below ${Math.floor(ref * 0.9)} and re-run.`);
      return;
    }
    note(`market reference ~${ref}; limit ${price} is ${((1 - price / ref) * 100).toFixed(1)}% below — non-marketable ✓`);
  } else {
    warnMsg(`could not fetch a market reference to double-check — ensure ${price} is well BELOW current MNQ (a Buy limit above market fills).`);
  }

  console.log(`Placing Buy LIMIT qty=${qty} @ ${price} on PRIMARY (${subs[0].name}) via mirror — must be non-marketable.`);
  const placed = []; // { accountId, name, orderId }
  let primaryOrderId = null;
  try {
    const res = await proxy.placeLimitOrder(subs[0].id, contract.id, qty, 'Buy', price);
    primaryOrderId = res && res.orderId;
    ok(primaryOrderId != null, `primary limit placed (orderId=${primaryOrderId})`);
    placed.push({ accountId: subs[0].id, name: subs[0].name, orderId: primaryOrderId });

    await sleep(2500); // let the background secondary placements + map land

    // Verify each secondary received the SAME order (action/type/price/qty)
    for (let i = 1; i < subs.length; i++) {
      const sub = subs[i];
      const wo = await client.getWorkingOrders(sub.id);
      const match = (wo || []).find((o) =>
        Number(o.contractId) === Number(contract.id) && o.action === 'Buy' &&
        (o.ordType === 'Limit' || o.orderType === 'Limit') &&
        Math.abs(Number(o.price ?? o.limitPrice ?? -1) - price) < 0.001);
      ok(!!match, `secondary ${sub.name} received the mirrored limit (id=${match ? match.id : 'NONE'})`);
      if (match) {
        placed.push({ accountId: sub.id, name: sub.name, orderId: match.id });
        const owner = mirror.ownerOfOrder(match.id);
        ok(owner && owner.kind === 'secondary' && Number(owner.accountId) === Number(sub.id),
          `ownerOfOrder(${match.id}) classifies it as secondary ${sub.name}`);
      }
    }
    if (primaryOrderId != null) {
      const po = mirror.ownerOfOrder(primaryOrderId);
      ok(po && po.kind === 'primary', `ownerOfOrder(primary ${primaryOrderId}) classifies it as primary`);
    }
  } catch (e) {
    ok(false, `limit placement failed: ${e.message}`);
  } finally {
    // ── ALWAYS clean up: cancel via the mirror (fans out), then verify gone ──
    if (primaryOrderId != null) {
      try { await proxy.cancelOrder(primaryOrderId); } catch (e) { warnMsg(`mirror cancel threw: ${e.message}`); }
      await sleep(2500);
    }
    let leftovers = 0;
    for (const sub of subs) {
      let wo = [];
      try { wo = await client.getWorkingOrders(sub.id); } catch (_) {}
      const mine = (wo || []).filter((o) =>
        Number(o.contractId) === Number(contract.id) && o.action === 'Buy' &&
        (o.ordType === 'Limit' || o.orderType === 'Limit') &&
        Math.abs(Number(o.price ?? o.limitPrice ?? -1) - price) < 0.001);
      for (const o of mine) {
        // belt-and-suspenders: cancel directly on the account
        try { await client.cancelOrder(o.id); } catch (_) {}
      }
      // re-read
      try { wo = await client.getWorkingOrders(sub.id); } catch (_) {}
      const still = (wo || []).filter((o) =>
        Number(o.contractId) === Number(contract.id) && o.action === 'Buy' &&
        (o.ordType === 'Limit' || o.orderType === 'Limit') &&
        Math.abs(Number(o.price ?? o.limitPrice ?? -1) - price) < 0.001);
      for (const o of still) { leftovers++; warnMsg(`MANUAL CLEANUP NEEDED: cancel orderId ${o.id} on account ${sub.name} (ID ${sub.id})`); }
    }
    ok(leftovers === 0, `all test orders cancelled on every sub-account (no leftovers)`);
  }
}

// ── validate one login (one .env = one login, possibly N sub-accounts) ────────
async function validateAccount(cfg) {
  hdr(`ACCOUNT CONFIG: ${cfg.accountId}  (env=${cfg.credentials.env})`);

  const auth = new TradovateAuth(cfg.credentials);
  try {
    await auth.authenticate();
    ok(true, `authenticated (${cfg.credentials.env})`);
  } catch (e) {
    ok(false, `authentication failed: ${e.message}`);
    return; // can't continue without auth
  }

  const client = new TradovateClient(auth);

  let accounts = [];
  try { accounts = await client.getAccounts(); ok(Array.isArray(accounts) && accounts.length > 0, `getAccounts ok (${accounts.length} visible under this login)`); }
  catch (e) { ok(false, `getAccounts failed: ${e.message}`); auth.stopRenewal(); return; }

  let subs;
  try {
    subs = resolveSubAccounts(accounts, cfg.credentials, cfg.accountId);
    ok(subs.length >= 1, `resolved ${subs.length} sub-account(s): ${subs.map((s) => `${s.name}(${s.id})`).join(', ')}`);
    note(`PRIMARY = ${subs[0].name} (${subs[0].id}); SECONDARIES = ${subs.slice(1).map((s) => s.name).join(', ') || '(none)'}`);
    if (subs.length < 2) warnMsg('only ONE sub-account resolved — set TRADOVATE_ACCOUNT_NAME="A,B" to mirror across both');
  } catch (e) {
    ok(false, `sub-account resolution failed: ${e.message}`);
    auth.stopRenewal();
    return;
  }

  // Per-sub-account read endpoints (the ones /status + reconcile use)
  for (let i = 0; i < subs.length; i++) await readChecks(client, subs[i], i === 0);

  // Contract resolution for the (first) instrument
  const ic = (cfg.instruments && cfg.instruments[0]) || { baseSymbol: 'MNQ', autoRollover: true };
  const contract = await resolveContract(client, ic);
  console.log('');
  ok(contract && contract.id != null, `contract resolved for ${ic.baseSymbol}: ${contract ? `${contract.name} (id ${contract.id}, exp ${contract.expirationDate || '?'})` : 'FAILED'}`);

  // Mirror wiring (the drop-in client + classification used live)
  const { client: proxy, mirror } = createOrderClient(client, subs);
  console.log('');
  if (subs.length < 2) {
    ok(proxy === client && mirror === null, `single sub-account → real client unchanged (byte-for-byte; no mirror)`);
  } else {
    ok(mirror !== null && proxy !== client, `mirror active → drop-in proxy returned`);
    ok(typeof proxy.reconcileSecondaries === 'function', `proxy exposes reconcileSecondaries()`);
    ok(typeof proxy.placeOCO === 'function' && typeof proxy.getOpenPositions === 'function', `proxy wraps order methods + forwards reads`);
    ok(mirror.ownerOfOrder(999999999) === null, `ownerOfOrder(unknown) === null (fills default to primary runner)`);
  }

  // Opt-in live order-fanout test (fill-safe, user-priced)
  if (has('--limit-test')) {
    if (subs.length < 2) warnMsg('limit-test needs >= 2 sub-accounts to exercise the fanout — skipping');
    else await limitFanoutTest(client, proxy, mirror, subs, contract);
  }

  auth.stopRenewal();
}

async function main() {
  console.log('═'.repeat(64));
  console.log('Sub-account mirror — LIVE validation (read-only by default)');
  console.log(`Mode: ${has('--limit-test') ? 'READ + LIMIT-FANOUT TEST' : 'READ-ONLY (no orders)'}`);
  console.log('═'.repeat(64));

  let configs;
  try { configs = buildConfigs(); }
  catch (e) { console.error(`Failed to load config: ${e.message}`); process.exit(2); }

  if (!configs.length) { console.error('No account configs found.'); process.exit(2); }

  for (const cfg of configs) {
    try { await validateAccount(cfg); }
    catch (e) { fail++; console.error(`  ✗ THREW validating ${cfg.accountId}: ${e.message}`); }
  }

  hdr('SUMMARY');
  console.log(`  ${pass} passed, ${fail} failed, ${warn} warning(s)`);
  if (fail === 0) console.log('  ✅ VALIDATION PASSED' + (warn ? ' (with warnings — review above)' : ''));
  else console.log('  ❌ VALIDATION FAILED — review the ✗ lines above');
  process.exit(fail === 0 ? 0 : 1);
}

main();
