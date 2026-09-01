# Spec: Webhook signal intake (external analysis → existing execution engine)

## Goal

Turn this bot into **execution-only**. Its internal strategies stop generating
signals. Instead an external analysis process (a Claude Code session driving
TradingView via the `tradingview-mcp` server) posts a fully-specified trade
signal to a local webhook. The bot parses it and runs it through the **existing,
unchanged** pipeline: guards → `SignalHandler` → bracket order → trailing stop →
Telegram.

**Non-goal:** do not rebuild order placement, brackets, trailing, loss limits or
Telegram. All of that already works and stays exactly as-is. This is an intake
adapter, nothing more.

---

## The integration seam

`src/bot/TradovateBot.js` ~line 609:

```js
// Strategy will emit signals to signal handler
this.strategy.on('signal', (signal) => this._onSignal(signal));
this.strategy.initialize();
```

**The webhook becomes a second producer of that same event.** Do NOT call
`this.signalHandler.handleSignal()` directly from the webhook — that would skip
every guard in `_onSignal`:

- `_warmingUp` block
- `_pausedByUser` (this is what `/pause` and `/halt` set — inheriting it is the
  whole point)
- post-reconnect cooldown
- `DISABLE_THURSDAY`
- `_isPastEntryCutoff()`
- `positionHandler.resetFillAccumulators()`

Route webhook signals through `this._onSignal(signal)` so all of the above keeps
applying. External signals must not be able to bypass risk controls.

---

## 1. `EXECUTION_ONLY` mode

Add env flag `EXECUTION_ONLY=true`.

When set, in the strategy-init method (the one containing line ~609):
- **skip** strategy construction, `.on('signal')` wiring and `.initialize()`
- log clearly: `⚙️  EXECUTION_ONLY — internal strategies disabled, awaiting webhook signals`
- leave everything else untouched: client, auth, websockets, `signalHandler`,
  `positionHandler`, `riskManager`, `lossLimits`, `trailingStop`,
  `profitManager`, Telegram, EOD flatten

Guard against null `this.strategy` elsewhere. `_onSignal` already calls
`if (this.strategy) this.strategy.onSignalRejected()` in most paths — **audit
every `this.strategy.` reference** in the file and add the same guard where
missing. This is the most likely source of a crash.

---

## 2. Webhook server

New file: `src/api/webhook_server.js`

**No new dependencies.** Deps today are `axios`, `ws`, `dotenv`. Use the
built-in `node:http`. Do not add express.

### Binding

- Bind **`127.0.0.1` only**, never `0.0.0.0`. This must not be reachable off the
  machine.
- Port from `WEBHOOK_PORT`, default `8787`.
- If the analysis process runs on another host, the operator tunnels it (SSH /
  Tailscale). The server itself stays loopback.

### Auth

