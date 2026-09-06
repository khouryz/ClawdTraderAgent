#!/usr/bin/env node
/**
 * Pre-session preflight.
 *
 *   node scripts/preflight.js                     # instance from .env on 8787
 *   node scripts/preflight.js MNQU6:8787 MESU6:8788
 *
 * Answers ONE question: is it safe to trade right now? Exit 0 = yes.
 * Any non-zero exit means DO NOT TRADE.
 *
 * This exists because on 4 Sep the bot had crashed overnight and it was found
 * only because someone happened to look at 03:32. Checks that a human would
 * skim past — a stale ledger date, a position with no stop, a contract a week
 * from expiry — are exactly the ones that cost money.
 *
 * Findings are one of:
 *   BLOCK  something is wrong that can lose money  -> exit 1
 *   WARN   worth knowing, not disqualifying        -> exit 0
 *   OK     verified
 */

require('dotenv').config();

const fs = require('fs');
const http = require('http');
const path = require('path');

const MarketHours = require('../src/utils/market_hours');
const Notifications = require('../src/utils/notifications');
const { CONTRACTS, FILES } = require('../src/utils/constants');

const ROLL_WARN_DAYS = 10;   // start nagging this far before expiry
const HTTP_TIMEOUT_MS = 8000;

const results = [];
const add = (level, check, detail) => results.push({ level, check, detail });
const ok = (c, d) => add('OK', c, d);
const warn = (c, d) => add('WARN', c, d);
const block = (c, d) => add('BLOCK', c, d);

// ── helpers ──────────────────────────────────────────────────────────────────

function envToken() {
  if (process.env.WEBHOOK_TOKEN) return process.env.WEBHOOK_TOKEN;
  try {
    const line = fs.readFileSync('.env', 'utf8').split(/\r?\n/)
      .find(l => l.startsWith('WEBHOOK_TOKEN='));
    return line ? line.slice('WEBHOOK_TOKEN='.length).trim().replace(/^["']|["']$/g, '') : null;
  } catch (_) { return null; }
}

function get(port, pathname, token) {
  return new Promise(resolve => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET',
        headers: token ? { 'x-signal-token': token } : {} },
      res => {
        let body = '';
        res.on('data', d => { body += d; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
          catch (_) { resolve({ status: res.statusCode, json: null }); }
        });
      }
    );
    req.setTimeout(HTTP_TIMEOUT_MS, () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.on('error', () => resolve({ status: 0, json: null }));
    req.end();
  });
}

