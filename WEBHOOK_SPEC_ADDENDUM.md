# Addendum to WEBHOOK_SIGNAL_SPEC — multi-target exits, cutoff fix, no trailing

Follows the execution-only webhook build. Three changes. Items 1 and 2 are code;
item 3 is a decision to record so it does not get undone later.

The confirmation gate is being handled separately by the operator — **do not
implement it here.**

---

## 1. Multi-target exits via split OCOs

### Why

`client.js placeOCO()` builds one Stop order with a single `other` Limit leg —
one stop, one target, whole quantity. `/order/placeoco` accepts exactly one
`other`, so a single OCO cannot carry two targets.

To scale out, **place one OCO per exit leg, all sharing the same stop price.**
When the nearer target fills, that leg's stop cancels itself via the OCO
linkage; the remaining leg keeps its own stop and target. This reproduces
trim-plus-runner **at the exchange** — no polling, no in-process state, and it
survives a bot crash because the exits live at the broker.

### Signal payload — new optional field

```jsonc
{
  "signalId": "mnq-2026-09-02-A1-01",
  "symbol": "MNQ",
  "type": "short",
  "orderType": "market",
  "price": 29232.00,
  "stopLoss": 29248.25,
  "quantity": 2,

  "exits": [
    { "qty": 1, "targetPrice": 29094.50 },
    { "qty": 1, "targetPrice": 29012.25 }
  ],

  "moveStopToBEAfterFirstTarget": true
}
```

**Backwards compatible.** If `exits` is absent, behaviour is exactly as today:
one OCO for the full quantity using `targetPrice`. Do not change the existing
path.

### Validation — reject with 400

1. `exits` is an array of 1–4 objects, each `{ qty: int > 0, targetPrice: number }`.
2. `sum(exits[].qty)` **must equal** `quantity`. Not less, not more.
3. Every `targetPrice` obeys the existing side rule — long above entry, short below.
4. Every `targetPrice` is tick-aligned for the contract.
5. Targets must be **strictly ordered by distance from entry**, nearest first:
   long → strictly ascending; short → strictly descending. Reject duplicates.
6. `exits` and a top-level `targetPrice` together → reject. Pick one.
7. `quantity` still bounded by `MAX_WEBHOOK_QTY`.

### Placement — `ExecutionBot.js` around line 375

Replace the single `placeOCO` call with a loop over the legs. All legs share
`stopPrice`; each gets its own `targetPrice` and `qty`.

Track every returned `{ orderId, ocoId }` in a list on the position record —
the current code stores one pair and that is no longer sufficient.

**Partial-failure handling is the critical part.** Legs are placed
sequentially and any one can be rejected:

- If leg 1 succeeds and leg 2 is rejected, the position is **partially
  unprotected** — 1 contract has a stop, 1 does not.
- On any leg failure: cancel all successfully-placed legs, then fall back to a
  **single OCO for the full remaining quantity** using the *nearest* target.
- If that fallback also fails, use the existing emergency market-close path and
  fire the critical Telegram alert. Never leave a naked position.

Log each leg placement individually so a partial failure is visible in the log,
not just in the aggregate result.

### Move stop to breakeven after the first target

When `moveStopToBEAfterFirstTarget` is true and the first target fills:

- Call `client.modifyOrder(remainingStopOrderId, {...})` for each remaining leg's
  stop, setting `stopPrice` to the actual entry fill price.
- `modifyOrder` is a **full replace** — it requires `orderType` and `orderQty`
  alongside the price or Tradovate 400s. Pass `tickSize` from
  `contracts.json` so rounding lands on the contract's grid (M2K is 0.10, not 0.25).
- If the modify is rejected, log it, notify, and **leave the original stop in
  place**. A stop at the original level is correct-but-suboptimal; no stop is a
  disaster. Never cancel-then-replace.

### Other call sites to update

- **EOD flatten** — must cancel *all* bracket legs, not one.
- **`/flatten`** — same.
- **Position re-adoption on restart** — the broker will return multiple working
  orders for one position. Current logic likely assumes one stop and one target.
