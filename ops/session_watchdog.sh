#!/bin/bash
# Alerts if the Claude session goes quiet DURING a trading day.
#
# clawd-claude.service restarts Claude if the process dies — but a session that
# is alive and simply stuck produces no alert at all. That is exactly the 3 Sep
# failure: the loop stopped, nothing crashed, and the afternoon was missed.
#
# Activity signal: the session transcript's mtime. It advances on every tool
# call and message, so a stale transcript during RTH means no work is happening.
set -u
export HOME=/root
ENVF=/home/ClawdTraderAgent/.env
PROJ=/root/.claude/projects/-home-ClawdTraderAgent
STALE_MIN=12          # quiet for this long during RTH = suspicious
COOLDOWN_MIN=30       # do not re-alert more often than this
STAMP=/root/tvtools/.watchdog_last_alert

tg() {
  local tok cid
  tok=$(grep -oE '^TELEGRAM_BOT_TOKEN=.*' "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '\r"'"'"' ')
  cid=$(grep -oE '^TELEGRAM_CHAT_ID=.*'   "$ENVF" 2>/dev/null | cut -d= -f2- | tr -d '\r"'"'"' ')
  [ -n "$tok" ] && [ -n "$cid" ] && curl -s --max-time 10 \
    -X POST "https://api.telegram.org/bot${tok}/sendMessage" \
    --data-urlencode "chat_id=${cid}" --data-urlencode "parse_mode=HTML" \
    --data-urlencode "text=$1" >/dev/null 2>&1
}

# Only during a day that was actually started.
TODAY=$(date '+%Y-%m-%d')
[ -f /root/tvtools/.day_active ] || exit 0
[ "$(cat /root/tvtools/.day_active 2>/dev/null)" = "$TODAY" ] || exit 0


# Never alert on a non-session day, even if .day_active is stale — a FORCE_START
# test can leave that marker set on a weekend.
DOW=$(date '+%u')
if [ "$DOW" -ge 6 ]; then exit 0; fi
if (cd /home/ClawdTraderAgent && node -e "
  const MH=require('./src/utils/market_hours.js');
  const C=MH.MarketHours||MH.default||MH;
  let i=null; try { i=(typeof C==='function')?new C():C; } catch(e){ i=C; }
  let h=false; try { h=!!i.isHoliday(new Date()); } catch(e){}
  process.exit(h?0:1);
" 2>/dev/null); then exit 0; fi

# Only inside RTH (06:30–13:00 PST). The server clock is America/Los_Angeles.


HM=$(date '+%H%M'); HM=$((10#$HM))
[ "$HM" -ge 630 ] && [ "$HM" -le 1300 ] || exit 0

# Cooldown
if [ -f "$STAMP" ]; then
  AGE=$(( ( $(date +%s) - $(stat -c %Y "$STAMP") ) / 60 ))
  [ "$AGE" -lt "$COOLDOWN_MIN" ] && exit 0
fi

# 1. Is the session even there?
if ! tmux has-session -t clawd 2>/dev/null; then
  tg "🚨 <b>Claude session is GONE</b> during RTH.
systemd should restart it — check: systemctl status clawd-claude"
  date > "$STAMP"; exit 0
fi


# A usage limit is not "stuck" — restarting does nothing and it clears itself at
# a stated time. Detect it so the alert says what to actually do.
LIM=$(tmux capture-pane -p -J -t clawd -S -40 2>/dev/null | grep -oiE "hit your (session|usage) limit[^|]{0,60}" | tail -1)
if [ -n "$LIM" ]; then
  tg "🟠 <b>Claude hit its usage limit</b> mid-session ($(date '+%H:%M %Z')).
${LIM}
Restarting will NOT help — it clears on its own. The loop has stopped and will not resume by itself: re-send the day-start once usage resets (bash /root/tvtools/start_trading_day.sh), or trade manually until then.
Positions are still protected by broker-side stops."
  date > "$STAMP"; exit 0
fi

# 2. Has it done anything recently?
F=$(ls -t "$PROJ"/*.jsonl 2>/dev/null | head -1)
if [ -z "$F" ]; then exit 0; fi
QUIET=$(( ( $(date +%s) - $(stat -c %Y "$F") ) / 60 ))
if [ "$QUIET" -ge "$STALE_MIN" ]; then
  tg "⚠️ <b>Claude session quiet for ${QUIET} min</b> during RTH ($(date '+%H:%M %Z')).
It is running but has produced nothing. It may be stuck, rate-limited, or the loop may have ended.
Check it: https://claude.ai/code/$(grep -ohE 'session_[A-Za-z0-9]{20,}' "$F" 2>/dev/null | sort -u | head -1)"
  date > "$STAMP"
fi