function tcpAlive(port) {
  return new Promise(resolve => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/json/version', method: 'GET' },
      res => { res.resume(); resolve(true); }
    );
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

/** Expiry for a futures symbol like MNQU6 -> third Friday of Sep 2026. */
function expiryOf(symbol) {
  const m = /^([A-Z0-9]{2,3})([FGHJKMNQUVXZ])(\d)$/.exec(String(symbol).toUpperCase());
  if (!m) return null;
  const monthCode = 'FGHJKMNQUVXZ'.indexOf(m[2]);          // 0 = Jan
  const digit = Number(m[3]);
  const nowYear = new Date().getUTCFullYear();
  // Single-digit year: pick the nearest year ending in that digit.
  let year = Math.floor(nowYear / 10) * 10 + digit;
  if (year < nowYear) year += 10;
  // Third Friday.
  const d = new Date(Date.UTC(year, monthCode, 1));
  let fridays = 0;
  while (true) {
    if (d.getUTCDay() === 5 && ++fridays === 3) break;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return d;
}

function pidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// ── checks ───────────────────────────────────────────────────────────────────

function checkCalendar() {
  const mh = new MarketHours();
  const now = mh.getNow();
  const day = now.getDay();
  if (day === 0 || day === 6) {
    block('Trading day', `it is ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]} — the RTH session does not run`);
    return;
  }
  if (mh.isHoliday(now)) {
    block('Trading day', 'today is a CME holiday — the market is closed');
    return;
  }
  ok('Trading day', `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][day]}, not a holiday`);
}

/**
 * Show UTC / PST / ET side by side.
 *
 * This machine runs UTC+9, and timezone confusion has caused four separate
 * bugs: a 7-hour scheduling error, a holiday check that missed Labor Day, a
 * risk ledger that rolled at 17:00 PST, and a preflight line claiming today
 * was before yesterday. Printing all three makes any drift obvious at a glance
 * instead of surfacing as a wrong decision hours later.
 */
function checkClock() {
  const now = new Date();
  const fmt = (tz) => new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const pst = fmt('America/Los_Angeles');
  const et = fmt('America/New_York');
  const utc = fmt('UTC');
  ok('Clock', `PST ${pst} · ET ${et} · UTC ${utc}`);
}

function checkEnv() {
  // Names only — never read or print a secret's value.
  const required = ['TRADOVATE_USERNAME', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'WEBHOOK_TOKEN'];
  let raw = '';
  try { raw = fs.readFileSync('.env', 'utf8'); } catch (_) {}
  const missing = required.filter(k => !process.env[k] && !new RegExp(`^${k}=.+`, 'm').test(raw));
  if (missing.length) block('Environment', `missing: ${missing.join(', ')}`);
  else ok('Environment', `all required keys present (${required.length})`);
}

function checkSharedLedger() {
  const dir = process.env.LOSS_LIMITS_DIR || './data/shared';
  const p = path.join(dir, 'loss_limits_state.json');
  if (!fs.existsSync(p)) { warn('Shared ledger', `${p} not created yet (fine on a first run)`); return null; }
  let st;
  try { st = JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { block('Shared ledger', `unreadable: ${e.message}`); return null; }

  if (st.isHalted) block('Shared ledger', `HALTED (${st.haltReason}) — no instance will trade until this clears`);
  else ok('Shared ledger', 'not halted');

  // A ledger still dated yesterday means today's P&L starts from a stale
  // number until the first trade rolls it.
  // Format the REAL instant in the trading timezone. Passing MarketHours.getNow()
  // here double-shifts it: that returns an ET wall-clock Date (ET time
  // reinterpreted as local), so formatting it again in LA moved the date back a
  // further day and printed "today" as earlier than the last trade.
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TIMEZONE || 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  if (st.lastTradeDate && st.lastTradeDate !== today) {
    warn('Ledger date', `last trade ${st.lastTradeDate}, today ${today} — resets on the first trade or the 06:29 reset`);
  } else if (st.lastTradeDate) {
    ok('Ledger date', `current (${st.lastTradeDate}), dailyPnL ${st.dailyPnL}`);
  }
  return st;
}

function checkPollerLock() {
  const dir = process.env.LOSS_LIMITS_DIR || './data/shared';
  const p = path.join(dir, '.telegram_poller.lock');
  if (!fs.existsSync(p)) { ok('Telegram poller', 'no stale lock — first instance up will claim it'); return; }
  const pid = fs.readFileSync(p, 'utf8').trim();
  if (pidAlive(pid)) ok('Telegram poller', `owned by live pid ${pid}`);
  else warn('Telegram poller', `lock held by DEAD pid ${pid} — next start takes over after 60s`);
}

/**
 * Ask the chart what symbol it is showing.
 *
 * A port check only proves Electron is alive. If the TradingView session has
 * expired, CDP answers perfectly while the page sits on a login screen — so the
 * bot would look healthy and every chart read would return nothing. This runs a
 * real Runtime.evaluate against the page over CDP (Node 24 has a native
 * WebSocket, so no dependency), and only passes if a chart reports a symbol.
 */
function chartSymbol(wsUrl) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} resolve(v); } };
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      return resolve({ err: e.message });
    }
    const timer = setTimeout(() => done({ err: 'timeout' }), 12000);
    ws.onerror = () => done({ err: 'websocket error' });
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          returnByValue: true,
          expression: `(() => {
            try {
              const api = window.TradingViewApi;
              if (!api || !api.activeChart) return JSON.stringify({ loaded: false, why: 'TradingViewApi absent (logged out or still loading)' });
              const c = api.activeChart();
              return JSON.stringify({ loaded: true, symbol: c.symbol(), resolution: c.resolution() });
            } catch (e) { return JSON.stringify({ loaded: false, why: String(e) }); }
          })()`,
        },
      }));
    };
    ws.onmessage = (ev) => {
      clearTimeout(timer);
      try {
        const m = JSON.parse(ev.data);
        const v = m?.result?.result?.value;
        done(v ? JSON.parse(v) : { err: 'no value returned' });
      } catch (e) { done({ err: e.message }); }
    };
  });
}

