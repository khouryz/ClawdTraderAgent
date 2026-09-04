#!/usr/bin/env bash
# Restart the execution bot, reliably.
#
# Why this exists: the obvious way to find the bot (querying Win32_Process for a
# node.exe whose CommandLine contains "src/index.js") is UNRELIABLE on this
# machine — it intermittently returns nothing while the bot is very much alive.
# When that happened, taskkill silently killed nothing and the follow-up launch
# started a SECOND bot that failed to bind port 8787. The old process kept
# running and kept its stale state, while the operator believed a fresh restart
# had happened. That is a silent failure at 06:00.
#
# The listening port is the source of truth: exactly one process can hold 8787.
#
# Usage:  bash scripts/restart_bot.sh
# Exit 0 = a NEW bot is up and answering /status. Any other exit = do not trade.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

PORT="${WEBHOOK_PORT:-8787}"

port_pid() {
  netstat -ano 2>/dev/null | grep LISTENING | grep ":${PORT}[^0-9]" \
    | awk '{print $NF}' | sort -u | head -1
}

OLD_PID="$(port_pid)"
if [ -n "$OLD_PID" ]; then
  echo "stopping bot on port ${PORT} (pid ${OLD_PID})"
  taskkill //PID "$OLD_PID" //F >/dev/null 2>&1
else
  echo "no process holding port ${PORT} — nothing to stop"
fi

# Wait for the port to actually free. Launching before it does gives an
# EADDRINUSE crash that only shows up in the log, not in the exit code.
for _ in $(seq 1 40); do
  [ -z "$(port_pid)" ] && break
done
if [ -n "$(port_pid)" ]; then
  echo "FAILED: port ${PORT} still held by $(port_pid) after kill" >&2
  exit 1
fi

echo "starting bot..."
nohup node src/index.js > logs/prod-restart.out 2>&1 &

# Wait for it to answer, rather than assuming. Bounded so a crash-loop cannot
# hang the caller.
for _ in $(seq 1 60); do
  if python scripts/signal_cli.py status >/dev/null 2>&1; then
    NEW_PID="$(port_pid)"
    if [ -n "$OLD_PID" ] && [ "$NEW_PID" = "$OLD_PID" ]; then
      echo "FAILED: pid unchanged (${NEW_PID}) — the old process never died" >&2
      exit 1
    fi
    echo "bot up (pid ${NEW_PID})"
    python scripts/signal_cli.py status 2>/dev/null \
      | grep -E '"connected"|"halted"|"tradesToday"|"lossLimitRemaining"|"entryCutoffPST"|"eodFlattenPST"'
    exit 0
  fi
done

echo "FAILED: bot did not answer /status after restart — check logs/prod-restart.out" >&2
tail -15 logs/prod-restart.out >&2
exit 1
