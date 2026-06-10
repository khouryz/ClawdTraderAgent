#!/usr/bin/env node
/**
 * mirror_live_trade_test.js
 *
 * ONE real 1-lot round-trip that exercises the ENTIRE mirror lifecycle on LIVE
 * sub-accounts and prints a per-account capability checklist:
 *
 *     market ENTRY  →  OCO bracket  →  MOVE STOP  →  FLATTEN
 *     (each step replicated primary → secondary by the OrderMirror)
 *
 * It verifies every step against EXCHANGE TRUTH (getOpenPositions / getWorkingOrders
 * on each sub-account), not just the mirror's own logs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ⚠️  THIS PLACES A REAL MARKET ORDER ON LIVE ACCOUNTS.
 *      Risk ≈ stopPts × $2 × qty per account (default 5pt × 1 = ~$10/account).
 *      The script ALWAYS flattens + cancels on every sub-account at the end,
 *      even if it errors. But markets move — treat the risk as real.
 *
 *  ⚠️  STOP THE TRADING BOT FIRST:   pm2 stop ClawdTraderAgent
 *      Running this while the bot is live on the same account will corrupt the
 *      bot's position tracking (its WS will see this test position).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Usage (must pass --go to actually trade):
 *   node scripts/mirror_live_trade_test.js --accounts-dir ./accounts --go
 *
 *   Options:
 *     --account <id>     which account config to use (default: first with >=2 subs)
 *     --side buy|sell    entry direction (default: buy)
 *     --qty <n>          contracts (default: 1)
 *     --stop-pts <n>     stop distance in points (default: 5  → ~$10 risk/acct)
 *     --tp-pts <n>       target distance in points (default: 10 → 2R)
 *     --be-pts <n>       move stop to entry ∓ this many pts (default: 2)
 *     --hold-sec <n>     seconds to hold after the stop move (default: 4)
 *     --go               REQUIRED — actually place the trade
 */

'use strict';
try { require('dotenv').config(); } catch (_) {}

const TradovateAuth = require('../src/api/auth');
const TradovateClient = require('../src/api/client');
const { createOrderClient } = require('../src/api/OrderMirror');
const { loadAccountConfigs, parseAccountNames } = require('../src/utils/account_config_loader');

