# ClawdTraderAgent — System Guide for AI Signal Generators

This document is written for the AI that generates trade signals and sends them to this execution server. Read this fully before sending your first signal.

---

## What This Server Is

ClawdTraderAgent is an **execution-only bot**. It does not analyze markets, generate signals, or make trading decisions. It receives fully-specified trade signals from you (an external AI) and executes them through the Tradovate futures broker.

Your job: decide *what* to trade (symbol, direction, entry, stop, target, quantity).
This bot's job: validate it, place the order, manage the bracket, track P&L, enforce risk limits, and notify via Telegram.

---

## Architecture

```
You (AI Signal Generator)
  │
  │  POST /signal  (HTTP, localhost, token-authenticated)
  │
  ▼
Webhook Server (port 8787, loopback only)
  │
  │  validates → deduplicates → checks guards
  │
  ▼
ExecutionBot
  │
  ├── SignalHandler     → risk check, position sizing, entry order
  ├── Tradovate API     → market/limit entry order placed
  ├── Order WebSocket   → listens for fill events
  ├── PositionHandler   → on entry fill, places OCO bracket (stop + target)
  ├── Loss Limits       → tracks daily P&L, halts if limits breached
  ├── Session Manager   → daily reset, EOD force-close at session end
  └── Telegram          → entry/exit notifications, remote commands
```

---

## How to Send a Signal

### Option A: Use the provided CLI scripts

**Python** (recommended — no dependencies needed):
```bash
python scripts/signal_cli.py send \
  --symbol MNQ \
  --type long \
  --price 19500.00 \
  --stop 19490.00 \
  --target 19520.00 \
  --qty 1
```

**Node.js** (no dependencies needed):
```bash
node scripts/signal_cli.js send \
  --symbol MNQ \
  --type long \
  --price 19500.00 \
  --stop 19490.00 \
  --target 19520.00 \
  --qty 1
```

Both scripts auto-generate a `signalId` if you don't provide one. They read `WEBHOOK_TOKEN` from the `.env` file automatically.

### Option B: Raw HTTP request

```python
import requests

resp = requests.post("http://127.0.0.1:8787/signal", json={
    "signalId": "sig-001",
    "symbol": "MNQ",
    "type": "long",
    "orderType": "market",
    "price": 19500.00,
    "stopLoss": 19490.00,
    "targetPrice": 19520.00,
    "quantity": 1,
}, headers={"X-Signal-Token": "YOUR_WEBHOOK_TOKEN"})

print(resp.json())
```

### Other CLI commands

```bash
# Check if bot is running, halted, paused, how many trades today
python scripts/signal_cli.py status

# Check open positions and working orders
python scripts/signal_cli.py positions

# Emergency close all positions
python scripts/signal_cli.py flatten
```

---

## Signal Specification

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `signalId` | string | Unique ID for this signal (≤64 chars). Used for deduplication. |
| `symbol` | string | Contract symbol: `MNQ`, `MES`, `MYM`, `M2K`, or `MGC` |
| `type` | string | `"long"` or `"short"` (also accepts `"buy"`/`"sell"`) |
| `price` | number | Entry reference price. Must be tick-aligned. |
| `stopLoss` | number | Stop loss price. Must be on the correct side of entry. |

### Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `targetPrice` | number | auto | Target price. If omitted, calculated from `PROFIT_TARGET_R × stop distance`. |
| `quantity` | integer | auto | Number of contracts. If omitted, calculated from `RISK_PER_TRADE_MAX`. |
| `orderType` | string | `"market"` | `"market"` or `"limit"`. Limit orders use `price` as the limit price. |
| `signalId` | string | auto | Auto-generated UUID if omitted. Provide your own for dedup control. |

### Validation rules (signals that fail these are rejected with 400)

1. **Stop side**: Long stop must be below entry. Short stop must be above entry.
2. **Target side** (if provided): Long target must be above entry. Short target must be below entry.
3. **Tick alignment**: All prices must be exact multiples of the contract's tick size.
   - MNQ: 0.25 (e.g. 19500.00, 19500.25, 19500.50 — not 19500.10)
   - MES: 0.25
   - MYM: 1.0
   - M2K: 0.10
   - MGC: 0.10
4. **Quantity limit**: `quantity` must be ≤ `MAX_WEBHOOK_QTY` (default: 2).
5. **Stop distance limit**: Stop distance must be ≤ `MAX_WEBHOOK_STOP_TICKS` ticks (default: 200).
   - For MNQ (tick=0.25): 200 ticks = 50 points max stop distance.
   - Calculated as `abs(price - stopLoss) / tickSize`, NOT raw point distance.
6. **Known symbol**: Must exist in `config/contracts.json`.

### Guards (signals that fail these return 200 with `blocked: true`)

These are not validation errors — they mean the bot is in a state where it cannot trade:

