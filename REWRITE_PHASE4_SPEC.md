# Platform Rewrite — Phase 3B / 4 Implementation Spec

**Audience:** the engineer/agent continuing the platform rewrite.
**Author:** maintainer of the legacy live system (source of the behavioral requirements below).
**Status of architecture:** FROZEN. Nothing in this document authorizes a new engine, layer, or
responsibility change. Everything here is verification, testing, and migration.

---

## 0. The one rule

> **Preserve behavior. Improve architecture.**
> If a behavior below looks like ugly legacy code worth cleaning up, it is almost certainly a
> production bug fix. Every invariant in §2 was paid for with real money or real downtime.
> Port it, test it, do not "improve" it.

---

## 1. Phase plan (revised)

### Phase 4A — File Replay Engine
No Databento API, no Python, no subprocesses, no network. Read files from disk.

```
disk → MarketDataService → Pipeline → Execution → TradeManager → Research → Analytics → EventStore
```

**REQUIREMENT 4A-1 — replay RAW, multi-contract data, not pre-cleaned bars.**
The historical files contain **every contract month interleaved** (each record carries `iid`).
`FileReplayProvider` must emit that raw stream so that **contract dedup, volume-leader locking,
roll detection, and junk-bar rejection all execute inside replay**.

*Rationale:* if replay reads pre-deduped bars, the entire data layer is untested until you swap in
the live provider — i.e. exactly at the riskiest moment. With raw replay, Phase 4C/4D become
genuine no-ops. Include a June→September roll window so roll logic is exercised.

**REQUIREMENT 4A-2 — the 1s/1m event-merge order is a specified behavior, not an implementation detail.**
Live runs two independent processes: 1s bars stream continuously, and the 1m bar is emitted
~500 ms after the minute closes (see §2.4). Replay must define the interleaving explicitly and
match it. Write it down, then pin it with a golden test.

*Rationale:* the legacy research harness had exactly this bug class — cached event arrays leaking
bar-tags across runs made results order-dependent and irreproducible.

**REQUIREMENT 4A-3 — 1-second resolution is mandatory**, not optional. See §2.1.

**ReplayRunner API — build in this order:**
- Ship first: `play() pause() resume() stepForward() changeSpeed(n) reset() stop() currentTimestamp() currentIndex() progress() remainingBars()`
- Defer: `seek()`, `stepBackward()` — backward stepping through a stateful pipeline (indicators,
  session state, open position) requires full state snapshots or replay-from-start. Easy to get
  subtly wrong; must not gate Phase 4B.

### Phase 4B — Replay Validation
**Split into two distinct comparisons. They have different pass criteria.**

**4B-1 — Platform replay vs legacy replay harness → MUST MATCH EXACTLY.**
Both sides are deterministic. This is the hard pass/fail gate: identical trades, entries, exits,
fills, stops, P&L, counts.

**4B-2 — Platform replay vs LIVE traded days → will NOT match, and must not be expected to.**
Live carries real slippage, broker rejects, risk-cap rejections, and resting orders that never
triggered. The pass criterion is **attribution**: *every* divergence has a named, documented cause.

*Reference case:* Jul 14–29 2026, live = −$928, honest backtest = −$1,340. Every difference was
explainable — risk cap rejecting $153–174 stops, InvalidPrice rejects on native stop entries,
and stop orders that never triggered. Reproduce that quality of explanation.

### Phase 4C — Historical Databento Adapter
Swap `FileReplayProvider` → `HistoricalDatabentoProvider`. **Nothing downstream may change.**
If anything downstream changes, the abstraction is wrong — fix the abstraction, not the consumer.

### Phase 4D — Live SharedPriceProvider
Port the legacy implementation (see `DATABENTO_INTEGRATION.md` in the repo root — complete
technical reference for the streaming layer). **Port it; do not redesign it.** Behavioral parity
is the objective. No new execution or strategy logic.

**Architecture invariant across 4A–4D:**
```
FileReplayProvider          ─┐
HistoricalDatabentoProvider ─┼→ identical Bar → Pipeline
Live SharedPriceProvider    ─┘
```
The pipeline must not be able to tell where a bar came from.

---

## 2. Non-negotiable behavioral invariants

Each of these is a production incident. Each needs a permanent regression test (Phase 3B).

### 2.1 One-second fill resolution is the validity gate
A 1-minute backtest is trustworthy **only** when the outcome does not depend on *which of two
levels price touched first inside a bar*.

| Strategy shape | 1m backtest | 1s truth |
|---|---|---|
| Bar-close entry, wide stop (IB breakout, 8pt) | +$1,639/yr | **+$1,738/yr** ✔ |
| Touch entry at a level, tight stop (4pt) | +$918/yr | **−$704/yr** ✘ sign flipped |

Golden datasets and the research path **must** carry 1s data. A 1m-only golden library will
confidently certify strategies that lose money.

### 2.2 Contract dedup
- **Backtests: dedup per DAY**, never globally — the front month rolls mid-quarter, so one global
  volume filter silently mixes contracts.
