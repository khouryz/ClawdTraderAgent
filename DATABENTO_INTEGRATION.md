# Databento Streaming Integration — Complete Technical Handoff

Everything needed to build a second trading system on the same Databento feed.
Written from the live production code (`src/data/`), not from memory.

---

## 1. Architecture in one picture

```
Databento Live API (TCP)
        │
        │  ONE db.Live() session per schema, all symbols multiplexed
        ▼
  databento_stream.py          ← Python subprocess (one per schema)
        │  JSON lines on stdout, one object per line, flush=True
        ▼
  SharedPriceProvider.js       ← Node: spawns 2 processes, parses, dedups
        │  EventEmitter
        ├── emit('bar:MNQ.FUT',   bar)    ← 1-minute, front-month, deduped
        ├── emit('bar1s:MNQ.FUT', bar1s)  ← 1-second,  front-month, deduped
        ├── emit('quote:MNQ.FUT', quote)
        ├── emit('reconnected' | 'disconnected' | 'status' | 'error')
        └── emit('maxReconnectAttemptsReached')
        ▼
  InstrumentRunner (one per account × instrument) subscribes
```

**Critical design fact:** exactly **2 concurrent Databento live sessions total**, ever —
one for `ohlcv-1m`, one for `ohlcv-1s`. Every symbol rides the same 2 sessions via a
comma-joined `subscribe()`. Adding instruments or accounts adds *symbols*, never
sessions. Databento enforces a concurrent-session limit; if your new system opens its
own `db.Live()` sessions, **you are consuming from the same account quota**. Coordinate
this or you will knock the trading bot's feed offline.

---

## 2. The Python bridge (`src/data/databento_stream.py`, 280 lines)

### Invocation
```bash
python databento_stream.py \
  --key   <DATABENTO_API_KEY> \
  --symbol "MNQ.FUT,MES.FUT,MYM.FUT" \   # comma-separated, parent symbology
  --schema "ohlcv-1s" \                   # ohlcv-1m | ohlcv-1s | trades | mbp-1 | mbp-10
  --dataset "GLBX.MDP3" \
  --mode  live                            # or: historical (+ --start --end --limit)
```

### Live mode internals
- `client = db.Live(key=api_key)` then **one `subscribe()` call per schema** on the
  same session (Databento-recommended: single TCP connection).
- `stype_in="parent"` — you subscribe to `MNQ.FUT` (the *parent*), and Databento
  delivers **every contract month** under it (MNQM6, MNQU6, MNQZ6, …). **This is the
  single most important thing to understand** — see dedup below.
- Consumes via the iterator pattern: `for record in client:`
- Prices are **fixed-point integers**: divide by `1e9`. (`record.price / 1e9`)
- Timestamps: `ts_event` is **nanoseconds since epoch** → `datetime.fromtimestamp(ts/1e9, tz=utc).isoformat()`
- Per-record exceptions are caught and emitted as `{"type":"error"}` — one bad record
  never kills the stream.
- SIGTERM/SIGINT handlers emit `shutting_down` then exit 0.
- `BrokenPipeError` on stdout → silent `sys.exit(0)` (parent died).

### Symbology mapping (how you learn what contract a record is)
`SymbologyMsg` / `SymbolMappingMsg` records arrive and populate two dicts:
```python
iid_to_symbol[instrument_id]   = stype_in_symbol    # "MNQ.FUT"  (parent)
iid_to_contract[instrument_id] = stype_out_symbol   # "MNQU6"    (actual contract)
```
Every emitted record carries **both** `symbol` (parent) and `contract` (actual).
Fallback if the map has not arrived yet: if only one symbol was subscribed, use it.

### Output message types (JSON lines on stdout)

```jsonc
// ohlcv-1s / ohlcv-1m
{"type":"ohlcv","ts":"2026-07-31T15:04:00+00:00","open":7478.5,"high":7479.25,
 "low":7478.25,"close":7479,"volume":142,"symbol":"MES.FUT","contract":"MESU6"}

// trades
{"type":"trade","ts":"...","price":7479.0,"size":2,"symbol":"MES.FUT",
 "contract":"MESU6","action":"T","side":"B"}

// mbp-1 (top of book) — note: only levels[0] is emitted
{"type":"quote","ts":"...","bid":7478.75,"ask":7479.0,"bid_size":10,"ask_size":15,
 "symbol":"MES.FUT"}

{"type":"status","message":"connecting|connected|streaming|disconnected|system|shutting_down"}
{"type":"error","message":"..."}
{"type":"historical","count":N,"records":[...]}   // historical mode only
```

