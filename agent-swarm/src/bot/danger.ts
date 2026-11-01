// src/bot/danger.ts
//
// Shared memory of where bots died, so every route planned afterwards prices
// those spots up and goes around them. Nothing about the world is hardcoded:
// the map is learned from deaths and persists in logs/danger-zones.json, which
// all squad processes read and merge into (atomic writes, best effort).
//
// A zone is a death position in one dimension. Deaths within MERGE blocks of an
// existing zone raise its count instead of adding a new one. The step cost the
// pathfinder pays for a block near a zone grows with the count and fades with
// distance, capped so a bad spot is avoided rather than made impassable.

import fs from "node:fs";
import path from "node:path";

export interface Zone {
  dim: string;
  x: number;
  y: number;
  z: number;
  count: number;
  last: string;
}

const FILE = path.join("logs", "danger-zones.json");
const MERGE = 10;
const RADIUS = 9;
const MAX_ZONES = 300;

let zones: Zone[] = [];
let loadedAt = 0;

function load(): void {
  if (Date.now() - loadedAt < 15_000) return;
  loadedAt = Date.now();
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(raw)) zones = raw.filter((z) => z && typeof z.x === "number");
  } catch {
    /* first run */
  }
}

function save(): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(zones));
    fs.renameSync(tmp, FILE);
  } catch {
    /* best effort */
  }
}

export function dimKey(dimension: unknown): string {
  const d = String(dimension ?? "");
  return d.includes("nether") ? "nether" : d.includes("end") ? "end" : "overworld";
}

/** Record a death; merges into a nearby zone when there is one. */
export function recordDeath(dim: string, pos: { x: number; y: number; z: number }): void {
  loadedAt = 0;
  load();
  const hit = zones.find((z) => z.dim === dim && Math.hypot(z.x - pos.x, z.y - pos.y, z.z - pos.z) <= MERGE);
  if (hit) {
    hit.count++;
    hit.last = new Date().toISOString();
  } else {
    zones.push({ dim, x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), count: 1, last: new Date().toISOString() });
    if (zones.length > MAX_ZONES) zones.sort((a, b) => b.count - a.count || Date.parse(b.last) - Date.parse(a.last)).length = MAX_ZONES;
  }
  save();
}

/** Extra step cost for standing at `p` in `dim`: 0 far from every zone, up to 40 at a repeat killer. */
export function dangerCost(dim: string, p: { x: number; y: number; z: number }): number {
  load();
  let cost = 0;
  for (const z of zones) {
    if (z.dim !== dim) continue;
    const d = Math.hypot(z.x - p.x, z.y - p.y, z.z - p.z);
    if (d > RADIUS) continue;
    cost += Math.min(40, 8 + 8 * z.count) * (1 - d / RADIUS);
  }
  return Math.min(cost, 40);
}

export function dangerZones(): Zone[] {
  load();
  return zones;
}

/** Test hook. */
export function _setZones(z: Zone[]): void {
  zones = z;
  loadedAt = Date.now() + 3_600_000;
}
