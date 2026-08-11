# Backtest Data — which files to tune with

## Use these

```
C:\Users\zaidf\Desktop\ClawdTraderAgent\backtest\mes_1m_et.json
C:\Users\zaidf\Desktop\ClawdTraderAgent\backtest\mnq_1m_et.json
C:\Users\zaidf\Desktop\ClawdTraderAgent\backtest\m2k_1m_et.json
C:\Users\zaidf\Desktop\ClawdTraderAgent\backtest\mym_1m_et.json
```

412 trading days, 2025-01-02 → 2026-08-07, all four instruments.

**Drop-in compatible** with the existing tooling — identical schema to the legacy
files (`timestamp, open, high, low, close, volume, iid`, ISO-8601 UTC timestamps,
multi-contract with `iid` present). No loader changes needed; just point at the
new path.

Regenerate any time — **Databento pulls are included in the subscription and cost
nothing**:

```
python C:\Users\zaidf\Desktop\ClawdTraderAgent\backtest\fetch_et_anchored.py
```

Only the *live streaming* session cap matters (the production bot holds those).
Historical REST pulls are unaffected.

## Why the legacy library is defective for tuning

The files in `.claude\worktrees\mes-experiment\backtest\` were pulled on a **fixed
UTC window** (13:30–20:00 UTC). That equals RTH only during EDT:

```
summer (EDT)   13:30-19:59 UTC  =  09:30-15:59 ET   correct
winter (EST)   13:30-19:59 UTC  =  08:30-14:59 ET   WRONG
```

In winter that is an hour of pre-market at the front and **the entire closing hour
missing** at the back. On `mnq_6mo_1m.json`, 88 of 128 days had short coverage.

Consequences for anything tuned on them:

- Any setup that resolves in the last hour of RTH was **invisible** to the tuning.
- The EOD force-close window (15:45–16:00 ET) contains no bars at all on those
  days, so end-of-day behaviour could not be modelled.
- Indicator warmup composition differs between summer and winter, because winter
  runs include an hour of pre-market the session logic excludes.

The `*_1m_et.json` files filter on **America/New_York wall-clock time**, so the
session is 09:30–16:00 ET year-round regardless of DST. Verified: first bar 09:30
ET and last bar 15:59 ET on every day in every file.

## Also fixed in the new pull

- **Calendar-spread instruments removed.** A parent-symbol pull returns outrights
  *and* spreads; a spread quotes a month difference (tens of points) rather than
  the index level (thousands). MES dropped 14,195 such bars, MNQ 11,356. Left in,
  they poison any median/ATR/range calculation.
- **`iid` on every bar.** Some legacy files lack it entirely
  (`mnq_6mo_1m.json`: 0 of 98,620 bars), which makes front-month selection
  impossible — you cannot dedup contracts you cannot identify.

## Known caveat

All four instruments are equity indices, and the window is a **uniform bull
market** (MES +16.4% then +11.0%; MNQ +21.1% then +15.4% across a Feb-2026 split).
Any directional hypothesis — long-only bias, drift capture, short filters — is
**untestable** on this sample, because removing shorts improves results
mechanically whether or not the setup has merit. Interpret accordingly until a
bear or sideways period is available.
