# Sub-Account Mirror Fanout — Design & Implementation

> Status: **IMPLEMENTED & unit-tested** (mirror-at-order-layer). Pending only Phase 4 live/DEMO validation with 2 real sub-accounts (human-in-the-loop). Branch: `feature/subaccount-fanout`.

Fans out a single strategy's orders across **multiple Tradovate sub-accounts under ONE login** (e.g. `TRADOVATE_ACCOUNT_NAME=1699181,1699182` in one `account1.env`). This is *mirror trading*: one signal → identical orders/OCO/exits/BE moves on every sub-account.

```
Today:  TRADOVATE_ACCOUNT_NAME=1699181            ← single name
        → one strategy → orders against ONE account

Now:    TRADOVATE_ACCOUNT_NAME=1699181,1699182    ← comma list, same login
        → one strategy → IDENTICAL orders mirrored across N sub-accounts
```

> **Not** the same as `feature/multi-account-support` (separate logins, one `accountN.env` each). This is several sub-accounts under the **same** login/token.

## Chosen architecture: **Mirror at the order layer**

The PRIMARY sub-account (`subAccounts[0]`) runs the existing execution stack — `InstrumentRunner` + `SignalHandler` + `PositionHandler` + trailing/profit managers — **100% unchanged**. A thin wrapper (`OrderMirror`, `src/api/OrderMirror.js`) sits in front of the shared `TradovateClient` and **replicates every order-mutating call** the primary makes onto each SECONDARY sub-account, with identical parameters — only `accountId`/`accountSpec` swapped.

```
AccountManager
  └─ AccountInstance (1 per account config; one auth token)
       Auth (1) · Client (1, REAL) · OrderWS (1, synced to {accounts:[all sub-ids]})
       createOrderClient(realClient, subAccounts):
         • N == 1  → returns the REAL client UNCHANGED  (mirror = null)
         • N  > 1  → returns { client: OrderMirror proxy, mirror }
       shared.client = that client  ─────────────┐
                                                  ▼
       InstrumentRunner (PRIMARY only, unchanged) → SignalHandler / PositionHandler / TrailingStop
                                                  │  every place/modify/cancel/liquidate
                                                  ▼
                                            OrderMirror
                              await primary call → return to caller immediately
                              then BACKGROUND-fan to secondaries (identical params)
                                  ┌───────────────┬───────────────┐
                                  │  secondary 1  │  secondary 2  │  …
                                  └───────────────┴───────────────┘
```

### Why this over a per-account "AccountExecutor" extraction
- **N == 1 is byte-for-byte identical to today.** The `OrderMirror` class is never even instantiated; runners receive the real client. This satisfies the hard requirement: *single-sub-account behavior must be unchanged after merge.*
- **"Same exact orders" is guaranteed by construction** — secondaries are sent the same `action`/`symbol`/`qty`/`prices`/`orderType`; the only delta is the account binding (which *is* what mirror trading means).
- Sizing, AI confirmation, slippage guard, and all strategy state are computed **once** on the primary. No duplicated/desynced decision logic.
- Primary latency is unchanged: the primary call is awaited and returned to the caller; secondary placements fire in the **background** and can never block or fail the primary.

Trade-off accepted: secondaries are "dumb" replicas, so we maintain an order-id correspondence map (below) and treat any secondary drift as a halt-worthy divergence.

## Tradovate API facts (verified against the OpenAPI spec)

1. **One access token covers every sub-account** under the username. `client.getAccounts()` returns them all.
2. **One order WebSocket can sync many accounts:** `user/syncrequest { accounts: [id1, id2, …] }`. `websocket.js synchronize(accountIds)` accepts a single id or an array. One socket, fills from all sub-accounts.
3. **No batch order endpoint.** `placeMarketOrder/placeLimitOrder/placeOCO` each take one account. Fan-out = N parallel calls (a few ms each).
4. **Entity schemas (routing-critical):**
   - **Fill** carries `orderId` + `contractId` but **NO `accountId`.** → secondary fills *cannot* be account-filtered; they must be routed by an `orderId → sub-account` map.
   - **Order** and **Position** carry `accountId`. → foreign sub-account order/position updates can be dropped directly.

## Order-id correspondence

