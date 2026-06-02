# Multi-Account Fanout Architecture — Research & Design

> Status: **DRAFT — not yet implemented.** This document captures the research and proposed design for fanning out a single signal across multiple Tradovate sub-accounts under one username (e.g. `TRADOVATE_ACCOUNT_NAME=1699181,sub-account2,sub-account3`).

## Goal

```
Today:  TRADOVATE_ACCOUNT_NAME=1699181        ← single string
        → one strategy → one set of orders against ONE account

Want:   TRADOVATE_ACCOUNT_NAME=1699181,sub-account2,sub-account3
        → one strategy → identical orders/OCO/fills mirrored across N sub-accounts
```

All orders, OCO brackets, fills, exits, and BE moves should be the same across accounts (subject to per-account fill variance).

## Tradovate API research

Tradovate natively supports multi-account from one login. Key facts:

1. **One access token works for all accounts under your username.**
   `auth.authenticate()` returns one token. `client.getAccounts()` returns ALL accounts. The token is fine for any of them.

2. **The order WebSocket can subscribe to multiple accounts at once.**
   `src/api/websocket.js:350-353`:
   ```js
   synchronize(accountId) {
     this.send('user/syncrequest', { accounts: [accountId] });  // already an array!
   }
   ```
   Tradovate accepts `accounts: [id1, id2, id3, ...]`. **One WS connection, fills from N accounts.** Routing happens by `entity.accountId` in the fill event.

3. **`placeMarketOrder/Limit/OCO` each take `accountId` per call.**
   No batch endpoint exists. To fan out to N accounts, you MUST make N API calls. They can be in parallel via `Promise.all` — 3-5 calls take ~30ms total.

## Current code points that need to change

Five single-account assumptions are baked into the live runtime:

### 1. Account selection (`src/bot/AccountInstance.js:113-133`)
```js
const preferredName = this.credentials.accountName;
this.account = accounts.find(a => a.name === preferredName);
```

### 2. Order placement (`src/bot/SignalHandler.js:387-405`)
```js
entryOrder = await this.client.placeMarketOrder(
  this.account.id,        // ← single account
  this.contract.id, position.contracts, action
);
```

### 3. OCO placement (`src/bot/InstrumentRunner.js:545-553`)
```js
await this.shared.client.placeOCO(
  ocoParams.accountSpec,   // single account name
  ocoParams.accountId,     // single account id
  ...
);
```

### 4. Fill routing (`src/bot/AccountInstance.js:234-252`)
```js
route('fill', 'handleFill');
this.orderWs.on('fill', (entity) => {
  const runner = this._contractIdToRunner.get(entity.contractId);
  if (runner) runner.handleFill(entity);  // ← single runner, single account
});
```
For multi-account, must route by `(contractId, accountId)` and feed each account's PositionHandler independently.

### 5. Position/cooldown state (`src/strategies/mnq_momentum_strategy_v2.js`)
The strategy has ONE position lock (`this.position`), ONE `signalFired`, ONE `_cooldownRemaining`. These are correct for SIGNAL GENERATION but EXECUTION must track N positions.

## Design options

### Option A: N independent AccountInstances (lazy, NOT recommended)
- N .env files, no code changes.
- ❌ N independent strategies → N signals (slightly different per-instance jitter)
- ❌ Tradovate may not allow same login from multiple sessions
- ❌ Doesn't match user intent

### Option B: True signal fanout (RECOMMENDED)
One strategy, one signal generator, N order executors. This is what prop firms do for "mirror trading."

```
AccountInstance (1)
  Auth (1)
  Client (1)
  OrderWS (1) — subscribed to {accounts: [a1, a2, a3]}
  Strategy (1)
  SignalHandler (1) ← generates signal
       ↓ fans out
  ┌────────────┬────────────┬────────────┐
  │ Executor1  │ Executor2  │ Executor3  │
  │ - account  │ - account  │ - account  │
  │ - LossLim  │ - LossLim  │ - LossLim  │
  │ - PosHandl │ - PosHandl │ - PosHandl │
  │ - OCO IDs  │ - OCO IDs  │ - OCO IDs  │
  └────────────┴────────────┴────────────┘
```

### Option C: Single executor (TIGHT coupling, not viable)
Tradovate doesn't allow one order across multiple accounts. Skip.

## Recommended architecture: Option B in detail

### Component changes (minimum invasive set)

**1. Config parsing** (`src/utils/account_config_loader.js`)
```diff
- credentials: { ..., accountName: env.TRADOVATE_ACCOUNT_NAME, ... }
+ credentials: { ..., accountNames: (env.TRADOVATE_ACCOUNT_NAME || '').split(',').map(s => s.trim()).filter(Boolean), ... }
```
Backward-compatible: single name still parses to a 1-element array.

**2. Account resolution** (`AccountInstance.initialize`)
```diff
- this.account = accounts.find(a => a.name === preferredName);
+ this.accounts = preferredNames.map(name => {
+   const a = accounts.find(x => x.name === name);
+   if (!a) throw new Error(`Account "${name}" not found`);
+   return a;
+ });
+ this.primaryAccount = this.accounts[0];  // For state-tracking
```

**3. WebSocket subscription** (one connection, all accounts)
```diff
- this.orderWs.synchronize(this.account.id);
+ this.orderWs.synchronizeMany(this.accounts.map(a => a.id));
```
Tiny edit to `websocket.js`.

