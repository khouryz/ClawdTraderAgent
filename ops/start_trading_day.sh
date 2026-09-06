#!/bin/bash
# Type a prompt into the live Claude session as if you had typed it yourself.
# This is how the day starts autonomously (systemd timer, weekdays 06:00 PST)
# AND how you start it by hand:
#   bash /root/tvtools/start_trading_day.sh            # standard pre-market start
#   bash /root/tvtools/start_trading_day.sh "custom"   # anything else
set -u
export HOME=/root
SESSION=clawd
ENVF=/home/ClawdTraderAgent/.env

tg() {
  local tok cid
  tok=$(grep -oE '^TELEGRAM_BOT_TOKEN=.*' "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '\r"'"'"' ')
  cid=$(grep -oE '^TELEGRAM_CHAT_ID=.*'   "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '\r"'"'"' ')
  [ -n "$tok" ] && [ -n "$cid" ] && curl -s --max-time 10 \
    -X POST "https://api.telegram.org/bot${tok}/sendMessage" \
    --data-urlencode "chat_id=${cid}" --data-urlencode "parse_mode=HTML" \
    --data-urlencode "text=$1" >/dev/null 2>&1
}

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tg "🚨 <b>Day start FAILED</b>
No Claude session to talk to. Check: systemctl status clawd-claude"
  echo "no session — is clawd-claude.service running?"; exit 1
fi


# --- holiday guard -------------------------------------------------------
# Skip CME holidays entirely rather than starting a session that preflight will
# only block a minute later. Reads the SAME holiday list the bot enforces, so
# the two can never disagree. A one-off "skip Monday" would have to be
# remembered again at Thanksgiving; this does not.
if [ -z "${FORCE_START:-}" ]; then
  HOL=$(cd /home/ClawdTraderAgent && node -e "
    const MH = require('./src/utils/market_hours.js');
    const C = MH.MarketHours || MH.default || MH;
    let inst = null;
    try { inst = (typeof C === 'function') ? new C() : C; } catch (e) { inst = C; }
    const now = new Date();
    const dow = now.getDay();
    let hol = false;
    try { hol = !!inst.isHoliday(now); } catch (e) { hol = false; }
    console.log((dow === 0 || dow === 6) ? 'WEEKEND' : (hol ? 'HOLIDAY' : 'OK'));
  " 2>/dev/null)
  if [ "$HOL" = "HOLIDAY" ] || [ "$HOL" = "WEEKEND" ]; then
    echo "skipping: $HOL"
    tg "😴 <b>No session today</b> — $(date '+%a %d %b'): ${HOL}. The trading day was not started. (Override with FORCE_START=1.)"
    exit 0
  fi
fi

DEFAULT='Start the trading day. Read BRIEF.md and OPERATIONS.md, then MEMORY.md and every memory file it links. Run node scripts/preflight.js and fix anything it flags. CHECK THE CALENDAR FIRST: search for todays scheduled US economic releases (CPI, PPI, PCE, NFP/jobs, FOMC decision or minutes, retail sales, GDP, ISM) and any Fed speakers, with their times in PST. State what you found. Treat the 15 minutes either side of a major release as a no-entry window, and do not carry a new entry into an FOMC decision. If you cannot determine the calendar, say so explicitly rather than assuming the day is clear. Set the chart to MNQ 5m. Build the pre-market plan, then run the session on a Monitor tick loop per OPERATIONS.md, stating a heartbeat every wake-up. Follow every rule in BRIEF.md. Do not trade blind and do not weaken a guardrail.'
MSG="${1:-$DEFAULT}"

# -l sends the text literally (no key-name interpretation); Enter goes separately.
tmux send-keys -t "$SESSION" -l "$MSG"
sleep 1
tmux send-keys -t "$SESSION" Enter
echo "sent to session '$SESSION'"
# Mark the day active. The watchdog only alerts when a day was actually started
# — otherwise a session sitting idle overnight would page you every 5 minutes.
date '+%Y-%m-%d' > /root/tvtools/.day_active


# The Remote Control id only lands in the transcript once the session has handled
# a message — which is exactly what we just did. Wait for it, then send the link
# so the phone always has a direct way in.
( for i in $(seq 1 24); do
    sleep 5
    F=$(ls -t /root/.claude/projects/-home-ClawdTraderAgent/*.jsonl 2>/dev/null | head -1)
    [ -z "$F" ] && continue
    ID=$(grep -ohE 'session_[A-Za-z0-9]{20,}' "$F" 2>/dev/null | sort -u | head -1)
    if [ -n "$ID" ]; then
      tg "🟢 <b>Trading day started</b>
$(date '+%a %d %b · %H:%M %Z')
Follow along or take over from your phone:
https://claude.ai/code/${ID}"
      exit 0
    fi
  done
  tg "🟢 <b>Trading day started</b> — open the newest session in your Claude app." ) &
