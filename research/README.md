# Research Pipeline — PB + VR Strategy Optimization

## Quick Start

### Step 1: Download Historical Data
```bash
cd C:\Users\zaidf\Desktop\ClawdTraderAgent
python research/download_historical.py --months 12
```
Downloads 12 months of MNQ 1-min OHLCV from Databento.
Saves to `research/data/mnq_1m_YYYY_YYYY.csv` and `.jsonl`.

### Step 2: Run PB Baseline (Phase 2)
```bash
node research/research_backtester.js --data research/data/mnq_1m_2025_2026.jsonl --experiment pb_baseline
```

### Step 3: Run All Experiments
```bash
node research/research_backtester.js --data research/data/mnq_1m_2025_2026.jsonl --experiment all
```

### Step 4: Context Analysis (Phase 5)
```bash
node research/analyze_results.js --dir research/results
```

## Experiments

| Name | Phase | Entry | BE | Trail | Target | Description |
|------|-------|-------|----|-------|--------|-------------|
| `pb_baseline` | 2 | Market | No | No | 2R | Raw PB edge test |
| `exec_market` | 3 | Market | No | No | 2.5R | Market entry baseline |
| `exec_limit_40` | 3 | 40% limit | No | No | 2.5R | Aggressive limit |
| `exec_limit_50` | 3 | 50% limit | No | No | 2.5R | Mid limit |
| `exec_limit_60` | 3 | 60% limit | No | No | 2.5R | Conservative limit (production) |
| `exit_none` | 4 | Market | No | No | 2.5R | No exit management |
| `exit_be2r` | 4 | Market | 2R | No | 2.5R | Break-even at 2R |
| `exit_ratchet` | 4 | Market | Ratchet | No | 2.5R | Ratchet stop |
| `vr_validation` | 6 | Market | No | No | VWAP | Simplified VR test |

## Output Files

All results go to `research/results/`:
- `<experiment>_setups.jsonl` — One row per detected setup (filled or not)
- `<experiment>_summary.json` — Aggregate statistics
- `<experiment>_context_analysis.csv` — Segmented analysis (Phase 5)
- `comparison.json` — Side-by-side comparison of all experiments

## Key Metrics

- **Expectancy per setup** (not per trade) — accounts for missed fills
- **Fill rate** — % of setups that actually execute
- **MAE/MFE** — calculated on ALL setups, including unfilled (forward-simulated)
- **Impulse size buckets** — 15-20, 20-30, 30-50, 50+ points

## Dependencies

- Python: `databento`, `pandas` (for data download)
- Node.js: Uses existing project dependencies
