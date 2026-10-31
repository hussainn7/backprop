#!/usr/bin/env python3
"""Print a bot's saved inventory from Paper playerdata. Usage: inv.py <Name> [--summary]"""
import gzip, struct, collections, hashlib, uuid, sys
def offline_uuid(n):
    h = bytearray(hashlib.md5(("OfflinePlayer:" + n).encode()).digest()); h[6] = h[6] & 0x0f | 0x30; h[8] = h[8] & 0x3f | 0x80
    return str(uuid.UUID(bytes=bytes(h)))
def nbt(b):
    p = [0]
    def r(n): v = b[p[0]:p[0] + n]; p[0] += n; return v
    def s(): n = struct.unpack('>H', r(2))[0]; return r(n).decode('utf8', 'replace')
    def pay(t):
        if t in (1, 2, 3, 4, 5, 6): return struct.unpack({1: '>b', 2: '>h', 3: '>i', 4: '>q', 5: '>f', 6: '>d'}[t], r({1: 1, 2: 2, 3: 4, 4: 8, 5: 4, 6: 8}[t]))[0]
        if t == 7: n = struct.unpack('>i', r(4))[0]; return r(n)
        if t == 8: return s()
        if t == 9: et = r(1)[0]; n = struct.unpack('>i', r(4))[0]; return [pay(et) for _ in range(n)]
        if t == 10:
            d = {}
            while True:
                tt = r(1)[0]
                if tt == 0: return d
                k = s(); d[k] = pay(tt)
        if t in (11, 12): n = struct.unpack('>i', r(4))[0]; return [pay(3 if t == 11 else 4) for _ in range(n)]
    t = r(1)[0]; s(); return pay(t)
name = sys.argv[1]
d = nbt(gzip.open(f"/home/hussain/minecraft-server/server/world/playerdata/{offline_uuid(name)}.dat").read())
c = collections.Counter()
for it in d.get('Inventory', []): c[it['id'].replace('minecraft:', '')] += it.get('count', 1)
print(f"{name}: {len(d.get('Inventory', []))}/41 slots | netherite_sword={c['netherite_sword']} ender_eye={c['ender_eye']} golden_carrot={c['golden_carrot']}")
if '--summary' not in sys.argv:
    for k, v in sorted(c.items(), key=lambda x: -x[1]): print(f"{v:5d} {k}")
