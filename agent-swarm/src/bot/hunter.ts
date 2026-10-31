// src/bot/hunter.ts
//
// HUNT_MODE=primary: while HUNT_PLAYER is in survival mode, every bot drops
// what it is doing and hunts him down. The brain is paused for the duration
// (its skills and squad logic would otherwise steer the bot away mid-chase)
// and resumed when he leaves survival, logs off, or changes dimension.
//
// Position: the live entity when it is within tracking range, otherwise the
// server's own record of where he is, read over local RCON every 1.5 s, so
// bots can find him anywhere in their dimension. The RCON password stays in
// server.properties on this machine; bots themselves never send commands.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
import { huntPlayer } from "./squad.js";
import { baseMoves } from "./navigation.js";
import { abortActiveSkill, isSkillRunning } from "../skills/executor.js";

const { goals } = pkg;

export const huntIsPrimary = (): boolean => !!huntPlayer() && process.env.HUNT_MODE === "primary";

// ── Server-side tracker (one per process, shared by its five bots) ─────────
interface Tracked {
  pos: Vec3;
  dimension: string;
  at: number;
}
let tracked: Tracked | null = null;
let trackerStarted = false;

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

function startTracker(name: string): void {
  if (trackerStarted) return;
  trackerStarted = true;
  const settings = rconSettings();
  if (!settings) {
    console.warn("[Hunt] no RCON settings in server/server.properties — bots only see the target within tracking range");
    return;
  }
  const { Rcon } = createRequire(import.meta.url)("rcon-client");
  let rcon: { send: (cmd: string) => Promise<string>; end: () => Promise<void> } | null = null;
  const poll = async () => {
    try {
      rcon ??= await Rcon.connect({ host: "127.0.0.1", port: settings.port, password: settings.password, timeout: 3000 });
      const pos = await rcon!.send(`data get entity ${name} Pos`);
      const m = pos.match(/\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/);
      if (!m) {
        tracked = null; // offline
        return;
      }
      const dim = (await rcon!.send(`data get entity ${name} Dimension`)).match(/"([^"]+)"/)?.[1] ?? "minecraft:overworld";
      tracked = { pos: new Vec3(Number(m[1]), Number(m[2]), Number(m[3])), dimension: dim, at: Date.now() };
    } catch {
      tracked = null;
      try {
        await rcon?.end();
      } catch {
        /* already closed */
      }
      rcon = null;
    }
  };
  void poll();
  setInterval(() => void poll(), 1500).unref();
}

// ── Unbreakable armor (UNBREAKABLE_ARMOR=true) ─────────────────────────────
// Every 20 s, through the same local RCON, mark every online player's armor
// and off-hand item (the shield) unbreakable and fully repaired. Idempotent,
// so both squad processes may run it; empty slots are simply skipped.
let armorKeeperStarted = false;
const UNBREAKABLE = '{function:"minecraft:set_components",components:{"minecraft:unbreakable":{},"minecraft:damage":0}}';

export function startArmorKeeper(): void {
  if (armorKeeperStarted || process.env.UNBREAKABLE_ARMOR !== "true") return;
  armorKeeperStarted = true;
  const settings = rconSettings();
  if (!settings) {
    console.warn("[Armor] no RCON settings in server/server.properties — cannot keep armor unbreakable");
    return;
  }
  const { Rcon } = createRequire(import.meta.url)("rcon-client");
  const apply = async () => {
    try {
      const rcon = await Rcon.connect({ host: "127.0.0.1", port: settings.port, password: settings.password, timeout: 3000 });
      for (const slot of ["armor.head", "armor.chest", "armor.legs", "armor.feet", "weapon.offhand"]) {
        await rcon.send(`item modify entity @a ${slot} ${UNBREAKABLE}`);
      }
      await rcon.end();
    } catch (err) {
      console.warn(`[Armor] unbreakable pass failed: ${(err as Error).message}`);
    }
  };
  void apply();
  setInterval(() => void apply(), 20_000).unref();
}

const sameDimension = (a: string, b: string | undefined) =>
  a.replace(/^minecraft:/, "") === String(b ?? "").replace(/^minecraft:/, "");

// ── Per-bot chase ───────────────────────────────────────────────────────────
interface Pausable {
  pause(): void;
  resume(): void;
}

/** Attack cooldown for the held weapon: a full-charge hit every swing. */
function swingMs(bot: Bot): number {
  const held = bot.heldItem?.name ?? "";
  if (held.endsWith("_sword")) return 650;
  if (held.endsWith("_axe")) return held.startsWith("wooden") || held.startsWith("stone") ? 1300 : 1050;
  return 300;
}

function equipBestWeapon(bot: Bot): void {
  const order = ["netherite", "diamond", "iron", "stone", "golden", "wooden"];
  const rank = (n: string) => {
    const tier = order.findIndex((t) => n.startsWith(t));
    return (tier < 0 ? 9 : tier) * 2 + (n.endsWith("_sword") ? 0 : 1); // sword before axe of a tier
  };
  const best = bot.inventory
    .items()
    .filter((i) => i.name.endsWith("_sword") || i.name.endsWith("_axe"))
    .sort((a, b) => rank(a.name) - rank(b.name))[0];
  if (best && bot.heldItem?.name !== best.name) void bot.equip(best, "hand").catch(() => {});
}

