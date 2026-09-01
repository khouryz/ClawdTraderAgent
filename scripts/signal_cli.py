#!/usr/bin/env python3
"""
ClawdTraderAgent — Signal CLI (Python)

Send trade signals and manage the execution bot from the command line.

Usage:
  python scripts/signal_cli.py send --symbol MNQ --type long --price 19500.00 --stop 19490.00 --target 19520.00 --qty 1
  python scripts/signal_cli.py send --symbol MNQ --type short --price 19510.00 --stop 19520.00 --order-type limit
  python scripts/signal_cli.py status
  python scripts/signal_cli.py positions
  python scripts/signal_cli.py flatten

Config:
  Set WEBHOOK_TOKEN in .env or via --token flag.
  Server runs at http://127.0.0.1:8787 by default (override with --port).
"""

import argparse
import json
import os
import sys
import uuid
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

DEFAULT_PORT = 8787
DEFAULT_HOST = "127.0.0.1"


def get_token(args):
    """Load token from --token flag, env var, or .env file."""
    if args.token:
        return args.token
    if os.environ.get("WEBHOOK_TOKEN"):
        return os.environ["WEBHOOK_TOKEN"]
    # Try loading from .env
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line.startswith("WEBHOOK_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    print("ERROR: WEBHOOK_TOKEN not found. Set it in .env or pass --token.", file=sys.stderr)
    sys.exit(1)


def api_call(host, port, token, method, path, body=None):
    """Make an HTTP request to the webhook server."""
    url = f"http://{host}:{port}{path}"
    data = json.dumps(body).encode("utf-8") if body else None
    req = Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Signal-Token", token)
    if data:
        req.add_header("Content-Length", str(len(data)))
    try:
        with urlopen(req) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return resp.status, result
    except HTTPError as e:
        try:
            result = json.loads(e.read().decode("utf-8"))
        except Exception:
            result = {"error": str(e)}
        return e.code, result
    except URLError as e:
        print(f"ERROR: Cannot connect to {url} — {e.reason}", file=sys.stderr)
        print("Is the bot running? Start it with: npm start", file=sys.stderr)
        sys.exit(1)


def cmd_send(args, token):
    """Send a trade signal."""
    signal = {
        "signalId": args.signal_id or f"sig-{uuid.uuid4().hex[:12]}",
        "symbol": args.symbol,
        "type": args.type,
        "price": float(args.price),
        "stopLoss": float(args.stop),
    }

    if args.target:
        signal["targetPrice"] = float(args.target)
    if args.qty:
        signal["quantity"] = int(args.qty)
    if args.order_type:
        signal["orderType"] = args.order_type

    print(f"Sending signal: {signal['signalId']}")
    print(f"  {signal['type'].upper()} {signal['symbol']} @ {signal['price']}")
    print(f"  Stop: {signal['stopLoss']}" + (f"  Target: {signal.get('targetPrice', 'auto')}" if 'targetPrice' in signal else ""))
    print(f"  Qty: {signal.get('quantity', 'auto')}  Order: {signal.get('orderType', 'market')}")

    status, result = api_call(args.host, args.port, token, "POST", "/signal", signal)

    if status == 200 and result.get("accepted"):
        print(f"\n✅ ACCEPTED — orderId: {result.get('orderId')}")
    elif status == 200 and result.get("blocked"):
        print(f"\n🚫 BLOCKED — {result.get('reason')}")
    elif status == 200 and result.get("duplicate"):
        print(f"\n♻️  DUPLICATE — already processed (cached result)")
    else:
        print(f"\n❌ REJECTED (HTTP {status}) — {result.get('reason', result.get('error', 'unknown'))}")

    print(json.dumps(result, indent=2))
    return result


def cmd_status(args, token):
    """Get bot status."""
    status, result = api_call(args.host, args.port, token, "GET", "/status")
    print(json.dumps(result, indent=2))
    return result


def cmd_positions(args, token):
    """Get open positions."""
    status, result = api_call(args.host, args.port, token, "GET", "/positions")
    print(json.dumps(result, indent=2))
    return result


def cmd_flatten(args, token):
    """Flatten all positions."""
    status, result = api_call(args.host, args.port, token, "POST", "/flatten")
    if result.get("flattened"):
        print(f"✅ FLATTENED — orderId: {result.get('orderId')}")
    else:
        print(f"ℹ️  {result.get('reason', result.get('error', 'nothing to flatten'))}")
    print(json.dumps(result, indent=2))
    return result


def main():
    parser = argparse.ArgumentParser(description="ClawdTraderAgent Signal CLI")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Server host (default: {DEFAULT_HOST})")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Server port (default: {DEFAULT_PORT})")
    parser.add_argument("--token", help="Webhook auth token (or set WEBHOOK_TOKEN in .env)")

    sub = parser.add_subparsers(dest="command", required=True)

    # send
    p_send = sub.add_parser("send", help="Send a trade signal")
    p_send.add_argument("--symbol", required=True, help="Contract symbol (MNQ, MES, MYM, etc.)")
    p_send.add_argument("--type", required=True, choices=["long", "short"], help="Trade direction")
    p_send.add_argument("--price", required=True, type=float, help="Entry price (tick-aligned)")
    p_send.add_argument("--stop", required=True, type=float, help="Stop loss price")
    p_send.add_argument("--target", type=float, help="Target price (auto-calculated if omitted)")
    p_send.add_argument("--qty", type=int, help="Quantity (auto-calculated from risk if omitted)")
    p_send.add_argument("--order-type", choices=["market", "limit"], default="market", help="Order type (default: market)")
    p_send.add_argument("--signal-id", help="Unique ID (auto-generated if omitted)")

    # status
    sub.add_parser("status", help="Get bot status")

    # positions
    sub.add_parser("positions", help="Get open positions")

    # flatten
    sub.add_parser("flatten", help="Close all positions immediately")

    args = parser.parse_args()
    token = get_token(args)

    if args.command == "send":
        cmd_send(args, token)
    elif args.command == "status":
        cmd_status(args, token)
    elif args.command == "positions":
        cmd_positions(args, token)
    elif args.command == "flatten":
        cmd_flatten(args, token)


if __name__ == "__main__":
    main()
