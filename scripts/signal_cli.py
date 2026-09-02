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
        # The webhook already lowercases and re-capitalises this, so either
        # form works over the wire. Sent capitalised anyway so the payload
        # matches what SignalHandler compares against, which makes a captured
        # request readable without tracing it through the validator.
        signal["orderType"] = {"market": "Market", "limit": "Limit", "stop": "Stop"}[args.order_type]
    if getattr(args, "entry_timeout", None):
        signal["entryTimeoutSec"] = int(args.entry_timeout)
    if getattr(args, "ref_price", None):
        # Current market price as YOU read it off the chart. The bot uses this
        # to verify a Stop entry is on the correct side. Tradovate has no REST
        # quote endpoint, so the sender is the only reliable source -- omit it
        # and the wrong-side check is skipped entirely.
        signal["refPrice"] = float(args.ref_price)

    # Multi-target exits: --exits "qty1@price1,qty2@price2"
    if args.exits:
        legs = []
        for part in args.exits.split(","):
            part = part.strip()
            if not part:
                continue
            q, p = part.split("@")
            legs.append({"qty": int(q.strip()), "targetPrice": float(p.strip())})
        signal["exits"] = legs
    if args.move_be:
        signal["moveStopToBEAfterFirstTarget"] = True

    print(f"Sending signal: {signal['signalId']}")
    print(f"  {signal['type'].upper()} {signal['symbol']} @ {signal['price']}")
    print(f"  Stop: {signal['stopLoss']}" + (f"  Target: {signal.get('targetPrice', 'auto')}" if 'targetPrice' in signal else ""))
    if 'exits' in signal:
        print(f"  Exits: {len(signal['exits'])} legs: " + ", ".join(f"{l['qty']}@{l['targetPrice']}" for l in signal['exits']))
    print(f"  Qty: {signal.get('quantity', 'auto')}  Order: {signal.get('orderType', 'market')}")

    status, result = api_call(args.host, args.port, token, "POST", "/signal", signal)

    # Order matters: a dedup'd retry comes back with accepted:true AND
    # duplicate:true. Checking accepted first made it print as a fresh accept,
    # which reads as "a second order was placed" when none was.
    if status == 200 and result.get("duplicate"):
        print(f"\n[DUPLICATE] already processed — no new order. Cached orderId: {result.get('orderId')}")
    elif status == 200 and result.get("accepted"):
        print(f"\n[OK] ACCEPTED — orderId: {result.get('orderId')}")
    elif status == 200 and result.get("blocked"):
        print(f"\n[BLOCKED] {result.get('reason')}")
    else:
        print(f"\n[REJECTED] (HTTP {status}) — {result.get('reason', result.get('error', 'unknown'))}")

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
        if result.get("cancelledEntry"):
            print(f"[OK] ENTRY CANCELLED -- resting order {result.get('orderId')} pulled, no position was open")
        else:
            print(f"[OK] FLATTENED -- orderId: {result.get('orderId')}")
    else:
        print(f"[INFO] {result.get('reason', result.get('error', 'nothing to flatten'))}")
    print(json.dumps(result, indent=2))
    return result


def cmd_resume(args, token):
    """Clear a halt. Needed because a halt persists to disk and only auto-clears
    when the UTC date changes -- a WEBSOCKET_DEAD halt taken overnight can
    survive into a same-UTC-date session and block every signal."""
    status, result = api_call(args.host, args.port, token, "POST", "/resume")
    if result.get("resumed"):
        print(f"[OK] RESUMED -- cleared halt: {result.get('clearedHalt')}")
    else:
        print(f"[INFO] {result.get('reason', result.get('error', 'nothing to clear'))}")
    print(json.dumps(result, indent=2))
    return result


def cmd_cancel_all(args, token):
    """Cancel every working order. Refuses while a position is open unless
    --force, because a live position's working orders ARE its stop and target."""
    body = {"force": True} if getattr(args, "force", False) else {}
    status, result = api_call(args.host, args.port, token, "POST", "/cancel-all", body)
    if result.get("refused"):
        print(f"[REFUSED] {result.get('reason')}")
    elif result.get("cancelled"):
        print(f"[OK] CANCELLED {result.get('cancelledCount')}/{result.get('total')} working orders"
              + (f" ({result.get('failed')} failed)" if result.get("failed") else ""))
    else:
        print(f"[FAILED] {result.get('error', 'unknown')}")
    print(json.dumps(result, indent=2))
    return result


def cmd_modify(args, token):
    """Modify a working order (e.g. move stop)."""
    payload = {"orderId": args.order_id}
    if args.stop_price:
        payload["stopPrice"] = args.stop_price
    if args.price:
        payload["price"] = args.price
    if args.qty:
        payload["orderQty"] = args.qty

    status, result = api_call(args.host, args.port, token, "POST", "/modify", payload)
    if result.get("modified"):
        print(f"\n[OK] MODIFIED -- orderId: {result.get('orderId')}")
    else:
        print(f"\n[FAILED] {result.get('reason', result.get('error', 'unknown'))}")
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
    p_send.add_argument("--order-type", choices=["market", "limit", "stop"], default="market", help="Order type (default: market). 'stop' rests until price trades through --price — use for break-of-signal-bar entries.")
    p_send.add_argument("--ref-price", type=float, default=None, help="Current market price from the chart; enables the wrong-side check on stop entries")
    p_send.add_argument("--entry-timeout", type=int, default=None, help="Seconds a resting Limit/Stop entry may work before it is cancelled (default 180 for limit, 900 for stop)")
    p_send.add_argument("--signal-id", help="Unique ID (auto-generated if omitted)")
    p_send.add_argument("--exits", help='Multi-target exits: "qty1@price1,qty2@price2" (e.g. "1@19520.00,1@19540.00")')
    p_send.add_argument("--move-be", action="store_true", help="Move remaining stops to breakeven after first target fills")

    # status
    sub.add_parser("status", help="Get bot status")

    # positions
    sub.add_parser("positions", help="Get open positions and working orders (with prices)")

    # flatten
    sub.add_parser("flatten", help="Close all positions immediately (cancels a resting entry if flat)")

    # resume
    sub.add_parser("resume", help="Clear a halt (e.g. WEBSOCKET_DEAD) so signals are accepted again")

    # cancel-all
    p_cancel = sub.add_parser("cancel-all", help="Cancel every working order (refuses while a position is open)")
    p_cancel.add_argument("--force", action="store_true", help="Cancel even with a position open -- this STRIPS its stop and target")

    # modify
    p_modify = sub.add_parser("modify", help="Modify a working order (move stop, change price/qty)")
    p_modify.add_argument("--order-id", type=int, required=True, help="Order ID to modify")
    p_modify.add_argument("--stop-price", type=float, help="New stop price")
    p_modify.add_argument("--price", type=float, help="New limit/stop price")
    p_modify.add_argument("--qty", type=int, help="New order quantity")

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
    elif args.command == "resume":
        cmd_resume(args, token)
    elif args.command == "cancel-all":
        cmd_cancel_all(args, token)
    elif args.command == "modify":
        cmd_modify(args, token)


if __name__ == "__main__":
    main()
