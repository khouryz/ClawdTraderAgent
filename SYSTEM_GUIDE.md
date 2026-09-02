# ClawdTraderAgent — System Guide for AI Signal Generators

This document is written for the AI that generates trade signals and sends them to this execution server. Read this fully before sending your first signal.

---

## What This Server Is

ClawdTraderAgent is an **execution-only bot**. It does not analyze markets, generate signals, fetch market data, or make trading decisions. It receives fully-specified trade signals from you (an external AI) and executes them through the Tradovate futures broker.

Your job: decide *what* to trade (symbol, direction, entry, stop, target, quantity, order type) and read the current market price off the chart.
This bot's job: validate it, place the order, manage the bracket, track P&L, enforce risk limits, and notify via Telegram.

**The bot makes zero market-data calls.** There is no quote feed, no bar subscription, no depth-of-book. Tradovate serves quotes over WebSocket only and this bot never connects one. Every price the bot acts on — entry, stop, target, and the reference price for side verification — arrives in the signal payload from you. You are the only price source.

---

## Architecture

```
You (AI Signal Generator, reading prices from the chart)
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
  ├── Tradovate API     → market/limit/stop entry order placed
  ├── Order WebSocket   → listens for fill events
  ├── PositionHandler   → on entry fill, places OCO bracket (stop + target)
  ├── Loss Limits       → tracks daily P&L, halts if limits breached
  ├── Session Manager   → daily reset, EOD force-close at session end
  └── Telegram          → entry/exit notifications, remote commands
```

---

## How to Send a Signal

### Option A: Use the Python CLI (recommended)

```bash
python scripts/signal_cli.py send \
  --symbol MNQ \
  --type long \
  --price 19500.00 \
  --stop 19490.00 \
  --target 19520.00 \
  --qty 1
```

For a break-of-signal-bar entry (resting stop order):

```bash
python scripts/signal_cli.py send \
  --symbol MNQ \
  --type long \
  --price 19510.00 \
  --stop 19490.00 \
  --qty 1 \
  --order-type stop \
  --ref-price 19500.00
```

The CLI auto-generates a `signalId` if you don't provide one. It reads `WEBHOOK_TOKEN` from the `.env` file automatically.

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

### Node.js CLI

`scripts/signal_cli.js` exists but is **not at parity** with the Python CLI. It supports `send` (market/limit only), `status`, `positions`, `flatten`, and `modify`. It does not support stop entries, `--ref-price`, `--entry-timeout`, `resume`, or `cancel-all`. Use the Python CLI for live trading.

---

## Signal Specification

### Required fields

| Field | Type | Description |
|-------|------|-------------|
| `signalId` | string | Unique ID for this signal (≤64 chars). Used for deduplication. |
| `symbol` | string | Contract symbol: `MNQ`, `MES`, `MYM`, `M2K`, or `MGC` |
| `type` | string | `"long"` or `"short"` (also accepts `"buy"`/`"sell"`) |
| `price` | number | Entry price. Must be tick-aligned. For stops, this is the trigger price. |
| `stopLoss` | number | Stop loss price. Must be on the correct side of entry. |

### Optional fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `targetPrice` | number | auto | Target price. If omitted, calculated from `PROFIT_TARGET_R × stop distance`. **Cannot be used with `exits`**. |
| `exits` | array | — | Multi-target exit legs: `[{ qty, targetPrice }, ...]` (1–4 legs). See below. |
| `moveStopToBEAfterFirstTarget` | boolean | `false` | Move remaining stop legs to breakeven after the first target fills. |
| `quantity` | integer | auto | Number of contracts. If omitted, calculated from `RISK_PER_TRADE_MAX`. **Required when `exits` is present.** |
| `orderType` | string | `"market"` | `"market"`, `"limit"`, or `"stop"`. See Order Types below. |
| `refPrice` | number | — | Current market price from the chart. **Required for stop entries.** See Order Types below. |
| `entryTimeoutSec` | integer | 180 (limit) / 900 (stop) | Seconds a resting limit/stop entry may work before it is auto-cancelled. Max 86400. |
| `signalId` | string | auto | Auto-generated if omitted. Provide your own for dedup control. |

### Order Types

#### `market` (default)
Immediate execution. The fill watchdog runs a 10-second timeout — if no fill arrives, the bot logs a warning and clears state. `price` is the reference price for risk calculation but the actual fill may differ.

