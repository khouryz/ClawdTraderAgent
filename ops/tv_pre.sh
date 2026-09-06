#!/bin/bash
# Electron leaves SingletonLock/Cookie/Socket behind when it is killed rather
# than closed — e.g. every reboot. A stale lock pointing at a dead pid makes the
# next launch misbehave. Clear them, and wait for X so we do not race Xvfb.
# Globbed on the revision dir: the snap's config path changes when it updates.
shopt -s nullglob
for CFG in /root/snap/tradingview/*/.config/TradingView; do
  rm -f "$CFG"/SingletonLock "$CFG"/SingletonCookie "$CFG"/SingletonSocket
done
rm -rf /tmp/scoped_dir* 2>/dev/null
for i in $(seq 1 60); do
  DISPLAY=:99 xdpyinfo >/dev/null 2>&1 && exit 0
  sleep 1
done
exit 0   # never block the start; the app retries on its own
