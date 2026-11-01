// src/bot/guardian.ts
//
// Hunt guardian: every 5 s, in hunt mode, make sure every bot of this squad is
// free and closing in on the target. Uses the server's own positions (local
// RCON), so it sees both squads and the target wherever they are.
//
//   inside a block   suffocating in a wall/floor: lift straight to the surface
//   stuck            moved < 2 blocks in 25 s, not fighting (> 20 blocks out):
//                    teleport to a FREE teammate (moving or already near him,
//                    healthy, closer to him than us); none free: lift to surface
//   under his tower  within 8 blocks of him horizontally but 8+ below him: the
//                    bot is climbing after him (it pillars with cobblestone);
//                    never teleported, never counted as stuck
//   too slow         > 120 blocks out and closed < 40 blocks in 25 s (e.g. just
//                    respawned far away): teleport to a free teammate at least
//                    twice as close, else drop on open ground 25 blocks from him
//   check            the next cycles confirm the bot moves again; a bot rescued
//                    twice in 2 min without moving is lifted near the best
//                    teammate's position instead
//
// Each process rescues only its own five bots, so two squads never fight over
// one. Every cycle writes logs/guardian-<squad>.json for `mc.ps1 check`.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { ALL_BOT_NAMES, SQUAD, huntPlayer, squadBots } from "./squad.js";
import { huntIsPrimary } from "./hunt-mode.js";
import { say } from "./team-comms.js";

const CYCLE_MS = 5000;
const STUCK_MS = 25_000;
const FIGHT_RANGE = 20;
const RESCUE_COOLDOWN_MS = 20_000;
// Too slow: far out and not closing fast enough (respawned 500 blocks away,
// crawling over hills). Not stuck, but not going to arrive in time either.
const FAR_RANGE = 120;
const MIN_CLOSING = 40; // blocks closer per 25 s
const DROP_RADIUS = 25; // put far bots this far from him, on their side

interface Sample {
  pos: Vec3;
  at: number;
}

interface Track {
  history: Sample[];
  hp: number;
  lastRescueAt: number;
  rescues: number[];
  status: string;
  /** Consecutive cycles found inside a block (2 = act: real suffocation persists). */
  walled: number;
  /** Consecutive cycles spent under his tower. */
  below: number;
}

const tracks = new Map<string, Track>();
let started = false;

function rconSettings(): { port: number; password: string } | null {
  try {
    const props = fs.readFileSync(path.join("server", "server.properties"), "utf8");
    const password = props.match(/^rcon\.password=(.*)$/m)?.[1]?.trim();
    if (!password) return null;
    return { port: Number(props.match(/^rcon\.port=(\d+)$/m)?.[1] ?? 25575), password };
  } catch {
    return null;
  }
}

const parsePos = (reply: string) => {
  const m = reply.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/);
  return m ? new Vec3(Number(m[1]), Number(m[2]), Number(m[3])) : null;
};

/** Blocks travelled over the last `ms` (max distance from the current spot). */
function moved(t: Track, ms: number, now: number): number {
  const cur = t.history.at(-1)?.pos;
  if (!cur) return 0;
  return Math.max(0, ...t.history.filter((s) => now - s.at <= ms).map((s) => s.pos.distanceTo(cur)));
}

/**
 * Feet or eyes inside a solid block, as this bot's client sees it. Measured at
 * feet + 0.2 and eye height so standing on farmland, soul sand or a slab (feet
 * slightly inside the block below) does not count.
 */
function inBlock(bot: Bot): boolean {
  const p = bot.entity?.position;
  if (!p) return false;
  const solid = (y: number) => bot.blockAt(new Vec3(Math.floor(p.x), Math.floor(y), Math.floor(p.z)))?.boundingBox === "block";
  return solid(p.y + 0.2) || solid(p.y + 1.6);
}