#### `limit`
Resting order that fills at-or-better. `price` is the limit price. If the order doesn't fill within the timeout (default 180s, overridable via `entryTimeoutSec`), the bot cancels it and clears state. The fill watchdog does **not** run for limit entries — they are expected to rest.

#### `stop`
Resting order that triggers only when price trades through `price`. Use this for break-of-signal-bar entries — a limit order here would be wrong: a buy limit parked above the market fills instantly at the current (lower) price, entering before any break happened.

**`refPrice` is required for stop entries.** The bot uses it to verify the stop is on the correct side of the market:
- Buy stop must be **above** `refPrice`
- Sell stop must be **below** `refPrice`

A stop on the wrong side triggers on submission and silently degrades into an immediate market fill — the exact opposite of a break entry. Since the bot has no market-data feed, it cannot check this without your price. A stop entry without `refPrice` is rejected with HTTP 400.

The fill watchdog does **not** run for stop entries. The default timeout is 900 seconds (15 minutes), reflecting that a break setup can take several bars to trigger. Override per-signal with `entryTimeoutSec`.

### Explicit vs. computed targets

If you supply `targetPrice`, it is treated as a **level** — the bot preserves it even when the actual fill differs from the requested entry price. This matters when slippage occurs: a signal at 29137 with target 29147 and a fill at 29142 still uses 29147 as the target, not a recomputed value.

If you omit `targetPrice`, the bot computes one from the actual fill price: `fill ± (stop_distance × PROFIT_TARGET_R)`, where `PROFIT_TARGET_R` defaults to 2.5. The stop is also adjusted to maintain the original risk distance from the fill.

### Multi-target exits (`exits[]`)

For scaling out, provide an `exits` array instead of a single `targetPrice`. Each leg specifies a quantity and target price. The bot places one OCO per leg at the exchange, all sharing the same stop price. When a target fills, that leg's stop self-cancels via OCO linkage — no polling, survives bot crashes.

```jsonc
{
  "signalId": "mnq-001",
  "symbol": "MNQ",
  "type": "long",
  "price": 19500.00,
  "stopLoss": 19490.00,
  "quantity": 2,
  "exits": [
    { "qty": 1, "targetPrice": 19520.00 },
    { "qty": 1, "targetPrice": 19540.00 }
  ],
  "moveStopToBEAfterFirstTarget": true
}
```

**Rules:**
1. `exits` and `targetPrice` are mutually exclusive — pick one.
2. `quantity` is required when `exits` is present.
3. `sum(exits[].qty)` must exactly equal `quantity`.
4. Each `targetPrice` must be on the correct side (long: above entry, short: below).
5. Each `targetPrice` must be tick-aligned.
6. Targets must be **strictly ordered by distance from entry, nearest first**: long → ascending, short → descending. No duplicates.
7. 1–4 legs maximum.
8. `quantity` still bounded by `MAX_WEBHOOK_QTY`.

**Partial-failure handling:** If any leg fails to place, all successfully-placed legs are cancelled and a single OCO for the full quantity is placed at the nearest target. If that also fails, the position is emergency market-closed.

**Breakeven move:** When `moveStopToBEAfterFirstTarget` is true and the first target fills, the bot calls `modifyOrder` on each remaining stop leg to move it to the entry fill price. If a modify is rejected, the original stop stays in place — the bot never cancels a stop to replace it.

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
7. **refPrice required for stops**: A stop entry without `refPrice` is rejected. `refPrice` must be a positive number.
8. **entryTimeoutSec**: If provided, must be a positive integer ≤ 86400.
9. **Exits validation**: See multi-target exits rules above.

### Guards (signals that fail these return 200 with `blocked: true`)

These are not validation errors — they mean the bot is in a state where it cannot trade:

1. **Paused**: User sent `/pause` via Telegram. Resume with `/resume`.
2. **Halted**: Loss limit hit (daily loss, weekly loss, consecutive losses, max drawdown). Resumes next day or via `/resume` endpoint or `/forceresume` via Telegram.
3. **Past entry cutoff**: Past `LAST_ENTRY_HOUR:LAST_ENTRY_MINUTE` PST (default: 12:30 PST).
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

### If accepted (market entry):

