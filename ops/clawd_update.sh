#!/bin/bash
# Pull new code, but only accept it if it PASSES ITS OWN TESTS and only when it
# is safe to restart. Auto-deploying into a live trading system is how a bad
# commit becomes a bad fill, so this is deliberately conservative:
#
#   1. refuses to run while either bot holds a position or a working order
#   2. fast-forward only — never merges, never rewrites local work
#   3. runs npm test on the NEW code; on failure it rolls back to the exact
#      previous commit and leaves the bots untouched
#   4. only restarts the bots when the tests are green AND something changed
#
# Telegrams the outcome either way, because a silent deploy is worse than none.
set -u
export HOME=/root
REPO=/home/ClawdTraderAgent
BRANCH=$(cd "$REPO" && git rev-parse --abbrev-ref HEAD)
ENVF="$REPO/.env"

tg() {
  local tok cid
  tok=$(grep -oE '^TELEGRAM_BOT_TOKEN=.*' "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '\r"'"'"' ')
  cid=$(grep -oE '^TELEGRAM_CHAT_ID=.*'   "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '\r"'"'"' ')
  [ -n "$tok" ] && [ -n "$cid" ] && curl -s --max-time 10 \
    -X POST "https://api.telegram.org/bot${tok}/sendMessage" \
    --data-urlencode "chat_id=${cid}" --data-urlencode "parse_mode=HTML" \
    --data-urlencode "text=$1" >/dev/null 2>&1
}

cd "$REPO" || exit 1

# --- 1. never deploy over an open position -------------------------------
for p in 8787 8788; do
  R=$(python3 scripts/signal_cli.py --port "$p" positions 2>/dev/null)
  [ -z "$R" ] && continue
  N=$(echo "$R" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(len(d.get('positions') or []) + len(d.get('workingOrders') or []))
except Exception: print(0)" 2>/dev/null)
  if [ "${N:-0}" != "0" ]; then
    echo "port $p has $N position(s)/order(s) — refusing to deploy"
    tg "⏸ <b>Update skipped</b> — ${p} has open exposure. Will not deploy over a live position."
    exit 0
  fi
done

# --- 2. is there anything new? -------------------------------------------
BEFORE=$(git rev-parse HEAD)
timeout 60 git fetch origin "$BRANCH" --quiet 2>/dev/null || { echo "fetch failed"; exit 1; }
REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null || echo "")
[ -z "$REMOTE" ] && { echo "no remote branch"; exit 1; }
if [ "$BEFORE" = "$REMOTE" ]; then
  echo "already up to date at ${BEFORE:0:8}"
  exit 0
fi

# Local commits that are not pushed would be destroyed by a reset later; bail.
if ! git merge-base --is-ancestor "$BEFORE" "$REMOTE"; then
  echo "local branch has diverged — refusing to auto-pull"
  tg "⚠️ <b>Update refused</b> — the server has local commits not on origin. Resolve by hand."
  exit 1
fi

# --- 3. take it, then prove it ------------------------------------------
git pull --ff-only --quiet origin "$BRANCH" || { tg "🚨 <b>Update failed</b> — git pull --ff-only errored."; exit 1; }
AFTER=$(git rev-parse HEAD)
npm ci --omit=dev --silent >/dev/null 2>&1 || npm install --silent >/dev/null 2>&1

if npm test > /tmp/deploy_test.log 2>&1; then
  # Operational scripts are versioned in ops/ but RUN from /root/tvtools, so the
  # running copy is only replaced once the new code has passed its tests.
  install -m 755 "$REPO"/ops/*.sh "$REPO"/ops/*.py /root/tvtools/ 2>/dev/null || true
  systemctl restart clawd-mnq clawd-mes
  sleep 25
  OK=0
  for p in 8787 8788; do
    python3 scripts/signal_cli.py --port "$p" status >/dev/null 2>&1 && OK=$((OK+1))
  done
  tg "🚀 <b>Deployed</b> ${BEFORE:0:8} → ${AFTER:0:8}
$(git log -1 --pretty=%s)
Tests green · ${OK}/2 bots answering after restart."
  echo "deployed $AFTER"
else
  git reset --hard --quiet "$BEFORE"
  tg "🛑 <b>Update ROLLED BACK</b>
${REMOTE:0:8} failed its own tests, so it was reverted to ${BEFORE:0:8}. The bots were NOT restarted and are still running the old code.
$(tail -5 /tmp/deploy_test.log | head -3)"
  echo "tests failed — rolled back to $BEFORE"
  exit 1
fi