1. **Paused**: User sent `/pause` via Telegram. Resume with `/resume`.
2. **Halted**: Loss limit hit (daily loss, weekly loss, consecutive losses, max drawdown). Resumes next day or via `/forceresume`.
3. **Past entry cutoff**: Past `LAST_ENTRY_HOUR:LAST_ENTRY_MINUTE` PST (default: 13:00 PST).
4. **Max trades per day**: Already placed `MAX_TRADES_PER_DAY` trades today (default: 3).
5. **Already in position**: Only one position at a time. Wait for it to close before sending another.
6. **Market closed**: Outside market hours.

### Response format

**Accepted:**
```json
{ "accepted": true, "signalId": "sig-001", "status": "submitted", "orderId": 12345 }
```

**Rejected (validation error, HTTP 400):**
```json
{ "accepted": false, "reason": "stopLoss 101 must be below entry 100 for a long" }
```

**Blocked (guard rejection, HTTP 200):**
```json
{ "accepted": false, "blocked": true, "reason": "blocked: max trades per day reached (3/3)" }
```

**Duplicate (idempotent, HTTP 200):**
```json
{ "accepted": true, "signalId": "sig-001", "status": "submitted", "orderId": 12345, "duplicate": true }
```

---

## What Happens After You Send a Signal

### If accepted:

1. **Entry order placed** — market or limit order sent to Tradovate immediately.
2. **Fill arrives** — via WebSocket (usually <1 second for market orders). For limit orders, waits until filled or timeout (180s).
3. **OCO bracket placed** — stop loss + target profit orders placed automatically after entry fill. Prices are adjusted to the actual fill price.
4. **Telegram notification** — you (the human operator) get an entry notification with the real fill price, stop, target, and risk.
5. **Position is open** — the bot now monitors for the exit fill (stop hit or target hit).
6. **Exit fill arrives** — OCO bracket triggers, position closes.
7. **P&L recorded** — performance tracker and loss limits updated.
8. **Telegram notification** — exit notification with P&L, R-multiple, and exit reason.
9. **Ready for next signal** — bot clears position state and can accept new signals.

### If OCO placement fails (rare):

The bot emergency-closes the naked position with a market order and sends a critical Telegram alert. This prevents an unprotected position from running.

### At end of day (12:55 PM PST):

The session manager force-closes any open position and cancels all working orders. A daily report is sent via Telegram.

### On bot restart with an existing position:

The bot re-adopts the position and its existing bracket orders from the broker. No manual intervention needed.

---

## Deduplication

If you send the same `signalId` twice within 5 minutes (`WEBHOOK_DEDUP_MS`), the second request returns the cached result from the first — it does NOT place a second order. This makes retries safe.

**Rule**: Generate a unique `signalId` for each distinct trade signal. Reuse the same ID only when retrying a failed/dropped request for the same signal.

---

## Risk Limits (enforced by the bot)

These are configured in `.env` and enforced automatically. You don't need to check them — the bot will reject your signal with a `blocked` response if any limit is hit.

| Limit | Default | What happens |
|-------|---------|--------------|
| Daily loss limit | $150 | Halts trading for the day |
| Weekly loss limit | $400 | Halts trading for the week |
| Max consecutive losses | 3 | Halts trading for the day |
| Max trades per day | 3 | Rejects new signals after N trades |
| Max drawdown | 15% | Halts trading (manual resume required) |
| Daily profit target | $700 | Halts trading (goal reached) |

---

## Telegram Commands (for the human operator)

The human can control the bot remotely via Telegram:

| Command | Effect |
|---------|--------|
| `/status` | Current bot state |
| `/pause` | Stop accepting new signals |
| `/resume` | Resume from pause |
| `/forceresume` | Force resume from any halt |
| `/halt` | Emergency halt |
| `/flatten` | Close position immediately |
| `/positions` | Show open positions |
| `/balance` | Show account balance |
| `/report` | Today's performance |

---

## Contract Specifications

| Symbol | Tick Size | Tick Value | Point Value | Description |
|--------|-----------|------------|-------------|-------------|
| MNQ | 0.25 | $0.50 | $2 | Micro E-mini Nasdaq-100 |
| MES | 0.25 | $1.25 | $5 | Micro E-mini S&P 500 |
| MYM | 1.0 | $0.50 | $0.50 | Micro Dow Jones |
| M2K | 0.10 | $0.50 | $5 | Micro E-mini Russell 2000 |
| MGC | 0.10 | $1.00 | $10 | Micro Gold |

**Risk per contract example (MNQ):**
- 10-point stop = 40 ticks = $20 risk per contract
- If `RISK_PER_TRADE_MAX=60`, bot sizes to 3 contracts ($20 × 3 = $60)

---

## Common Patterns for AI Signal Generators

### Pattern 1: Send and forget
```bash
python scripts/signal_cli.py send --symbol MNQ --type long --price 19500.00 --stop 19490.00 --target 19520.00 --qty 1
```
Send the signal. The bot handles everything else. Check `status` later to see if it's still in a position.

