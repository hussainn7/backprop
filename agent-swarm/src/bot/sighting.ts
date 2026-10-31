// src/bot/sighting.ts
//
// Spotter board: when any bot sees the hunted player, it publishes where he is
// and how he is moving. Squadmates read it from memory (same process); the
// other squad reads it from logs/sighting.json (written atomically, at most
// twice a second). Hunters that cannot see him use the freshest sighting,
// projected forward by his velocity, to cut him off instead of chasing the
// spot where he was.

import fs from "node:fs";
import path from "node:path";
import { Vec3 } from "vec3";

export interface Sighting {
  pos: Vec3;
  vel: Vec3; // blocks per second, horizontal
  at: number;
  by: string;
  dimension: string;
}

const FILE = path.join("logs", "sighting.json");
let local: Sighting | null = null;
let fileCache: { s: Sighting | null; readAt: number } = { s: null, readAt: 0 };
let lastWrite = 0;

// Velocity estimate from the last two published positions of the target.
let prev: { pos: Vec3; at: number } | null = null;
let vel = new Vec3(0, 0, 0);

/** A bot that sees the target reports it. Returns true when this is a fresh spot (nobody had him for 20 s). */
export function reportSighting(pos: Vec3, by: string, dimension: string): boolean {
  const now = Date.now();
  if (prev && now - prev.at >= 250) {
    const dt = (now - prev.at) / 1000;
    const v = new Vec3((pos.x - prev.pos.x) / dt, 0, (pos.z - prev.pos.z) / dt);
    // Smooth, and ignore teleport-sized jumps (respawn, pearls).
    vel = v.norm() > 20 ? new Vec3(0, 0, 0) : vel.scaled(0.5).plus(v.scaled(0.5));
    prev = { pos: pos.clone(), at: now };
  } else if (!prev || now - prev.at > 3000) {
    prev = { pos: pos.clone(), at: now };
  }
  const fresh = !latestSighting(dimension, 20_000);
  local = { pos: pos.clone(), vel: vel.clone(), at: now, by, dimension };
  if (now - lastWrite > 500) {
    lastWrite = now;
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pos: [pos.x, pos.y, pos.z], vel: [vel.x, vel.y, vel.z], at: now, by, dimension }));
      fs.renameSync(tmp, FILE);
    } catch {
      /* the other squad simply misses this one */
    }
  }
  return fresh;
}

function readFile(): Sighting | null {
  const now = Date.now();
  if (now - fileCache.readAt < 400) return fileCache.s;
  let s: Sighting | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf8"));
    s = { pos: new Vec3(j.pos[0], j.pos[1], j.pos[2]), vel: new Vec3(j.vel[0], j.vel[1], j.vel[2]), at: j.at, by: j.by, dimension: j.dimension };
  } catch {
    s = null;
  }
  fileCache = { s, readAt: now };
  return s;
}

const sameDim = (a: string, b: string) => a.replace(/^minecraft:/, "") === b.replace(/^minecraft:/, "");

/** Freshest sighting (either squad) in this dimension, no older than maxAgeMs. */
export function latestSighting(dimension: string, maxAgeMs = 2500): Sighting | null {
  const now = Date.now();
  const candidates = [local, readFile()].filter(
    (s): s is Sighting => !!s && now - s.at <= maxAgeMs && sameDim(s.dimension, dimension),
  );
  return candidates.sort((a, b) => b.at - a.at)[0] ?? null;
}

/** Where he will be after `seconds`, by his last known velocity (capped at 4 s ahead). */
export function predict(s: Sighting, seconds: number): Vec3 {
  const t = Math.min(4, Math.max(0, seconds));
  return s.pos.plus(s.vel.scaled(t));
}