- Require header `X-Signal-Token` matching `WEBHOOK_TOKEN` from env.
- Compare with `crypto.timingSafeEqual` on equal-length buffers, not `===`.
- Missing/wrong token → `401`, log the attempt, do not process.
- Refuse to start if `WEBHOOK_TOKEN` is unset or shorter than 32 chars.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/signal` | submit a trade signal |
| GET | `/status` | bot state — see §6 |
| GET | `/positions` | open positions + working orders |
| POST | `/flatten` | close all (same path as the existing flatten) |

---

## 3. Signal payload

`POST /signal`, `Content-Type: application/json`.

These field names are what `SignalHandler` and `_onSignal` already read —
**verify against `src/bot/SignalHandler.js` before finalising**, and treat that
file as the source of truth if anything here disagrees.

```jsonc
{
  "signalId": "mnq-2026-09-02-A1-01",   // REQUIRED, unique — see §4
  "symbol": "MNQ",                       // REQUIRED, must match contracts.json
  "type": "long",                        // REQUIRED "long" | "short"
  "orderType": "market",                 // "market" | "limit"
  "price": 29232.00,                     // entry; required for limit
  "stopLoss": 29248.25,                  // REQUIRED, absolute price
  "targetPrice": 29094.50,               // T1, absolute price
  "quantity": 2,                         // optional; default from env

  "strategy": "level-reaction-A1",       // shows in logs + Telegram
  "confluenceScore": 4,                  // Four-Rules count that passed

  "moveStopToBE": true,
  "partialProfitEnabled": true,
  "partialProfitR": 1.0,

  "meta": {                              // free-form, log only, never executed
    "level": 29232.00,
    "signalBar": "2026-09-02T06:45:00-07:00",
    "rAtSignalBar": 4.6,
    "note": "A1 untested level, 5m sell setup"
  }
}
```

### Validation — reject with `400` and a reason on any failure

Reject, do not coerce:

1. `signalId` present, string, ≤64 chars
2. `symbol` exists in `config/contracts.json`
3. `type` is exactly `long` or `short`
4. `stopLoss` present and numeric
5. **Stop is on the correct side:** long → `stopLoss < price`; short →
   `stopLoss > price`. An inverted stop is the single most dangerous malformed
   payload — it turns a stop into a target.
6. **Target on the correct side** if present: long → `targetPrice > price`.
7. `quantity` is a positive integer, and `quantity <= MAX_WEBHOOK_QTY`
   (env, default 2). Hard ceiling regardless of what was sent.
8. **Stop distance sanity:** reject if `abs(price - stopLoss)` exceeds
   `MAX_WEBHOOK_STOP_TICKS` (env, default 200 ticks) — catches a decimal slip
   or a stale price.
9. All prices align to the contract's `tickSize` from `contracts.json`
   (MNQ = 0.25). Reject rather than round.

Every rejection: `400` + `{ accepted: false, reason: "..." }`, logged, and
sent to Telegram. A silently-dropped signal is worse than a loud rejection.

---

## 4. Idempotency — required, not optional

The sender may retry on a timeout. Without dedup that is a double position.

- Keep an in-memory `Map` of `signalId → { at, result }`.
- On a repeat `signalId` within `WEBHOOK_DEDUP_MS` (env, default 300000 = 5 min),
  return `200` with the **original stored result** and `duplicate: true`.
  Do not place a second order.
- Evict entries older than the window.
- Log every duplicate hit — a spike means the sender has a retry bug.

---

## 5. Confirmation gate (recommended, default ON)

Env `WEBHOOK_REQUIRE_CONFIRM` (default `true`).

When on, a valid signal is **not** executed immediately:
1. Store as pending with a short id.
2. Send a Telegram message with the full trade — direction, symbol, entry,
   stop, target, quantity, dollar risk computed from `contracts.json`
   `pointValue`, plus `strategy` and `meta.note`.
3. Wait for `/approve <id>` or `/reject <id>` via the existing
   `TelegramCommandHandler`.
4. Expire unapproved signals after `WEBHOOK_CONFIRM_TIMEOUT_MS`
   (default 180000 = 3 min) — a stale setup must not fire late. Notify on expiry.
5. On approval, call `this._onSignal(signal)`.

With `WEBHOOK_REQUIRE_CONFIRM=false`, execute straight away. The flag exists so
the gate can be dropped once the external signal source has a track record —
start with it on.

---

## 6. Responses

`POST /signal` — always JSON, never an empty body:

```jsonc
// accepted, executed
{ "accepted": true, "signalId": "...", "status": "submitted",
  "orderId": "...", "filledQty": 2, "avgPrice": 29231.75 }

// accepted, awaiting confirmation
{ "accepted": true, "signalId": "...", "status": "pending_confirmation",
  "confirmId": "a7f3" }

// rejected by validation
{ "accepted": false, "reason": "stopLoss 29248.25 is above entry 29232.00 for a long" }

// rejected by an existing guard — reason must say WHICH
{ "accepted": false, "reason": "blocked: past entry cutoff (13:05 PST > 12:30 PST)" }
{ "accepted": false, "reason": "blocked: paused by user" }
{ "accepted": false, "reason": "blocked: daily loss limit reached" }
```

`_onSignal` currently returns nothing and swallows its blocks into log lines.
**Refactor it to return a structured result** `{ accepted, reason }` so the
webhook can report accurately. Keep the existing logging.

`GET /status`:

```jsonc
{ "connected": true, "executionOnly": true, "paused": false,
  "tradesId": 1, "maxTrades": 3,
  "dailyPnl": -58.00, "lossLimitRemaining": 442.00,
  "openPositions": 1, "workingOrders": 2,
  "marketOpen": true, "pastEntryCutoff": false }