async function checkTradingView() {
  const port = process.env.TV_CDP_PORT || 9223;
  if (!(await tcpAlive(port))) {
    block('TradingView', `no CDP on ${port} — no price source, so no entries can be priced`);
    return;
  }
  ok('TradingView', `CDP responding on ${port}`);

  // Find the chart page among the targets.
  const targets = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/json', method: 'GET' }, (res) => {
      let b = ''; res.on('data', d => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve([]); } });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve([]); });
    req.on('error', () => resolve([]));
    req.end();
  });
  const page = (targets || []).find(t => t.type === 'page' && /tradingview\.com\/chart/.test(t.url || ''));
  if (!page || !page.webSocketDebuggerUrl) {
    block('Chart', 'no TradingView chart page found on CDP — the app may be on a login or blank screen');
    return;
  }

  const r = await chartSymbol(page.webSocketDebuggerUrl);
  if (r && r.loaded && r.symbol) {
    ok('Chart', `showing ${r.symbol} @ ${r.resolution}`);
  } else {
    block('Chart', `chart not usable — ${r?.why || r?.err || 'no symbol'}. Log in via VNC (ssh -L 5900:localhost:5900) if the session expired.`);
  }
}

async function checkInstance(symbol, port, token) {
  const tag = `${symbol}:${port}`;

  const status = await get(port, '/status', token);
  if (status.status !== 200 || !status.json) {
    block(`Bot ${tag}`, status.status === 0 ? 'not answering — the bot is DOWN' : `/status returned ${status.status}`);
    return;
  }
  const s = status.json;
  ok(`Bot ${tag}`, 'answering /status');

  if (s.connected === false) block(`Broker ${tag}`, 'not connected to Tradovate');
  else ok(`Broker ${tag}`, 'connected');

  if (s.halted) block(`Halt ${tag}`, `HALTED${s.haltReason ? ` (${s.haltReason})` : ''}`);
  else ok(`Halt ${tag}`, 'not halted');

  const used = s.tradesToday ?? 0;
  const max = s.maxTrades ?? 3;
  if (used >= max) warn(`Budget ${tag}`, `${used}/${max} trades already used`);
  else ok(`Budget ${tag}`, `${used}/${max} trades used, $${s.lossLimitRemaining ?? '?'} loss budget left`);

  // Contract: does the running bot hold the contract we think it does?
  const running = s.contract || s.contractSymbol || null;
  if (running && String(running).toUpperCase() !== String(symbol).toUpperCase()) {
    block(`Contract ${tag}`, `bot is on ${running}, expected ${symbol}`);
  } else {
    ok(`Contract ${tag}`, running || symbol);
  }

  // Roll warning.
  const exp = expiryOf(symbol);
  if (exp) {
    const days = Math.ceil((exp - new Date()) / 86400000);
    if (days < 0) block(`Roll ${tag}`, `${symbol} EXPIRED ${-days}d ago`);
    else if (days <= 2) block(`Roll ${tag}`, `${symbol} expires in ${days}d — roll before trading`);
    else if (days <= ROLL_WARN_DAYS) warn(`Roll ${tag}`, `${symbol} expires in ${days}d (${exp.toISOString().slice(0,10)}) — volume moves ~8d before`);
    else ok(`Roll ${tag}`, `${days}d to expiry`);
  }

  // Exposure: an open position with no stop is the worst state to open on.
  const pos = await get(port, '/positions', token);
  if (pos.status !== 200 || !pos.json) {
    warn(`Exposure ${tag}`, 'could not read positions');
  } else {
    const positions = pos.json.positions || [];
    const orders = pos.json.workingOrders || [];
    const live = positions.filter(p => p.netPos !== 0);
    if (live.length === 0) {
      ok(`Exposure ${tag}`, orders.length ? `flat, ${orders.length} working order(s)` : 'flat, no working orders');
    } else {
      const stops = orders.filter(o => String(o.orderType).toLowerCase() === 'stop');
      if (stops.length === 0) {
        block(`Exposure ${tag}`, `OPEN POSITION (netPos ${live[0].netPos}) WITH NO STOP — flatten or protect it now`);
      } else {
        warn(`Exposure ${tag}`, `carrying ${live[0].netPos} @ ${live[0].netPrice}, ${stops.length} stop(s) in place`);
      }
    }
  }

  // Was the last stop clean? Read it from the LOG, not the marker file: the bot
  // consumes (deletes) that marker at startup, so once an instance is running the
  // file is always gone and a file check warns every single time.
  const short = String(symbol).slice(0, 3);
  try {
    const NL = String.fromCharCode(10);
    const dir = fs.existsSync(`./logs/${short}`) ? `./logs/${short}` : "./logs";
    const logs = fs.readdirSync(dir)
      .filter(f => f.startsWith("bot-") && f.endsWith(".log")).sort();
    if (!logs.length) throw new Error("no bot log");
    const text = fs.readFileSync(path.join(dir, logs[logs.length - 1]), "utf8");
    const rows = text.split(NL);
    let lastBoot = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].indexOf("Execution Bot is LIVE") !== -1) lastBoot = i;
    }
    if (lastBoot === -1) throw new Error("no startup banner");
    const after = rows.slice(lastBoot);
    if (after.some(l => l.indexOf("Previous shutdown was NOT clean") !== -1)) {
      warn(`Last stop ${tag}`, "previous shutdown was NOT clean - check the broker for strays");
    } else {
      ok(`Last stop ${tag}`, "previous shutdown was clean");
    }
  } catch (e) {
    warn(`Last stop ${tag}`, `could not determine (${e.message})`);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

(async () => {
  const args = process.argv.slice(2);
  const instances = args.length
    ? args.map(a => { const [sym, port] = a.split(':'); return { symbol: sym, port: Number(port) || 8787 }; })
    : [{ symbol: process.env.CONTRACT_SYMBOL || 'MNQ', port: Number(process.env.WEBHOOK_PORT) || 8787 }];

  const token = envToken();
  if (!token) warn('Auth', 'no WEBHOOK_TOKEN found — instance checks may be rejected');

  checkClock();
  checkCalendar();
  checkEnv();
  checkSharedLedger();
  checkPollerLock();
  await checkTradingView();
  for (const { symbol, port } of instances) await checkInstance(symbol, port, token);

  // ── report ──
  const pad = Math.max(...results.map(r => r.check.length));
  console.log('\n──────── PREFLIGHT ────────');
  for (const r of results) {
    const mark = r.level === 'OK' ? '✓' : r.level === 'WARN' ? '!' : '✗';
    console.log(`${mark} ${r.check.padEnd(pad)}  ${r.detail}`);
  }

  const blocks = results.filter(r => r.level === 'BLOCK');
  const warns = results.filter(r => r.level === 'WARN');
  const verdict = blocks.length
    ? `DO NOT TRADE — ${blocks.length} blocker(s)`
    : warns.length ? `CLEAR with ${warns.length} warning(s)` : 'ALL CLEAR';
  console.log('───────────────────────────');
  console.log(verdict + '\n');

  // Telegram: sending IS the test that notifications work at all.
  try {
    const n = new Notifications({});
    if (n.enabled) {
      const icon = blocks.length ? '🛑' : warns.length ? '⚠️' : '✅';
      const lines = [
        `${icon} <b>Preflight — ${verdict}</b>`,
        ...blocks.map(b => `✗ ${b.check}: ${b.detail}`),
        ...warns.map(w => `! ${w.check}: ${w.detail}`),
      ];
      if (!blocks.length && !warns.length) lines.push(`${results.length} checks passed.`);
      await n.send(lines.join('\n'));
      console.log('(preflight summary sent to Telegram)');
    } else {
      console.log('(Telegram not configured — no summary sent)');
    }
  } catch (e) {
    console.error(`(Telegram summary failed: ${e.message})`);
  }

  process.exit(blocks.length ? 1 : 0);
})();