- **Live:** accumulate volume per contract → **lock after 3 consecutive leader wins** → **switch on
  2× cumulative volume** (roll detection).
- **The 1s stream mirrors the 1m lock.** It must never run an independent lock, or the two streams
  end up on different contracts. (Pre-lock fallback to a 1s-local leader is permitted.)

### 2.3 Junk-bar guard — the `AND` is load-bearing
> Reject a bar only if **BOTH** `volume < 10` **AND** price deviates **> 50 points** from reference.

*Incident:* a pure deviation check rejected every legitimate gap bar after a ~460pt overnight MNQ
gap and left the bot blind for hours. Real gap bars carry thousands of contracts; junk prints
(auction / stale back-month) carry almost none.

### 2.4 Adaptive bar-flush timing
1m bars are buffered before emission so a same-minute sibling-contract bar can arrive:
- **500 ms** when locked to the front month (`BAR_FLUSH_MS_LOCKED`)
- **3000 ms** pre-lock / mid-roll (`BAR_FLUSH_MS_UNLOCKED`)
- 1s bars are emitted **immediately**, never buffered.

This is observable behavior (it shifts entry timing) — replay must reproduce it.

### 2.5 Listener isolation
All consumers share one emitter. **One synchronous throw starves every listener registered after
it in the same `emit()`.** *Incident:* one account silently missed breakeven moves because a
sibling account's listener threw. Every subscriber must be isolated; a failing consumer must not
affect siblings.

### 2.6 Order placement validation
Tradovate returns **HTTP 200 for failures**, in two shapes:
1. `{ordStatus: 'Rejected', rejectReason, text}`
2. `{failureReason, failureText}` **with no `orderId` at all**

*Incident:* shape 2 was treated as success → phantom position with `orderId=undefined` → **5 of 5
MYM signals silently forfeited on one account** while the other account filled the same signals.
Any placement adapter must assert an `orderId` exists and fail loudly otherwise.

### 2.7 Native stop-entry needs a market fallback
A resting stop is only valid on the far side of the market. On fast breaks price crosses the
trigger before the order lands → exchange rejects `InvalidPrice`. Required behavior: at placement
time, compare trigger to live price; if already crossed, **send a market order instead** (the
break already happened). Live-confirmed working.

### 2.8 Signed distance checks — never `abs()`
An `abs()` on target distance allows a target to sit **behind** the entry — an order that fills
instantly at a loss, and which a naive backtest books as a **win with negative P&L**, inflating
win rate. All target/stop distance checks must be direction-signed.

### 2.9 Tick safety
`parseInt` on stop points and hardcoded `0.25` rounding **break M2K (0.10 tick) and MYM (1.0 tick)**.
Always `round(px / tickSize) * tickSize` then `toFixed(2)` — float dust like `2980.8000000000002`
is rejected outright by the exchange.

| Symbol | tickSize | tickValue | pointValue |
|---|---|---|---|
| MES | 0.25 | $1.25 | $5 |
| MNQ | 0.25 | $0.50 | $2 |
| M2K | **0.10** | $0.50 | $5 |
| MYM | **1.0** | $0.50 | **$0.5** |
| MGC | 0.10 | $1.00 | $10 |

### 2.10 Time handling
- **DST-aware sessions.** A hardcoded UTC-7 offset broke Dec–Feb parity by a full hour.
- A **fixed UTC data window clips the RTH close in winter** (13:00–20:29 UTC covers full RTH in
  summer; cuts off at 15:29 ET in winter). Pull to ≥21:30 UTC when the close matters.
- **Warmup parity:** daily cold-start via `resetDay`, no cross-day indicator carry.
- **Mid-session restart must disarm signals generated during backfill** — otherwise a replayed
  historical bar fires a live trade.

### 2.11 Legitimate wall-clock dependence
The "no `Date.now()`" rule is correct, but a few behaviors are *genuinely* real-time driven:
- post-reconnect cooldown (measures actual downtime → `droppedBars = floor(downtimeMs/60000)`;
  cooldown applies when `droppedBars ≥ 3`, suppressing signals for 10 min, **reset not accumulated**)
- fill watchdog (fires on elapsed real time)

These need an **injected `Clock`** that replay drives from event timestamps — not removal.

### 2.12 Risk governance
The **account-level daily-loss halt aggregates across all instruments** and is the single governor
(per-instrument limits are parked at 100000 = effectively off). Halt = no new entries for the day;
open trades run to completion. It belongs in the Risk Engine as **account-scoped** state.

---

## 3. Data formats

### Research datasets — `mes-experiment/backtest/`
JSON arrays; one file per instrument / timeframe / period.
Naming: `{sym}_{1m|1s}_{period}.json` e.g. `mes_1m_q4.json`, `mnq_1s_jul1429.json`

