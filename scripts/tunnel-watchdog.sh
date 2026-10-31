#!/usr/bin/env bash
# Restart playit if its control session is stuck failing to re-register
# (seen 2026-10-31: "RegisterUnauthorized" loop after a Wi-Fi blip; tunnel dead until restart).
LOG=/home/hussain/minecraft-server/logs/playit.log
tail -n 40 "$LOG" | sed 's/\x1b\[[0-9;]*m//g' > /tmp/playit-tail.$$
last_ok=$(grep -n "tunnels loaded" /tmp/playit-tail.$$ | tail -1 | cut -d: -f1)
last_bad=$(grep -n "RegisterUnauthorized" /tmp/playit-tail.$$ | tail -1 | cut -d: -f1)
bad_count=$(grep -cE "RegisterUnauthorized" /tmp/playit-tail.$$)
rm -f /tmp/playit-tail.$$
if [ -n "$last_bad" ] && [ "${last_ok:-0}" -lt "$last_bad" ] && [ "$bad_count" -ge 3 ]; then
  echo "$(date -Is) playit stuck re-registering ($bad_count failures) — restarting"
  systemctl --user restart mc-tunnel
fi