1. **Entry order placed** — market order sent to Tradovate immediately.
2. **Fill arrives** — via WebSocket (usually <1 second). The 10-second fill watchdog monitors for this.
3. **OCO bracket placed** — stop loss + target profit orders placed automatically after entry fill. Stop and target are adjusted to the actual fill price (unless `targetPrice` was explicit — then it is preserved).
4. **Telegram notification** — entry notification with the real fill price, stop, target, and risk.
5. **Position is open** — the bot monitors for the exit fill (stop hit or target hit).
6. **Exit fill arrives** — OCO bracket triggers, position closes.
7. **P&L recorded** — performance tracker and loss limits updated.
8. **Telegram notification** — exit notification with P&L, R-multiple, and exit reason.
9. **Ready for next signal** — bot clears position state and can accept new signals.

### If accepted (limit/stop entry):

1. **Entry order placed** — resting order sent to Tradovate. Bot state records the position from this moment, but the broker is still flat.
2. **Order rests** — waits until filled or until `entryTimeoutSec` expires (default 180s for limit, 900s for stop). The fill watchdog does **not** run — resting orders are expected to wait.
3. **If filled** — same as market entry from step 2 above.
4. **If timeout expires** — bot cancels the order and clears state. No position was opened.
5. **If `/flatten` is called while resting** — the bot checks the broker position first. If the broker is flat (entry never filled), it cancels the working entry order instead of sending a market close. This prevents opening a reversed position.

### If OCO placement fails (rare):

The bot emergency-closes the naked position with a market order and sends a critical Telegram alert. This prevents an unprotected position from running.

### At end of day (12:55 PM PST):

The session manager force-closes any open position and cancels all working orders. A daily report is sent via Telegram.

### On bot restart with an existing position:

The bot re-adopts the position and its existing bracket orders from the broker. It fetches working orders and their order versions (to get `orderType`, `stopPrice`, `price`, `orderQty`), classifies stops and targets, pairs them via OCO linkage, and rebuilds internal bracket-leg state. No manual intervention needed.

---

## Deduplication

If you send the same `signalId` twice within 5 minutes (`WEBHOOK_DEDUP_MS`), the second request returns the cached result from the first — it does NOT place a second order. This makes retries safe.

**Rule**: Generate a unique `signalId` for each distinct trade signal. Reuse the same ID only when retrying a failed/dropped request for the same signal.

---

## All Endpoints

### `POST /signal`
Send a trade signal. See Signal Specification above.

### `GET /status`
Returns the current bot state:
```json
{
  "connected": true,
  "executionOnly": true,
  "paused": false,
  "halted": false,
  "haltReason": null,
  "tradesToday": 0,
  "maxTrades": 3,
  "dailyPnl": 0,
  "lossLimitRemaining": 300,
  "openPositions": 0,
  "positionSide": null,
  "positionQty": 0,
  "positionEntry": null,
  "positionStop": null,
  "positionTarget": null,
  "marketOpen": true,
  "pastEntryCutoff": true,
  "entryCutoffPST": "12:30",
  "eodFlattenPST": "12:55"
}
```

### `GET /positions`
Returns broker truth and bot-tracked state, separated:
```json
{
  "positions": [...],
  "workingOrders": [
    {
      "id": 12345,
      "ocoId": 67890,
      "action": "Sell",
      "ordStatus": "Working",
      "orderType": "Stop",
      "stopPrice": 19490.00,
      "price": null,
      "orderQty": 1,
      "contractId": 4399654,
      "accountId": 39938961
    }
  ],
  "bracketLegs": [
    {
      "legIndex": 0,
      "orderId": 12345,
      "ocoId": 67890,
      "qty": 1,
      "targetPrice": 19520.00,
      "stopPrice": 19490.00
    }
  ]
}
```

`workingOrders` is broker truth (from `/order/list` enriched with `/orderVersion/list`). `bracketLegs` is the bot's internal tracking state. Comparing the two detects drift.

### `POST /flatten`
Closes the current position. If the broker is flat (e.g. a resting entry never filled), cancels the working entry order instead of sending a market close. Returns:
```json
{ "flattened": true, "orderId": 12345 }
```
Or if a resting entry was cancelled:
```json
{ "flattened": true, "cancelledEntry": true, "orderId": 12345 }
```

### `POST /resume`
Clears a halt so signals are accepted again. Also clears a user pause. Returns:
```json
{ "resumed": true, "clearedHalt": "WEBSOCKET_DEAD", "halted": false }
```
If not halted:
```json
{ "resumed": false, "reason": "not halted", "halted": false }
```

