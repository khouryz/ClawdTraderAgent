#!/bin/bash
# Roll the traded contract to the next quarter automatically.
#
# Expiry is the third Friday; we roll 8 days before it, which is the same rule
# Zaid uses by hand ("roll before Thu 10 Sep" for an 18 Sep expiry). Forgetting
# a roll means trading a contract into expiry, or — worse — the chart quietly
# showing a different instrument than the bots trade, since MNQ1! rolls on its
# own schedule.
#
# Refuses to roll over an open position. Announces every change.
set -u
export HOME=/root
ENVF=/home/ClawdTraderAgent/.env
WHEN="${ROLL_TEST_DATE:-}"     # for testing only

tg() {
  local tok cid
  tok=$(grep -oE '^TELEGRAM_BOT_TOKEN=.*' "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '\r"'"'"' ')
  cid=$(grep -oE '^TELEGRAM_CHAT_ID=.*'   "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '\r"'"'"' ')
  [ -n "$tok" ] && [ -n "$cid" ] && curl -s --max-time 10 \
    -X POST "https://api.telegram.org/bot${tok}/sendMessage" \
    --data-urlencode "chat_id=${cid}" --data-urlencode "parse_mode=HTML" \
    --data-urlencode "text=$1" >/dev/null 2>&1
}

cd /home/ClawdTraderAgent || exit 1

CHANGED=""
for pair in "mnq:MNQ:8787" "mes:MES:8788"; do
  key=${pair%%:*}; rest=${pair#*:}; prefix=${rest%%:*}; port=${rest##*:}
  read -r NEW EXP DAYS <<< "$(python3 /root/tvtools/front_contract.py "$prefix" $WHEN)"
  CUR=$(grep -oE '^CONTRACT_SYMBOL=.*' "/etc/clawd/${key}.env" | cut -d= -f2)
  if [ "$CUR" = "$NEW" ]; then
    echo "$prefix: $CUR unchanged (expires $EXP, ${DAYS}d)"
    continue
  fi

  # Never roll with exposure on the old contract.
  R=$(python3 scripts/signal_cli.py --port "$port" positions 2>/dev/null)
  N=$(echo "$R" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin); print(len(d.get('positions') or []) + len(d.get('workingOrders') or []))
except Exception: print(0)" 2>/dev/null)
  if [ "${N:-0}" != "0" ]; then
    echo "$prefix: ROLL BLOCKED — $N open position(s)/order(s) on $CUR"
    tg "⚠️ <b>Roll blocked — ${prefix}</b>
${CUR} → ${NEW} could not be applied: ${N} open position(s)/order(s). Flatten, then re-run /root/tvtools/clawd_roll.sh"
    continue
  fi

  if [ -n "$WHEN" ]; then
    echo "$prefix: WOULD roll $CUR -> $NEW (dry run, ROLL_TEST_DATE=$WHEN)"
    continue
  fi
  echo "CONTRACT_SYMBOL=$NEW" > "/etc/clawd/${key}.env"
  CHANGED="$CHANGED ${prefix}: ${CUR} → ${NEW}"
  echo "$prefix: rolled $CUR -> $NEW"
done

[ -z "$CHANGED" ] && exit 0
systemctl daemon-reload
systemctl restart clawd-mnq clawd-mes
sleep 25
OUT=""
for p in 8787 8788; do
  S=$(python3 scripts/signal_cli.py --port "$p" status 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin); s=d.get('status',d); print('%s ok' % s.get('instrument'))
except Exception: print('NO RESPONSE')" 2>/dev/null)
  OUT="$OUT
  :$p $S"
done
tg "🔄 <b>Contract rolled</b>${CHANGED}

After restart:${OUT}

The CHART is separate — MNQ1! follows its own roll schedule. Check it still matches what the bots trade."