**Not implemented in the bridge:** `mbp-10` depth levels. `--schema mbp-10` is accepted
by argparse but only `MBP1Msg` is handled, and only `levels[0]`. If your system needs
order-book depth you must extend `run_live_stream()` to handle `MBP10Msg` and emit all
10 levels.

### Historical mode
`db.Historical(api_key).timeseries.get_range(dataset, schema, stype_in="parent", symbols, start, end, limit)`,
collected via `data.replay(callback)`, emitted as ONE big `{"type":"historical","records":[...]}`
line. Only `OHLCVMsg` and `TradeMsg` are collected.

---

## 3. THE DEDUP PROBLEM (read this twice)

Because `stype_in="parent"` returns **all contract months simultaneously**, a naive
consumer sees 2–4 bars for the same timestamp — front month, back month, and spreads.
Mixing them corrupts everything: wrong prices, doubled volume, phantom gaps.

### Live dedup — volume-leader contract lock (`_handleOHLCV`)

1. Accumulate `contractVolumes[contract] += volume` per parent symbol.
2. Determine the current **leader** = highest cumulative volume.
3. **Lock** after the same contract leads **3 consecutive bars**:
   `state.lockedContract = leader` → logs `🔒 Locked to contract: MESU6`
4. Once locked, bars from any other contract are **dropped immediately**.
5. **Roll detection:** if a non-locked contract's cumulative volume exceeds the locked
   contract's by **2×**, switch the lock and reset tracking:
   `🔄 Contract roll detected: MESM6 → MESU6`
6. Same-timestamp tiebreak (pre-lock): keep the **higher-volume** bar.

### 1-second stream dedup (`_handleMessage1s`)
The 1s stream **does not run its own lock** once 1m has decided — it *mirrors the 1m
lock* (`state.lockedContract`) so the two streams can never diverge onto different
contracts. Before the 1m lock exists (first ~3 bars of a session / just after restart)
it falls back to its own independent volume leader via `contractVolumes1s`.

**If you build your own consumer, you MUST implement equivalent logic.** The simplest
correct version for a 1s-only system: track cumulative volume per `contract` per day,
emit only the leader, and re-evaluate on a 2× threshold.

### Historical dedup
Different and simpler — group by timestamp, keep the highest-volume record:
```js
if (!byTs[r.ts] || r.volume > byTs[r.ts].volume) byTs[r.ts] = bar;
```
For **backtests**, the equivalent used in the research harness is: group by day, pick
the dominant-volume `iid` for that day, then filter. Front month changes mid-quarter,
so a single global filter is wrong — dedup **per day**.

---

## 4. Bar emission timing (adaptive flush)

A freshly-arrived 1m bar is **buffered before emission** so a same-minute sibling-contract
bar can arrive and the higher-volume one can win:

| State | Delay | Env override |
|---|---|---|
| Locked to front month | **500 ms** | `BAR_FLUSH_MS_LOCKED` (0–3000) |
| Pre-lock / mid-roll | **3000 ms** | `BAR_FLUSH_MS_UNLOCKED` (250–10000) |

Once locked, the lock filter already dropped every sibling bar, so the wait is pure
latency — hence the fast path. **1-second bars are emitted immediately, no buffering.**

Flush also happens early if a *new* timestamp arrives before the timer fires, and on `stop()`.

---

## 5. Junk-bar / price-sanity guards

Applied on **both** streams, and again in the strategy:

> Reject a bar only if **BOTH** (a) `volume < 10` **AND** (b) price deviates **> 50 points**
> from the reference (last tick, else last emitted close).

The `AND` is deliberate and hard-won: a pure deviation check rejected every legitimate
gap bar after a ~460pt overnight MNQ gap and left the bot blind for hours. Real gap bars
carry thousands of contracts; junk prints (auction/stale back-month) carry almost none.

There is a separate guard for BE-ladder ticks: reject if deviation > **5R** from entry.

---

## 6. Events emitted (the consumer API)

```js
provider.on(`bar:${sym}`,   bar   => ...)  // {timestamp, open, high, low, close, volume, symbol}
provider.on(`bar1s:${sym}`, bar1s => ...)  // identical shape, 1-second
provider.on(`quote:${sym}`, q     => ...)  // {price, timestamp, volume, symbol}
provider.on('reconnected',  ({downtimeMs, attempts}) => ...)   // only when BOTH streams are back
provider.on('disconnected', ({code, stream}) => ...)           // stream: '1m'|'1s'
provider.on('status'|'error', ...)
provider.on('maxReconnectAttemptsReached', ...)                // both dead
provider.getLastTickPrice(sym)  // → {price, receivedAt, ageMs} | null
```

