"""
Download 12 months of MNQ 1-minute OHLCV data from Databento.

Saves to research/data/mnq_1m_YYYY.csv with columns:
  timestamp, open, high, low, close, volume

Usage:
  python research/download_historical.py

Requires: pip install databento pandas
"""

import os
import sys
import json
import argparse
from datetime import datetime, timezone, timedelta

# Load .env manually (avoid extra dependency)
def load_env(env_path):
    env = {}
    if not os.path.exists(env_path):
        return env
    with open(env_path, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, val = line.split('=', 1)
            env[key.strip()] = val.strip()
    return env

def main():
    parser = argparse.ArgumentParser(description="Download MNQ 1-min OHLCV from Databento")
    parser.add_argument("--months", type=int, default=12, help="Months of history to download (default 12)")
    parser.add_argument("--symbol", default="MNQ.FUT", help="Symbol (default MNQ.FUT)")
    parser.add_argument("--output-dir", default=None, help="Output directory")
    args = parser.parse_args()

    # Load API key from .env
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = load_env(os.path.join(project_root, '.env'))
    api_key = env.get('DATABENTO_API_KEY') or os.environ.get('DATABENTO_API_KEY')

    if not api_key:
        print("ERROR: DATABENTO_API_KEY not found in .env or environment")
        sys.exit(1)

    try:
        import databento as db
    except ImportError:
        print("ERROR: databento package not installed. Run: pip install databento")
        sys.exit(1)

    try:
        import pandas as pd
    except ImportError:
        print("ERROR: pandas package not installed. Run: pip install pandas")
        sys.exit(1)

    # Output directory
    output_dir = args.output_dir or os.path.join(project_root, 'research', 'data')
    os.makedirs(output_dir, exist_ok=True)

    # Date range: N months back from today
    end_date = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    start_dt = datetime.now(timezone.utc) - timedelta(days=args.months * 30)
    start_date = start_dt.strftime('%Y-%m-%d')

    print(f"=" * 60)
    print(f"  Databento Historical Data Download")
    print(f"=" * 60)
    print(f"  Symbol:     {args.symbol}")
    print(f"  Schema:     ohlcv-1m")
    print(f"  Dataset:    GLBX.MDP3")
    print(f"  Range:      {start_date} → {end_date}")
    print(f"  Output:     {output_dir}")
    print(f"=" * 60)

    # Download in monthly chunks to manage memory and provide progress
    client = db.Historical(api_key)

    all_records = []
    current = start_dt
    end_dt = datetime.now(timezone.utc)
    chunk_num = 0

    while current < end_dt:
        chunk_end = min(current + timedelta(days=30), end_dt)
        chunk_start_str = current.strftime('%Y-%m-%dT00:00:00Z')
        chunk_end_str = chunk_end.strftime('%Y-%m-%dT00:00:00Z')
        chunk_num += 1

        print(f"\n  [{chunk_num}] Fetching {current.strftime('%Y-%m-%d')} → {chunk_end.strftime('%Y-%m-%d')} ...")

        try:
            data = client.timeseries.get_range(
                dataset="GLBX.MDP3",
                schema="ohlcv-1m",
                stype_in="parent",
                symbols=args.symbol,
                start=chunk_start_str,
                end=chunk_end_str,
            )

            # Convert to DataFrame
            df = data.to_df()

            if len(df) == 0:
                print(f"       → 0 bars (no data)")
                current = chunk_end
                continue

            # Databento returns fixed-point prices (divide by 1e9 for display-price)
            # When using to_df(), prices are already converted to float
            # Columns: open, high, low, close, volume, ts_event (index)

            # Normalize column names
            if 'ts_event' in df.columns:
                df = df.rename(columns={'ts_event': 'timestamp'})
            elif df.index.name == 'ts_event':
                df.index.name = 'timestamp'
                df = df.reset_index()

            # Keep only OHLCV columns
            needed = ['timestamp', 'open', 'high', 'low', 'close', 'volume']
            available = [c for c in needed if c in df.columns]
            if 'timestamp' not in available and df.index.name == 'timestamp':
                df = df.reset_index()
                available = [c for c in needed if c in df.columns]

            df = df[available]
            all_records.append(df)

            print(f"       → {len(df)} bars")

        except Exception as e:
            print(f"       → ERROR: {e}")
            # Continue to next chunk

        current = chunk_end

    if not all_records:
        print("\nERROR: No data downloaded!")
        sys.exit(1)

    # Combine all chunks
    combined = pd.concat(all_records, ignore_index=True)

    # Sort by timestamp and deduplicate
    combined = combined.sort_values('timestamp').drop_duplicates(subset=['timestamp'], keep='first')

    # Filter to CME session hours only (Sun 5PM CT - Fri 4PM CT)
    # For the backtester, we keep all bars and let the strategy handle session filtering

    # Save as CSV
    output_file = os.path.join(output_dir, f"mnq_1m_{start_date[:4]}_{end_date[:4]}.csv")
    combined.to_csv(output_file, index=False)

    # Also save as JSONL for faster Node.js processing
    jsonl_file = os.path.join(output_dir, f"mnq_1m_{start_date[:4]}_{end_date[:4]}.jsonl")
    with open(jsonl_file, 'w') as f:
        for _, row in combined.iterrows():
            record = {
                'timestamp': str(row['timestamp']),
                'open': float(row['open']),
                'high': float(row['high']),
                'low': float(row['low']),
                'close': float(row['close']),
                'volume': int(row['volume']) if 'volume' in row else 0,
            }
            f.write(json.dumps(record) + '\n')

    print(f"\n{'=' * 60}")
    print(f"  ✓ Downloaded {len(combined)} bars")
    print(f"  ✓ Date range: {combined['timestamp'].iloc[0]} → {combined['timestamp'].iloc[-1]}")
    print(f"  ✓ CSV:   {output_file}")
    print(f"  ✓ JSONL: {jsonl_file}")
    print(f"{'=' * 60}")

    # Print basic stats
    if 'volume' in combined.columns:
        print(f"\n  Stats:")
        print(f"    Avg volume/bar: {combined['volume'].mean():.0f}")
        print(f"    Avg range/bar:  {(combined['high'] - combined['low']).mean():.2f} pts")
        print(f"    Total days:     ~{len(combined) // 390}")  # ~390 bars per CME session

if __name__ == "__main__":
    main()
