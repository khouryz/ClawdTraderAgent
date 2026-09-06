#!/bin/bash
# Re-run the TradingView desktop sign-in handoff.
#
# The snap's xdg-open shim calls `snapctl user-open`, which needs a snapd
# session agent that does not exist on a headless root session — so the app can
# never launch a browser itself. We read the auth URL straight off its execve
# attempt and open it in Firefox ourselves.
#
# The `key` in that URL belongs to the RUNNING app instance. If TradingView
# restarts, the key dies and this must be re-run.
set -u
export DISPLAY=:99 HOME=/root
TVPID=$(pgrep -x tradingview | head -1)
[ -z "$TVPID" ] && { echo "TradingView is not running"; exit 1; }

DLG=$(curl -s --max-time 8 http://127.0.0.1:9223/json | python3 -c "
import sys,json
for t in json.load(sys.stdin):
    if 'dialog-window' in (t.get('url') or ''): print(t['webSocketDebuggerUrl']); break" 2>/dev/null)
[ -z "$DLG" ] && { echo "No sign-in dialog open (already signed in?)"; exit 1; }

rm -f /tmp/tvauth.strace
# SIGTERM (via timeout) makes strace DETACH; SIGKILL would leave the app wedged.
timeout 22 strace -f -p "$TVPID" -e trace=execve -s 900 -o /tmp/tvauth.strace >/dev/null 2>&1 &
sleep 3
node /root/tvtools/cdp.js "$DLG" '(()=>{const b=[...document.querySelectorAll("button")].find(x=>/sign in with browser/i.test(x.innerText));if(!b)return "no button";b.click();return "clicked";})()' >/dev/null 2>&1
wait 2>/dev/null; sleep 2

URL=$(grep -aoE 'https://auth\.tradingview\.com/accounts/tvd/connect/\?[^"]{20,300}' /tmp/tvauth.strace | head -1)
[ -z "$URL" ] && { echo "Could not capture the auth URL"; exit 1; }
[ "$(pgrep -x tradingview | head -1)" != "$TVPID" ] && { echo "App restarted — key is stale, re-run"; exit 1; }

echo "$URL" > /root/tvtools/auth_url.txt
# `pkill -x firefox` MISSES — the real binary's comm is "firefox-bin". Match the
# resolved exe path. Never `pkill -f` over SSH: it matches this script itself.
for p in /proc/[0-9]*; do
  pid=${p#/proc/}; exe=$(readlink -f "$p/exe" 2>/dev/null) || continue
  case "$exe" in */firefox*) kill -TERM "$pid" 2>/dev/null;; esac
done
sleep 4
# A killed Firefox restores its old tabs, which would show STALE auth keys
# alongside the fresh one. Drop the session so only the new tab opens.
PROF=$(grep -h "^Path=" /root/.mozilla/firefox/profiles.ini 2>/dev/null | head -1 | cut -d= -f2)
[ -n "$PROF" ] && PROF="/root/.mozilla/firefox/$PROF"
[ -n "$PROF" ] && rm -f "$PROF"/sessionstore.jsonlz4 "$PROF"/sessionstore-backups/* 2>/dev/null
setsid nohup firefox "$URL" >/tmp/ff.log 2>&1 </dev/null &
sleep 15
FF=$(xdotool search --onlyvisible --name 'Mozilla Firefox' | head -1)
[ -n "$FF" ] && { xdotool windowactivate "$FF"; xdotool windowraise "$FF"; xdotool windowsize "$FF" 1152 864; xdotool windowmove "$FF" 384 108; }
echo "Firefox opened at the auth page. Complete the sign-in over VNC."
