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
import { huntPlayer, ALL_BOT_NAMES, SQUAD } from "./squad.js";
import { CombatLearner, availableTactics, stateKey, type CombatState, type Tactic } from "../learn/combat-learner.js";
import { PearlAim, trajectory } from "../learn/pearl-aim.js";
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

// ── Pearl top-up (PEARL_TOPUP=true) ─────────────────────────────────────────
// Pearl tactics and the aim model learn only while there are pearls to throw.
// Every 20 s, refill this squad's bots (never human players) back to 16 when
// they are down to 4 or fewer. `clear <bot> ender_pearl 0` counts without
// removing anything. Each squad process refills only its own five bots.
let pearlTopupStarted = false;

export function startPearlTopup(botNames: string[]): void {
  if (pearlTopupStarted || process.env.PEARL_TOPUP !== "true") return;
  pearlTopupStarted = true;
  const settings = rconSettings();
  if (!settings) {
    console.warn("[Pearls] no RCON settings in server/server.properties — cannot top up pearls");
    return;
  }
  const { Rcon } = createRequire(import.meta.url)("rcon-client");
  const refill = async () => {
    try {
      const rcon = await Rcon.connect({ host: "127.0.0.1", port: settings.port, password: settings.password, timeout: 3000 });
      for (const name of botNames) {
        const reply: string = await rcon.send(`clear ${name} minecraft:ender_pearl 0`);
        const have = Number(reply.match(/Found (\d+) matching item/)?.[1] ?? (/No items were found/.test(reply) ? 0 : NaN));
        if (Number.isNaN(have) || have > 4) continue; // offline, or plenty left
        await rcon.send(`give ${name} minecraft:ender_pearl ${16 - have}`);
        console.log(`[Pearls] topped up ${name}: ${have} -> 16`);
      }
      await rcon.end();
    } catch (err) {
      console.warn(`[Pearls] top-up pass failed: ${(err as Error).message}`);
    }
  };
  void refill();
  setInterval(() => void refill(), 20_000).unref();
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

// ── Learning (shared by every bot in this squad process) ────────────────────
let learner: CombatLearner | null = null;
let aimModel: PearlAim | null = null;

/** The squad's combat learner and pearl-aim model (created on first use). */
export function learners(): { combat: CombatLearner; pearl: PearlAim } {
  if (!learner || !aimModel) {
    learner = new CombatLearner(SQUAD);
    aimModel = new PearlAim(SQUAD);
    const l = learner;
    setInterval(() => {
      try {
        l.save();
      } catch (err) {
        console.warn(`[Learn] save failed: ${(err as Error).message}`);
      }
    }, 30_000).unref();
    setInterval(() => {
      const s = l.summary();
      const last = s.curve.at(-1);
      console.log(
        `[Learn] squad ${SQUAD}: ${s.updates} updates, eps=${s.epsilon.toFixed(3)}, ${s.statesVisited} states, ` +
          `kills ${s.kills}, deaths ${s.deaths}${last !== undefined ? `, mean reward (last 25) ${last.toFixed(2)}` : ""}`,
      );
    }, 60_000).unref();
  }
  return { combat: learner, pearl: aimModel };
}

const DECISION_MS = 1200;

interface Window {
  state: CombatState;
  tactic: Tactic;
  explored: boolean;
  start: number;
  dist0: number;
  hits: number;
  hpLost: number;
  side: "left" | "right";
}

export function startHunter(bot: Bot, brain: Pausable): void {
  const name = huntPlayer();
  if (!huntIsPrimary()) return;
  startTracker(name);
  const { combat, pearl } = learners();

  let hunting = false;
  let lastSwing = 0;
  let lastGoal: Vec3 | null = null;
  let followed: Entity | null = null;
  let goalKind = "";
  let lastEquip = 0;
  let lastLog = 0;
  let blocking = false;
  let win: Window | null = null;
  let pearlBusy = false;
  let lastHp = 20;

  // A raised shield slows the bot to sneaking speed: lower it to run or swing.
  const lowerShield = () => {
    if (!blocking) return;
    blocking = false;
    bot.deactivateItem();
  };

  const pearls = () => bot.inventory.items().filter((i) => i.name === "ender_pearl").reduce((n, i) => n + i.count, 0);

  const observe = (ent: Entity): CombatState => {
    const me = bot.entity.position;
    const flags = Number((ent as unknown as { metadata?: unknown[] }).metadata?.[8] ?? 0);
    let allies = 0;
    for (const n of ALL_BOT_NAMES) {
      const e = bot.players[n]?.entity;
      if (e && e.position.distanceTo(ent.position) <= 6) allies++;
    }
    return {
      dist: ent.position.distanceTo(me),
      hp: bot.health,
      targetShielding: (flags & 0x01) === 1,
      dy: ent.position.y - me.y,
      alliesNearTarget: allies,
    };
  };

  const resetMotion = () => {
    lowerShield();
    bot.clearControlStates();
    followed = null;
    goalKind = "";
  };

  /** Close the current window: score it, update Q, log the experience. */
  const finish = (next: CombatState | null, terminal: "kill" | "death" | null, teamKill = false) => {
    if (!win) return;
    const w = win;
    win = null;
    const dist1 = next?.dist ?? w.dist0;
    const closed = w.dist0 > 4 ? Math.max(-5, Math.min(10, w.dist0 - dist1)) : 0;
    let reward = w.hits * 1.0 - w.hpLost * 0.5 + closed / 5;
    if (terminal === "kill") reward += 10;
    if (terminal === "death") reward -= 10;
    if (teamKill) reward += 2;
    const nextOptions = next ? availableTactics(next, pearls(), shieldInOffhand(bot)) : [];
    combat.update(w.state, w.tactic, reward, terminal ? null : next, nextOptions);
    combat.record({
      ts: new Date().toISOString(),
      bot: bot.username,
      state: `${w.state.dist.toFixed(1)}b hp${w.state.hp.toFixed(0)}${w.state.targetShielding ? " shield" : ""}`,
      tactic: w.tactic,
      explored: w.explored,
      epsilon: +combat.stateEpsilon(stateKey(w.state)).toFixed(3),
      reward: +reward.toFixed(2),
      hits: w.hits,
      damageTaken: +w.hpLost.toFixed(1),
      closed: +closed.toFixed(1),
      terminal,
    });
    if (w.hits || terminal || w.tactic.startsWith("pearl")) {
      console.log(
        `[Learn] ${bot.username} ${w.tactic}${w.explored ? " (explore)" : ""}: hits ${w.hits}, took ${w.hpLost.toFixed(0)}, reward ${reward.toFixed(2)}${terminal ? ` [${terminal}]` : ""}`,
      );
    }
  };

  /** Throw a pearl at a point using the learned aim; learn from where we land. */
  const throwPearl = async (point: Vec3, why: string) => {
    const item = bot.inventory.items().find((i) => i.name === "ender_pearl");
    if (!item) return;
    pearlBusy = true;
    try {
      bot.pathfinder.setGoal(null);
      resetMotion();
      await bot.equip(item, "hand");
      const start = bot.entity.position.clone();
      const dx = point.x - start.x;
      const dz = point.z - start.z;
      const d = Math.hypot(dx, dz);
      const dy = point.y - start.y;
      if (d < 2) return;
      // Trace each candidate arc through the real blocks; a pearl that would
      // clip a hillside, trunk or wall well short of the target is not thrown.
      const fx0 = dx / d;
      const fz0 = dz / d;
      const clear = (p: number) => {
        const path = trajectory(p, dy);
        for (let i = 1; i < path.length; i++) {
          const [ax, ay] = path[i - 1];
          const [bx, by] = path[i];
          const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.4);
          for (let k = 1; k <= steps; k++) {
            const fwd = ax + ((bx - ax) * k) / steps;
            if (fwd > d - 2) return true; // reached the target area
            const y = ay + ((by - ay) * k) / steps;
            const b = bot.blockAt(new Vec3(start.x + fx0 * fwd, start.y + y, start.z + fz0 * fwd).floored());
            if (b && b.boundingBox === "block") return false;
          }
        }
        return true;
      };
      let pitch: number | null = null;
      let arc = "";
      for (const a of ["low", "high"] as const) {
        const p = pearl.aim(d, dy, a);
        if (p !== null && clear(p)) {
          pitch = p;
          arc = a;
          break;
        }
      }
      if (pitch === null) {
        console.log(`[Learn] ${bot.username} pearl (${why}) not thrown: no clear arc over the terrain to ${d.toFixed(0)} blocks`);
        return;
      }
      await bot.look(Math.atan2(-dx, -dz), pitch, true);
      const landed = await new Promise<Vec3 | null>((resolve) => {
        const onMove = () => {
          clearTimeout(timer);
          bot.off("forcedMove", onMove);
          resolve(bot.entity.position.clone());
        };
        const timer = setTimeout(() => {
          bot.off("forcedMove", onMove);
          resolve(null);
        }, 4000);
        bot.on("forcedMove", onMove);
        bot.activateItem();
      });
      if (!landed) return;
      const fx = dx / d;
      const fz = dz / d;
      const rx = landed.x - start.x;
      const rz = landed.z - start.z;
      const forward = rx * fx + rz * fz;
      const lateral = rz * fx - rx * fz;
      // A teleport from elsewhere (death, an admin /tp) is not a pearl landing.
      if (forward > 0.5 && forward < 70 && Math.abs(lateral) < 8) {
        pearl.learn(bot.username, pitch, { d, dy }, { forward, lateral, dy: landed.y - start.y }, arc as "low" | "high");
        const err = Math.hypot(forward - d, lateral, landed.y - start.y - dy);
        console.log(`[Learn] ${bot.username} pearl (${why}, ${arc} arc) aimed ${d.toFixed(1)} blocks, landed ${err.toFixed(1)} off target`);
      }
    } catch (err) {
      console.warn(`[Hunt] ${bot.username} pearl failed: ${(err as Error).message}`);
    } finally {
      pearlBusy = false;
      lastEquip = 0; // re-arm with the weapon on the next tick
      if (win) win.start = 0; // a throw ends its decision window
    }
  };

  const stop = (why: string) => {
    if (!hunting) return;
    finish(null, null);
    resetMotion();
    hunting = false;
    lastGoal = null;
    bot.pathfinder?.setGoal(null);
    console.log(`[Hunt] ${bot.username} stops hunting ${name}: ${why}`);
    brain.resume();
  };

  const follow = (ent: Entity, kind: "follow" | "retreat") => {
    if (followed === ent && goalKind === kind) return;
    followed = ent;
    goalKind = kind;
    const goal = kind === "retreat" ? new goals.GoalInvert(new goals.GoalFollow(ent, 12)) : new goals.GoalFollow(ent, 1);
    bot.pathfinder.setGoal(goal, true);
  };

  const swing = (ent: Entity) => {
    lowerShield();
    lastSwing = Date.now();
    bot.attack(ent);
  };

  /** Run the current tactic for one 250 ms tick. */
  const act = (ent: Entity, tactic: Tactic, dist: number, now: number) => {
    const ready = now - lastSwing >= swingMs(bot);
    const inReach = dist <= 3.4;
    if (inReach && tactic !== "retreat") void bot.lookAt(ent.position.offset(0, (ent.height ?? 1.8) * 0.85, 0), true);
    switch (tactic) {
      case "rush":
        follow(ent, "follow");
        if (inReach && ready) swing(ent);
        break;
      case "shield":
        follow(ent, "follow");
        if (inReach && ready) swing(ent);
        else if (dist <= 4 && !blocking && shieldInOffhand(bot) && now - lastSwing > 100 && now - lastSwing < swingMs(bot) - 150) {
          blocking = true;
          bot.activateItem(true);
        }
        break;
      case "wtap":
        follow(ent, "follow");
        if (inReach && ready) {
          swing(ent);
          // Release forward/sprint for a moment, then re-engage: the next hit
          // starts a fresh sprint and deals sprint knockback again.
          bot.pathfinder.setGoal(null);
          bot.clearControlStates();
          followed = null;
        }
        break;
      case "crit":
        follow(ent, "follow");
        if (inReach && ready && bot.entity.onGround) {
          bot.setControlState("jump", true);
          const started = Date.now();
          const onTick = () => {
            const falling = bot.entity.velocity.y < -0.08;
            if (falling || Date.now() - started > 700) {
              bot.off("physicsTick", onTick);
              bot.setControlState("jump", false);
              if (falling && ent.isValid && ent.position.distanceTo(bot.entity.position) <= 3.6) swing(ent);
            }
          };
          bot.on("physicsTick", onTick);
          lastSwing = now; // hold the cooldown until the falling hit
        }
        break;
      case "strafe":
        if (followed) {
          bot.pathfinder.setGoal(null);
          followed = null;
          goalKind = "";
        }
        void bot.lookAt(ent.position.offset(0, (ent.height ?? 1.8) * 0.85, 0), true);
        bot.setControlState("forward", dist > 2.5);
        bot.setControlState("sprint", dist > 2.5);
        bot.setControlState(win?.side ?? "left", true);
        if (inReach && ready) swing(ent);
        break;
      case "retreat":
        follow(ent, "retreat");
        break;
      case "pearl_close":
        if (!pearlBusy) void throwPearl(ent.position.clone(), "close the gap");
        break;
      case "pearl_escape":
        if (!pearlBusy) {
          const me = bot.entity.position;
          const away = me.minus(ent.position);
          const len = Math.hypot(away.x, away.z) || 1;
          void throwPearl(new Vec3(me.x + (away.x / len) * 20, me.y, me.z + (away.z / len) * 20), "escape");
        }
        break;
    }
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
      lastHp = bot.health;
      console.log(`[Hunt] ${bot.username} hunting ${name} (${target.distanceTo(bot.entity.position).toFixed(0)} blocks away, ${pearls()} pearls)`);
    }
    if (pearlBusy) return;
    if (now - lastEquip > 5000) {
      lastEquip = now;
      equipBestWeapon(bot);
    }

    const dist = target.distanceTo(bot.entity.position);
    if (ent && dist <= 40) {
      // Engaged: the learner picks a tactic for each decision window.
      if (!win || now - win.start >= DECISION_MS) {
        const state = observe(ent);
        const prevTactic = win?.tactic;
        finish(state, null);
        const options = availableTactics(state, pearls(), shieldInOffhand(bot));
        const { tactic, explored } = combat.choose(state, options);
        if (tactic !== prevTactic) resetMotion();
        win = { state, tactic, explored, start: now, dist0: state.dist, hits: 0, hpLost: 0, side: Math.random() < 0.5 ? "left" : "right" };
      }
      act(ent, win.tactic, dist, now);
    } else {
      // Out of sight: path to his tracked position, no learning.
      finish(null, null);
      if (followed || goalKind) resetMotion();
      if (!lastGoal || lastGoal.distanceTo(target) > 4 || !bot.pathfinder.isMoving()) {
        lastGoal = target.clone();
        bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 2));
      }
    }
    if (now - lastLog > 30_000) {
      lastLog = now;
      console.log(`[Hunt] ${bot.username} -> ${name}: ${dist.toFixed(0)} blocks${ent ? " (in sight)" : " (tracked)"}`);
    }
  };

  // ── Reward signals ──
  bot.on("entityHurt", (e: Entity) => {
    if (!win || e.username !== name) return;
    if (Date.now() - lastSwing < 600 && e.position.distanceTo(bot.entity.position) <= 4.5) win.hits++;
  });
  bot.on("health", () => {
    if (win && bot.health < lastHp) win.hpLost += lastHp - bot.health;
    lastHp = bot.health;
  });
  bot.on("messagestr", (msg: string) => {
    if (!win || !msg.startsWith(`${name} `)) return;
    if (msg.endsWith(` ${bot.username}`) || msg.includes(` by ${bot.username}`)) finish(null, "kill");
    else if (ALL_BOT_NAMES.some((b) => msg.includes(` by ${b}`))) finish(null, null, true);
  });
  bot.on("death", () => {
    finish(null, "death");
    followed = null;
    goalKind = "";
    lastGoal = null;
    blocking = false;
    pearlBusy = false;
  });

  const iv = setInterval(() => {
    try {
      tick();
    } catch (err) {
      console.warn(`[Hunt] ${bot.username} tick failed: ${(err as Error).message}`);
    }
  }, 250);
  bot.once("end", () => {
    clearInterval(iv);
    finish(null, null);
  });
}
