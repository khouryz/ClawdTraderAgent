# ClawdTraderAgent — Execution-Only Webhook Bot

A minimal, execution-only trading bot that accepts fully-specified trade signals via HTTP webhook and executes them through the **Tradovate** API. No internal strategies, no market data feed, no indicators — just signal intake, validation, and order execution.

## Architecture

```
External Signal Generator
        │
        ▼
   POST /signal (HTTP, loopback-only, token-auth)
        │
        ▼
  WebhookServer ── validates ──▶ ExecutionBot.executeSignal()
        │                              │
        │                              ├── Guards (pause, halt, cutoff, max trades)
        │                              ├── SignalHandler (risk, sizing, entry order)
        │                              ├── Tradovate API (market/limit entry)
        │                              ├── Order WebSocket (fill events)
        │                              ├── PositionHandler (P&L, OCO bracket)
        │                              └── Telegram notifications
        │
        ▼
   Tradovate API
```

## Prerequisites

| Service | Purpose |
|---------|---------|
| **Tradovate** | Order execution & account management |
| **Telegram** (optional) | Trade notifications & remote commands |

- **Node.js** 18+
- No Python required

## Setup

### 1. Install

```bash
git clone <repo-url>
cd ClawdTraderAgent
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env` with your Tradovate credentials, Telegram bot token, and webhook token.

**Generate a webhook token** (must be ≥32 chars):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3. Run

```bash
npm start
```

The bot will:
1. Authenticate with Tradovate.
2. Connect the order WebSocket.
3. Re-adopt any existing position + bracket orders.
4. Start the webhook server on `127.0.0.1:WEBHOOK_PORT`.
5. Start Telegram command polling.
6. Begin the session manager (daily reset + EOD flatten).

## Webhook API

All endpoints require `X-Signal-Token` header matching `WEBHOOK_TOKEN`.

### `POST /signal` — Submit a trade signal

```json
{
  "signalId": "unique-id-123",
  "symbol": "MNQ",
  "type": "long",
  "orderType": "market",
  "price": 19500.00,
  "stopLoss": 19490.00,
  "targetPrice": 19520.00,
  "quantity": 1
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `signalId` | yes | Unique ID for deduplication (string, ≤64 chars) |
| `symbol` | yes | Contract symbol from `config/contracts.json` (MNQ, MES, MYM, etc.) |
| `type` | yes | `"long"` or `"short"` (also accepts `"buy"`/`"sell"`) |
| `price` | yes | Entry reference price (must be tick-aligned) |
| `stopLoss` | yes | Stop loss price (must be on correct side, tick-aligned) |
| `targetPrice` | no | Target price (if omitted, calculated from `PROFIT_TARGET_R`) |
| `orderType` | no | `"market"` (default) or `"limit"` |
| `quantity` | no | Number of contracts (if omitted, calculated from risk) |

**Validation rules:**
- Stop must be below entry for longs, above for shorts.
- Target must be above entry for longs, below for shorts.
- All prices must be tick-aligned (multiples of `tickSize`).
- Stop distance ≤ `MAX_WEBHOOK_STOP_TICKS` ticks.
- Quantity ≤ `MAX_WEBHOOK_QTY`.
- Duplicate `signalId` within `WEBHOOK_DEDUP_MS` returns cached result (idempotent).

**Response:**
```json
{ "accepted": true, "signalId": "...", "status": "submitted", "orderId": 12345 }
```

Rejected signals return `400` with `{ "accepted": false, "reason": "..." }`.
Blocked signals (paused/halted) return `200` with `{ "accepted": false, "blocked": true, "reason": "..." }`.

### `GET /status` — Bot status

Returns current bot state: paused, halted, trades today, P&L, position info.

### `GET /positions` — Open positions

Returns current positions and working orders for the configured contract.

### `POST /flatten` — Close position immediately

Cancels all working orders and closes the open position with a market order.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Show help |
| `/pause` | Pause trading (no new entries) |
| `/resume` | Resume from pause |
| `/forceresume` | Force resume from any halt |
| `/halt` | Emergency halt (stops until tomorrow) |
| `/flatten` | Close open position now |
| `/status` | Current bot state |
| `/positions` | Open positions + orders |
| `/balance` | Account balance |
| `/report` | Today's performance |

## Risk Management

- **Daily loss limit** — halts trading when reached.
- **Weekly loss limit** — halts trading when reached.
- **Max consecutive losses** — halts after N losses in a row.
- **Max trades per day** — rejects signals after N trades.
- **Entry cutoff** — no new entries past `LAST_ENTRY_HOUR:LAST_ENTRY_MINUTE` PST.
- **EOD flatten** — force-closes positions 5 min before session end.
- **OCO bracket** — stop + target placed automatically after entry fill.
- **Emergency close** — if OCO placement fails, naked position is closed immediately.

## Testing

```bash
node tests/test_webhook.js
```

Tests cover: auth, malformed JSON, inverted stops, unknown symbols, quantity limits, tick alignment, stop distance, deduplication, paused/halted rejection, valid signal execution, and all HTTP endpoints.

## Configuration

See `.env.example` for all environment variables. Key settings:

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_ENABLED` | `true` | Enable webhook server |
| `WEBHOOK_PORT` | `8787` | HTTP port (loopback only) |
| `WEBHOOK_TOKEN` | required | Auth token (≥32 chars) |
| `MAX_WEBHOOK_QTY` | `2` | Max contracts per signal |
| `MAX_WEBHOOK_STOP_TICKS` | `200` | Max stop distance in ticks |
| `WEBHOOK_DEDUP_MS` | `300000` | Dedup window (5 min) |
| `MAX_TRADES_PER_DAY` | `3` | Max entries per day |
| `DAILY_LOSS_LIMIT` | `150` | Daily loss limit in $ |
| `CONTRACT_SYMBOL` | required | Tradovate contract symbol |