### `POST /cancel-all`
Cancels every working order. **Refuses with HTTP 409 if a position is open** — the working orders on a live position ARE its stop and target, and cancelling them would leave it naked. Override with `{ "force": true }`:
```json
{ "cancelled": true, "cancelledCount": 2, "total": 2, "failed": 0 }
```
If refused:
```json
{ "cancelled": false, "refused": true, "reason": "position open at broker (netPos 2) — ...", "netPos": 2 }
```

### `POST /modify`
Modifies a working order's price or quantity. Requires `orderId` (number) and at least one of:
- `stopPrice` (number) — new stop trigger price
- `price` (number) — new limit price
- `orderQty` (positive integer) — new quantity

```json
{ "orderId": 12345, "stopPrice": 19500.00 }
```
Returns:
```json
{ "modified": true, "orderId": 12345 }
```

---

## CLI Commands (Python)

```bash
# Check if bot is running, halted, paused, how many trades today
python scripts/signal_cli.py status

# Check open positions and working orders (with broker-provided prices)
python scripts/signal_cli.py positions

# Emergency close all positions (cancels resting entry if flat)
python scripts/signal_cli.py flatten

# Clear a halt so signals are accepted again
python scripts/signal_cli.py resume

# Cancel all working orders (refuses if position open, unless --force)
python scripts/signal_cli.py cancel-all
python scripts/signal_cli.py cancel-all --force

# Modify a working order
python scripts/signal_cli.py modify --order-id 12345 --stop-price 19500.00
python scripts/signal_cli.py modify --order-id 12345 --price 19520.00 --qty 2
```

### Send command flags

| Flag | Required | Description |
|------|----------|-------------|
| `--symbol` | yes | Contract symbol (MNQ, MES, MYM, M2K, MGC) |
| `--type` | yes | `long` or `short` |
| `--price` | yes | Entry price (tick-aligned). For stops, the trigger price. |
| `--stop` | yes | Stop loss price |
| `--target` | no | Target price (auto-calculated if omitted) |
| `--qty` | no | Quantity (auto-calculated from risk if omitted) |
| `--order-type` | no | `market` (default), `limit`, or `stop` |
| `--ref-price` | **required for stop** | Current market price from the chart |
| `--entry-timeout` | no | Seconds before resting entry is cancelled (default 180 limit, 900 stop) |
| `--signal-id` | no | Unique ID (auto-generated if omitted) |
| `--exits` | no | Multi-target: `"qty1@price1,qty2@price2"` |
| `--move-be` | no | Move remaining stops to breakeven after first target fills |

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

### Pattern 1: Send and forget (market entry)
```bash
python scripts/signal_cli.py send --symbol MNQ --type long --price 19500.00 --stop 19490.00 --target 19520.00 --qty 1
```

### Pattern 2: Break-of-signal-bar entry (stop order)
```bash
# Read the current price off the chart, pass it as --ref-price
python scripts/signal_cli.py send --symbol MNQ --type long --price 19510.00 --stop 19490.00 --qty 1 --order-type stop --ref-price 19500.00
```

### Pattern 3: Check before sending
```bash
# Check if bot can accept a signal
python scripts/signal_cli.py status

# If "openPositions": 0 and "halted": false and "tradesToday" < "maxTrades", send it
python scripts/signal_cli.py send --symbol MNQ --type long --price 19500.00 --stop 19490.00 --qty 1
```

### Pattern 4: Emergency exit
```bash
python scripts/signal_cli.py flatten
```

### Pattern 5: Retry on network error
```bash
# If the first request times out, retry with the SAME signalId
python scripts/signal_cli.py send --symbol MNQ --type long --price 19500.00 --stop 19490.00 --signal-id sig-001
# If first one actually went through, the retry returns "duplicate": true (safe)
```

### Pattern 6: Clear a halt
```bash
python scripts/signal_cli.py resume
```

### Pattern 7: Cancel orphaned working orders
```bash
# Refuses if a position is open (the orders are its protection)
python scripts/signal_cli.py cancel-all

# Force-cancel even with a position open — strips its stop and target
python scripts/signal_cli.py cancel-all --force
```

---

## What NOT to Do