`sym` is always the **parent** symbol (`MNQ.FUT`), never the contract.

### ⚠️ Listener isolation (production bug, already fixed here)
All consumers share ONE EventEmitter. A synchronous throw in one listener **starves
every listener registered after it** in the same `emit()`. The bot wraps every shared
listener in try/catch for this reason:
```js
const safe = (...args) => { try { fn(...args); } catch (e) { logger.error(...); } };
```
This caused a real incident (one account missing breakeven moves because a sibling
account's listener threw). **Do the same in your system.**

---

## 7. Reconnection & gap handling

- Each stream reconnects **independently**. Attempts 1–2: 2000 ms. Then
  `reconnectDelayMs (5000) × min(attempts, 6)`. Max **10** attempts.
- `isConnected` = both streams up. `'reconnected'` fires only when both are back.
- 30-second startup timeout → resolves anyway and continues (does not block boot).
- **Post-reconnect cooldown:** downtime is converted to `droppedBars = floor(downtimeMs/60000)`.
  If `droppedBars >= POST_RECONNECT_MIN_DROPPED_BARS` (default 3), new signals are
  suppressed for `POST_RECONNECT_COOLDOWN_MINS` (default 10) so indicators can rebuild.
  The cooldown **resets** to N minutes from now (does not accumulate).
- **Gap backfill:** missing bars are re-fetched historically and replayed through
  `strategy.onBar()` with a `_warmingUp` flag set, filtered by `_isInSession()` and
  deduped against existing timestamps. Signals generated during backfill are discarded
  (`signalFired` reset) so a replayed bar can't fire a live trade.

---

## 8. Historical fetch + caching

`getHistoricalBars(symbol, start, end, schema='ohlcv-1m', limit)`

- **In-flight Promise cache**, key = `symbol|start|end|schema|limit`. Multiple accounts
  booting concurrently share ONE fetch instead of spawning N subprocesses.
- Resolved bars are cached for the process lifetime (historical OHLCV is immutable).
- Cache entry is **evicted on failure** so retries work.
- One Python subprocess per uncached call; **60-second timeout** then `proc.kill()`.
- Uses the `db.Historical` endpoint — does **not** count against the live concurrent-session limit.

### Historical API gotchas (learned the expensive way)
1. **`data_end_after_available_end` (HTTP 422):** historical data lags real time by
   ~30–60 min. The error message states the true max end — cap your `end` to it.
2. **HTTP 504** on large 1s pulls is transient. Retry.
3. **Volume/cost:** 1m for a year ≈ 100k bars/instrument (seconds, cheap). 1s for a
   quarter ≈ 2.4M bars ≈ 250 MB per instrument (minutes, real money). Query
   `metadata.get_cost()` / `metadata.get_record_count()` **before** pulling — those
   calls are free.
4. **DST bug:** a fixed UTC window clips sessions. `13:00–20:29 UTC` covers full RTH in
   summer but **cuts off at 15:29 ET in winter**. Pull to ≥ 21:30 UTC if you need the close.

---

## 9. Instrument specs (`src/utils/constants.js` → `CONTRACTS`)

| Symbol | Name | tickSize | tickValue | pointValue |
|---|---|---|---|---|
| MES | Micro E-mini S&P 500 | 0.25 | $1.25 | **$5** |
| MNQ | Micro E-mini Nasdaq-100 | 0.25 | $0.50 | **$2** |
| M2K | Micro E-mini Russell 2000 | **0.10** | $0.50 | $5 |
| MYM | Micro Dow | **1.0** | $0.50 | **$0.5** |
| MGC | Micro Gold | 0.10 | $1.00 | $10 |

⚠️ **Tick-safety bug class:** code that assumes `0.25` ticks or uses `parseInt` on stop
points silently breaks M2K (0.10) and MYM (1.0). Always round prices to the instrument's
tick: `Math.round(px / tickSize) * tickSize`, then `toFixed(2)` — float dust like
`2980.8000000000002` is **rejected by the exchange**.

---

## 10. Consuming the 1s stream (what the trading bot does with it)

The 1s bar **close is the tick cadence** — the bot does *not* subscribe to raw trade
prints. This is deliberate: it makes live behavior identical to the backtester.

Each `bar1s` event drives:
1. `strategy.onTick({price, open, high, low, timestamp})` — full OHLC passed so
   stop-entries trigger on the intrabar **touch**, matching the backtest exactly.
2. `_lastTickPrice` → the **slippage guard** in SignalHandler (rejects entries when the
   market has run too far from the signal; requires `ageMs < 5000` to be trusted, else
   fails open).
3. Breakeven-ladder evaluation + a BE safety net.
4. MAE/MFE excursion tracking for the trade journal.
5. Deferred-entry evaluation (event-driven, one evaluation per bar — no timer sampling).

**Parity principle:** anything you do on 1s data in live must be reproducible bar-for-bar
in a backtest, or your backtest is fiction. This system's hardest-won lesson: strategies
using **tight stops at a price level** look profitable on 1-minute bars and collapse on
1-second fills (one measured case: +$918/yr → −$704/yr). Entries confirmed by a **bar
close** with a **wide stop** survive. Validate anything new on 1s before believing it.

---

## 11. Market-data recording (free replay dataset)

`MarketDataRecorder` writes append-only JSONL, one file per (symbol, date):
`<dir>/md_<symbol>_<date>.jsonl` — 1m bars, lock/roll events, and optionally 1s bars.

| Env | Default | Meaning |
|---|---|---|
| `RECORD_MARKET_DATA` | `true` | master switch (`false` disables) |
| `RECORD_MARKET_DATA_1S` | `false` | 1s bars off by default (re-fetchable, large) |
| `MARKETDATA_DIR` | `./data/marketdata` | output directory |

Async, buffered (20k), never on the hot path. This is the exact feed the bot saw —
ideal for deterministic replay.

---

## 12. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `DATABENTO_API_KEY` | — | **required** |
| `DATABENTO_DATASET` | `GLBX.MDP3` | CME Globex MDP3 |
| `DATABENTO_SYMBOL` | per-instrument | e.g. `MNQ.FUT` (`<SYM>_DATABENTO_SYMBOL`) |
| `PYTHON_PATH` | `python` | must have `databento` pip package |
| `BAR_FLUSH_MS_LOCKED` | 500 | 1m emit delay when locked |
| `BAR_FLUSH_MS_UNLOCKED` | 3000 | 1m emit delay pre-lock/roll |
| `POST_RECONNECT_COOLDOWN_MINS` | 10 | signal suppression after a gap |
| `POST_RECONNECT_MIN_DROPPED_BARS` | 3 | threshold to trigger cooldown |
| `RECORD_MARKET_DATA` / `_1S` / `MARKETDATA_DIR` | see §11 | recorder |

---

## 13. Building a second system — practical checklist

1. **Do not open new `db.Live()` sessions carelessly.** You share the account's
   concurrent-session quota with the trading bot. Either (a) reuse `SharedPriceProvider`
   by subscribing to its events from the same Node process, or (b) accept one additional
   session and confirm the quota allows it. Option (a) is free; option (b) can break
   live trading if the limit is hit.
2. **Reuse `databento_stream.py` as-is** if you only need 1s/1m/trades. Extend it for
   `mbp-10` if you need depth (not currently implemented).
3. **Implement contract dedup or your data is wrong.** Parent symbology returns all
   months. Volume-leader + lock + 2× roll switch.
4. **Wrap every shared-emitter listener in try/catch.**
5. **Use `parent` symbology and key everything by parent symbol**, carrying `contract`
   alongside for dedup/roll logging.
6. **Divide prices by 1e9; timestamps are nanoseconds.**
7. **Round every price to the instrument tick before sending an order.**
8. **Handle the 30–60 min historical lag and DST window clipping.**
9. **Check `metadata.get_cost()` before large pulls** — 1s data is expensive.
10. **Validate on 1-second fills, with train/test split, before trusting any result.**

---

## 14. Files to read, in order

| File | Lines | What it is |
|---|---|---|
| `src/data/databento_stream.py` | 280 | Python bridge — live + historical |
| `src/data/SharedPriceProvider.js` | 731 | Multi-symbol dual-stream provider (**the main one**) |
| `src/data/DatabentoPriceProvider.js` | 625 | Single-instrument fallback provider |
| `src/bot/InstrumentRunner.js` (~890–930) | — | Consumer wiring: `bar` / `bar1s` subscription |
| `src/bot/AccountInstance.js` (~318–360) | — | Listener isolation + reconnect fan-out |
| `src/analytics/MarketDataRecorder.js` | — | JSONL recording format |
| `src/utils/constants.js` → `CONTRACTS` | — | Tick sizes / point values |
