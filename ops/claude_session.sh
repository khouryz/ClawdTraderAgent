#!/bin/bash
# Always-on Claude Code session for the trading system.
#
# Runs inside tmux, NOT an xterm, for two reasons: it needs a real pty (Claude
# Code is a TUI), and it must not depend on X being up. The VNC desktop attaches
# to this same session, so the phone view and the SSH view are the same session,
# not two competing ones.
#
# systemd owns the lifetime: if Claude exits, the tmux session ends, this script
# returns, and Restart=always brings up a fresh one.
set -u
export HOME=/root
export TERM=xterm-256color
cd /home/ClawdTraderAgent || exit 1

SESSION=clawd

if ! tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux new-session -d -s "$SESSION" -x 220 -y 50 "claude"
fi

# Give it time to print the Remote Control URL, then push that URL to Telegram
# so a restart is never silent — otherwise the session is alive but you have no
# idea where to find it from the phone.
(
  sleep 40
  # The Remote Control id only lands in the transcript AFTER the session has
  # handled a message, and the banner carrying the URL is not reliably in the
  # pane. So prime it with one cheap message: that creates the transcript, makes
  # the link discoverable, and proves the session is actually responsive.
  tmux send-keys -t "$SESSION" -l "Session started by systemd. Reply with exactly: READY. Nothing else, no tool calls."
  sleep 1
  tmux send-keys -t "$SESSION" Enter
  URL=""
  for i in $(seq 1 30); do
    sleep 5
    F=$(ls -t /root/.claude/projects/-home-ClawdTraderAgent/*.jsonl 2>/dev/null | head -1)
    [ -z "$F" ] && continue
    ID=$(grep -ohE 'session_[A-Za-z0-9]{20,}' "$F" 2>/dev/null | sort -u | head -1)
    [ -n "$ID" ] && { URL="https://claude.ai/code/${ID}"; break; }
  done
  TOK=$(grep -oE '^TELEGRAM_BOT_TOKEN=.*' /home/ClawdTraderAgent/.env | cut -d= -f2- | tr -d '"'"'"' ')
  CID=$(grep -oE '^TELEGRAM_CHAT_ID=.*'   /home/ClawdTraderAgent/.env | cut -d= -f2- | tr -d '"'"'"' ')
  if [ -n "$TOK" ] && [ -n "$CID" ]; then
    if [ -n "$URL" ]; then
      MSG="Claude session online - open from your phone:
${URL}"
    else
      MSG="Claude session online, but the link could not be determined. Open the newest session in your Claude app, or run: /claude"
    fi
    curl -s --max-time 10 -X POST "https://api.telegram.org/bot${TOK}/sendMessage"       --data-urlencode "chat_id=${CID}" --data-urlencode "text=${MSG}" >/dev/null 2>&1
  fi
  [ -n "$URL" ] && echo "$URL" > /root/tvtools/.session_url
) &

# Block while the session lives so systemd tracks it properly.
while tmux has-session -t "$SESSION" 2>/dev/null; do sleep 10; done
echo "tmux session ended"
