"""
Databento Live Data Stream Bridge
Streams real-time market data from Databento and outputs JSON lines to stdout.
Node.js spawns this process and reads stdout for price data.

Usage:
    python databento_stream.py --key <API_KEY> --symbol <SYMBOL> --schema <SCHEMA>

Output format (JSON lines to stdout):
    {"type":"trade","ts":"2026-01-01T12:00:00Z","price":6000.25,"size":1,"symbol":"ES.FUT"}
    {"type":"ohlcv","ts":"2026-01-01T12:00:00Z","open":6000,"high":6001,"low":5999,"close":6000.5,"volume":100,"symbol":"ES.FUT"}
    {"type":"quote","ts":"2026-01-01T12:00:00Z","bid":6000,"ask":6000.25,"bid_size":10,"ask_size":15,"symbol":"ES.FUT"}
    {"type":"status","message":"connected"}
    {"type":"error","message":"..."}
"""

import sys
import json
import argparse
import signal
import time
from datetime import datetime, timezone

def emit(data):
    """Write a JSON line to stdout for Node.js to consume."""
    try:
        print(json.dumps(data), flush=True)
    except BrokenPipeError:
        sys.exit(0)

def handle_sigterm(signum, frame):
    emit({"type": "status", "message": "shutting_down"})
    sys.exit(0)

signal.signal(signal.SIGTERM, handle_sigterm)
signal.signal(signal.SIGINT, handle_sigterm)

def format_timestamp(ts_event):
    """Convert nanosecond timestamp to ISO string."""
    if isinstance(ts_event, int):
        # Nanosecond timestamp
        seconds = ts_event / 1e9
        dt = datetime.fromtimestamp(seconds, tz=timezone.utc)
        return dt.isoformat()
    return str(ts_event)

def run_live_stream(api_key, symbol, schema, dataset):
    """Run the Databento live data stream using the iterator pattern."""
    try:
        import databento as db
    except ImportError:
        emit({"type": "error", "message": "databento package not installed. Run: pip install databento"})
        sys.exit(1)

    emit({"type": "status", "message": "connecting", "symbol": symbol, "schema": schema})

    try:
        client = db.Live(key=api_key)

        client.subscribe(
            dataset=dataset,
            schema=schema,
            stype_in="parent",
            symbols=symbol,
        )

        emit({"type": "status", "message": "connected", "symbol": symbol, "schema": schema})
        emit({"type": "status", "message": "streaming"})

        # Use the iterator pattern — the official SDK approach
        for record in client:
            try:
                record_type = type(record).__name__

                if record_type == "TradeMsg":
                    emit({
                        "type": "trade",
                        "ts": format_timestamp(record.ts_event),
                        "price": record.price / 1e9,  # Fixed-point to float
                        "size": record.size,
                        "symbol": symbol,
                        "action": str(record.action) if hasattr(record, 'action') else None,
                        "side": str(record.side) if hasattr(record, 'side') else None,
                    })

                elif record_type == "OHLCVMsg":
                    emit({
                        "type": "ohlcv",
                        "ts": format_timestamp(record.ts_event),
                        "open": record.open / 1e9,
                        "high": record.high / 1e9,
                        "low": record.low / 1e9,
                        "close": record.close / 1e9,
                        "volume": record.volume,
                        "symbol": symbol,
                    })

                elif record_type == "MBP1Msg":
                    # Top of book quote
                    if record.levels and len(record.levels) > 0:
                        level = record.levels[0]
                        emit({
                            "type": "quote",
                            "ts": format_timestamp(record.ts_event),
                            "bid": level.bid_px / 1e9 if hasattr(level, 'bid_px') else None,
                            "ask": level.ask_px / 1e9 if hasattr(level, 'ask_px') else None,
                            "bid_size": level.bid_sz if hasattr(level, 'bid_sz') else None,
                            "ask_size": level.ask_sz if hasattr(level, 'ask_sz') else None,
                            "symbol": symbol,
                        })

                elif record_type == "ErrorMsg":
                    emit({
                        "type": "error",
                        "message": str(record.err) if hasattr(record, 'err') else "Unknown error",
                    })

                elif record_type == "SystemMsg":
                    emit({
                        "type": "status",
                        "message": "system",
                        "detail": str(record.msg) if hasattr(record, 'msg') else "",
                    })

                # Ignore heartbeats and other internal messages silently

            except Exception as e:
                emit({"type": "error", "message": f"Record processing error: {str(e)}"})

        emit({"type": "status", "message": "disconnected"})

    except Exception as e:
        emit({"type": "error", "message": str(e)})
        sys.exit(1)

def run_historical(api_key, symbol, schema, dataset, start, end, limit):
    """Fetch historical data from Databento."""
    try:
        import databento as db
    except ImportError:
        emit({"type": "error", "message": "databento package not installed. Run: pip install databento"})
        sys.exit(1)

    emit({"type": "status", "message": "fetching_historical", "symbol": symbol, "schema": schema})

    try:
        client = db.Historical(api_key)

        kwargs = {
            "dataset": dataset,
            "schema": schema,
            "stype_in": "parent",
            "symbols": symbol,
            "start": start,
        }
        if end:
            kwargs["end"] = end
        if limit:
            kwargs["limit"] = int(limit)

        data = client.timeseries.get_range(**kwargs)

        records = []

        def collect_record(record):
            record_type = type(record).__name__
            if record_type == "OHLCVMsg":
                records.append({
                    "type": "ohlcv",
                    "ts": format_timestamp(record.ts_event),
                    "open": record.open / 1e9,
                    "high": record.high / 1e9,
                    "low": record.low / 1e9,
                    "close": record.close / 1e9,
                    "volume": record.volume,
                    "symbol": symbol,
                })
            elif record_type == "TradeMsg":
                records.append({
                    "type": "trade",
                    "ts": format_timestamp(record.ts_event),
                    "price": record.price / 1e9,
                    "size": record.size,
                    "symbol": symbol,
                })

        data.replay(collect_record)

        emit({
            "type": "historical",
            "count": len(records),
            "records": records,
        })

    except Exception as e:
        emit({"type": "error", "message": str(e)})
        sys.exit(1)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Databento Data Stream Bridge")
    parser.add_argument("--key", required=True, help="Databento API key")
    parser.add_argument("--symbol", default="MES.FUT", help="Symbol to subscribe (e.g., ES.FUT, MES.FUT)")
    parser.add_argument("--schema", default="trades", help="Data schema (trades, ohlcv-1s, ohlcv-1m, mbp-1, mbp-10)")
    parser.add_argument("--dataset", default="GLBX.MDP3", help="Dataset (default: GLBX.MDP3)")
    parser.add_argument("--mode", default="live", choices=["live", "historical"], help="Mode: live or historical")
    parser.add_argument("--start", default=None, help="Historical start time (ISO format)")
    parser.add_argument("--end", default=None, help="Historical end time (ISO format)")
    parser.add_argument("--limit", default=None, help="Max records for historical")

    args = parser.parse_args()

    if args.mode == "live":
        run_live_stream(args.key, args.symbol, args.schema, args.dataset)
    else:
        run_historical(args.key, args.symbol, args.schema, args.dataset, args.start, args.end, args.limit)