// ── args ──────────────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const has = (f) => ARGS.includes(f);
const arg = (f, d) => { const i = ARGS.indexOf(f); return (i >= 0 && ARGS[i + 1] != null) ? ARGS[i + 1] : d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TICK = 0.25;
const POINT_VALUE = 2; // MNQ $/point
const roundTick = (p) => parseFloat((Math.round(p / TICK) * TICK).toFixed(2));

const SIDE = (arg('--side', 'buy')).toLowerCase() === 'sell' ? 'sell' : 'buy';
const QTY = Math.max(1, parseInt(arg('--qty', '1'), 10) || 1);
const STOP_PTS = parseFloat(arg('--stop-pts', '5'));
const TP_PTS = parseFloat(arg('--tp-pts', '10'));
const BE_PTS = parseFloat(arg('--be-pts', '2'));
const HOLD_SEC = parseInt(arg('--hold-sec', '4'), 10) || 4;
const GO = has('--go');

// ── verbose logging ───────────────────────────────────────────────────────────
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const hr = (m) => console.log(`\n${'═'.repeat(70)}\n${m}\n${'═'.repeat(70)}`);
const sub = (m) => console.log(`\n── ${m} ──`);

// ── exchange-truth readers ────────────────────────────────────────────────────
async function netPos(client, accountId, contractId) {
  const positions = await client.getOpenPositions(accountId).catch(() => []);
  const p = (positions || []).find((x) => Number(x.contractId) === Number(contractId));
  return p && p.netPos ? { netPos: Number(p.netPos), netPrice: p.netPrice } : { netPos: 0, netPrice: null };
}
async function bracket(client, accountId, contractId) {
  const wo = await client.getWorkingOrders(accountId).catch(() => []);
  const mine = (wo || []).filter((o) => Number(o.contractId) === Number(contractId));
  const isStop = (o) => o.ordType === 'Stop' || o.ordType === 'StopLimit' || o.stopPrice != null;
  const isLimit = (o) => (o.ordType === 'Limit') || (o.price != null && o.stopPrice == null);
  return {
    all: mine,
    stop: mine.find(isStop) || null,
    target: mine.find((o) => isLimit(o) && !isStop(o)) || null,
    count: mine.length,
  };
}
async function dumpState(client, label, subs, contractId) {
  sub(`STATE: ${label}`);
  for (const s of subs) {
    const np = await netPos(client, s.id, contractId);
    const br = await bracket(client, s.id, contractId);
    const stopStr = br.stop ? `stop@${br.stop.stopPrice ?? br.stop.price} (id ${br.stop.id})` : 'stop:—';
    const tgtStr = br.target ? `target@${br.target.price} (id ${br.target.id})` : 'target:—';
    log(`   ${s.name} (${s.id}): netPos=${np.netPos}${np.netPrice != null ? ` @ ${np.netPrice}` : ''} | ${br.count} working [${stopStr}, ${tgtStr}]`);
  }
}

// ── bulletproof cleanup (runs in finally) ─────────────────────────────────────
async function flattenEverything(client, subs, contractId, reason) {
  hr(`🧹 CLEANUP (${reason}) — flatten + cancel on all ${subs.length} sub-account(s)`);
  for (const s of subs) {
    try {
      const wo = await client.getWorkingOrders(s.id).catch(() => []);
      const mine = (wo || []).filter((o) => Number(o.contractId) === Number(contractId));
      for (const o of mine) {
        try { await client.cancelOrder(o.id); log(`   cancelled ${s.name} order ${o.id} (${o.ordType || '?'})`); }
        catch (e) { log(`   ⚠ cancel ${o.id} on ${s.name} failed: ${e.message}`); }
      }
    } catch (e) { log(`   ⚠ ${s.name} getWorkingOrders failed: ${e.message}`); }
    try {
      const np = await netPos(client, s.id, contractId);
      if (np.netPos !== 0) {
        await client.liquidatePosition(s.id, contractId, np.netPos);
        log(`   flattened ${s.name} netPos=${np.netPos}`);
      }
    } catch (e) { log(`   ⚠ ${s.name} flatten failed: ${e.message}`); }
  }
  await sleep(1800);
  let clean = true;
  for (const s of subs) {
    const np = await netPos(client, s.id, contractId);
    const br = await bracket(client, s.id, contractId);
    if (np.netPos !== 0 || br.count > 0) {
      clean = false;
      log(`   🚨 LEFTOVER on ${s.name} (${s.id}): netPos=${np.netPos}, ${br.count} working order(s) [ids: ${br.all.map((o) => o.id).join(',') || '—'}] — CANCEL/FLATTEN MANUALLY`);
    }
  }
  log(clean ? '   ✓ all sub-accounts flat with zero working orders' : '   ❌ MANUAL CLEANUP REQUIRED (see above)');
  return clean;
}

async function resolveContract(client, ic) {
  if (ic && ic.symbol) { try { const c = await client.findContract(ic.symbol); if (c && c.id) return c; } catch (_) {} }
  try { return await client.getFrontMonthContract((ic && ic.baseSymbol) || 'MNQ'); } catch (_) { return null; }
}

async function main() {
  hr('MIRROR LIVE TRADE TEST — full lifecycle on both accounts');
  log(`side=${SIDE} qty=${QTY} stop=${STOP_PTS}pt tp=${TP_PTS}pt moveStopTo=entry∓${BE_PTS}pt hold=${HOLD_SEC}s`);
  log(`estimated risk ≈ $${(STOP_PTS * POINT_VALUE * QTY).toFixed(2)} per account`);
  if (STOP_PTS * POINT_VALUE * QTY > 40) { log('❌ refusing: estimated risk > $40/account — lower --stop-pts/--qty'); process.exit(2); }
  if (!GO) {
    log('\nDRY RUN — no order placed. Re-run with --go to actually trade.');
    log('⚠️  STOP THE BOT FIRST (pm2 stop ClawdTraderAgent) so it does not see this test position.');
    process.exit(0);
  }

  // ── load config + pick the mirror account ──
  const dir = arg('--accounts-dir', process.env.ACCOUNTS_DIR || './accounts');
  const want = arg('--account', null);
  const configs = loadAccountConfigs(dir);
  if (!configs.length) { log(`❌ no account configs in ${dir}`); process.exit(2); }

  let chosen = null;
  for (const cfg of configs) {
    if (want && cfg.accountId !== want) continue;
    const names = parseAccountNames((cfg.credentials.accountNames || []).join(',') || cfg.credentials.accountName || '');
    if (want || names.length >= 2) { chosen = cfg; if (want || names.length >= 2) break; }
  }
  if (!chosen) { log('❌ no account config with >=2 sub-accounts found (need a mirror account). Use --account <id>.'); process.exit(2); }
  log(`using account config: ${chosen.accountId}`);

  // ── auth + resolve subs + mirror ──
  const auth = new TradovateAuth(chosen.credentials);
  await auth.authenticate();
  const realClient = new TradovateClient(auth);
  const accounts = await realClient.getAccounts();
  const names = (Array.isArray(chosen.credentials.accountNames) && chosen.credentials.accountNames.length)
    ? chosen.credentials.accountNames : [chosen.credentials.accountName];
  const subs = names.map((n) => {
    const a = accounts.find((x) => x.name === n);
    if (!a) throw new Error(`sub-account "${n}" not found under this login`);
    return { id: a.id, name: a.name };
  });
  if (subs.length < 2) { log('❌ resolved <2 sub-accounts — nothing to mirror'); auth.stopRenewal(); process.exit(2); }
  const primary = subs[0];
  const secondaries = subs.slice(1);
  log(`PRIMARY=${primary.name}(${primary.id})  SECONDARIES=${secondaries.map((s) => `${s.name}(${s.id})`).join(', ')}`);

  const { client, mirror } = createOrderClient(realClient, subs);
  if (!mirror) { log('❌ mirror not active'); auth.stopRenewal(); process.exit(2); }

  const ic = (chosen.instruments && chosen.instruments[0]) || { baseSymbol: 'MNQ' };
  const contract = await resolveContract(realClient, ic);
  if (!contract || !contract.id) { log('❌ could not resolve contract'); auth.stopRenewal(); process.exit(2); }
  const contractId = contract.id;
  log(`contract: ${contract.name} (id ${contractId})`);

  const entryAction = SIDE === 'buy' ? 'Buy' : 'Sell';
  const exitAction = SIDE === 'buy' ? 'Sell' : 'Buy';
  const results = {}; // per sub-account capability flags
  for (const s of subs) results[s.name] = { entered: false, oco: false, stopMoved: false };

  let ocoStopId = null;
  try {
    // ── PRE-FLIGHT: every account must be flat & order-free ──
    hr('PRE-FLIGHT — confirm a clean slate on every sub-account');
    await dumpState(realClient, 'before entry', subs, contractId);
    for (const s of subs) {
      const np = await netPos(realClient, s.id, contractId);
      const br = await bracket(realClient, s.id, contractId);
      if (np.netPos !== 0 || br.count > 0) { log(`❌ ABORT: ${s.name} is not flat/clean — refusing to trade into existing state`); auth.stopRenewal(); process.exit(2); }
    }
    log('✓ all sub-accounts flat and order-free');

    // ── STEP 1: MARKET ENTRY (mirrored) ──
    hr(`STEP 1 — MARKET ${entryAction} ${QTY} on PRIMARY (mirrors to secondaries)`);
    const entryRes = await client.placeMarketOrder(primary.id, contractId, QTY, entryAction);
    log(`primary entry order placed (orderId=${entryRes && entryRes.orderId})`);
    log('waiting for fills on every account (≤12s)...');
    let primaryEntryPrice = null;
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      await sleep(700);
      const pnp = await netPos(realClient, primary.id, contractId);
      if (pnp.netPos !== 0) { primaryEntryPrice = pnp.netPrice; break; }
    }
    for (const s of subs) {
      const np = await netPos(realClient, s.id, contractId);
      results[s.name].entered = np.netPos !== 0;
      log(`   ${s.name}: ${np.netPos !== 0 ? `✓ FILLED netPos=${np.netPos} @ ${np.netPrice}` : '✗ NOT filled (margin/reject?)'}`);
    }
    if (!results[primary.name].entered || primaryEntryPrice == null) {
      log('❌ PRIMARY did not fill — likely margin rejection. Aborting (cleanup will run).');
      throw new Error('primary entry not filled');
    }

    // ── STEP 2: OCO BRACKET (mirrored, gated per-account on actual entry) ──
    const entry = roundTick(primaryEntryPrice);
    const stopPrice = SIDE === 'buy' ? roundTick(entry - STOP_PTS) : roundTick(entry + STOP_PTS);
    const targetPrice = SIDE === 'buy' ? roundTick(entry + TP_PTS) : roundTick(entry - TP_PTS);
    hr(`STEP 2 — OCO bracket: ${exitAction} stop@${stopPrice} / target@${targetPrice} (entry ${entry})`);
    const oco = await client.placeOCO(primary.name || String(primary.id), primary.id, contract.name, QTY, exitAction, stopPrice, targetPrice);
    ocoStopId = oco && oco.orderId; // primary stop leg (used for the move)
    log(`primary OCO placed (stopId=${oco && oco.orderId}, targetId=${oco && oco.ocoId})`);
    log('letting the mirror fan the bracket to secondaries (≤6s)...');
    for (let i = 0; i < 8; i++) {
      await sleep(750);
      let allDone = true;
      for (const s of subs) {
        const br = await bracket(realClient, s.id, contractId);
        results[s.name].oco = !!(br.stop && br.target);
        if (!results[s.name].oco && results[s.name].entered) allDone = false;
      }
      if (allDone) break;
    }
    await dumpState(realClient, 'after OCO', subs, contractId);
    for (const s of subs) {
      if (results[s.name].entered) log(`   ${s.name}: ${results[s.name].oco ? '✓ OCO present (stop+target working)' : '✗ OCO MISSING'}`);
      else log(`   ${s.name}: (no entry → bracket correctly skipped by H2 gate)`);
    }

    // ── STEP 3: MOVE STOP (mirrored modify) ──
    const newStop = SIDE === 'buy' ? roundTick(entry - BE_PTS) : roundTick(entry + BE_PTS);
    hr(`STEP 3 — MOVE STOP ${stopPrice} → ${newStop} on PRIMARY (mirrors to secondaries)`);
    const beforeStops = {};
    for (const s of subs) { const br = await bracket(realClient, s.id, contractId); beforeStops[s.name] = br.stop ? (br.stop.stopPrice ?? br.stop.price) : null; }
    await client.modifyOrder(ocoStopId, { stopPrice: newStop });
    log('letting the mirror fan the modify to secondaries (≤5s)...');
    for (let i = 0; i < 7; i++) {
      await sleep(700);
      let allMoved = true;
      for (const s of subs) {
        if (!results[s.name].oco) continue;
        const br = await bracket(realClient, s.id, contractId);
        const sp = br.stop ? Number(br.stop.stopPrice ?? br.stop.price) : null;
        results[s.name].stopMoved = sp != null && Math.abs(sp - newStop) < TICK;
        if (!results[s.name].stopMoved) allMoved = false;
      }
      if (allMoved) break;
    }
    await dumpState(realClient, 'after stop move', subs, contractId);
    for (const s of subs) {
      if (!results[s.name].oco) continue;
      const br = await bracket(realClient, s.id, contractId);
      const sp = br.stop ? (br.stop.stopPrice ?? br.stop.price) : null;
      log(`   ${s.name}: stop ${beforeStops[s.name]} → ${sp} ${results[s.name].stopMoved ? '✓ MOVED' : '✗ did not move'}`);
    }

    // ── STEP 4: hold briefly, then exit (cleanup below does the flatten) ──
    hr(`STEP 4 — holding ${HOLD_SEC}s, then flattening both accounts`);
    await sleep(HOLD_SEC * 1000);
  } catch (e) {
    log(`\n❌ ERROR during test: ${e.message}`);
  } finally {
    const clean = await flattenEverything(realClient, subs, contractId, 'end of test');

    // ── CAPABILITY SUMMARY ──
    hr('CAPABILITY SUMMARY (per account)');
    const mark = (b) => (b ? '✓' : '✗');
    for (const s of subs) {
      const r = results[s.name];
      const role = s.id === primary.id ? 'PRIMARY  ' : 'SECONDARY';
      console.log(`   ${role} ${s.name}: entry ${mark(r.entered)} | OCO ${mark(r.oco)} | stop-moved ${mark(r.stopMoved)}`);
    }
    console.log(`   cleanup (all flat, no orders): ${mark(clean)}`);
    const secOK = secondaries.every((s) => results[s.name].entered && results[s.name].oco && results[s.name].stopMoved);
    const priOK = results[primary.name].entered && results[primary.name].oco && results[primary.name].stopMoved;
    hr(priOK && secOK && clean
      ? '✅ FULL MIRROR LIFECYCLE VALIDATED ON ALL ACCOUNTS'
      : '⚠️  REVIEW ABOVE — not every step confirmed on every account (margin? see logs)');
    auth.stopRenewal();
    process.exit(0);
  }
}

main().catch((e) => { console.error(`FATAL: ${e.stack || e.message}`); process.exit(1); });