1. **Don't send signals too fast** — the bot only holds one position at a time. Wait for the current position to close before sending another.
2. **Don't reuse signalId for different trades** — each unique trade needs a unique ID.
3. **Don't send prices that aren't tick-aligned** — they will be rejected. Round to the nearest tick.
4. **Don't send stops on the wrong side** — long stop below entry, short stop above entry. Always.
5. **Don't send a stop entry without `refPrice`** — it will be rejected with 400. The bot has no market-data feed and cannot verify the stop side without your price.
6. **Don't send a stop on the wrong side of the market** — a buy stop below the current price triggers instantly and becomes a market fill. The bot checks this against `refPrice` and rejects it.
7. **Don't try to connect from another machine** — the server binds to `127.0.0.1` only. You must be on the same host.
8. **Don't put the token in the URL** — use the `X-Signal-Token` header.
9. **Don't assume a signal was executed just because it was accepted** — "accepted" means the order was submitted. Check `status` or `positions` to confirm the fill.
10. **Don't use `cancel-all --force` on a live position** — it strips the stop and target, leaving the position naked. Use `flatten` to exit instead.

---

## Entry Cutoff and EOD Flatten

The bot accepts signals until **12:30 PM PST** (`LAST_ENTRY_HOUR`/`LAST_ENTRY_MINUTE`) and force-closes any open position at **12:55 PM PST** (session end − 5 min). These values are surfaced in `GET /status` as `entryCutoffPST` and `eodFlattenPST`.

On startup, the bot asserts that the entry cutoff is at least 15 minutes before the EOD flatten time. If not, it refuses to start — a misconfiguration here silently wastes signals.

---

## Resting Entry Timeouts

Limit and stop entries are resting orders — they may not fill immediately. The bot auto-cancels them after a timeout to avoid stale orders:

| Order type | Default timeout | Env override |
|------------|----------------|--------------|
| Limit | 180 seconds | `LIMIT_ENTRY_TIMEOUT_SEC` |
| Stop | 900 seconds | `STOP_ENTRY_TIMEOUT_SEC` |

Override per-signal with `entryTimeoutSec` in the payload or `--entry-timeout` on the CLI. The fill watchdog (10-second timeout) runs **only** for market entries — it never fires on resting orders, which are expected to wait.

---

## Trailing Stops: Intentionally Not Implemented

`trailing_stop.js` and `profit_manager.js` were removed in the execution-only pivot. This was a deliberate decision based on live session data (1 Sep 2026 MNQ), where static brackets outperformed trim-plus-trail on both winning trades. In-process trailing also loses its state on a crash, whereas exchange-resident OCO legs do not.

Scaling out is now available through the `exits[]` field without any trailing engine. If a future requirement genuinely needs a dynamic trail, it should be implemented as `modifyOrder` calls driven by fill events — not as a polling module holding its own position state.

This decision should be revisited only with more live data, and the data should be recorded. The R-multiple comparison behind this decision is documented in `WEBHOOK_SPEC_ADDENDUM.md`.

---

## File Structure

```
ClawdTraderAgent/
├── .env                          # Credentials + webhook token (gitignored)
├── .env.example                  # Template
├── config/contracts.json         # Contract specifications (tick sizes, point values)
├── scripts/
│   ├── signal_cli.py             # Python CLI (full feature parity)
│   └── signal_cli.js             # Node.js CLI (limited — not at parity)
├── src/
│   ├── index.js                  # Entry point (npm start) — graceful shutdown + crash alerts
│   ├── api/
│   │   ├── auth.js               # Tradovate authentication
│   │   ├── client.js             # Tradovate REST API client
│   │   ├── webhook_server.js     # HTTP webhook server (port 8787)
│   │   └── websocket.js          # Tradovate order WebSocket
│   ├── bot/
│   │   ├── ExecutionBot.js       # Main orchestrator
│   │   ├── SignalHandler.js      # Signal → entry order (market/limit/stop)
│   │   └── PositionHandler.js    # Fill → OCO bracket, explicit target preservation
│   ├── risk/
│   │   ├── manager.js            # Position sizing
│   │   └── loss_limits.js        # Daily/weekly loss limits
│   ├── filters/session_filter.js # Trading session hours
│   ├── orders/order_manager.js   # Order tracking
│   ├── analytics/performance.js  # Trade history + stats
│   └── utils/
│       ├── notifications.js      # Telegram notifications
│       ├── TelegramCommandHandler.js  # Telegram commands
│       ├── market_hours.js       # Market open/close (time-based, no data feed)
│       ├── config_validator.js   # Config validation + sanitization
│       ├── logger.js             # Logging
│       └── ...                   # Other utilities
├── tests/test_webhook.js         # 53 tests — validation, stop entries, refPrice, flatten, resume, cancel-all
├── SYSTEM_GUIDE.md               # This document
└── WEBHOOK_SPEC_ADDENDUM.md      # Design rationale: multi-leg OCO, cutoff fix, trailing-stop decision
```

