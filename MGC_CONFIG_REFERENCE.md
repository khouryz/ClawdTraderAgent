# MGC — validated config reference (4th instrument; metals diversification)

MGC (Micro Gold, **$10/pt, tick 0.10**) trades **alongside MNQ + MES + M2K as a fully
independent engine** — own Databento feed (multiplexed into the existing 2 python sessions,
**zero new streams**), own orders, own per-instrument loss-limits / performance / journals,
1 trade at a time, marketable-limit entry.

## ⚠️ Required code change (shipped)
MGC was **added to the `CONTRACTS` map** (`src/utils/constants.js`): `tickSize 0.10,
tickValue 1.0, pointValue 10`. Without it the order layer would fall back to MES specs and
mis-size/mis-round MGC. (This is the only code change — everything else is config.)

## How it was derived
- **MNQ→MGC volatility ratio = 5.54×** (front-month-deduped median RTH 1m range: MNQ 15.5 /
  MGC 2.8 pts; gold ≈ MES's % volatility). Point-params = MNQ ÷ 5.54, tick-rounded to 0.10.
  ⚠️ Gold lists *monthly* contracts, so the raw parent feed is full of illiquid back-month
  bars — vol/correlation were measured on **front-month-deduped** data (via the loader).
- **Edge (full year, deterministic, generic scaled config — no MGC-specific tuning):**
  +$26,922, PF ~2.0, **13/13 green months**. **OOS-confirmed**: H1 +$8,467 / **H2 (out-of-sample)
  +$18,669 at PF 1.90** — both halves green → not overfit. Best first-pass of any micro tested.
- **Trim to ~5 quality trades/day:** the clean lever is the **entry cutoff** (gold's edge is a
  morning phenomenon; the afternoon is dead). Confluence-6 over-filters (gold rarely hits 6/6),
  dropping PB2m hurts PF, cooldown barely trims. Chosen: **cutoff 10:30 PT**.
- **Trimmed + $200 daily-loss-limit, Mar–Jun 2026:** +$10,340, PF 2.25, net/DD 17.0, maxDD
  $609, 4/4 green; 5.1 trades/day; avgWin +$172 / avgLoss −$70. June 2026: **+$1,022 net after
  commission** (gross +$1,148, −$126 commission @ $1.08/RT), 56 trades, 117 contracts (~2.1/trade).

## ⚠️ Honest caveats before live money
- **NOT a clean diversifier in this regime.** Gold ran **+0.61 daily-return correlation** with
  MNQ/MES this year (the gold-*and*-equities "everything rally," $3,450→$4,334). It won't reduce
  correlated drawdowns in a melt-up. Its *driver* is different (real rates / USD / geopolitics),
  so it decouples in genuine risk-off — partial crisis-hedge, not all-weather. Pair with an
  account-level cap / correlation guard as the book grows.
- **Slippage gate:** deterministic edge survives to **~5 ticks** of entry slippage (more robust
  than MES's ~3) — so the 2-tick marketable-limit keeps it well inside the safe zone. Still,
  **watch the order journal's realized `slippagePt`** in the first sessions.
- **Commission drag is real:** the BE-heavy, ~5/day profile pays a lot of round-turns (~$126/mo
  on MGC at $1.08/RT ≈ 11% of gross). Numbers above already net it out.
- **Deterministic backtest** (slippage off, 100% fills) — live with the limit entry runs a bit
  under (some signals won't fill / fill late).

## Deploy steps
1. Deploy **off-hours / when flat** (per-instrument data-dir relocates loss-limit state once on
   first restart).
2. Paste the `MGC_*` block below into **account1.env** (and any account that should trade MGC).
3. Set `INSTRUMENTS=MNQ,MES,MGC` (or +M2K) and bump root `MAX_SIMULTANEOUS_POSITIONS`.
4. **Verify the front month.** Gold uses the EVEN-month cycle (G/J/M/Q/V/Z); as of mid-June the
   active contract is ~**Aug (MGCQ6)**, not the equity quarter (U6). Confirm before enabling.
5. On boot, confirm a 4th `EFFECTIVE CONFIG` block: `specs=$10/pt tick=0.1`, distinct
   `[isolation] dataDir`, `ENTRY MODE 🎯 LIMIT … verified`, and a `🔒 Locked to contract` line.

## Config block (account1.env)

```env
# === MGC CONFIGURATION (4th instrument; geometry = MNQ / 5.54) ===
MGC_SYMBOL=MGCQ6              # VERIFY front month (gold even-month cycle G/J/M/Q/V/Z; mid-Jun ≈ Q6)
MGC_STRATEGY=mnq_momentum_v2
MGC_DATABENTO_SYMBOL=MGC.FUT
MGC_AUTO_ROLLOVER=false

# === RISK (independent per-instrument) ===
MGC_RISK_PER_TRADE_MIN=15
MGC_RISK_PER_TRADE_MAX=90
MGC_MAX_CONTRACTS=10
MGC_DAILY_LOSS_LIMIT=200
MGC_WEEKLY_LOSS_LIMIT=750
MGC_MAX_CONSECUTIVE_LOSSES=5
MGC_MAX_DRAWDOWN_PERCENT=15
MGC_MAX_LOSSES_PER_DAY=5

# === SESSION (entry cutoff 10:30 PT — trims the dead gold afternoon) ===
MGC_LAST_ENTRY_HOUR=10
MGC_LAST_ENTRY_MINUTE=30
MGC_SKIP_HOURS=

# === TARGETS / STOPS / CONFLUENCE (R2.5; geometry = MNQ / 5.54, tick 0.10) ===
MGC_PROFIT_TARGET_R=2.5
MGC_MIN_CONFLUENCE=5
MGC_PB_MIN_CONFLUENCE=5
MGC_PB3M_MIN_CONFLUENCE=5
MGC_PB2M_MIN_CONFLUENCE=5
MGC_CONSEC_TICKS_REQUIRED=4
MGC_ZONE_EXIT_MARGIN=0.10
MGC_COOLDOWN_BARS=6
MGC_MAX_STOP_POINTS=7.2
MGC_MIN_STOP_POINTS=0.9
MGC_MIN_TARGET_POINTS=1.4
MGC_STOP_BUFFER=0.4
MGC_PRIOR_LEVEL_TOLERANCE=0.9

# === BREAKEVEN LADDER (BE at 1.0R) ===
MGC_MOVE_STOP_TO_BE=true
MGC_BE_ACTIVATION_R=1.0
MGC_BE_STOP_STEPS=1.0:0

# === SUB-STRATEGY TOGGLES (PB5m + PB3m + PB2m; EMAX/VR off) ===
MGC_EMAX_ENABLED=false
MGC_VR_ENABLED=false
MGC_PB3M_ENABLED=true
MGC_PB2M_ENABLED=true
MGC_VOLUME_FILTER_ENABLED=false

# === PB 5m ===
MGC_PB_MIN_IMPULSE=2.7
MGC_PB_MAX_IMPULSE=Infinity
MGC_PB_MIN_IMP_BODY_RATIO=0.40
MGC_PB_RETRACE_MIN=0.20
MGC_PB_RETRACE_MAX=0.85
MGC_PB_MAX_TIME=780
MGC_PB_LOOKBACK_BARS=3
MGC_PB_ENTRY_MODE=immediate
MGC_PB_CONFIRM_BARS=5
MGC_PB_TREND_FILTER=false
MGC_PB_TICK_ENTRY=false
MGC_PB_ZONE_EXIT_ENTRY=true

# === PB 3m ===
MGC_PB3M_MIN_IMPULSE=3.6
MGC_PB3M_MAX_IMPULSE=21.7
MGC_PB3M_LOOKBACK_BARS=4
MGC_PB3M_MAX_TIME=780
MGC_PB3M_RETRACE_MIN=0.20
MGC_PB3M_RETRACE_MAX=0.85
MGC_PB3M_MIN_IMP_BODY_RATIO=0.10
MGC_PB3M_MAX_STOP_POINTS=7.2
MGC_PB3M_MIN_STOP_POINTS=0.9
MGC_PB3M_MIN_TARGET_POINTS=1.4
MGC_PB3M_TICK_ENTRY=false
MGC_PB3M_ZONE_EXIT_ENTRY=true

# === PB 2m ===
MGC_PB2M_MIN_IMPULSE=0.7
MGC_PB2M_MAX_IMPULSE=14.4
MGC_PB2M_LOOKBACK_BARS=3
MGC_PB2M_MAX_TIME=780
MGC_PB2M_RETRACE_MIN=0.20
MGC_PB2M_RETRACE_MAX=0.85
MGC_PB2M_MIN_IMP_BODY_RATIO=0.10
MGC_PB2M_MAX_STOP_POINTS=7.2
MGC_PB2M_MIN_STOP_POINTS=0.9
MGC_PB2M_MIN_TARGET_POINTS=1.4
MGC_PB2M_TICK_ENTRY=false
MGC_PB2M_ZONE_EXIT_ENTRY=true

# === ENTRY ORDER TYPE (marketable limit — 2-tick buffer, 90s cancel, like MES) ===
MGC_ENTRY_ORDER_TYPE=Limit
MGC_ENTRY_LIMIT_BUFFER_TICKS=2
MGC_LIMIT_ENTRY_TIMEOUT_SEC=90
MGC_MAX_ENTRY_SLIPPAGE_PTS=0.5
MGC_DEFERRED_ENTRY_WINDOW_SEC=60
```

## Backtest summary (deterministic, slippage off, commission on)
| Window | Trades/day | Net | PF | net/DD | Green |
|---|---|---|---|---|---|
| Full year (untrimmed) | 7.3 | +$26,922 | ~2.0 | 19.4 | 13/13 |
| H2 out-of-sample (untrimmed) | 7.8 | +$18,669 | 1.90 | 20.4 | 7/7 |
| Trimmed (10:30 + $200 DLL) Mar–Jun | 5.1 | +$10,340 | 2.25 | 17.0 | 4/4 |
| Trimmed June (net after $1.08/RT comm) | 4.9 | +$1,022 | 1.65 | — | 1/1 |