```json
{"timestamp":"2026-03-05T16:29:11+00:00","open":6816.5,"high":6816.75,
 "low":6816.25,"close":6816.25,"volume":74,"iid":42003800}
```
- Timestamps ISO-8601 **UTC**
- **Multi-contract, NOT deduped** — `iid` is the dedup key (this is the raw stream 4A-1 requires)
- Volume: ~100k bars/year/instrument at 1m; ~2.4M bars ≈ **250 MB per quarter** at 1s

### Live recordings — `data/marketdata/`
JSONL, one file per (symbol, date): `md_<symbol>_<date>.jsonl` — 1m bars plus `lock` / `roll` events.
**1s recording is OFF by default** (`RECORD_MARKET_DATA_1S=true` enables it). Turn it on now if you
want live-recorded 1s golden days.

### Performance requirement
JSON parsing dominates: **3–4 minutes per instrument per quarter** at 1s, mostly parse time.
A 500-day × 400-parameter sweep (160,000 runs) is **not feasible** against JSON. Required for the
research ambition:
1. binary/Parquet store instead of JSON
2. bars held in memory across parameter sets
3. indicator computation shared where parameters don't affect it
4. parallelism across runs

Design for this now rather than discovering it after the research loop is promised.

---

## 4. Phase 3B — regression test catalogue

One permanent test per historical production bug. Minimum set:

**Data layer**
- `dedup_per_day_across_roll` — global filter must fail, per-day must pass
- `contract_lock_after_3_consecutive_wins`
- `roll_switch_on_2x_volume`
- `1s_stream_mirrors_1m_lock` (never diverges onto another contract)
- `junk_bar_requires_low_vol_AND_deviation` — 460pt gap bar with high volume must be **kept**
- `flush_500ms_when_locked_3000ms_when_not`
- `listener_throw_does_not_starve_siblings`

**Execution**
- `placement_response_without_orderId_throws` (both failure shapes)
- `native_stop_already_crossed_falls_back_to_market`
- `signed_target_distance_rejects_target_behind_entry`
- `tick_rounding_M2K_010_MYM_10` + float-dust rejection
- next-bar fills, slippage, partial exits, commissions, average price, P&L multiplier

**Risk**
- `account_level_halt_aggregates_across_instruments`
- `halt_blocks_new_entries_but_lets_open_trades_run`
- position sizing, quantity adjustment, trade rejection, daily loss

**Trade manager**
- break-even, trailing, EOD exit, time stop, **stop monotonicity** (a stop must never move against
  the position)

**Time**
- `DST_transition_session_boundaries`
- `warmup_resets_daily_no_cross_day_carry`
- `midsession_restart_disarms_backfill_signals`

**Determinism**
- repeated runs produce identical events, IDs, P&L, trades, snapshots, JSON

---

## 5. Phase 4A/4B integration tests — use REAL recorded data, not synthetic candles

Generic day types (trend / range / holiday / half-day / low-liquidity / high-volatility) **plus**
these specific incident days, which are worth more because each one broke production:

| Test | Date | What it pins |
|---|---|---|
| `gap_460pt.test` | the ~460pt overnight gap day | junk-bar guard keeps high-volume gap bars |
| `invalid_price_rejects.test` | **2026-07-15** | native stop-entry InvalidPrice → market fallback |
| `silent_placement_failure.test` | **2026-07-17 → 07-28** | `orderId=undefined` must fail loudly |
| `account_halt.test` | **2026-07-20 / 07-22 / 07-28** | account-level daily-loss halt fires |
| `fill_crash.test` | **2026-06-15** | toFixed crash + manual/duplicate fill double-count |
| `contract_roll.test` | U6 roll window | lock switch on 2× volume |
| `DST.test` | Dec–Feb boundary | session times + RTH close not clipped |

Each must run at **1-second resolution**.

---

## 6. Acceptance criteria

| Phase | Done when |
|---|---|
| 3A | No unused constructor parameter; no silently-missing optional dependency; DI container resolves every engine |
| 3B | Every bug in §2 and §4 has a passing regression test; determinism suite green over repeated runs |
| 3C | Golden datasets include 1s data; every future change reproduces them exactly |
| 4A | Raw multi-contract replay drives the full pipeline; dedup/lock/roll/junk-guard execute inside replay; merge order pinned by golden test |
| 4B | **4B-1:** platform replay == legacy harness, exactly. **4B-2:** every divergence vs live has a named cause |
| 4C | Provider swap changes nothing downstream |
| 4D | Live provider ported (not redesigned); behavioral parity with `DATABENTO_INTEGRATION.md` |

---

## 7. Anti-goals

- No new engines, layers, or responsibility changes (architecture is frozen)
- No strategy changes — this rewrite must not alter trading decisions
- No "cleaning up" the invariants in §2
- No live Databento connection before 4B passes
- No promising a 160k-run research loop before the storage/perf work in §3 is done
- **Do not open new Databento live sessions casually** — the account has a concurrent-session limit
  and the live bot uses exactly 2 (one per schema). Extra sessions can knock production offline.
