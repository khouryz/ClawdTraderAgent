#!/usr/bin/env node

/**
 * ClawdTraderAgent — Signal CLI (Node.js)
 *
 * ⚠️ NOT AT PARITY WITH signal_cli.py — use the Python CLI for live trading.
 * Missing here: `resume`, `cancel-all`, --order-type stop, --entry-timeout,
 * --ref-price. Sending a break entry from this script is not possible, and
 * there is no way to clear a halt or cancel orphaned orders.
 *
 * Send trade signals and manage the execution bot from the command line.
 * No external dependencies — uses built-in http module.
 *
 * Usage:
 *   node scripts/signal_cli.js send --symbol MNQ --type long --price 19500.00 --stop 19490.00 --target 19520.00 --qty 1
 *   node scripts/signal_cli.js send --symbol MNQ --type short --price 19510.00 --stop 19520.00 --order-type limit
 *   node scripts/signal_cli.js status
 *   node scripts/signal_cli.js positions
 *   node scripts/signal_cli.js flatten
 *
 * Config:
 *   Set WEBHOOK_TOKEN in .env or via --token flag.
 *   Server runs at http://127.0.0.1:8787 by default (override with --port).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';

// ── Token loading ───────────────────────────────────────────────────

function getToken(args) {
  if (args.token) return args.token;
  if (process.env.WEBHOOK_TOKEN) return process.env.WEBHOOK_TOKEN;
  // Try loading from .env
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    const match = content.match(/^WEBHOOK_TOKEN=(.+)$/m);
    if (match) return match[1].trim().replace(/^["']|["']$/g, '');
  }
  console.error('ERROR: WEBHOOK_TOKEN not found. Set it in .env or pass --token.');
  process.exit(1);
}

// ── HTTP helper ─────────────────────────────────────────────────────

function apiCall(host, port, token, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({
      hostname: host, port, method, path: pathname,
      headers: {
        'Content-Type': 'application/json',
        'X-Signal-Token': token,
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', chunk => buf += chunk);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(buf); } catch { parsed = buf; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', (err) => {
      console.error(`ERROR: Cannot connect to http://${host}:${port} — ${err.message}`);
      console.error('Is the bot running? Start it with: npm start');
      process.exit(1);
    });
    req.end(data);
  });
}

// ── Parsed args helper ──────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _command: null, _values: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else if (!args._command) {
      args._command = arg;
    } else {
      args._values.push(arg);
    }
  }
  return args;
}

// ── Commands ────────────────────────────────────────────────────────

async function cmdSend(args, token) {
  const signal = {
    signalId: args.signalId || `sig-${crypto.randomBytes(6).toString('hex')}`,
    symbol: args.symbol,
    type: args.type,
    price: parseFloat(args.price),
    stopLoss: parseFloat(args.stop),
  };

  if (args.target) signal.targetPrice = parseFloat(args.target);
  if (args.qty) signal.quantity = parseInt(args.qty);
  if (args.orderType) signal.orderType = args.orderType;

  // Multi-target exits: --exits "qty1@price1,qty2@price2"
  if (args.exits) {
    signal.exits = args.exits.split(',').map(part => {
      const [q, p] = part.trim().split('@');
      return { qty: parseInt(q.trim()), targetPrice: parseFloat(p.trim()) };
    });
  }
  if (args.moveBe) signal.moveStopToBEAfterFirstTarget = true;

  console.log(`Sending signal: ${signal.signalId}`);
  console.log(`  ${signal.type.toUpperCase()} ${signal.symbol} @ ${signal.price}`);
  console.log(`  Stop: ${signal.stopLoss}` + (signal.targetPrice ? `  Target: ${signal.targetPrice}` : '  Target: auto'));
  if (signal.exits) {
    console.log(`  Exits: ${signal.exits.length} legs: ${signal.exits.map(l => `${l.qty}@${l.targetPrice}`).join(', ')}`);
  }
  console.log(`  Qty: ${signal.quantity || 'auto'}  Order: ${signal.orderType || 'market'}`);

  const { status, body } = await apiCall(args.host || DEFAULT_HOST, parseInt(args.port || DEFAULT_PORT), token, 'POST', '/signal', signal);

  if (status === 200 && body.accepted) {
    console.log(`\n[OK] ACCEPTED -- orderId: ${body.orderId}`);
  } else if (status === 200 && body.blocked) {
    console.log(`\n[BLOCKED] ${body.reason}`);
  } else if (status === 200 && body.duplicate) {
    console.log(`\n[DUPLICATE] already processed (cached result)`);
  } else {
    console.log(`\n[REJECTED] (HTTP ${status}) -- ${body.reason || body.error || 'unknown'}`);
  }

  console.log(JSON.stringify(body, null, 2));
}

async function cmdStatus(args, token) {
  const { body } = await apiCall(args.host || DEFAULT_HOST, parseInt(args.port || DEFAULT_PORT), token, 'GET', '/status');
  console.log(JSON.stringify(body, null, 2));
}

async function cmdPositions(args, token) {
  const { body } = await apiCall(args.host || DEFAULT_HOST, parseInt(args.port || DEFAULT_PORT), token, 'GET', '/positions');
  console.log(JSON.stringify(body, null, 2));
}

async function cmdFlatten(args, token) {
  const { body } = await apiCall(args.host || DEFAULT_HOST, parseInt(args.port || DEFAULT_PORT), token, 'POST', '/flatten');
  if (body.flattened) {
    console.log(`[OK] FLATTENED -- orderId: ${body.orderId}`);
  } else {
    console.log(`[INFO] ${body.reason || body.error || 'nothing to flatten'}`);
  }
  console.log(JSON.stringify(body, null, 2));
}

async function cmdModify(args, token) {
  if (!args.orderId) {
    console.error('Usage: node scripts/signal_cli.js modify --order-id <id> --stop-price <price> [--price <price>] [--qty <n>]');
    process.exit(1);
  }
  const payload = { orderId: parseInt(args.orderId) };
  if (args.stopPrice) payload.stopPrice = parseFloat(args.stopPrice);
  if (args.price) payload.price = parseFloat(args.price);
  if (args.qty) payload.orderQty = parseInt(args.qty);

  const { status, body } = await apiCall(args.host || DEFAULT_HOST, parseInt(args.port || DEFAULT_PORT), token, 'POST', '/modify', payload);
  if (body.modified) {
    console.log(`\n[OK] MODIFIED -- orderId: ${body.orderId}`);
  } else {
    console.log(`\n[FAILED] ${body.reason || body.error || 'unknown'}`);
  }
  console.log(JSON.stringify(body, null, 2));
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = getToken(args);

  switch (args._command) {
    case 'send':
      if (!args.symbol || !args.type || !args.price || !args.stop) {
        console.error('Usage: node scripts/signal_cli.js send --symbol MNQ --type long --price 19500.00 --stop 19490.00 [--target 19520.00] [--qty 1] [--order-type market|limit]');
        process.exit(1);
      }
      await cmdSend(args, token);
      break;
    case 'status':
      await cmdStatus(args, token);
      break;
    case 'positions':
      await cmdPositions(args, token);
      break;
    case 'flatten':
      await cmdFlatten(args, token);
      break;
    case 'modify':
      await cmdModify(args, token);
      break;
    default:
      console.error(`Usage: node scripts/signal_cli.js <command> [options]

Commands:
  send       Send a trade signal
  status     Get bot status
  positions  Get open positions and working orders (with prices)
  flatten    Close all positions
  modify     Modify a working order (move stop, change price/qty)

Options:
  --symbol       Contract symbol (MNQ, MES, MYM, etc.)
  --type         long or short
  --price        Entry price (tick-aligned)
  --stop         Stop loss price
  --target       Target price (optional, auto-calculated if omitted)
  --qty          Quantity (optional, auto-calculated from risk if omitted)
  --order-type   market or limit (default: market)
  --signal-id    Unique ID (auto-generated if omitted)
  --exits        Multi-target: "qty1@price1,qty2@price2" (e.g. "1@19520.00,1@19540.00")
  --move-be      Move remaining stops to breakeven after first target fills
  --order-id     Order ID to modify (for modify command)
  --stop-price   New stop price (for modify command)
  --host         Server host (default: 127.0.0.1)
  --port         Server port (default: 8787)
  --token        Auth token (or set WEBHOOK_TOKEN in .env)

Examples:
  node scripts/signal_cli.js send --symbol MNQ --type long --price 19500.00 --stop 19490.00 --target 19520.00 --qty 1
  node scripts/signal_cli.js send --symbol MNQ --type short --price 19510.00 --stop 19520.00 --order-type limit
  node scripts/signal_cli.js send --symbol MNQ --type long --price 19500.00 --stop 19490.00 --qty 2 --exits "1@19520.00,1@19540.00" --move-be
  node scripts/signal_cli.js status
  node scripts/signal_cli.js positions
  node scripts/signal_cli.js flatten
  node scripts/signal_cli.js modify --order-id 12345 --stop-price 19500.00`);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
