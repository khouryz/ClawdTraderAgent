#!/usr/bin/env bash
# Restart the default single instance, using the symbol from .env.
#
# Thin wrapper over run_instance.sh so the graceful-stop, force-kill fallback
# and Telegram-on-force logic live in exactly one place.
#
#   bash scripts/restart_bot.sh
#
# Exit 0 = a NEW bot is up and answering /status. Any other exit = do not trade.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

SYMBOL="${CONTRACT_SYMBOL:-$(grep -oE '^CONTRACT_SYMBOL=.*' .env 2>/dev/null | cut -d= -f2- | tr -d '\r"'\'' ')}"
PORT="${WEBHOOK_PORT:-8787}"

if [ -z "$SYMBOL" ]; then
  echo "FAILED: no CONTRACT_SYMBOL in the environment or .env" >&2
  exit 2
fi

exec bash scripts/run_instance.sh "$SYMBOL" "$PORT"
