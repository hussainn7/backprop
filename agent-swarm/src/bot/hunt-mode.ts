// src/bot/hunt-mode.ts
//
// Two modes, switchable in game with `!mode hunt` / `!mode game`:
//   hunt  every bot commits to killing HUNT_PLAYER while he is in survival
//   game  bots play to beat the game (the LLM brain and its skills)
// Stored in logs/hunt-mode.json so both squad processes agree and the choice
// survives restarts. Until set in game, HUNT_MODE=primary in .env means hunt.

import fs from "node:fs";
import path from "node:path";
import { huntPlayer } from "./squad.js";

export type Mode = "hunt" | "game";

const FILE = path.join("logs", "hunt-mode.json");
let cache: { mode: Mode; readAt: number } | null = null;

function defaultMode(): Mode {
  return process.env.HUNT_MODE === "primary" ? "hunt" : "game";
}

export function currentMode(): Mode {
  const now = Date.now();
  if (cache && now - cache.readAt < 2000) return cache.mode;
  let mode = defaultMode();
  try {
    const m = JSON.parse(fs.readFileSync(FILE, "utf8")).mode;
    if (m === "hunt" || m === "game") mode = m;
  } catch {
    /* never set in game: use the .env default */
  }
  cache = { mode, readAt: now };
  return mode;
}

export function setMode(mode: Mode, by: string): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ mode, by, at: new Date().toISOString() }));
  fs.renameSync(tmp, FILE);
  cache = { mode, readAt: Date.now() };
}

/** Hunting is on: a target is configured and the mode is "hunt". */
export const huntIsPrimary = (): boolean => !!huntPlayer() && currentMode() === "hunt";