### Pattern 2: Check before sending
```bash
# Check if bot can accept a signal
python scripts/signal_cli.py status

# If "openPositions": 0 and "halted": false and "tradesToday" < "maxTrades", send it
python scripts/signal_cli.py send --symbol MNQ --type long --price 19500.00 --stop 19490.00 --qty 1
```

### Pattern 3: Emergency exit
```bash
# Close everything immediately
python scripts/signal_cli.py flatten
```

### Pattern 4: Retry on network error
```bash
# If the first request times out, retry with the SAME signalId
python scripts/signal_cli.py send --symbol MNQ --type long --price 19500.00 --stop 19490.00 --signal-id sig-001
# If first one actually went through, the retry returns "duplicate": true (safe)
```

---

## What NOT to Do

1. **Don't send signals too fast** — the bot only holds one position at a time. Wait for the current position to close before sending another.
2. **Don't reuse signalId for different trades** — each unique trade needs a unique ID.
3. **Don't send prices that aren't tick-aligned** — they will be rejected. Round to the nearest tick.
4. **Don't send stops on the wrong side** — long stop below entry, short stop above entry. Always.
5. **Don't try to connect from another machine** — the server binds to `127.0.0.1` only. You must be on the same host.
6. **Don't put the token in the URL** — use the `X-Signal-Token` header.
7. **Don't assume a signal was executed just because it was accepted** — "accepted" means the order was submitted. Check `status` or `positions` to confirm the fill.

---

## File Structure

```
ClawdTraderAgent/
├── .env                          # Your credentials + webhook token
├── .env.example                  # Template
├── config/contracts.json         # Contract specifications (tick sizes, point values)
├── scripts/
│   ├── signal_cli.py             # Python CLI for sending signals
│   └── signal_cli.js             # Node.js CLI for sending signals
├── src/
│   ├── index.js                  # Entry point (npm start)
│   ├── api/
│   │   ├── auth.js               # Tradovate authentication
│   │   ├── client.js             # Tradovate REST API client
│   │   ├── webhook_server.js     # HTTP webhook server (port 8787)
│   │   └── websocket.js          # Tradovate order WebSocket
│   ├── bot/
│   │   ├── ExecutionBot.js       # Main orchestrator
│   │   ├── SignalHandler.js      # Signal → entry order
│   │   └── PositionHandler.js    # Fill → P&L → OCO bracket
│   ├── risk/
│   │   ├── manager.js            # Position sizing
│   │   └── loss_limits.js        # Daily/weekly loss limits
│   ├── filters/session_filter.js # Trading session hours
│   ├── orders/order_manager.js   # Order tracking
│   ├── analytics/performance.js  # Trade history + stats
│   └── utils/
│       ├── notifications.js      # Telegram notifications
│       ├── TelegramCommandHandler.js  # Telegram commands
│       ├── market_hours.js       # Market open/close
│       ├── logger.js             # Logging
│       └── ...                   # Other utilities
└── tests/test_webhook.js         # Validation tests
```

---

## Quick Reference

| What | How |
|------|-----|
| Start the bot | `npm start` |
| Send a signal | `python scripts/signal_cli.py send --symbol MNQ --type long --price 19500.00 --stop 19490.00` |
| Check status | `python scripts/signal_cli.py status` |
| Check positions | `python scripts/signal_cli.py positions` |
| Emergency close | `python scripts/signal_cli.py flatten` |
| Run tests | `npm test` |

---

## Questions

**Can I send a signal without a target?**
Yes. If you omit `targetPrice`, the bot calculates it from `PROFIT_TARGET_R` (default: 2.5× the stop distance from entry).

**Can I send a signal without a quantity?**
Yes. If you omit `quantity`, the bot calculates it from `RISK_PER_TRADE_MAX` and the stop distance.

**What if the bot is already in a position?**
Your signal is rejected with `blocked: true, reason: "blocked: already in position"`. Wait for the position to close (check with `status`).

**What if the bot is halted?**
Your signal is rejected with `blocked: true, reason: "blocked: <halt reason>"`. The bot resumes automatically at the next daily reset (6:30 AM PST), or the human can `/forceresume` via Telegram.

**What happens if the bot crashes mid-trade?**
On restart, it re-adopts any existing position and bracket orders from the broker. The position is never lost — it lives at the broker level.

**Can I send limit orders?**
Yes. Set `"orderType": "limit"` or `--order-type limit`. The `price` field becomes the limit price. If the order doesn't fill within 180 seconds, the bot cancels it and clears state.

**What's the difference between "rejected" and "blocked"?**
- **Rejected (HTTP 400)**: Your signal was invalid (bad prices, wrong stop side, unknown symbol). Fix and resend with a new `signalId`.
- **Blocked (HTTP 200)**: Your signal was valid but the bot can't trade right now (paused, halted, max trades, already in position). Don't retry immediately — check `status` first.