export function startGuardian(): void {
  if (started || !huntPlayer()) return;
  started = true;
  const settings = rconSettings();
  if (!settings) {
    console.warn("[Guardian] no RCON settings in server/server.properties: guardian disabled");
    return;
  }
  const { Rcon } = createRequire(import.meta.url)("rcon-client");
  let rcon: { send: (cmd: string) => Promise<string>; end: () => Promise<void> } | null = null;
  const target = huntPlayer();
  const stateFile = path.join("logs", `guardian-${SQUAD}.json`);

  const cycle = async () => {
    if (!huntIsPrimary()) return;
    const now = Date.now();
    rcon ??= await Rcon.connect({ host: "127.0.0.1", port: settings.port, password: settings.password, timeout: 6000 });
    const send = (cmd: string) => rcon!.send(cmd);

    const him = parsePos(await send(`data get entity ${target} Pos`));
    const hisMode = (await send(`data get entity ${target} playerGameType`)).match(/: (\d)/)?.[1];
    if (!him || hisMode !== "0") return; // offline or not in survival: nothing to chase

    // Everyone's position and health, both squads.
    for (const name of ALL_BOT_NAMES) {
      const pos = parsePos(await send(`data get entity ${name} Pos`));
      if (!pos) {
        tracks.delete(name);
        continue;
      }
      const hp = Number((await send(`data get entity ${name} Health`)).match(/: ([\d.]+)f/)?.[1] ?? 20);
      const t = tracks.get(name) ?? { history: [], hp, lastRescueAt: 0, rescues: [], status: "", walled: 0, below: 0 };
      t.history.push({ pos, at: now });
      while (t.history.length && now - t.history[0].at > 60_000) t.history.shift();
      t.hp = hp;
      tracks.set(name, t);
    }

    const dist = (name: string) => tracks.get(name)?.history.at(-1)?.pos.distanceTo(him) ?? Infinity;
    const isFree = (name: string) => {
      const t = tracks.get(name);
      if (!t || t.hp < 8) return false;
      return dist(name) <= FIGHT_RANGE || moved(t, STUCK_MS, now) >= 4;
    };

    const report: Record<string, unknown> = {};
    for (const bot of squadBots()) {
      const name = bot.username;
      const t = tracks.get(name);
      if (!t || !bot.entity || bot.health <= 0) continue;
      const d = dist(name);
      const tracked = now - (t.history[0]?.at ?? now);
      const stuck = tracked >= STUCK_MS && moved(t, STUCK_MS, now) < 2 && d > FIGHT_RANGE;
      const oldest = t.history.find((s) => now - s.at <= STUCK_MS);
      const closing = oldest ? oldest.pos.distanceTo(him) - d : 0;
      const slow = !stuck && tracked >= STUCK_MS && d > FAR_RANGE && closing < MIN_CLOSING;
      t.walled = inBlock(bot) ? t.walled + 1 : 0;
      const walled = t.walled >= 2;
      const here0 = t.history.at(-1)!.pos;
      const underTower = Math.hypot(here0.x - him.x, here0.z - him.z) <= 8 && him.y - here0.y >= 8;
      t.below = underTower ? t.below + 1 : 0;
      const climbing = t.below >= 1;
      t.status = walled
        ? "inside a block"
        : climbing
          ? "climbing his tower"
          : stuck
            ? "stuck"
            : slow
              ? "too slow"
              : d <= FIGHT_RANGE
                ? "fighting"
                : "chasing";

      if ((walled || ((stuck || slow) && !climbing)) && now - t.lastRescueAt > RESCUE_COOLDOWN_MS) {
        t.lastRescueAt = now;
        t.rescues = t.rescues.filter((r) => now - r < 120_000);
        t.rescues.push(now);
        const here = t.history.at(-1)!.pos;
        // Closest free teammate that is nearer to him than we are.
        const mate = ALL_BOT_NAMES.filter((n) => n !== name && isFree(n) && dist(n) < d).sort((a, b) => dist(a) - dist(b))[0];
        let action: string;
        const nearMate = ALL_BOT_NAMES.filter((n) => n !== name && isFree(n) && dist(n) < d * 0.5).sort((a, b) => dist(a) - dist(b))[0];
        if (walled) {
          await send(`spreadplayers ${Math.floor(here.x)} ${Math.floor(here.z)} 0 1 false ${name}`);
          action = "lifted out of a block to the surface";
        } else if (slow) {
          if (nearMate) {
            await send(`tp ${name} ${nearMate}`);
            action = `too slow (${closing.toFixed(0)} blocks closer in 25 s): teleported to ${nearMate} (${dist(nearMate).toFixed(0)} blocks from ${target})`;
          } else {
            const away = here.minus(him);
            const len = Math.hypot(away.x, away.z) || 1;
            const p = him.plus(new Vec3((away.x / len) * DROP_RADIUS, 0, (away.z / len) * DROP_RADIUS));
            await send(`spreadplayers ${Math.floor(p.x)} ${Math.floor(p.z)} 0 3 false ${name}`);
            action = `too slow (${closing.toFixed(0)} blocks closer in 25 s): dropped ${DROP_RADIUS} blocks from ${target}`;
          }
          say(bot, "unstuck", `On my way back, ${target}!`, 30_000);
        } else if (mate && t.rescues.length < 3) {
          await send(`tp ${name} ${mate}`);
          action = `teleported to free teammate ${mate} (${dist(mate).toFixed(0)} blocks from ${target})`;
          say(bot, "unstuck", `Got stuck, regrouping with ${mate}. Coming for you, ${target}!`, 30_000);
        } else {
          // No free teammate, or rescued repeatedly: put it on open ground on the
          // way to him, a third of the distance closer.
          const p = mate ? tracks.get(mate)!.history.at(-1)!.pos : here.plus(him.minus(here).scaled(1 / 3));
          await send(`spreadplayers ${Math.floor(p.x)} ${Math.floor(p.z)} 0 4 false ${name}`);
          action = `lifted to open ground at ${Math.floor(p.x)} ${Math.floor(p.z)}`;
        }
        t.history = [];
        t.walled = 0;
        t.status = `rescued: ${action}`;
        console.log(`[Guardian] ${name} ${walled ? "was inside a block" : `${slow ? "far" : "stuck"} ${d.toFixed(0)} blocks from ${target}`}: ${action}`);
      }
      report[name] = {
        status: t.status,
        distance: Math.round(d),
        moved25s: +moved(t, STUCK_MS, now).toFixed(1),
        closed25s: Math.round(closing),
        hp: +t.hp.toFixed(1),
        rescuesLast2min: t.rescues.filter((r) => now - r < 120_000).length,
      };
    }
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({ at: new Date().toISOString(), target, targetPos: [him.x, him.y, him.z].map(Math.round), bots: report }, null, 1));
    } catch {
      /* status file is best effort */
    }
  };

  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    cycle()
      .catch(async (err) => {
        console.warn(`[Guardian] cycle failed: ${(err as Error).message}`);
        try {
          await rcon?.end();
        } catch {
          /* already closed */
        }
        rcon = null;
      })
      .finally(() => (running = false));
  }, CYCLE_MS).unref();
  console.log(`[Guardian] watching squad ${SQUAD}: stuck > ${STUCK_MS / 1000}s or inside a block -> teleport to a free teammate or lift to the surface`);
}
