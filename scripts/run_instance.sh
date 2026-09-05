#!/usr/bin/env bash
# Start (or restart) ONE bot instance for ONE instrument.
#
#   bash scripts/run_instance.sh MNQU6 8787
#   bash scripts/run_instance.sh MESU6 8788
#
# Each instance gets its own contract, port, logs, data and clean-shutdown
# marker. They SHARE one risk ledger under data/shared, so the daily loss cap
# applies to the account as a whole: recordTrade() takes a cross-process lock
# and re-reads the ledger before every decision.
#
# Stopping is GRACEFUL first (POST /shutdown), so the bot writes its
# clean-shutdown marker and sends the Telegram offline alert itself. Only if it
# refuses to go away do we force-kill — and because taskkill /F cannot be caught
# by any process, THIS SCRIPT sends the alert in that case. You get a Telegram
# message either way.
#
# Exit 0 = a NEW process is up and answering /status. Any other exit = do not trade.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

SYMBOL="${1:-}"
PORT="${2:-}"
if [ -z "$SYMBOL" ] || [ -z "$PORT" ]; then
  echo "usage: run_instance.sh <CONTRACT_SYMBOL> <PORT>   e.g. run_instance.sh MNQU6 8787" >&2
  exit 2
fi

SHORT="$(echo "$SYMBOL" | cut -c1-3)"
export CONTRACT_SYMBOL="$SYMBOL"
export WEBHOOK_PORT="$PORT"
export LOG_DIR="./logs/${SHORT}"
export DATA_DIR="./data/${SHORT}"
export LOSS_LIMITS_DIR="./data/shared"      # shared on purpose — one loss budget

mkdir -p "$LOG_DIR" "$DATA_DIR" "$LOSS_LIMITS_DIR"

# Telegram straight from the script, for the one case the bot cannot report:
# being force-killed. Reads .env without echoing the secrets.
notify() {
  local msg="$1" tok cid
  tok="$(grep -oE '^TELEGRAM_BOT_TOKEN=.*' .env 2>/dev/null | cut -d= -f2- | tr -d '\r"'\'' ')"
  cid="$(grep -oE '^TELEGRAM_CHAT_ID=.*'   .env 2>/dev/null | cut -d= -f2- | tr -d '\r"'\'' ')"
  if [ -n "$tok" ] && [ -n "$cid" ]; then
    curl -s --max-time 10 -X POST "https://api.telegram.org/bot${tok}/sendMessage" \
      --data-urlencode "chat_id=${cid}" \
      --data-urlencode "parse_mode=HTML" \
      --data-urlencode "text=${msg}" >/dev/null 2>&1 || true
  fi
}

port_pid() {
  netstat -ano 2>/dev/null | grep LISTENING | grep ":${PORT}[^0-9]" \
    | awk '{print $NF}' | sort -u | head -1
}

OLD_PID="$(port_pid)"
if [ -n "$OLD_PID" ]; then
  echo "[$SHORT] asking pid ${OLD_PID} to stop gracefully..."
  python scripts/signal_cli.py --port "$PORT" shutdown >/dev/null 2>&1

  # Give it time to flatten its bookkeeping, alert, and release the port.
  for _ in $(seq 1 60); do
    [ -z "$(port_pid)" ] && break
    sleep 0.25 2>/dev/null || true
  done

  if [ -n "$(port_pid)" ]; then
    STUCK="$(port_pid)"
    echo "[$SHORT] did not stop gracefully — forcing (pid ${STUCK})" >&2
    taskkill //PID "$STUCK" //F >/dev/null 2>&1
    # The bot cannot report a SIGKILL, so say it on its behalf.
    notify "🛑 <b>Bot force-stopped — ${SHORT}</b>
${SYMBOL} on port ${PORT} ignored a graceful shutdown and was killed.
No clean-shutdown marker was written, so check the broker for stray orders."
  fi
fi

for _ in $(seq 1 40); do
  [ -z "$(port_pid)" ] && break
done
if [ -n "$(port_pid)" ]; then
  echo "[$SHORT] FAILED: port ${PORT} still held by $(port_pid)" >&2
  notify "🚨 <b>Restart FAILED — ${SHORT}</b>
Port ${PORT} is still held; ${SYMBOL} did not restart. The bot is NOT running."
  exit 1
fi

echo "[$SHORT] starting ${SYMBOL} on ${PORT} (logs ${LOG_DIR}, data ${DATA_DIR}, ledger ${LOSS_LIMITS_DIR})"
nohup node src/index.js > "${LOG_DIR}/stdout.out" 2>&1 &

for _ in $(seq 1 60); do
  if python scripts/signal_cli.py --port "$PORT" status >/dev/null 2>&1; then
    NEW_PID="$(port_pid)"
    if [ -n "$OLD_PID" ] && [ "$NEW_PID" = "$OLD_PID" ]; then
      echo "[$SHORT] FAILED: pid unchanged (${NEW_PID}) — the old process never died" >&2
      exit 1
    fi
    echo "[$SHORT] up (pid ${NEW_PID})"
    python scripts/signal_cli.py --port "$PORT" status 2>/dev/null \
      | grep -E '"connected"|"halted"|"tradesToday"|"lossLimitRemaining"'
    exit 0
  fi
done

echo "[$SHORT] FAILED: no /status after restart — check ${LOG_DIR}/stdout.out" >&2
notify "🚨 <b>Start FAILED — ${SHORT}</b>
${SYMBOL} did not answer /status after restarting. The bot is NOT running."
tail -15 "${LOG_DIR}/stdout.out" >&2
exit 1
