#!/bin/bash
# Snapshot the memory directory.
#
# Memory is the only place the system's learning survives a restart, and it lives
# in exactly one directory on one box. A bad edit, a wrong deletion, or a rebuild
# loses everything learned. This keeps 30 daily snapshots so any of that is
# recoverable.
#
# It is NOT offsite. The repo is public, so memory (which names infrastructure)
# does not belong in it. Offsite backup is still an open decision.
set -u
SRC=/root/.claude/projects/-home-ClawdTraderAgent/memory
DST=/root/memory-backups
mkdir -p "$DST"
[ -d "$SRC" ] || exit 0

STAMP=$(date '+%Y-%m-%d')
tar -czf "$DST/memory-$STAMP.tar.gz" -C "$(dirname "$SRC")" "$(basename "$SRC")" 2>/dev/null

# Prune to the last 30
ls -1t "$DST"/memory-*.tar.gz 2>/dev/null | tail -n +31 | xargs -r rm -f

N=$(ls -1 "$SRC"/*.md 2>/dev/null | wc -l)
IDX=$(grep -c '^- \[' "$SRC/MEMORY.md" 2>/dev/null || echo 0)
echo "snapshot $STAMP: $N files, $IDX index entries, $(ls -1 "$DST"/memory-*.tar.gz | wc -l) snapshots kept"

# Integrity: every index entry must resolve, and every file must be indexed.
BROKEN=""
while read -r f; do [ -f "$SRC/$f" ] || BROKEN="$BROKEN $f"; done < <(grep -oE '\]\([a-z0-9-]+\.md\)' "$SRC/MEMORY.md" 2>/dev/null | tr -d ']()')
ORPHAN=""
for f in "$SRC"/*.md; do b=$(basename "$f"); [ "$b" = "MEMORY.md" ] && continue
  grep -q "($b)" "$SRC/MEMORY.md" 2>/dev/null || ORPHAN="$ORPHAN $b"; done
if [ -n "$BROKEN" ] || [ -n "$ORPHAN" ]; then
  TOK=$(grep -oE '^TELEGRAM_BOT_TOKEN=.*' /home/ClawdTraderAgent/.env | cut -d= -f2- | tr -d '\r"'"'"' ')
  CID=$(grep -oE '^TELEGRAM_CHAT_ID=.*'   /home/ClawdTraderAgent/.env | cut -d= -f2- | tr -d '\r"'"'"' ')
  [ -n "$TOK" ] && curl -s --max-time 10 -X POST "https://api.telegram.org/bot${TOK}/sendMessage" \
    --data-urlencode "chat_id=${CID}" \
    --data-urlencode "text=Memory index is inconsistent.
Index entries with no file:${BROKEN:- none}
Files missing from the index:${ORPHAN:- none}
A memory nothing points at is a memory that will not be read." >/dev/null 2>&1
  echo "  INCONSISTENT — broken:${BROKEN:- none} orphans:${ORPHAN:- none}"
fi
