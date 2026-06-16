# M2K — validated config reference (3rd instrument)

M2K (Micro Russell 2000, **$5/pt, tick 0.10**) trades **alongside MNQ + MES as a fully
independent engine** — own Databento feed (multiplexed into the existing 2 python sessions,
**zero new streams**), own orders, own per-instrument loss-limits / performance / journals,
1 trade at a time. Enabling it is **config-only** *after* the `parseFloat` fix below.

## ⚠️ Required code change (shipped) — fractional stop points
M2K's vol-matched geometry is **fractional** (`maxStop 4.8`, `minStop 0.6`, `stopBuffer 0.2`).
The loader previously read stop/target points with `parseInt`, which truncated `0.6→0`
(silently disabling the min-stop filter) and `4.8→4`. Both parsers
(`account_config_loader.js` + `MultiInstrumentBot.js`) now use `parseFloat` on the 8 point
fields. MNQ/MES use integer points → **unchanged**.

## How it was derived
- **MNQ→M2K volatility ratio = 8.4×** (median 1m range MNQ 11.75 vs M2K 1.40 pts). All
  point-params = MNQ ÷ 8.4, quantized to the 0.10 tick.
- Same momentum-v2 engine as MNQ/MES (PB5m + PB3m + PB2m, confluence ≥5).
- Key choices: **R 2.5**, **wide retrace 0.20–0.85** (mean-reverting RTY), **BE at 1.0R**,
  **entry cutoff 10:00 PT** (trims the dead late-morning tail), **MAX_CONTRACTS=10** (lifts
  avgWin to ~$190 by letting small-stop trades use the full $90 risk).
- **Backtest Mar–Jun 2026 (deterministic, no slippage):** +$7,092, 4.5 trades/day, PF 1.79,
  avgWin $193 / avgLoss $84, net/DD 9.7, 4/4 green months, maxConsecL 9, worst day −$273.
  June 2026: +$2,198, 3.4/day, PF 5.50.

## ⚠️ Before live money
- **Thin book** → uses the **marketable-limit entry** (signal ±1 tick, $0.50 cap, 180s
  cancel) just like MES. Backtest is slippage-off, so a few backtested fills won't happen
  live (limit cancels if price runs past +1 tick) — expect slightly fewer trades than backtest.
- **Watch the order journal's realized entry `slippagePt`** in the first sessions.
- `DAILY_LOSS_LIMIT=300` is a circuit-breaker set just above the worst observed day (−$273);
  the backtest itself relied on `MAX_LOSSES_PER_DAY=5` + `MAX_CONSECUTIVE_LOSSES=5`, not a
  dollar cap. Lower to 200 if you want a tighter leash to match MNQ/MES (will clip the ~2
  worst days/quarter).

## Deploy steps
1. Deploy **off-hours / when flat** (the per-instrument data-dir relocates loss-limit state
   once on first restart). This also picks up the watchdog fix (`63ccf6e`).
2. Paste the `M2K_*` block below into **account1.env only** (the M2K-trading account).
   **Leave account2.env as `INSTRUMENTS=MNQ`** — it is untouched.
3. In account1.env set `INSTRUMENTS=MNQ,MES,M2K`.
4. In the **root .env** set `MAX_SIMULTANEOUS_POSITIONS=3` (lets MNQ+MES+M2K all be open).
5. **Verify the front month.** As of 2026-06-16 the June (M6) contract expires Jun 19, so the
   active contract is **U6 (September)**. Make sure `M2K_SYMBOL` matches the month your MNQ/MES
   are on; roll all three together.
6. On boot, confirm **three** `EFFECTIVE CONFIG` blocks, each with a **distinct** `[isolation]
   dataDir`, the M2K one showing `specs=$5/pt tick=0.1`, `ENTRY MODE 🎯 LIMIT … verified`, and
   three `🔒 Locked to contract` lines.

## Config block (account1.env)