---

## Quick Reference

| What | How |
|------|-----|
| Start the bot | `npm start` |
| Send a market signal | `python scripts/signal_cli.py send --symbol MNQ --type long --price 19500.00 --stop 19490.00` |
| Send a stop entry | `python scripts/signal_cli.py send --symbol MNQ --type long --price 19510.00 --stop 19490.00 --order-type stop --ref-price 19500.00` |
| Check status | `python scripts/signal_cli.py status` |
| Check positions | `python scripts/signal_cli.py positions` |
| Emergency close | `python scripts/signal_cli.py flatten` |
| Clear a halt | `python scripts/signal_cli.py resume` |
| Cancel working orders | `python scripts/signal_cli.py cancel-all` |
| Modify an order | `python scripts/signal_cli.py modify --order-id 12345 --stop-price 19500.00` |
| Run tests | `npm test` |

---

## Questions

**Can I send a signal without a target?**
Yes. If you omit `targetPrice`, the bot calculates it from `PROFIT_TARGET_R` (default: 2.5× the stop distance from the fill price).

**Can I send a signal without a quantity?**
Yes. If you omit `quantity`, the bot calculates it from `RISK_PER_TRADE_MAX` and the stop distance.

**What if the bot is already in a position?**
Your signal is rejected with `blocked: true, reason: "blocked: already in position"`. Wait for the position to close (check with `status`).

**What if the bot is halted?**
Your signal is rejected with `blocked: true, reason: "blocked: <halt reason>"`. The bot resumes automatically at the next daily reset (6:30 AM PST), or you can clear it with `POST /resume` or the human can `/forceresume` via Telegram.

**What happens if the bot crashes mid-trade?**
On restart, it re-adopts any existing position and bracket orders from the broker. The position is never lost — it lives at the broker level.

**Can I send limit orders?**
Yes. Set `"orderType": "limit"` or `--order-type limit`. The `price` field becomes the limit price. If the order doesn't fill within the timeout (default 180s), the bot cancels it and clears state.

**Can I send stop orders?**
Yes. Set `"orderType": "stop"` or `--order-type stop`. The `price` field is the trigger price. You must also supply `refPrice` (the current market price from the chart) so the bot can verify the stop is on the correct side. A buy stop must be above the market, a sell stop below it. If the stop is on the wrong side, it is rejected — it would trigger immediately and become an unintended market fill.

**Why is `refPrice` required for stops but not for market/limit?**
A stop on the wrong side of the market triggers on submission and silently becomes a market fill — the opposite of a break entry. The bot has no market-data feed (Tradovate quotes are WebSocket-only and this bot doesn't connect one), so it cannot check the side without your price. Market and limit entries don't have this problem: a market order fills regardless, and a limit on the wrong side fills immediately at-or-better, which is at worst an early entry, not a reversal.

**What's the difference between "rejected" and "blocked"?**
- **Rejected (HTTP 400)**: Your signal was invalid (bad prices, wrong stop side, unknown symbol, stop without refPrice). Fix and resend with a new `signalId`.
- **Blocked (HTTP 200)**: Your signal was valid but the bot can't trade right now (paused, halted, max trades, already in position). Don't retry immediately — check `status` first.

**What happens if I call `/flatten` on a resting entry that never filled?**
The bot checks the broker position first. If the broker is flat, it cancels the working entry order instead of sending a market close. This prevents opening a reversed position — the old behavior would have "closed" a position that didn't exist, effectively opening a new one in the opposite direction while the original entry order kept working.

**Does the bot fetch any market data?**
No. The bot makes zero market-data calls. `getQuote`, `getBars`, and related methods exist in `client.js` but have no callers. Every price the bot acts on comes from the signal payload. Fill prices come from the order WebSocket as execution facts, not market data.