- **Exit notification** — should report which leg filled ("T1 1/2 @ 29094.50")
  rather than treating any fill as a full close.
- **P&L / performance tracking** — a position now closes in stages. Confirm the
  R-multiple and P&L maths handle partial closes.

### Tests

1. `exits` qty sum ≠ `quantity` → 400
2. Targets out of order (long, descending) → 400
3. Both `exits` and `targetPrice` present → 400
4. Valid 2-leg signal → `placeOCO` called **twice**, same stop, different targets
5. Second leg rejected → first leg cancelled, single-OCO fallback placed
6. Fallback also fails → emergency close called
7. First target fills with `moveStopToBEAfterFirstTarget` → `modifyOrder` called
   on the remaining stop with the entry fill price
8. Modify rejected → original stop still working, no cancel issued
9. EOD flatten with 2 legs open → both cancelled
10. Restart with a 2-leg position at the broker → both adopted

---

## 2. Fix the entry-cutoff conflict

Three sources currently disagree:

| Source | Value |
|---|---|
| `.env.example:28-29` | `LAST_ENTRY_HOUR=13`, `LAST_ENTRY_MINUTE=0` |
| `ExecutionBot.js:66-67` | defaults to `11:00` when the env vars are unset |
| EOD flatten | session end − 5 min = **12:55 PST** |

So with the example config, entries are accepted until 13:00 but the session
force-closes at 12:55 — a five-minute window where a signal is accepted and
immediately flattened. And behaviour silently changes depending on whether the
env vars happen to be set.

**Changes:**

1. `.env.example` → `LAST_ENTRY_HOUR=12`, `LAST_ENTRY_MINUTE=30`
2. `ExecutionBot.js:66-67` → same defaults (`12` / `30`), so set and unset agree
3. **Add a startup assertion**: if the entry cutoff is not at least 15 minutes
   before the EOD flatten time, log a loud warning and refuse to start. A
   misconfiguration here silently wastes signals.
4. Surface both values in `GET /status` as `entryCutoffPST` and `eodFlattenPST`
   so the sender can see them without reading `.env`.

---

## 3. Trailing stops and profit manager stay deleted — record the decision

`src/orders/trailing_stop.js` and `src/orders/profit_manager.js` were removed in
the execution-only pivot. **This was correct. Do not restore them.**

Reason, from the 1 Sep 2026 MNQ session — the only live data available:

| Trade | Actual (trim + trail) | Static bracket |
|---|---|---|
| T1 long 29201.25 | +2.60R blended | **+2.76R** (target 29268.25 reached) |
| T2 short 29142 | −1.00R | −1.00R |
| T3 long 29045.75 | +3.84R blended | **+4.17R** (target 29111.50 reached) |
| **Total** | **+5.44R** | **+5.93R** |

Both winners reached their first target, so trimming only capped them. In-process
trailing also loses its state on a crash, whereas exchange-resident OCO legs do
not.

Scaling out is now available through §1 without any trailing engine. If a future
requirement genuinely needs a dynamic trail, implement it as `modifyOrder` calls
driven by fill events — not as a polling module holding its own position state.

One session is not proof. Revisit only with more data, and record the data.

---

## 4. Not in scope

- Confirmation gate — operator is handling this separately.
- Anything in `order_manager.js`, `loss_limits.js`, `SignalHandler.js`,
  `auth.js`, `client.js` beyond the additions above.
- Demo vs live account configuration — operator's decision, bot-side config.

---

## 5. Unverified — test on demo before trusting

I read `placeOCO`, `modifyOrder` and the call site, but **this has not been run
against Tradovate.** Specifically unknown:

- whether the exchange accepts **two OCOs carrying the same stop price on one
  position** without a duplicate-order rejection
- whether filling one leg's target reliably cancels only *that* leg's stop
- how partial fills on the entry interact with pre-computed leg quantities

Test with 2 MNQ micros on a demo account and confirm at the broker — not just in
the logs — before this path is used for anything that matters.