**4. Per-account executor (NEW class)** — `src/bot/AccountExecutor.js`
- Owns: account, LossLimitsManager, position state, OCO order IDs
- Receives signals from SignalHandler
- Places orders for ITS account
- Receives fills routed by accountId
- Manages its own BE stop ladder & OCO updates
- Can halt independently if its loss limit hits

**5. SignalHandler fanout** (the critical change)
```diff
- async handleSignal(signal) {
-   entryOrder = await this.client.placeMarketOrder(this.account.id, ...);
+ async handleSignal(signal) {
+   const results = await Promise.allSettled(
+     this.executors.map(ex => ex.placeEntry(signal))
+   );
+ }
```

**6. Fill routing** (`AccountInstance._connectOrderWebSocket`)
```diff
  this.orderWs.on('fill', (entity) => {
-   const runner = this._contractIdToRunner.get(entity.contractId);
-   if (runner) runner.handleFill(entity);
+   const runner = this._contractIdToRunner.get(entity.contractId);
+   if (!runner) return;
+   const executor = runner.getExecutorByAccountId(entity.accountId);
+   if (executor) executor.handleFill(entity);
  });
```

## Critical design decisions

### Position sizing — Mode A vs Mode B

**Mode A: Mirror exact qty** (RECOMMENDED for prop-firm-style)
- Strategy decides "3 contracts" → each account gets 3 contracts
- Identical orders across accounts
- Risk: smaller accounts could get margin-called if balances vary
- **Use when all sub-accounts have SAME balance and risk limits**

**Mode B: Per-account sizing**
- Each executor computes its own qty based on its own balance
- More correct, but breaks "identical orders"
- **Use when sub-accounts have DIFFERENT sizes**

### Per-account loss limits

**Mode A: Halt only the account that breached** (RECOMMENDED)
- That account stops; others continue
- Each executor maintains its own LossLimitsManager + state file
- Loss state persisted per-account in `data/accounts/<accountid>/`

**Mode B: Halt all on any halt**
- Simpler, but loses the benefit of running multiple

## Edge cases

1. **One account's order rejects** (insufficient margin, account locked)
   - Others should still execute. Notify user of partial fanout.

2. **Different fill prices per account** (execution variance)
   - Each account's OCO uses its own fill price.
   - Acceptable; log variance for audit.

3. **BE move timing differences**
   - Each account's BE evaluates independently based on its own stopDistance.
   - True mirror semantics.

4. **One account closes before others** (stop hit on one, target on another)
   - Strategy's "position closed → cooldown" should unlock on PRIMARY account close.

5. **Account-specific risk limits**
   - Each executor validates against its own account's max contracts.

6. **WebSocket reconnect**
   - Re-synchronize ALL account IDs on reconnect.

## Operational concerns

- **Telegram**: per-account routing OR single channel with `[accountId]` prefix
- **Logging**: prefix every order/fill log with `[accountId]` for traceability
- **Performance tracker**: separate per-account JSON files (already supported in `dataDir`)
- **Position sync at startup**: reconcile open positions across ALL accounts

## Migration plan (incremental, low-risk)

### Phase 1 — Multi-account read-only (1-2 days, no trading impact)
- Add `accountNames` array parsing
- Resolve ALL accounts at startup, log them
- Subscribe WS to all accounts (no order changes yet)
- Validate fills route correctly by `accountId`
- **Outcome:** monitor multiple accounts; trading still single-account.

### Phase 2 — Order fanout (3-5 days, trading change)
- Create `AccountExecutor` class
- Refactor `SignalHandler` to delegate order placement to executors
- Refactor `PositionHandler` to be per-executor
- Refactor `InstrumentRunner` to manage list of executors
- Per-executor `LossLimitsManager` with per-account state persistence
- **Outcome:** signals fanned out to all sub-accounts; identical orders.

### Phase 3 — Edge case hardening (1-2 days)
- Handle one-account-fails-others-succeed
- Per-account BE moves
- Per-account halt semantics
- Master notification thread for cross-account events
- **Outcome:** production-ready multi-account.

### Phase 4 — Validation
- Run in DEMO with 2+ accounts for 1 week
- Confirm orders mirror correctly across accounts
- Confirm fills, OCOs, BEs all execute per account
- Promote to LIVE

## Proof-of-concept first (recommended)

Before committing to the refactor, build a 50-line POC script that:

1. Authenticates ONCE
2. Calls `client.getAccounts()` to list all accounts under the username
3. Places a tiny market order on ALL of them in parallel (1 contract on MNQ)
4. Subscribes WS to `{accounts: [all_ids]}`
5. Logs all fills as they come back
6. Closes positions
7. Reports timing/price variance per account

Validates Tradovate's actual behavior with multi-account WS + parallel orders WITHOUT touching production code. **DEMO only.**

## Open questions to answer before implementation

1. Do all sub-accounts have IDENTICAL risk limits / max contracts / daily loss caps?
   (Determines whether Mode A is feasible.)
2. Should one account's halt stop the others or not?
   (Halt-only-breaching vs halt-all.)
3. Telegram routing — per-account channels vs master channel?
4. Should the strategy unlock cooldown on primary's close or wait for all accounts?
