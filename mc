#!/usr/bin/env bash
# One control script for the AI civilization server.
#   ./mc status | start | stop | restart [unit] | logs [unit] | console "<cmd>" ...
#   ./mc whitelist add|remove|list <MinecraftName>
#   ./mc bots <N>         set active bot count (1-5) and restart agents
#   ./mc budget           show API spend      ./mc backup     run a backup now
#   ./mc dashboard        print the Mission Control URL
set -euo pipefail
B=/home/hussain/minecraft-server
NODE=$B/runtime/node/bin/node
RCON="$NODE $B/agent-swarm/scripts/rcon.mjs"
UNITS=(mc-paper mc-proxy-public mc-proxy-bots mc-tunnel mc-agents)
sc() { systemctl --user "$@"; }
unit() { case "${1:-}" in paper|server) echo mc-paper;; proxy|public) echo mc-proxy-public;; botproxy) echo mc-proxy-bots;;
  tunnel|playit) echo mc-tunnel;; agents|bots) echo mc-agents;; "") echo "";; *) echo "$1";; esac; }

case "${1:-status}" in
  status)
    for u in "${UNITS[@]}"; do printf '%-16s %s\n' "$u" "$(sc is-active "$u" 2>/dev/null || true)"; done
    printf '%-16s %s\n' mc-backup.timer "$(sc is-active mc-backup.timer || true)"
    $RCON "tps" "list" 2>/dev/null | sed 's/§.//g' | grep -v '^>' || echo "(RCON unreachable — server down?)"
    ;;
  start)   sc start "${UNITS[@]}" ;;
  stop)    sc stop mc-agents mc-tunnel mc-proxy-public mc-proxy-bots mc-paper ;;
  restart) u=$(unit "${2:-}"); if [ -n "$u" ]; then sc restart "$u"; else sc restart "${UNITS[@]}"; fi ;;
  logs)    u=$(unit "${2:-agents}"); f=$B/logs/${u#mc-}.log; [ "$u" = mc-proxy-public ] && f=$B/logs/proxy-public.log
           [ "$u" = mc-proxy-bots ] && f=$B/logs/proxy-bots.log; [ "$u" = mc-tunnel ] && f=$B/logs/playit.log; tail -n 80 -f "$f" ;;
  console) shift; $RCON "$@" | sed 's/§.//g' ;;
  whitelist)
    # Humans are added by Mojang UUID (the backend looks it up because the public proxy is online-mode).
    case "${2:-list}" in
      add|remove) $RCON "whitelist ${2} ${3:?name}" | sed 's/§.//g' ;;
      list) $RCON "whitelist list" | sed 's/§.//g' ;;
    esac ;;
  bots)
    n=${2:?count 1-5}; [[ $n =~ ^[1-5]$ ]] || { echo "count must be 1-5"; exit 1; }
    sed -i "s/^BOT_COUNT=.*/BOT_COUNT=$n                    # scale up gradually: 1 → 2 → 3 → 5/" $B/agent-swarm/.env
    sc restart mc-agents; echo "Agents restarting with $n bot(s)." ;;
  budget)  python3 -c "
import json; d=json.load(open('$B/agent-swarm/logs/api-usage.json'))
t=d['today']; l=d['lifetime']
print(f\"today {d['day']}: \${t['costUsd']:.4f} over {t['calls']} calls ({t['errors']} errors)\")
print(f\"lifetime: \${l['costUsd']:.4f} over {l['calls']} calls\")
print('paused:', d.get('pausedReason'))
for k,v in d['todayByBot'].items(): print(f\"  {k:8s} \${v['costUsd']:.4f}  {v['calls']} calls\")
for k,v in d['todayByModel'].items(): print(f\"  {k:18s} \${v['costUsd']:.4f}  {v['calls']} calls  cache-read {v['cacheReadTokens']} tok\")" 2>/dev/null || echo "No API usage recorded yet." ;;
  backup)  sc start mc-backup.service && tail -n 1 $B/logs/backup.log ;;
  dashboard) echo "Mission Control: http://127.0.0.1:3010  (localhost only; from another device use an SSH tunnel: ssh -L 3010:127.0.0.1:3010 hussain@<macbook-lan-ip>)" ;;
  *) sed -n 2,8p "$0"; exit 1 ;;
esac
