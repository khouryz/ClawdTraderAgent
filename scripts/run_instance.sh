#!/usr/bin/env bash
# Start (or restart) ONE bot instance for ONE instrument.
#
#   bash scripts/run_instance.sh MNQU6 8787
#   bash scripts/run_instance.sh MESU6 8788
#
# Each instance gets its own contract, port, logs and trade files. They SHARE
# one risk ledger under data/shared, so the daily loss cap applies to the
# account as a whole rather than per instrument — recordTrade() takes a
# cross-process lock and re-reads the ledger before every decision.
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

port_pid() {
  netstat -ano 2>/dev/null | grep LISTENING | grep ":${PORT}[^0-9]" \
    | awk '{print $NF}' | sort -u | head -1
}

OLD_PID="$(port_pid)"
if [ -n "$OLD_PID" ]; then
  echo "[$SHORT] stopping pid ${OLD_PID} on port ${PORT}"
  taskkill //PID "$OLD_PID" //F >/dev/null 2>&1
fi

# Wait for the port to actually free; launching early gives an EADDRINUSE that
# only shows up in the log, not in the exit code.
for _ in $(seq 1 40); do
  [ -z "$(port_pid)" ] && break
done
if [ -n "$(port_pid)" ]; then
  echo "[$SHORT] FAILED: port ${PORT} still held by $(port_pid)" >&2
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
tail -15 "${LOG_DIR}/stdout.out" >&2
exit 1