modify/cancel are keyed by `orderId`, and each account has its **own** orderId for "the same" logical order. `OrderMirror` keeps `primary orderId → [{ accountId, accountSpec, orderId }]`. Because `modifyOrder` modifies **in place** (the orderId is stable across BE/trailing moves), a map built once at placement time stays valid for the life of the order.

- `placeOCO` returns `{ orderId (stop leg), ocoId (target leg) }`; **both** legs are mapped per secondary, so a stop-BE-modify or a target-cancel fans out to the correct secondary leg.
- `cancelOrder` deletes the map entry after fanning out (so a repeat cancel of a dead id makes only the primary call — no stale fanout).

## Fill routing (`AccountInstance._routeFill`)

The order WS is synced to all sub-accounts, so secondary fills arrive on the same stream. Since fills lack `accountId`, `OrderMirror.ownerOfOrder(orderId)` classifies each fill:

- **primary** → fed to the runner (exactly as today).
- **secondary** → logged for audit (`🪞 mirror fill …`), **NOT** fed to the primary runner (which tracks only the primary account).
- **unknown** → in mirror mode this is **never** a primary bot order: the primary's orderIds are recorded *synchronously* at placement, before any fill frame for them can be processed. So an unknown fill is either a secondary whose HTTP ack hasn't landed yet (the WS-fill-beats-ack race) or a foreign/manual order. It is re-checked up to 8×40ms to let a slow secondary ack record (for audit logging), then **dropped** — feeding it to the primary runner would corrupt the primary's position tracking.

For single-account configs there is no mirror, so `_routeFill` is a direct passthrough to `runner.handleFill` — identical to before.

## Divergence policy (any drift = unsafe → COLLECTIVE halt)

A secondary that fails to place/modify/cancel means the accounts are no longer mirror images. `OrderMirror` reports the failure to `AccountInstance._onMirrorDivergence`, which:

1. **Halts ALL sub-accounts** — every runner's `LossLimitsManager.halt('MIRROR_DIVERGENCE', …)` deactivates its strategy, so no new entries anywhere.
2. **Alerts once** (Telegram) with the failing account/method/error for manual reconciliation.