```env
# === M2K CONFIGURATION (3rd instrument; geometry = MNQ / 8.4) ===
M2K_SYMBOL=M2KU6
M2K_STRATEGY=mnq_momentum_v2
M2K_DATABENTO_SYMBOL=M2K.FUT
M2K_AUTO_ROLLOVER=false

# === RISK MANAGEMENT (independent per-instrument) ===
M2K_RISK_PER_TRADE_MIN=15
M2K_RISK_PER_TRADE_MAX=90
M2K_MAX_CONTRACTS=10
M2K_DAILY_LOSS_LIMIT=300
M2K_WEEKLY_LOSS_LIMIT=750
M2K_MAX_CONSECUTIVE_LOSSES=5
M2K_MAX_DRAWDOWN_PERCENT=15
M2K_MAX_LOSSES_PER_DAY=5

# === SESSION (entry cutoff 10:00 PT) ===
M2K_LAST_ENTRY_HOUR=10
M2K_LAST_ENTRY_MINUTE=0
M2K_SKIP_HOURS=

# === TARGETS / STOPS / CONFLUENCE (R2.5; geometry = MNQ / 8.4, tick 0.10) ===
M2K_PROFIT_TARGET_R=2.5
M2K_MIN_CONFLUENCE=5
M2K_PB_MIN_CONFLUENCE=5
M2K_PB3M_MIN_CONFLUENCE=5
M2K_PB2M_MIN_CONFLUENCE=5
M2K_CONSEC_TICKS_REQUIRED=4
M2K_ZONE_EXIT_MARGIN=0.10
M2K_COOLDOWN_BARS=6
M2K_MAX_STOP_POINTS=4.8
M2K_MIN_STOP_POINTS=0.6
M2K_MIN_TARGET_POINTS=1.0
M2K_STOP_BUFFER=0.2
M2K_PRIOR_LEVEL_TOLERANCE=0.6

# === BREAKEVEN STOP LADDER (BE at 1.0R) ===
M2K_MOVE_STOP_TO_BE=true
M2K_BE_ACTIVATION_R=1.0
M2K_BE_STOP_STEPS=1.0:0

# === SUB-STRATEGY TOGGLES (PB5m + PB3m + PB2m; EMAX/VR off) ===
M2K_EMAX_ENABLED=false
M2K_VR_ENABLED=false
M2K_PB3M_ENABLED=true
M2K_PB2M_ENABLED=true
M2K_VOLUME_FILTER_ENABLED=false

# === PB 5m ===
M2K_PB_MIN_IMPULSE=1.8
M2K_PB_MAX_IMPULSE=Infinity
M2K_PB_MIN_IMP_BODY_RATIO=0.40
M2K_PB_RETRACE_MIN=0.20
M2K_PB_RETRACE_MAX=0.85
M2K_PB_MAX_TIME=780
M2K_PB_LOOKBACK_BARS=3
M2K_PB_ENTRY_MODE=immediate
M2K_PB_CONFIRM_BARS=5
M2K_PB_TREND_FILTER=false
M2K_PB_TICK_ENTRY=false
M2K_PB_ZONE_EXIT_ENTRY=true

# === PB 3m ===
M2K_PB3M_MIN_IMPULSE=2.4
M2K_PB3M_MAX_IMPULSE=14.3
M2K_PB3M_LOOKBACK_BARS=4
M2K_PB3M_MAX_TIME=780
M2K_PB3M_RETRACE_MIN=0.20
M2K_PB3M_RETRACE_MAX=0.85
M2K_PB3M_MIN_IMP_BODY_RATIO=0.10
M2K_PB3M_MAX_STOP_POINTS=4.8
M2K_PB3M_MIN_STOP_POINTS=0.6
M2K_PB3M_MIN_TARGET_POINTS=1.0
M2K_PB3M_TICK_ENTRY=false
M2K_PB3M_ZONE_EXIT_ENTRY=true

# === PB 2m ===
M2K_PB2M_MIN_IMPULSE=0.5
M2K_PB2M_MAX_IMPULSE=9.5
M2K_PB2M_LOOKBACK_BARS=3
M2K_PB2M_MAX_TIME=780
M2K_PB2M_RETRACE_MIN=0.20
M2K_PB2M_RETRACE_MAX=0.85
M2K_PB2M_MIN_IMP_BODY_RATIO=0.10
M2K_PB2M_MAX_STOP_POINTS=4.8
M2K_PB2M_MIN_STOP_POINTS=0.6
M2K_PB2M_MIN_TARGET_POINTS=1.0
M2K_PB2M_TICK_ENTRY=false
M2K_PB2M_ZONE_EXIT_ENTRY=true

# === ENTRY ORDER TYPE (marketable limit — thin book, like MES) ===
M2K_ENTRY_ORDER_TYPE=Limit
M2K_ENTRY_LIMIT_BUFFER_TICKS=1
M2K_LIMIT_ENTRY_TIMEOUT_SEC=180
M2K_MAX_ENTRY_SLIPPAGE_PTS=0.3
M2K_DEFERRED_ENTRY_WINDOW_SEC=60
```
