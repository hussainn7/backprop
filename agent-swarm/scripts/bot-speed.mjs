#!/usr/bin/env node
// Measures every bot's real speed over a short window and what it says it is doing.
// Usage: node scripts/bot-speed.mjs [seconds=25]   (needs the race page running on :3020)
import fs from "fs";
import http from "http";

const secs = Number(process.argv[2] || 25);
const key = fs.readFileSync("logs/race-key.txt", "utf8").trim();
const get = () =>
  new Promise((res) => {
    http
      .get({ host: "localhost", port: 3020, path: `/api/race?k=${key}`, timeout: 30000 }, (r) => {
        let b = "";
        r.on("data", (c) => (b += c));
        r.on("end", () => {
          try {
            res(JSON.parse(b));
          } catch {
            res(null);
          }
        });
      })
      .on("error", () => res(null));
  });
const flatten = (d) => {
  const m = new Map();
  for (const s of d?.squads ?? []) for (const b of s.bots ?? []) m.set(b.name, { ...b, squad: s.squad });
  return m;
};
const A = flatten(await get());
await new Promise((r) => setTimeout(r, secs * 1000));
const B = flatten(await get());
const rows = [];
for (const [n, y] of B) {
  const x = A.get(n);
  const spd = x?.pos && y.pos ? Math.hypot(y.pos[0] - x.pos[0], y.pos[2] - x.pos[2]) / secs : null;
  rows.push({ n, sq: y.squad, spd, doing: y.doing, dim: y.dim });
}
rows.sort((p, q) => (p.spd ?? -1) - (q.spd ?? -1));
for (const r of rows) {
  console.log(`${r.n.padEnd(8)} ${r.sq.padEnd(8)} ${r.spd == null ? "offline" : r.spd.toFixed(1).padStart(4) + " b/s"}  ${String(r.dim).slice(0, 5).padEnd(5)} ${String(r.doing).slice(0, 62)}`);
}
const online = rows.filter((r) => r.spd != null);
console.log(`\n${online.filter((r) => r.spd > 1).length}/${online.length} online bots moving faster than 1 block/s; mean ${(online.reduce((s, r) => s + r.spd, 0) / Math.max(1, online.length)).toFixed(1)} b/s`);
