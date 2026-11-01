// src/bot/hunter.ts
//
// Hunt mode (`!mode hunt`, or HUNT_MODE=primary until set in game): while
// HUNT_PLAYER is in survival mode, every bot drops
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
import { huntPlayer, ALL_BOT_NAMES, SQUAD, leaderBot } from "./squad.js";
import { CombatLearner, availableTactics, stateKey, type CombatState, type Tactic, type TargetMotion } from "../learn/combat-learner.js";
import { huntIsPrimary } from "./hunt-mode.js";
import { latestSighting, predict, reportSighting } from "./sighting.js";
import { say, fmt, requestHelp, clearHelp, helpRequests } from "./team-comms.js";
import { Pursuit } from "./pursuit.js";
import { isHostile } from "./perception.js";
import { PearlAim, trajectory } from "../learn/pearl-aim.js";
import { baseMoves } from "./navigation.js";
import { abortActiveSkill, isSkillRunning } from "../skills/executor.js";

const { goals } = pkg;

export { huntIsPrimary };

// ── Server-side tracker (one per process, shared by its five bots) ─────────
interface Tracked {
  pos: Vec3;
  dimension: string;
  at: number;
}
let tracked: Tracked | null = null;
let trackerStarted = false;

export function rconSettings(): { port: number; password: string } | null {
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
      // Scaffolding to pillar up to a target on a tower or hill.
      for (const name of botNames) {
        const reply: string = await rcon.send(`clear ${name} minecraft:cobblestone 0`);
        const have = Number(reply.match(/Found (\d+) matching item/)?.[1] ?? (/No items were found/.test(reply) ? 0 : NaN));
        if (Number.isNaN(have) || have >= 16) continue;
        await rcon.send(`give ${name} minecraft:cobblestone ${64 - have}`);
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
    // Every 3 min in hunt mode the squad leader reports what the squad has learned.
    setInterval(() => {
      const lb = leaderBot();
      if (!lb || !huntIsPrimary()) return;
      const s = l.summary();
      if (!s.updates) return;
      const pick = (dist: string, situation: string) => s.policy.find((r) => r.dist === dist && r.situation === situation)?.tactic ?? "?";
      say(
        lb,
        "learned",
        `Squad ${SQUAD} learning: ${s.updates} fight decisions so far. Up close I'd ${pick("≤3", "fighting")}; ` +
          `if he runs at 12-24 blocks: ${pick("12–24", "fleeing")}; when he's busy with a teammate at 6-12: ${pick("6–12", "fighting")}.`,
        170_000,
      );
    }, 180_000).unref();
  }
  return { combat: learner, pearl: aimModel };
}

const DECISION_MS = 1200;
/**
 * Potential for reward shaping, Φ = −distance/4; the shaping term is Φ(s′) − Φ(s),
 * so closing in pays, backing off costs and standing still is neutral. (Round 1
 * used γΦ(s′) − Φ(s) with γ = 0.8, which quietly paid ~+1 per window just for
 * standing 20+ blocks away; bots learned to retreat. γ = 1 removes that bias.)
 */
const potential = (dist: number) => -Math.min(dist, 40) / 4;

const lastRejoin = new Map<string, number>();

// Hits on the target by any bot of this squad: the team part of the reward.
let teamHits = 0;
let lastCallout = 0;

interface Window {
  state: CombatState;
  tactic: Tactic;
  explored: boolean;
  start: number;
  hits: number;
  teamHitsAtStart: number;
  mobHits: number;
  hpLost: number;
  side: "left" | "right";
  guarding: boolean;
}

