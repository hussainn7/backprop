// src/bot/team-comms.ts
//
// What the hunters tell each other, and the player, in chat — plus the help
// board that backup decisions are learned from.
//
// Chat: every callout goes through say(), which rate-limits per process (one
// message per 2.5 s) and per bot and kind, so ten bots never flood chat.
//
// Help board: a bot at low health posts {who, where, hp}. Squadmates read it
// from memory; the other squad reads logs/help.json (atomic writes, ≤2/s).
// Whether to answer it is a tactic the combat learner chooses ("backup").

import fs from "node:fs";
import path from "node:path";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";

// ── Chat ────────────────────────────────────────────────────────────────────
const PROCESS_GAP_MS = 2500;
let lastProcessSay = 0;
const lastByKey = new Map<string, number>();

/** Say something in chat unless this bot said this kind of thing within `cooldownMs`. */
export function say(bot: Bot, kind: string, text: string, cooldownMs: number): boolean {
  const now = Date.now();
  const key = `${bot.username}:${kind}`;
  if (now - (lastByKey.get(key) ?? 0) < cooldownMs) return false;
  // Urgent kinds jump the process-wide gap; chatter waits for it.
  const urgent = kind === "help" || kind === "kill" || kind === "down";
  if (!urgent && now - lastProcessSay < PROCESS_GAP_MS) return false;
  lastByKey.set(key, now);
  lastProcessSay = now;
  bot.chat(text.slice(0, 240));
  return true;
}

export const fmt = (p: Vec3) => `${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`;

// ── Help board ──────────────────────────────────────────────────────────────
export interface HelpRequest {
  bot: string;
  pos: Vec3;
  hp: number;
  at: number;
  dimension: string;
}

const FILE = path.join("logs", "help.json");
const local = new Map<string, HelpRequest>();
let lastWrite = 0;
let fileCache: { list: HelpRequest[]; readAt: number } = { list: [], readAt: 0 };

function flush(): void {
  const now = Date.now();
  if (now - lastWrite < 500) return;
  lastWrite = now;
  try {
    // Merge with the other squad's live entries so neither overwrites the other.
    const mine = new Set(local.keys());
    const others = readFile().filter((r) => !mine.has(r.bot) && now - r.at < 6000);
    const all = [...local.values(), ...others].map((r) => ({ ...r, pos: [r.pos.x, r.pos.y, r.pos.z] }));
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, FILE);
  } catch {
    /* the other squad misses this update */
  }
}

function readFile(): HelpRequest[] {
  const now = Date.now();
  if (now - fileCache.readAt < 400) return fileCache.list;
  let list: HelpRequest[] = [];
  try {
    list = (JSON.parse(fs.readFileSync(FILE, "utf8")) as Array<Omit<HelpRequest, "pos"> & { pos: number[] }>).map((r) => ({
      ...r,
      pos: new Vec3(r.pos[0], r.pos[1], r.pos[2]),
    }));
  } catch {
    list = [];
  }
  fileCache = { list, readAt: now };
  return list;
}

/** A hurt bot keeps its request fresh every tick while hurt. */
export function requestHelp(bot: string, pos: Vec3, hp: number, dimension: string): void {
  local.set(bot, { bot, pos: pos.clone(), hp, at: Date.now(), dimension });
  flush();
}

export function clearHelp(bot: string): void {
  if (local.delete(bot)) {
    lastWrite = 0;
    flush();
  }
}

const sameDim = (a: string, b: string) => a.replace(/^minecraft:/, "") === b.replace(/^minecraft:/, "");

/** Live help requests (both squads) in this dimension, excluding `self`, nearest first. */
export function helpRequests(self: string, from: Vec3, dimension: string, maxDist = 40): HelpRequest[] {
  const now = Date.now();
  const byBot = new Map<string, HelpRequest>();
  for (const r of [...readFile(), ...local.values()]) {
    if (r.bot === self || now - r.at > 4000 || !sameDim(r.dimension, dimension)) continue;
    const prev = byBot.get(r.bot);
    if (!prev || prev.at < r.at) byBot.set(r.bot, r);
  }
  return [...byBot.values()].filter((r) => r.pos.distanceTo(from) <= maxDist).sort((a, b) => a.pos.distanceTo(from) - b.pos.distanceTo(from));
}