Special case — **naked secondary**: a secondary that ENTERED but whose protective OCO failed is sitting unprotected. `OrderMirror` force-flattens it first (reads the secondary's own open position via `getOpenPositions`, resolves the contract id from the symbol if needed, `liquidatePosition`), *then* reports divergence with `naked: true`.

`liquidatePosition` fan-out flattens each secondary's **own** net (read live), so it is robust even if fill quantities drifted between accounts.

## Resolved design decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Sizing** | **Mode A — mirror identical qty.** Strategy decides N contracts → every sub-account gets N. | Sub-accounts are configured identically; "same exact orders." |
| **Loss limits / halt** | **COLLECTIVE.** All sub-accounts share identical limits; any halt → all halt. Plus divergence → halt-all. | User requirement; accounts are mirror images. |
| **Per-secondary FIFO P&L pairing** | **Not built.** Secondary fills are logged, not paired into per-account P&L. | Mirrors are near-identical; the **primary is the P&L/halt authority**. Pairing would be fragile for ~zero benefit. |
| **Rollout** | **Straight to phased refactor** (no separate DEMO POC script). | API behavior verified against the spec; mirror keeps the N=1 path untouched. |
| **Telegram / status** | Single channel; status reports the **primary's** balance/positions. | Accounts are identical by construction. |

## Files changed

| File | Change |
|---|---|
| `src/api/OrderMirror.js` | **NEW.** `OrderMirror` class + `createOrderClient` factory. Wraps `placeMarketOrder`/`placeLimitOrder`/`placeOCO`/`modifyOrder`/`cancelOrder`/`liquidatePosition`; order-id map; `ownerOfOrder`; divergence + naked-flatten; `asClient()` Proxy. |
| `src/bot/AccountInstance.js` | Resolve ALL sub-accounts (primary first; `this.account = subAccounts[0]`). Build mirror via `createOrderClient`; inject as `shared.client`. WS synced to all sub-account ids (initial + reconnect). `_routeFill` / `_recordSecondaryFill` / `_onMirrorDivergence`. Foreign-account guard on order/position updates. |
| `src/api/websocket.js` | `synchronize(accountIds)` accepts a single id or an array → `user/syncrequest { accounts: [...] }`. |
| `src/utils/account_config_loader.js` | `TRADOVATE_ACCOUNT_NAME` parsed into `accountNames[]` (comma list); single name still yields a 1-element array (backward compatible). |
| `tests/test_order_mirror.js` | **NEW.** Mock-client unit suite (63 checks, no network): N≤1 passthrough; one entry → N identical entries; OCO maps both legs; modify/cancel fan out by mapped ids; `ownerOfOrder` classification; per-secondary own-net liquidation; entry-failure divergence; naked-OCO force-flatten. |

`run:` `node tests/test_order_mirror.js`

## Audit — every order-mutating path routes through the mirror

The active sub-account path is `index.js` (`MULTI_ACCOUNT=true` / `ACCOUNTS_DIR`) → `AccountManager` → `AccountInstance` → `InstrumentRunner` → `SignalHandler` / `PositionHandler` / `TrailingStopManager`. Verified every mutation in that path uses `shared.client` (the mirror proxy):
- `InstrumentRunner` — all calls via `this.shared.client` (entry OCO, naked-close fallback, EOD cancel/flatten, stop-BE modify, orphan liquidation).
- `SignalHandler` — constructed with `client: shared.client`; entry `placeLimitOrder`/`placeMarketOrder` go through it.
- `TrailingStopManager` — `setClient(shared.client, …)`.
- `PositionHandler` — makes **no** order mutations.
- `AccountInstance` / `AccountManager` — make **no** direct order mutations.

The legacy `TradovateBot` / `MultiInstrumentBot` / `order_manager.js` paths are single-login/single-account, are selected only when sub-account configs are *not* in use, and cannot load a multi-sub-account config — so they have no secondaries and correctly need no mirroring.

## Edge cases handled

1. **Secondary entry rejects** → divergence (halt-all + alert); primary keeps its trade; no naked position (entry didn't happen).
2. **Secondary OCO fails (naked)** → force-flatten the secondary, then divergence with `naked: true`.
3. **Secondary modify/cancel fails** → divergence (halt-all + alert); accounts have drifted.
4. **Modify/cancel issued before the secondary placement ack lands** → the primary call returns synchronously while the secondary fan-out is still in flight, so the orderId→secondary map may be empty for an instant. `modifyOrder`/`cancelOrder` first `await` the pending placement for that orderId (`_awaitPendingFanout`, tracked via `_pendingFanout`) so the fan-out reads a *complete* map — a BE-move or cancel on a just-placed order can never be silently lost on the secondaries.
5. **Fill arrives before placement ack** (unknown orderId) → re-checked up to 8×40ms. In mirror mode the primary's orderIds are recorded synchronously at placement, so an unknown fill is **never** the primary's → after the retry budget it is **dropped** (never fed to the primary runner), preventing corruption of primary position tracking. Single-account mode has no mirror, so the fill goes straight to the runner — unchanged.
6. **Fill-qty drift between accounts** → `liquidatePosition` flattens each secondary's *own* live net.
7. **WebSocket reconnect** → re-`synchronize` ALL sub-account ids.
8. **N == 1** → real client returned unchanged; mirror never instantiated; zero behavioral delta.

## Known limitations

- **Mode-A fixed-qty closes under partial-fill divergence.** Exits that close a *fixed* quantity — the EOD flatten (`placeMarketOrder(account.id, contract.id, pos.quantity, closeAction)`) and the BE/stop modifies — mirror the **primary's** quantity onto every secondary. If a secondary's entry had *partially* filled to a different net than the primary (e.g. one account got 1 of 2 lots), a fixed-qty close could over- or under-close that secondary. This is **inherent to identical-qty mirror trading** (Mode A), not a defect in the mirror layer — the layer faithfully replicates the primary's order. Two factors bound the blast radius: (a) the only *quantity-aware* flatten path, `liquidatePosition`, reads each secondary's **own live net** and is therefore immune; (b) any secondary order failure already triggers a collective halt. Per-account fill-quantity reconciliation (FIFO pairing) was explicitly **descoped** (see decisions table): for the target instrument/size (MNQ, 1–2 lots, marketable entries) partial-fill divergence across sub-accounts is effectively nil, and per-account fill tracking would add fragile state for ~zero benefit.

## Remaining work

- **Phase 4 — DEMO/live validation (human-in-the-loop):** run with 2 real sub-accounts; confirm entries/OCO/BE/exits mirror across accounts, fills route correctly, and a forced secondary failure triggers collective halt + alert. Cannot be exercised without live credentials + real fills.