```

The external analysis process polls this before sending a signal, so it can
decline to send when the bot would reject anyway.

---

## 7. Halt behaviour

- `/halt` and `/pause` must block webhook signals. Routing through `_onSignal`
  gives this automatically — **verify with a test**, do not assume.
- Add `/halt` handling to the webhook: return `503` with
  `{ accepted: false, reason: "halted" }` while halted.
- Loss-limit breach must block webhook signals identically.

---

## 8. Wiring

In `TradovateBot`:
- Construct the webhook server after handlers are initialised, only when
  `WEBHOOK_ENABLED=true`.
- Pass it a reference to the bot (or a narrow façade exposing `_onSignal`,
  status getters and the Telegram sender). A narrow façade is preferable to
  handing over the whole bot.
- Shut it down cleanly in the existing shutdown path.
- Log the bound address and port on start; never log the token.

---

## 9. Env vars to add

```
EXECUTION_ONLY=true
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8787
WEBHOOK_TOKEN=<random 32+ chars>
WEBHOOK_REQUIRE_CONFIRM=true
WEBHOOK_CONFIRM_TIMEOUT_MS=180000
WEBHOOK_DEDUP_MS=300000
MAX_WEBHOOK_QTY=2
MAX_WEBHOOK_STOP_TICKS=200
```

Document them in the README next to the existing vars.

---

## 10. Tests

Add `tests/webhook.test.js` in the existing style:

1. Missing/invalid token → 401
2. Malformed JSON → 400
3. **Inverted stop (long with stopLoss above entry) → 400** — highest value test
4. Unknown symbol → 400
5. Quantity above `MAX_WEBHOOK_QTY` → 400
6. Price off the tick grid → 400
7. Stop distance above `MAX_WEBHOOK_STOP_TICKS` → 400
8. Duplicate `signalId` inside the window → 200, `duplicate: true`, **only one
   order placed** (assert on the mock)
9. Valid signal with `WEBHOOK_REQUIRE_CONFIRM=true` → `pending_confirmation`,
   no order placed until approve
10. Confirmation timeout → expires, no order, notification sent
11. `_pausedByUser = true` → rejected with a "paused" reason
12. `EXECUTION_ONLY=true` → bot starts, `this.strategy` is null, nothing crashes
13. Valid signal end-to-end against a mocked client → `placeBracketOrder`
    called once with the right side, qty, stop and target

Mock the Tradovate client. **No test should hit a broker endpoint.**

---

## 11. Manual verification before it is trusted

1. Start with `EXECUTION_ONLY=true`, `WEBHOOK_ENABLED=true`,
   `WEBHOOK_REQUIRE_CONFIRM=true`. Confirm no internal signals fire.
2. `curl` a valid signal → Telegram prompt arrives with correct dollar risk.
3. Reject it → no order.
4. Send again, approve → order placed with the correct bracket. Verify stop and
   target on the broker side, not just in the logs.
5. Send the same `signalId` twice → one position.
6. Send an inverted stop → 400, nothing placed.
7. `/pause`, then send → rejected.
8. Kill the webhook mid-flight → confirm no orphaned order.

---

## 12. Notes for the implementer

- **Do not modify** `order_manager.js`, `trailing_stop.js`, `profit_manager.js`,
  `loss_limits.js` or `SignalHandler.js` beyond the `_onSignal` return-value
  refactor in §6. They work; this is an intake adapter.
- The `meta` object is **log/notify only**. Nothing in it should ever influence
  execution — that keeps the sender from smuggling behaviour through it.
- `contracts.json` is the authority for tick size and point value.
  MNQ: `tickSize 0.25`, `tickValue 0.50`, `pointValue 2`. Compute displayed
  dollar risk from `pointValue`, not from a hardcoded number.
- Whether the account is demo or live is a **bot-side config decision** and
  stays entirely in the operator's hands. The webhook has no opinion and no
  knowledge of it — it just receives a signal.
- Keep the endpoint loopback-only. If it ever needs to be remote, that is a
  tunnel, not a bind-address change.

---

## 13. Open questions for the operator

1. Default `quantity` when the signal omits it — 2 is assumed (minimum for a
   trim plus a runner).
2. Should a webhook signal count against the existing `maxTrades` per day
   counter? Assumed **yes**.
3. Behaviour when a position is already open and a new signal arrives — reject,
   queue, or reverse? Assumed **reject** with a clear reason.
4. Should `/status` be pollable without the token, given it is loopback-only?
   Assumed **token required** for consistency.
