#!/usr/bin/env bash
# Consistent world + agent-memory backup. Keeps the newest 16 archives.
set -euo pipefail
B=/home/hussain/minecraft-server
RCON="$B/runtime/node/bin/node $B/agent-swarm/scripts/rcon.mjs"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$B/backups/world-$STAMP.tar.zst"
mkdir -p "$B/backups"
running=0
if $RCON "save-off" "save-all flush" >/dev/null 2>&1; then running=1; sleep 5; fi
trap '[ $running = 1 ] && $RCON "save-on" >/dev/null 2>&1 || true' EXIT
cd "$B"
tar --zstd -cf "$OUT" \
  --exclude='server/world*/session.lock' \
  server/world server/world_nether server/world_the_end \
  server/whitelist.json server/ops.json server/server.properties \
  $(ls agent-swarm/memory-*.json agent-swarm/logs/milestones.json agent-swarm/logs/api-usage.json 2>/dev/null) 2>/dev/null || true
echo "$(date -Is) backup $(du -h "$OUT" | cut -f1) $OUT"
ls -1t "$B"/backups/world-*.tar.zst | tail -n +17 | xargs -r rm --
