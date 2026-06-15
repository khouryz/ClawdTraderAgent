# MES — validated config reference (not yet enabled)

MES (Micro S&P, **$5/pt**) is fully supported to trade **alongside MNQ as an independent
engine** (own data stream, own orders, own per-instrument loss-limits/performance, 1 trade
at a time; both can be open at once). Enabling it is **config-only** — no code changes.

This is the validated **F1** config (momentum-v2, MES vol-matched geometry). It is **not yet
turned on** — paste the block below into each account `.env` that should trade MES and set
`INSTRUMENTS=MNQ,MES`.

## How it was derived
- **MNQ→MES volatility ratio = 6.3×** (median 1m range 18.75 vs 3.00 pts, consistent across
  TFs). MES point-params = MNQ ÷ 6.3.
- **Backtest (1yr):** ~$20,777, net/DD 12.9, 11/13 green months, both halves positive.
- Key wins over the baseline: **BE at 2.0R** (not 1.0 — lets winners reach the 2.5R target) +
  **deeper/wider retrace 0.20–0.85** (suits the mean-reverting S&P).

## ⚠️ Before live money — the slippage gate
F1 is a **thin, high-frequency edge** (~1,900 trades/yr, PF ~1.24). Stress test:
**~$10k/yr lost per TICK of entry slippage; edge dies at ~3 ticks (0.75pt) avg.** Exits are
OCO limits (no exit slippage). **Watch the order journal's realized entry `slippagePt` in the
first sessions** — if it runs ≤2 ticks the edge holds; if 3+, throttle/pause MES.

## Deploy steps
1. Deploy **off-hours** (the per-instrument data-dir change relocates loss-limit/performance
   state once on first restart).
2. Paste the `MES_*` block below into each account `.env` that trades MES.
3. Set `INSTRUMENTS=MNQ,MES` in those files.
4. Confirm root `.env` has `MAX_SIMULTANEOUS_POSITIONS=2` (lets MNQ + MES both be open).
5. Verify the MES front month (`MESM6` for June; roll to `MESU6` before the quarterly expiry).
6. On boot, confirm **two** `EFFECTIVE CONFIG` blocks + two `🔒 Locked to contract` lines.

## Config block

```env
# === MES CONFIGURATION ===
MES_SYMBOL=MESM6
MES_STRATEGY=mnq_momentum_v2
MES_DATABENTO_SYMBOL=MES.FUT
MES_AUTO_ROLLOVER=false

# === RISK MANAGEMENT (independent per-instrument) ===
MES_RISK_PER_TRADE_MIN=15
MES_RISK_PER_TRADE_MAX=90
MES_MAX_CONTRACTS=5
MES_DAILY_LOSS_LIMIT=200
MES_WEEKLY_LOSS_LIMIT=650
MES_MAX_CONSECUTIVE_LOSSES=5
MES_MAX_DRAWDOWN_PERCENT=15
MES_MAX_LOSSES_PER_DAY=5

# === SESSION ===
MES_LAST_ENTRY_HOUR=12
MES_LAST_ENTRY_MINUTE=45
MES_SKIP_HOURS=

# === TARGETS / STOPS / CONFLUENCE (F1; geometry = MNQ / 6.3) ===
MES_PROFIT_TARGET_R=2.5
MES_MIN_CONFLUENCE=5
MES_PB_MIN_CONFLUENCE=5
MES_PB3M_MIN_CONFLUENCE=5
MES_PB2M_MIN_CONFLUENCE=5
MES_CONSEC_TICKS_REQUIRED=4
MES_ZONE_EXIT_MARGIN=0.10
MES_COOLDOWN_BARS=6
MES_MAX_STOP_POINTS=6
MES_MIN_STOP_POINTS=1
MES_MIN_TARGET_POINTS=1.25
MES_STOP_BUFFER=0.25
MES_PRIOR_LEVEL_TOLERANCE=0.75

# === BREAKEVEN STOP LADDER (BE at 2.0R) ===
MES_MOVE_STOP_TO_BE=true
MES_BE_ACTIVATION_R=2.0
MES_BE_STOP_STEPS=2.0:0

# === SUB-STRATEGY TOGGLES (PB5m + PB3m + PB2m; EMAX/VR off) ===
MES_EMAX_ENABLED=false
MES_VR_ENABLED=false
MES_PB3M_ENABLED=true
MES_PB2M_ENABLED=true
MES_VOLUME_FILTER_ENABLED=false

# === PB 5m ===
MES_PB_MIN_IMPULSE=2.5
MES_PB_MAX_IMPULSE=Infinity
MES_PB_MIN_IMP_BODY_RATIO=0.40
MES_PB_RETRACE_MIN=0.20
MES_PB_RETRACE_MAX=0.85
MES_PB_MAX_TIME=780
MES_PB_LOOKBACK_BARS=3
MES_PB_ENTRY_MODE=immediate
MES_PB_CONFIRM_BARS=5
MES_PB_LIMIT_RETRACE_PCT=0.6
MES_PB_LIMIT_TIMEOUT_BARS=5
MES_PB_TREND_FILTER=false
MES_PB_TICK_ENTRY=false
MES_PB_ZONE_EXIT_ENTRY=true

# === PB 3m ===
MES_PB3M_MIN_IMPULSE=3.25
MES_PB3M_MAX_IMPULSE=19
MES_PB3M_LOOKBACK_BARS=4
MES_PB3M_MAX_TIME=780
MES_PB3M_RETRACE_MIN=0.20
MES_PB3M_RETRACE_MAX=0.85
MES_PB3M_MIN_IMP_BODY_RATIO=0.10
MES_PB3M_MAX_STOP_POINTS=6
MES_PB3M_MIN_STOP_POINTS=1
MES_PB3M_MIN_TARGET_POINTS=1
MES_PB3M_TICK_ENTRY=false
MES_PB3M_ZONE_EXIT_ENTRY=true

# === PB 2m ===
MES_PB2M_MIN_IMPULSE=0.75
MES_PB2M_MAX_IMPULSE=12.75
MES_PB2M_LOOKBACK_BARS=3
MES_PB2M_MAX_TIME=780
MES_PB2M_RETRACE_MIN=0.20
MES_PB2M_RETRACE_MAX=0.85
MES_PB2M_MIN_IMP_BODY_RATIO=0.10
MES_PB2M_MAX_STOP_POINTS=6
MES_PB2M_MIN_STOP_POINTS=1
MES_PB2M_MIN_TARGET_POINTS=1
MES_PB2M_TICK_ENTRY=false
MES_PB2M_ZONE_EXIT_ENTRY=true

# === SLIPPAGE GUARD (MES is slippage-sensitive — watch the order journal) ===
MES_MAX_ENTRY_SLIPPAGE_PTS=1.0
MES_DEFERRED_ENTRY_WINDOW_SEC=60
```