export function startHunter(bot: Bot, brain: Pausable): void {
  const name = huntPlayer();
  if (!name) return;
  startTracker(name);
  const { combat, pearl } = learners();

  let hunting = false;
  let lastSwing = 0;
  let lastMobSwing = 0;
  let lastGoal: Vec3 | null = null;
  let followed: Entity | null = null;
  let goalKind = "";
  let lastEquip = 0;
  let lastLog = 0;
  let blocking = false;
  let win: Window | null = null;
  let pearlBusy = false;
  let lastHp = 20;
  let lastTargetSwing = 0;
  let lastTargetHurt = 0;
  // Help is for fights with him: health is only trusted after the server sent
  // it (it reads 0 right after login), and damage must have come from him.
  let healthKnown = false;
  let lastHurtByTarget = 0;
  let engaged = false;

  // A raised shield slows the bot to sneaking speed: lower it to run or swing.
  const lowerShield = () => {
    if (!blocking) return;
    blocking = false;
    bot.deactivateItem();
  };

  const pearls = () => bot.inventory.items().filter((i) => i.name === "ender_pearl").reduce((n, i) => n + i.count, 0);
  const dimension = () => String(bot.game.dimension ?? "overworld");

  const nearestMob = (radius: number) => {
    const me = bot.entity?.position;
    if (!me) return null;
    return bot.nearestEntity((e) => e !== bot.entity && !!e.position && isHostile(e) && e.position.distanceTo(me) <= radius);
  };

  /** Raw state for the learner; which tactic is good in it is learned, not coded. */
  const observe = (ent: Entity): CombatState => {
    const me = bot.entity.position;
    const flags = Number((ent as unknown as { metadata?: unknown[] }).metadata?.[8] ?? 0);
    let allies = 0;
    let alliesClose = 0;
    for (const n of ALL_BOT_NAMES) {
      if (n === bot.username) continue;
      const e = bot.players[n]?.entity;
      if (!e) continue;
      const d = e.position.distanceTo(ent.position);
      if (d <= 6) allies++;
      if (d <= 4) alliesClose++;
    }
    // Radial speed from the spotter board's velocity estimate: + is away from us.
    const s = latestSighting(dimension(), 2500);
    let motion: TargetMotion = "still";
    if (s) {
      const away = ent.position.minus(me);
      const len = Math.hypot(away.x, away.z) || 1;
      const radial = (s.vel.x * away.x + s.vel.z * away.z) / len;
      motion = radial > 1.5 ? "fleeing" : radial < -1.5 ? "approaching" : "still";
    }
    const now = Date.now();
    return {
      dist: ent.position.distanceTo(me),
      hp: bot.health,
      targetShielding: (flags & 0x01) === 1,
      dy: ent.position.y - me.y,
      alliesNearTarget: allies,
      targetMotion: motion,
      targetBusy: now - lastTargetSwing < 2000 || now - lastTargetHurt < 2000 || alliesClose > 0,
      mobAdjacent: !!nearestMob(4),
      allyHurt: helpRequests(bot.username, me, dimension()).length > 0,
    };
  };

  const resetMotion = () => {
    lowerShield();
    bot.clearControlStates();
    followed = null;
    goalKind = "";
  };

  /**
   * Close the current window, score it and update Q. The reward:
   *   +1 per own hit on him, +0.25 per squadmate hit (team play), +0.3 per hit
   *   on a mob that is on us, −0.5 per HP lost, −0.05 per window (finish fast),
   *   + potential-based shaping γΦ(s′) − Φ(s) with Φ = −distance/4,
   *   +10 for the kill, +5 when a squadmate gets it, −10 for dying.
   */
  const finish = (next: CombatState | null, terminal: "kill" | "death" | null, teamKill = false) => {
    if (!win) return;
    const w = win;
    win = null;
    const others = Math.max(0, teamHits - w.teamHitsAtStart - w.hits);
    w.guarding = !!bot.entity && helpRequests(bot.username, bot.entity.position, dimension(), 5).length > 0;
    const shaping = next && !terminal ? potential(next.dist) - potential(w.state.dist) : 0;
    let reward = w.hits * 1.0 + others * 0.25 + w.mobHits * 0.3 - w.hpLost * 0.5 - 0.05 + shaping;
    // Bodyguard: ending the window beside a teammate who called for help.
    if (w.guarding) reward += 0.5;
    if (terminal === "kill") reward += 10;
    if (terminal === "death") reward -= 10;
    if (teamKill) reward += 5;
    const nextOptions = next ? availableTactics(next, pearls(), shieldInOffhand(bot)) : [];
    combat.update(w.state, w.tactic, reward, terminal || teamKill ? null : next, nextOptions);
    const st = w.state;
    combat.record({
      ts: new Date().toISOString(),
      bot: bot.username,
      state:
        `${st.dist.toFixed(1)}b hp${st.hp.toFixed(0)} ${st.targetMotion}` +
        `${st.targetBusy ? " busy" : ""}${st.targetShielding ? " shield" : ""}${st.mobAdjacent ? " mob" : ""}${st.allyHurt ? " allyhurt" : ""} al${st.alliesNearTarget}`,
      tactic: w.tactic,
      explored: w.explored,
      epsilon: +combat.stateEpsilon(stateKey(st)).toFixed(3),
      reward: +reward.toFixed(2),
      hits: w.hits,
      teamHits: others,
      mobHits: w.mobHits,
      damageTaken: +w.hpLost.toFixed(1),
      closed: +((next?.dist !== undefined ? st.dist - next.dist : 0)).toFixed(1),
      terminal: terminal ?? (teamKill ? "team_kill" : null),
    });
    if (w.hits || w.mobHits || terminal || teamKill || w.tactic.startsWith("pearl")) {
      console.log(
        `[Learn] ${bot.username} ${w.tactic}${w.explored ? " (explore)" : ""}: hits ${w.hits}, team ${others}, mob ${w.mobHits}, ` +
          `took ${w.hpLost.toFixed(0)}, reward ${reward.toFixed(2)}${terminal ? ` [${terminal}]` : teamKill ? " [team kill]" : ""}`,
      );
    }
  };

  /**
   * Plan a throw at a point: trace the low arc, then a high lob, through the
   * real blocks. Null when both would clip a hillside, trunk or wall well short
   * of the target, so the pearl tactic is not even offered in that situation.
   */
  const planThrow = (point: Vec3) => {
    const start = bot.entity.position.clone();
    const dx = point.x - start.x;
    const dz = point.z - start.z;
    const d = Math.hypot(dx, dz);
    const dy = point.y - start.y;
    if (d < 2) return null;
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
    for (const arc of ["low", "high"] as const) {
      const pitch = pearl.aim(d, dy, arc);
      if (pitch !== null && clear(pitch)) return { start, dx, dz, d, dy, pitch, arc };
    }
    return null;
  };

  const escapePoint = (ent: Entity) => {
    const me = bot.entity.position;
    const away = me.minus(ent.position);
    const len = Math.hypot(away.x, away.z) || 1;
    return new Vec3(me.x + (away.x / len) * 20, me.y, me.z + (away.z / len) * 20);
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
      const plan = planThrow(point);
      if (!plan) {
        console.log(`[Learn] ${bot.username} pearl (${why}) not thrown: no clear arc over the terrain`);
        return;
      }
      const { start, dx, dz, d, dy, pitch, arc } = plan;
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
        pearl.learn(bot.username, pitch, { d, dy }, { forward, lateral, dy: landed.y - start.y }, arc);
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
    clearHelp(bot.username);
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

  /**
   * Movement for the hunt. baseMoves keeps protected blocks (chests, beds...)
   * safe, but for a bot without a pickaxe it pins canDig to false through a
   * getter, so a bot that respawned inside a closed shelter could never get
   * out: all ten sat on their beds 340 blocks away. Hunters may dig (by hand
   * if need be), open doors and pillar up. Re-applied whenever something else
   * swapped the movements (respawn safety, a skill before the hunt began).
   */
  let huntMoves: ReturnType<typeof baseMoves> | null = null;
  const ensureHuntMoves = () => {
    if (!huntMoves) {
      huntMoves = baseMoves(bot);
      Object.defineProperty(huntMoves, "canDig", { value: true, writable: true, configurable: true, enumerable: true });
      huntMoves.canOpenDoors = true;
      huntMoves.allow1by1towers = true;
      huntMoves.allowSprinting = true;
      huntMoves.allowParkour = true;
    }
    if (bot.pathfinder.movements !== huntMoves) bot.pathfinder.setMovements(huntMoves);
  };

  const pursuit = new Pursuit(bot, {
    // Pearl hops only to get unstuck, and not when a 5 HP landing could kill.
    hop: (p) => {
      if (pearlBusy || pearls() === 0 || bot.health < 8 || !planThrow(p)) return false;
      void throwPearl(p, "pursuit hop");
      return true;
    },
    // At most once per 10 min per bot (the map outlives the bot instance).
    rejoin: () => {
      const now = Date.now();
      if (now - (lastRejoin.get(bot.username) ?? 0) < 600_000) return false;
      lastRejoin.set(bot.username, now);
      setTimeout(() => bot.quit(), 200);
      return true;
    },
    log: (m) => console.log(`[Hunt] ${bot.username} ${m}`),
  });

  const swing = (ent: Entity) => {
    lowerShield();
    lastSwing = Date.now();
    bot.attack(ent);
  };

  /** Run the current tactic for one 250 ms tick. */
  const act = (ent: Entity, tactic: Tactic, dist: number, now: number) => {
    const ready = now - lastSwing >= swingMs(bot);
    const inReach = dist <= 3.4;
    if (inReach && tactic !== "retreat" && tactic !== "defend") void bot.lookAt(ent.position.offset(0, (ent.height ?? 1.8) * 0.85, 0), true);
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
      case "defend": {
        const mob = nearestMob(4.5);
        if (!mob) {
          follow(ent, "follow"); // the mob is gone: back to him
          if (inReach && ready) swing(ent);
          break;
        }
        if (followed) {
          bot.pathfinder.setGoal(null);
          followed = null;
          goalKind = "";
        }
        void bot.lookAt(mob.position.offset(0, (mob.height ?? 1.6) * 0.8, 0), true);
        bot.setControlState("forward", mob.position.distanceTo(bot.entity.position) > 2.8);
        if (now - lastSwing >= swingMs(bot) && mob.position.distanceTo(bot.entity.position) <= 3.4) {
          lowerShield();
          lastSwing = now;
          lastMobSwing = now;
          bot.attack(mob);
        }
        break;
      }
      case "backup": {
        const r = helpRequests(bot.username, bot.entity.position, dimension())[0];
        if (!r) {
          follow(ent, "follow"); // nobody needs help any more: back on him
          if (inReach && ready) swing(ent);
          break;
        }
        // Go stand with the hurt teammate; fight whatever is there, him first.
        if (!lastGoal || lastGoal.distanceTo(r.pos) > 3 || goalKind !== "backup") {
          lastGoal = r.pos.clone();
          followed = null;
          goalKind = "backup";
          bot.pathfinder.setGoal(new goals.GoalNear(r.pos.x, r.pos.y, r.pos.z, 2));
        }
        if (inReach && ready) swing(ent);
        else {
          const mob = nearestMob(3.4);
          if (mob && now - lastSwing >= swingMs(bot)) {
            void bot.lookAt(mob.position.offset(0, (mob.height ?? 1.6) * 0.8, 0), true);
            lowerShield();
            lastSwing = now;
            lastMobSwing = now;
            bot.attack(mob);
          }
        }
        break;
      }
      case "pearl_close":
        if (!pearlBusy) {
          say(bot, "pearl", `Pearling in on ${name}!`, 15_000);
          void throwPearl(ent.position.clone(), "close the gap");
        }
        break;
      case "pearl_escape":
        if (!pearlBusy) void throwPearl(escapePoint(ent), "escape");
        break;
    }
  };

  const tick = () => {
    if (!bot.entity || bot.health <= 0) return;
    if (!huntIsPrimary()) return stop("game mode");
    const info = bot.players[name];
    if (!info || info.gamemode !== 0) return stop(info ? "not in survival" : "offline");
    const ent = info.entity && info.entity.isValid ? info.entity : null;
    const now = Date.now();

    // Where is he? Own eyes, then a squadmate's sighting projected forward,
    // then the server's record.
    if (ent) {
      if (reportSighting(ent.position, bot.username, dimension()) && now - lastCallout > 20_000) {
        lastCallout = now;
        say(bot, "spotted", `Spotted ${name} at ${fmt(ent.position)}. Everyone on him!`, 20_000);
      }
    }
    const seen = ent ? null : latestSighting(dimension());
    const remote = tracked && now - tracked.at < 6000 && sameDimension(tracked.dimension, bot.game.dimension) ? tracked.pos : null;
    const target = ent?.position ?? seen?.pos ?? remote;
    if (!target) return stop("not in this dimension");

    if (!hunting) {
      hunting = true;
      brain.pause();
      if (isSkillRunning(bot)) abortActiveSkill(bot);
      lastHp = bot.health;
      console.log(`[Hunt] ${bot.username} hunting ${name} (${target.distanceTo(bot.entity.position).toFixed(0)} blocks away, ${pearls()} pearls)`);
    }
    if (pearlBusy) return;
    ensureHuntMoves();
    if (now - lastEquip > 5000) {
      lastEquip = now;
      equipBestWeapon(bot);
    }

    const dist = target.distanceTo(bot.entity.position);

    // Call for backup only when he is the one hurting us, up close; withdraw
    // the call once healed or out of the fight.
    const fighting = !!ent && dist <= 12 && now - lastHurtByTarget < 6000;
    if (healthKnown && bot.health > 0 && bot.health <= 8 && fighting) {
      requestHelp(bot.username, bot.entity.position, bot.health, dimension());
      say(bot, "help", `${Math.ceil(bot.health)} HP fighting ${name} at ${fmt(bot.entity.position)}, need backup!`, 15_000);
    } else if (!fighting || bot.health > 12) {
      clearHelp(bot.username);
    }

    if (ent && dist <= 40) {
      if (!engaged) {
        engaged = true;
        pursuit.reset();
      }
      // Engaged: the learner picks a tactic for each decision window.
      if (!win || now - win.start >= DECISION_MS) {
        const state = observe(ent);
        const prevTactic = win?.tactic;
        finish(state, null);
        // Physically possible tactics; pearls only when a clear arc exists.
        const options = availableTactics(state, pearls(), shieldInOffhand(bot)).filter((t) =>
          t === "pearl_close" ? !!planThrow(ent.position) : t === "pearl_escape" ? !!planThrow(escapePoint(ent)) : true,
        );
        const { tactic, explored } = combat.choose(state, options);
        if (tactic !== prevTactic) resetMotion();
        win = {
          state,
          tactic,
          explored,
          start: now,
          hits: 0,
          teamHitsAtStart: teamHits,
          mobHits: 0,
          hpLost: 0,
          side: Math.random() < 0.5 ? "left" : "right",
          guarding: false,
        };
        if (tactic === "backup") {
          const r = helpRequests(bot.username, bot.entity.position, dimension())[0];
          if (r) say(bot, "backup", `On my way, ${r.bot}! Holding on at ${fmt(r.pos)}.`, 12_000);
        }
      }
      act(ent, win.tactic, dist, now);
    } else {
      // Out of sight or range: close the last window against his real distance,
      // so backing off out of range is penalized like any other retreat (closing
      // it with no next state skipped the shaping term, and bots learned to
      // retreat past 40 blocks for free). Then head for where he WILL be.
      if (win) finish({ ...win.state, dist }, null);
      if (engaged) {
        engaged = false;
        resetMotion();
        pursuit.reset();
      }
      const aim = seen ? predict(seen, (now - seen.at) / 1000 + dist / 5.6) : target;
      pursuit.step(aim);
    }
    if (now - lastLog > 30_000) {
      lastLog = now;
      const how = ent ? "in sight" : seen ? `spotted by ${seen.by}` : "server position";
      console.log(`[Hunt] ${bot.username} -> ${name}: ${dist.toFixed(0)} blocks (${how})`);
    }
  };

  // ── Reward and state signals ──
  bot.on("entityHurt", (e: Entity) => {
    const now = Date.now();
    if (e === bot.entity) {
      const him = bot.players[name]?.entity;
      if (him && him.position.distanceTo(bot.entity.position) <= 5) lastHurtByTarget = now;
      return;
    }
    if (e.username === name) {
      lastTargetHurt = now;
      if (win && now - lastSwing < 600 && e.position.distanceTo(bot.entity.position) <= 4.5) {
        win.hits++;
        teamHits++;
      }
    } else if (win && e !== bot.entity && isHostile(e) && now - lastMobSwing < 600 && e.position.distanceTo(bot.entity.position) <= 4.5) {
      win.mobHits++;
    }
  });
  bot.on("entitySwingArm", (e: Entity) => {
    if (e.username === name) lastTargetSwing = Date.now();
  });
  bot.on("health", () => {
    healthKnown = true;
    if (win && bot.health < lastHp) win.hpLost += lastHp - bot.health;
    lastHp = bot.health;
  });
  bot.on("messagestr", (msg: string) => {
    if (!win || !msg.startsWith(`${name} `)) return;
    if (msg.endsWith(` ${bot.username}`) || msg.includes(` by ${bot.username}`)) {
      finish(null, "kill");
      say(bot, "kill", `Got him! ${name} is down.`, 5_000);
    }
    else if (ALL_BOT_NAMES.some((b) => msg.includes(` by ${b}`))) finish(null, null, true);
  });
  bot.on("death", () => {
    if (win) {
      const p = bot.players[name]?.entity?.position ?? latestSighting(dimension(), 4000)?.pos;
      say(bot, "down", p ? `I'm down. ${name} is at ${fmt(p)}, finish him!` : "I'm down!", 10_000);
    }
    clearHelp(bot.username);
    pursuit.reset();
    engaged = false;
    huntMoves = null; // rebuilt after respawn (scaffolding blocks may have changed)
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