const OFFHAND_SLOT = 45;

const shieldInOffhand = (bot: Bot) => bot.inventory.slots[OFFHAND_SLOT]?.name === "shield";

/**
 * Keep a carried shield in the off-hand at all times (every bot carried one in
 * its pack, unused). A totem of undying already there stays: it saves a life.
 * With the shield in place the pvp plugin can block in ordinary mob fights too.
 */
export function startShieldKeeper(bot: Bot): void {
  const iv = setInterval(() => {
    if (!bot.entity || bot.health <= 0 || shieldInOffhand(bot)) return;
    if (bot.inventory.slots[OFFHAND_SLOT]?.name === "totem_of_undying") return;
    const shield = bot.inventory.items().find((i) => i.name === "shield");
    if (shield) void bot.equip(shield, "off-hand").catch(() => {});
  }, 3000);
  bot.once("end", () => clearInterval(iv));
}

export function startHunter(bot: Bot, brain: Pausable): void {
  const name = huntPlayer();
  if (!huntIsPrimary()) return;
  startTracker(name);

  let hunting = false;
  let lastSwing = 0;
  let lastGoal: Vec3 | null = null;
  let followed: Entity | null = null;
  let lastEquip = 0;
  let lastLog = 0;
  let blocking = false;

  // A raised shield slows the bot to sneaking speed: lower it to run or swing.
  const lowerShield = () => {
    if (!blocking) return;
    blocking = false;
    bot.deactivateItem();
  };

  const stop = (why: string) => {
    if (!hunting) return;
    lowerShield();
    hunting = false;
    followed = null;
    lastGoal = null;
    bot.pathfinder?.setGoal(null);
    console.log(`[Hunt] ${bot.username} stops hunting ${name}: ${why}`);
    brain.resume();
  };

  const tick = () => {
    if (!bot.entity || bot.health <= 0) return;
    const info = bot.players[name];
    if (!info || info.gamemode !== 0) return stop(info ? "not in survival" : "offline");
    const ent = info.entity && info.entity.isValid ? info.entity : null;
    const remote = tracked && Date.now() - tracked.at < 6000 && sameDimension(tracked.dimension, bot.game.dimension) ? tracked.pos : null;
    const target = ent?.position ?? remote;
    if (!target) return stop("not in this dimension");

    const now = Date.now();
    if (!hunting) {
      hunting = true;
      brain.pause();
      if (isSkillRunning(bot)) abortActiveSkill(bot);
      const moves = baseMoves(bot);
      moves.allowSprinting = true;
      moves.allowParkour = true;
      moves.canDig = bot.inventory.items().some((i) => i.name.endsWith("_pickaxe"));
      bot.pathfinder.setMovements(moves);
      console.log(`[Hunt] ${bot.username} hunting ${name} (${target.distanceTo(bot.entity.position).toFixed(0)} blocks away)`);
    }
    if (now - lastEquip > 5000) {
      lastEquip = now;
      equipBestWeapon(bot);
    }

    const dist = target.distanceTo(bot.entity.position);
    if (ent) {
      if (followed !== ent) {
        followed = ent;
        bot.pathfinder.setGoal(new goals.GoalFollow(ent, 1), true);
      }
      if (dist <= 3.4) {
        void bot.lookAt(ent.position.offset(0, (ent.height ?? 1.8) * 0.85, 0), true);
        if (now - lastSwing >= swingMs(bot)) {
          lowerShield(); // can't swing from behind a raised shield
          lastSwing = now;
          bot.attack(ent);
        }
      }
      // Between swings in melee range, block with the shield. It needs a
      // quarter second raised to take effect, which fits inside the cooldown.
      if (dist <= 4 && !blocking && shieldInOffhand(bot) && now - lastSwing > 100 && now - lastSwing < swingMs(bot) - 150) {
        blocking = true;
        bot.activateItem(true);
      } else if (dist > 4) {
        lowerShield();
      }
    } else {
      lowerShield();
      followed = null;
      if (!lastGoal || lastGoal.distanceTo(target) > 4 || !bot.pathfinder.isMoving()) {
        lastGoal = target.clone();
        bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 2));
      }
    }
    if (now - lastLog > 30_000) {
      lastLog = now;
      console.log(`[Hunt] ${bot.username} → ${name}: ${dist.toFixed(0)} blocks${ent ? " (in sight)" : " (tracked)"}`);
    }
  };

  const iv = setInterval(() => {
    try {
      tick();
    } catch (err) {
      console.warn(`[Hunt] ${bot.username} tick failed: ${(err as Error).message}`);
    }
  }, 250);
  bot.once("end", () => clearInterval(iv));
  bot.on("death", () => {
    followed = null;
    lastGoal = null;
    blocking = false;
  });
}
