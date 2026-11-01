#!/usr/bin/env bash
# Appends a one-line-per-squad race summary every 60 s, plus every new chat line, to logs/race-overnight.log.
cd "$(dirname "$0")/.." || exit 1
K=$(cat logs/race-key.txt)
LAST=0
while true; do
  curl -s --max-time 25 "http://localhost:3020/api/race?k=$K" | python -c "
import json,sys,time
last=$LAST
try: d=json.load(sys.stdin)
except Exception: sys.exit()
ts=time.strftime('%H:%M:%S')
for s in d['squads']:
  if s.get('offline'): print(ts,s['squad'],'OFFLINE'); continue
  st=s.get('stronghold'); on=sum(1 for b in s['bots'] if b['online'])
  print(ts,s['squad'],s['phase'],'online',on,'rods',s['rods'],'eyes',s['eyes'],'sh',(round(st['x']),round(st['z'])) if st else None,'portal',s.get('endPortal'))
for c in d['chat']:
  if c['at']>last: print(ts,'chat',c['text'][:200])
print(d['chat'][-1]['at'] if d['chat'] else last, file=sys.stderr)
" >> logs/race-overnight.log 2> /tmp/race-last.txt
  L=$(tail -1 /tmp/race-last.txt 2>/dev/null); [[ "$L" =~ ^[0-9]+$ ]] && LAST=$L
  sleep 60
done
