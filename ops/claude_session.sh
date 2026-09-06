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
  sleep 45
  URL=$(tmux capture-pane -p -J -t "$SESSION" -S -300 2>/dev/null \
        | grep -oE 'https://claude\.ai/code/session_[A-Za-z0-9]+' | head -1)
  TOK=$(grep -oE '^TELEGRAM_BOT_TOKEN=.*' /home/ClawdTraderAgent/.env | cut -d= -f2- | tr -d '\r"'"'"' ')
  CID=$(grep -oE '^TELEGRAM_CHAT_ID=.*'   /home/ClawdTraderAgent/.env | cut -d= -f2- | tr -d '\r"'"'"' ')
  if [ -n "$URL" ] && [ -n "$TOK" ] && [ -n "$CID" ]; then
    curl -s --max-time 10 -X POST "https://api.telegram.org/bot${TOK}/sendMessage" \
      --data-urlencode "chat_id=${CID}" --data-urlencode "parse_mode=HTML" \
      --data-urlencode "text=🧠 <b>Claude session online</b>
Open from your phone: ${URL}" >/dev/null 2>&1
  fi
) &

# Block while the session lives so systemd tracks it properly.
while tmux has-session -t "$SESSION" 2>/dev/null; do sleep 10; done
echo "tmux session ended"
