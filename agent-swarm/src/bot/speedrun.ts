// src/bot/speedrun.ts
//
// Speedrun director: each squad races to kill the Ender Dragon as a team.
// SPEEDRUN_DIRECTOR=true turns it on in game mode (`!mode game`). It pauses
// the LLM brain of every bot it drives and plays a fixed route, because the
// brain spent its time fighting zombies, eating and chasing early-game goals
// that the speedrun kit had already covered, and it had no endgame actions at
// all (no stronghold search, no End portal, no dragon fight).
//
// Route (one shared phase per squad, persisted in logs/speedrun-<squad>.json):
//   portal      the bot holding the most obsidian builds a frame and lights it
//   nether      everyone crosses
//   fortress    five bots fan out on five headings; the first to see nether
//               bricks calls it and the squad converges
//   blaze       everyone hunts blazes (sword first: Looting III drops more rods)
//               until the squad holds ROD_TARGET rods
//   home        back through the Nether portal
//   eyes        every bot crafts powder and eyes; members hand their eyes to the leader
//   stronghold  the leader throws eyes, triangulates, the squad follows;
//               end portal frames are searched in every loaded chunk on each leg
//   fill        the leader digs to the portal room and fills the frames
//   end         everyone jumps in
//   dragon      shoot open end crystals, shoot the dragon with lead, melee it when it perches
//   done        exit portal open
// Split times per phase go into the state file; `mc.ps1 race` compares squads.

import fs from "node:fs";
import path from "node:path";
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
import { SQUAD, squadBots, leaderName, isLeader, squadName, type Archetype } from "./squad.js";
import { currentMode } from "./hunt-mode.js";
import { baseMoves, safeGoto } from "./navigation.js";
import { recordDeath, dimKey } from "./danger.js";
import { abortActiveSkill, isSkillRunning } from "../skills/executor.js";
import { ARROW, flightPath, flightTicks, solvePitch } from "../learn/ballistics.js";

const { goals } = pkg;

export const PHASES = [
  "portal",
  "nether",
  "fortress",
  "blaze",
  "home",
  "eyes",
  "stronghold",
  "fill",
  "end",
  "dragon",
  "done",
] as const;
export type Phase = (typeof PHASES)[number];

/** Rods the squad collects before heading home: 8 rods = 16 powder = 16 eyes. */
const ROD_TARGET = Number(process.env.SPEEDRUN_RODS || 8);
/** Eyes the leader never throws below once it has a stronghold estimate. */
const PORTAL_EYES = 12;
const LEG = 240; // blocks walked between eye throws

interface XYZ {
  x: number;
  y: number;
  z: number;
}
export interface EyeLine {
  x: number;
  z: number;
  dx: number;
  dz: number;
}
interface RaceState {
  squad: string;
  phase: Phase;
  startedAt: string;
  splits: Partial<Record<Phase, string>>;
  builder?: string;
  overworldPortal?: XYZ;
  netherPortal?: XYZ;
  fortress?: XYZ;
  spawner?: XYZ;
  rodTarget: number;
  eyeLines: EyeLine[];
  stronghold?: { x: number; z: number; exact: boolean };
  endPortal?: XYZ;
  beds?: Record<string, string>;
  captain?: string;
  updatedAt?: string;
}

const FILE = path.join("logs", `speedrun-${SQUAD}.json`);
let state: RaceState = load();

function load(): RaceState {
  try {
    const s = JSON.parse(fs.readFileSync(FILE, "utf8")) as RaceState;
    if (PHASES.includes(s.phase)) return { ...s, eyeLines: s.eyeLines ?? [], rodTarget: s.rodTarget ?? ROD_TARGET };
  } catch {
    /* fresh race */
  }
  return { squad: SQUAD, phase: "portal", startedAt: new Date().toISOString(), splits: {}, rodTarget: ROD_TARGET, eyeLines: [] };
}
function save(): void {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    state.updatedAt = new Date().toISOString();
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.warn(`[Speedrun] save failed: ${(err as Error).message}`);
  }
}

const elapsed = (): string => {
  const s = Math.round((Date.now() - Date.parse(state.startedAt)) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function announce(text: string): void {
  console.log(`[Speedrun] ${SQUAD}: ${text}`);
  pushEvent(text);
  const lead = squadBots().find((b) => isLeader(b.username)) ?? squadBots()[0];
  try {
    lead?.chat(`[${SQUAD} ${elapsed()}] ${text}`.slice(0, 240));
  } catch {
    /* offline */
  }
}

// ── Live view: what each bot is doing, squad events, server chat ──────────
const doingMap = new Map<string, { text: string; at: number }>();
const events: { at: number; text: string }[] = [];
const chatLog: { at: number; text: string }[] = [];
export function doing(bot: Bot | string, text: string): void {
  const name = typeof bot === "string" ? bot : bot.username;
  const prev = doingMap.get(name);
  if (prev?.text === text) return;
  doingMap.set(name, { text, at: Date.now() });
}
function pushEvent(text: string): void {
  events.push({ at: Date.now(), text });
  if (events.length > 60) events.shift();
}
let chatCaptured = false;
function captureChat(bot: Bot): void {
  if (chatCaptured) return;
  chatCaptured = true;
  bot.on("messagestr", (msg: string, position: string) => {
    if (position === "game_info" || !msg.trim()) return;
    chatLog.push({ at: Date.now(), text: msg.slice(0, 300) });
    if (chatLog.length > 150) chatLog.shift();
  });
  bot.once("end", () => {
    chatCaptured = false;
    const next = squadBots().find((b) => b !== bot && b.entity);
    if (next) captureChat(next);
  });
}

export function raceSnapshot() {
  const bots = squadBots();
  const byName = new Map(bots.map((b) => [b.username, b]));
  const names = (["Atlas", "Flora", "Forge", "Mason", "Blade"] as Archetype[]).map((a) => squadName(a));
  return {
    squad: SQUAD,
    phase: state.phase,
    phaseIndex: PHASES.indexOf(state.phase),
    phases: PHASES,
    startedAt: state.startedAt,
    splits: state.splits,
    rods: squadCount("blaze_rod"),
    rodTarget: state.rodTarget,
    eyes: squadCount("ender_eye"),
    fortress: state.fortress ?? null,
    stronghold: state.stronghold ?? null,
    endPortal: state.endPortal ?? null,
    bots: names.map((name, i) => {
      const b = byName.get(name);
      const d = doingMap.get(name);
      const e = b?.entity;
      return {
        name,
        role: ["leader", "farmer", "miner", "builder", "fighter"][i],
        leader: isLeader(name),
        captain: state.captain === name && !isLeader(name),
        online: !!e,
        dim: b && e ? (inNether(b) ? "nether" : inEnd(b) ? "end" : "overworld") : null,
        pos: e ? [Math.round(e.position.x), Math.round(e.position.y), Math.round(e.position.z)] : null,
        hp: b && e ? Math.round(b.health) : null,
        food: b && e ? Math.round(b.food) : null,
        held: b?.heldItem?.name ?? null,
        rods: b ? count(b, "blaze_rod") : 0,
        eyes: b ? count(b, "ender_eye") : 0,
        pearls: b ? count(b, "ender_pearl") : 0,
        doing: d?.text ?? (e ? "waiting" : "offline"),
        doingAt: d?.at ?? null,
      };
    }),
    events: events.slice(-40),
    chat: chatLog.slice(-100),
    at: Date.now(),
  };
}

function setPhase(next: Phase, why: string): void {
  if (state.phase === next) return;
  state.phase = next;
  state.splits[next] = new Date().toISOString();
  save();
  announce(`${next.toUpperCase()}: ${why}`);
}

// ── Small helpers ────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dim = (bot: Bot) => String(bot.game?.dimension ?? "overworld");
const inNether = (bot: Bot) => dim(bot).includes("nether");
const inEnd = (bot: Bot) => dim(bot).includes("end");
const inOverworld = (bot: Bot) => !inNether(bot) && !inEnd(bot);
const v = (p: XYZ) => new Vec3(p.x, p.y, p.z);
const flat = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const count = (bot: Bot, name: string) =>
  bot.inventory
    .items()
    .filter((i) => i.name === name)
    .reduce((n, i) => n + i.count, 0);
const squadCount = (name: string) => squadBots().reduce((n, b) => n + count(b, name), 0);
const leader = (): Bot | undefined => squadBots().find((b) => isLeader(b.username) && !!b.entity);

/**
 * Who runs the overworld half of the route (eyes, stronghold, portal). The
 * squad leader when it is in the overworld; otherwise the overworld bot that
 * carries the most eyes and rods. Run 1: charlie's leader sat stuck at lava
 * level in the Nether while Sage stood home with 7 of the 9 rods, and the
 * squad waited for the leader. The choice sticks while the captain stays usable.
 */
function captain(): Bot | undefined {
  const lead = leader();
  const worth = (b: Bot) => count(b, "ender_eye") * 3 + count(b, "blaze_rod") * 2 + count(b, "blaze_powder");
  const current = squadBots().find((b) => b.username === state.captain && b.entity && inOverworld(b));
  // A stand-in holding the eyes keeps command when the leader comes home empty-handed.
  // Sticky: comparing holdings each step made two bots hand eyes back and forth.
  if (current && current !== lead && (!lead || !inOverworld(lead) || worth(current) > 0)) return current;
  if (lead && inOverworld(lead)) return lead;
  const pick = squadBots()
    .filter((b) => b.entity && inOverworld(b))
    .sort((a, b) => worth(b) - worth(a) || (state.overworldPortal ? flat(a.entity.position, state.overworldPortal) - flat(b.entity.position, state.overworldPortal) : 0))[0];
  if (pick && pick.username !== state.captain) {
    state.captain = pick.username;
    save();
    announce(`${pick.username} takes charge while ${leaderName()} is away`);
  }
  return pick;
}

async function equip(bot: Bot, name: string): Promise<boolean> {
  const it = bot.inventory.items().find((i) => i.name === name);
  if (!it) return false;
  if (bot.heldItem?.name !== name) await bot.equip(it, "hand").catch(() => {});
  return bot.heldItem?.name === name;
}
async function equipSword(bot: Bot): Promise<void> {
  for (const n of ["netherite_sword", "diamond_sword", "iron_sword", "netherite_axe", "stone_sword"]) {
    if (await equip(bot, n)) return;
  }
}

function moves(bot: Bot, dig: boolean) {
  const m = baseMoves(bot);
  const mm = m as unknown as { canDig: boolean; allow1by1towers: boolean; allowParkour: boolean };
  mm.canDig = dig;
  mm.allow1by1towers = true;
  mm.allowParkour = false;
  return m;
}
async function goNear(bot: Bot, p: XYZ, range: number, ms: number, dig = true): Promise<boolean> {
  bot.pathfinder.setMovements(moves(bot, dig));
  await safeGoto(bot, new goals.GoalNear(p.x, p.y, p.z, range), ms).catch(() => {});
  return !!bot.entity && bot.entity.position.distanceTo(v(p)) <= range + 1.5;
}

/** Long walk in hops (handles lava, cliffs, stalls). Returns when close, stopped or out of time. */
async function march(bot: Bot, target: XYZ | { x: number; z: number }, ms: number, stop: () => boolean): Promise<void> {
  {
    const cur = (doingMap.get(bot.username)?.text ?? "walking").split(" (")[0];
    doing(bot, `${cur} (${Math.round(flat(bot.entity.position, target))} blocks to ${Math.round(target.x)} ${Math.round(target.z)})`);
  }
  const { marchToward } = await import("../skills/loot-bastion.js");
  const ac = new AbortController();
  const onDeath = () => ac.abort();
  bot.once("death", onDeath);
  try {
    await marchToward(bot, target, ms, ac.signal, {
      label: "speedrun",
      progress: () => 0.5,
      step: () => {},
      stop: () => stop() || currentMode() !== "game" || ac.signal.aborted,
      beforeHop: async () => {
        await defend(bot, 6);
        await topUp(bot);
      },
    });
  } finally {
    bot.removeListener("death", onDeath);
  }
}

/** Eat when hurt or hungry: golden apples when hurt, beef otherwise. */
const fireResAt = new Map<string, number>();

async function topUp(bot: Bot): Promise<void> {
  if (!bot.entity) return;
  // In the Nether keep Fire Resistance up (an enchanted golden apple gives 5 min of it):
  // falls into the lava sea under the fortress were the main killer.
  if (inNether(bot) && Date.now() - (fireResAt.get(bot.username) ?? 0) > 270_000 && count(bot, "enchanted_golden_apple")) {
    const held = bot.heldItem?.name;
    if (await equip(bot, "enchanted_golden_apple")) {
      bot.pathfinder.setGoal(null);
      await Promise.race([bot.consume().catch(() => {}), sleep(4000)]);
      fireResAt.set(bot.username, Date.now());
      console.log(`[Speedrun] ${bot.username}: ate an enchanted golden apple for fire resistance (${count(bot, "enchanted_golden_apple")} left)`);
      if (held) await equip(bot, held);
    }
  }
  let food: string | null = null;
  if (bot.health <= 8 && count(bot, "enchanted_golden_apple")) food = "enchanted_golden_apple";
  else if (bot.health <= 13 && count(bot, "golden_apple")) food = "golden_apple";
  else if (bot.food <= 14) food = ["cooked_beef", "golden_carrot", "bread", "golden_apple"].find((f) => count(bot, f)) ?? null;
  if (!food) return;
  const held = bot.heldItem?.name;
  if (await equip(bot, food)) {
    await Promise.race([bot.consume().catch(() => {}), sleep(4000)]);
    if (held) await equip(bot, held);
  }
}

const FOES = new Set([
  "zombie",
  "husk",
  "drowned",
  "skeleton",
  "stray",
  "spider",
  "cave_spider",
  "creeper",
  "witch",
  "wither_skeleton",
  "blaze",
  "magma_cube",
  "slime",
  "piglin_brute",
  "hoglin",
  "zoglin",
  "silverfish",
  "endermite",
  "pillager",
  "vindicator",
  "phantom",
]);

/** Fight off whatever hostile is within `radius` (bounded to 15 s). */
async function defend(bot: Bot, radius: number): Promise<number> {
  let fought = 0;
  const until = Date.now() + 15_000;
  while (Date.now() < until && bot.entity) {
    const me = bot.entity.position;
    const foe = bot.nearestEntity((e) => FOES.has(e.name ?? "") && e.isValid && e.position.distanceTo(me) <= radius);
    if (!foe) break;
    fought++;
    await equipSword(bot);
    const gap = foe.position.distanceTo(me);
    if (gap > 3.2) {
      bot.pathfinder.setMovements(moves(bot, false));
      await safeGoto(bot, new goals.GoalNear(foe.position.x, foe.position.y, foe.position.z, 2), 3000).catch(() => {});
    } else {
      await bot.lookAt(foe.position.offset(0, (foe.height ?? 1.8) * 0.8, 0), true).catch(() => {});
      bot.attack(foe);
      await sleep(620);
    }
  }
  return fought;
}

function blockInLine(bot: Bot, target: Vec3): string | null {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const d = target.minus(eye);
  const n = d.norm();
  if (n < 1) return null;
  const hit = (
    bot.world as unknown as {
      raycast: (from: Vec3, dir: Vec3, range: number) => { name: string; boundingBox?: string } | null;
    }
  ).raycast(eye, d.scaled(1 / n), n - 0.5);
  if (!hit || hit.boundingBox === "empty") return null;
  return hit.name;
}

/** One full-draw bow shot at `target`, leading it by `vel` (blocks/tick). */
async function shoot(bot: Bot, ent: Entity, aimHeight: number, vel: () => Vec3): Promise<boolean> {
  if (!(await equip(bot, "bow"))) return false;
  if (!count(bot, "arrow")) return false;
  const { pauseGaze } = await import("../skills/enderman-gaze.js");
  const plan = () => {
    const eye = bot.entity.position;
    let ticks = 0;
    let aim = ent.position.offset(0, aimHeight, 0);
    for (let i = 0; i < 3; i++) {
      const lead = vel().scaled(ticks);
      aim = ent.position.offset(lead.x, aimHeight + lead.y, lead.z);
      const d = Math.hypot(aim.x - eye.x, aim.z - eye.z);
      const pitch = solvePitch(ARROW, d, aim.y - eye.y);
      if (pitch === null) return null;
      ticks = flightTicks(ARROW, pitch, d);
    }
    const dx = aim.x - eye.x;
    const dz = aim.z - eye.z;
    const d = Math.hypot(dx, dz);
    if (d < 1.5) return null;
    const pitch = solvePitch(ARROW, d, aim.y - eye.y);
    if (pitch === null) return null;
    // Trace the arc through real blocks: a pillar or the bars of a cage stop it.
    const pathPts = flightPath(ARROW, pitch, aim.y - eye.y, d);
    for (const [fwd, h] of pathPts) {
      if (fwd > d - 1.5) break;
      const b = bot.blockAt(new Vec3(eye.x + (dx / d) * fwd, eye.y + h, eye.z + (dz / d) * fwd).floored());
      if (b && b.boundingBox === "block") return null;
    }
    return { yaw: Math.atan2(-dx, -dz), pitch };
  };
  let p = plan();
  if (!p) return false;
  bot.pathfinder.setGoal(null);
  pauseGaze(bot, 2500);
  bot.activateItem();
  const start = Date.now();
  while (Date.now() - start < 1100) {
    if (!ent.isValid) break;
    p = plan() ?? p;
    await bot.look(p.yaw, p.pitch, true).catch(() => {});
    await sleep(80);
  }
  if (ent.isValid) {
    p = plan() ?? p;
    await bot.look(p.yaw, p.pitch, true).catch(() => {});
  }
  bot.deactivateItem();
  await sleep(150);
  return true;
}

/** Velocity tracker for one entity (blocks per tick), sampled on demand. */
function tracker(ent: Entity) {
  const hist: { t: number; p: Vec3 }[] = [];
  return () => {
    const now = Date.now();
    hist.push({ t: now, p: ent.position.clone() });
    while (hist.length > 2 && now - hist[0].t > 600) hist.shift();
    if (hist.length < 2) return new Vec3(0, 0, 0);
    const a = hist[0];
    const b = hist[hist.length - 1];
    const ticks = Math.max(1, (b.t - a.t) / 50);
    return b.p.minus(a.p).scaled(1 / ticks);
  };
}

async function pickUpNear(bot: Bot, names: string[], radius: number, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until && bot.entity) {
    const me = bot.entity.position;
    const drop = Object.values(bot.entities)
      .filter((e) => {
        if (e.name !== "item" || !e.isValid || e.position.distanceTo(me) > radius) return false;
        const it = (e as unknown as { getDroppedItem?: () => { name?: string } | null }).getDroppedItem?.();
        return !!it?.name && names.includes(it.name);
      })
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    if (!drop) return;
    await goNear(bot, drop.position, 0.5, 6000, false);
    await sleep(400);
  }
}

/** Walk to a squadmate and hand it items by tossing them at its feet. */
async function handTo(bot: Bot, to: Bot, names: string[]): Promise<number> {
  if (!to.entity || !bot.entity) return 0;
  if (dim(to) !== dim(bot)) return 0;
  if (bot.entity.position.distanceTo(to.entity.position) > 24) {
    await follow(bot, to, 3);
    return 0;
  }
  if (bot.entity.position.distanceTo(to.entity.position) > 3) {
    await goNear(bot, to.entity.position, 2, 20_000, false);
  }
  if (bot.entity.position.distanceTo(to.entity.position) > 4) return 0;
  let given = 0;
  const heldBy = (b: Bot) => names.reduce((n, nm) => n + count(b, nm), 0);
  const before = heldBy(to);
  for (const name of names) {
    for (const it of bot.inventory.items().filter((i) => i.name === name)) {
      await bot.lookAt(to.entity.position.offset(0, 0.5, 0), true).catch(() => {});
      await bot.toss(it.type, null, it.count).catch(() => {});
      given += it.count;
    }
  }
  // A toss can be lost (receiver rejoined, walked off, pack full). Wait for the receiver's
  // count to rise; if it doesn't, take the items back instead of leaving them to despawn.
  const until = Date.now() + 7000;
  while (Date.now() < until && heldBy(to) - before < given) await sleep(300);
  const got = Math.max(0, heldBy(to) - before);
  if (got < given) {
    console.warn(`[Speedrun] ${bot.username}: only ${got}/${given} ${names.join("/")} reached ${to.username}; recovering the rest`);
    await pickUpNear(bot, names, 10, 6000);
    given = got;
  }
  if (given) doing(bot, `handed ${given} ${names.join("/")} to ${to.username}`);
  if (given) console.log(`[Speedrun] ${bot.username} handed ${given} item(s) (${names.join("/")}) to ${to.username}`);
  return given;
}

// Everything the route uses; the rest is junk the brain picked up over the session.
const KEEP = /^(netherite_.*|diamond_.*|iron_ingot|gold_ingot|bow|crossbow|arrow|spectral_arrow|shield|totem_of_undying|.*golden_apple|golden_carrot|cooked_.*|bread|baked_potato|ender_pearl|ender_eye|blaze_rod|blaze_powder|water_bucket|lava_bucket|bucket|flint_and_steel|obsidian|cobblestone|crafting_table|furnace|.*_bed|torch|oak_log|.*_planks|stick)$/;

/** Toss junk until `free` slots are open (one stack of cobblestone is kept for scaffolding). */
async function keepRoom(bot: Bot, free = 5): Promise<void> {
  if (bot.inventory.emptySlotCount() >= free) return;
  let cobbleKept = false;
  const items = [...bot.inventory.items()].sort((a, b) => a.count - b.count);
  for (const it of items) {
    if (bot.inventory.emptySlotCount() >= free) break;
    if (it.name === "cobblestone") {
      if (!cobbleKept) {
        cobbleKept = true;
        continue;
      }
    } else if (KEEP.test(it.name)) continue;
    await bot.toss(it.type, null, it.count).catch(() => {});
  }
  console.log(`[Speedrun] ${bot.username}: made room in the pack (${bot.inventory.emptySlotCount()} free)`);
}

async function craft(bot: Bot, name: string, times: number): Promise<number> {
  const item = bot.registry.itemsByName[name];
  if (!item || times <= 0) return 0;
  // One craft at a time: a batch call fails part-way ("missing ingredient") when
  // the inputs sit in several stacks, and leaves the result count unknown.
  let made = 0;
  for (let i = 0; i < times; i++) {
    const recipe = bot.recipesFor(item.id, null, 1, null)[0];
    if (!recipe) break;
    try {
      await bot.craft(recipe, 1, undefined);
      made++;
    } catch (err) {
      console.warn(`[Speedrun] ${bot.username} craft ${name} #${i + 1}/${times} failed: ${(err as Error).message}`);
      break;
    }
  }
  return made;
}

/** Follow the squad leader, or another anchor, keeping within `range`. */
async function follow(bot: Bot, anchor: Bot | undefined, range = 6): Promise<void> {
  if (anchor && anchor !== bot) doing(bot, `following ${anchor.username}`);
  if (!anchor?.entity || anchor === bot || dim(anchor) !== dim(bot)) {
    await defend(bot, 8);
    await sleep(1500);
    return;
  }
  const gap = bot.entity.position.distanceTo(anchor.entity.position);
  if (gap > 48) {
    const at = anchor.entity.position;
    await march(bot, { x: at.x, y: at.y, z: at.z }, 60_000, () => !anchor.entity || bot.entity.position.distanceTo(anchor.entity.position) < 16);
  } else if (gap > range) {
    await goNear(bot, anchor.entity.position, Math.max(2, range - 2), 15_000);
  } else {
    await defend(bot, 8);
    await sleep(1000);
  }
}

// ── Portal ──────────────────────────────────────────────────────────────────
const SOFT = /^(air|cave_air|short_grass|grass|tall_grass|fern|large_fern|dandelion|poppy|snow|dead_bush|.*_flower|.*_tulip|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|sweet_berry_bush)$/;

const HARD = /water|lava|bedrock|obsidian|chest|spawner|portal|unknown|bubble/;

export interface PortalSite {
  origin: Vec3;
  axis: "x" | "z";
  stand: Vec3;
}

/** Frame cells (i 0..3 along the axis, j 0..4 up); `frame` marks the border. */
export function frameCells(o: Vec3, axis: "x" | "z") {
  const out: { pos: Vec3; i: number; j: number; frame: boolean }[] = [];
  for (let j = 0; j <= 4; j++)
    for (let i = 0; i <= 3; i++) {
      const pos = axis === "x" ? o.offset(i, j, 0) : o.offset(0, j, i);
      out.push({ pos, i, j, frame: i === 0 || i === 3 || j === 0 || j === 4 });
    }
  return out;
}

function findPortalSite(bot: Bot): PortalSite | null {
  const p = bot.entity.position.floored();
  const name = (q: Vec3) => bot.blockAt(q)?.name ?? "unknown";
  const solid = (q: Vec3) => {
    const b = bot.blockAt(q);
    return !!b && b.boundingBox === "block" && !/leaves|lava|water|ice|sand|gravel/.test(b.name);
  };
  let best: { site: PortalSite; score: number } | null = null;
  for (let r = 2; r <= 14; r++)
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (let dy = -3; dy <= 3; dy++) {
          const o = p.offset(dx, dy, dz);
          for (const axis of ["x", "z"] as const) {
            const cells = frameCells(o, axis);
            // Any ordinary block in the way gets dug out; liquids and hard blocks rule a site out.
            let digs = 0;
            let blocked = false;
            for (const c of cells) {
              const n = name(c.pos);
              if (SOFT.test(n)) continue;
              if (HARD.test(n)) blocked = true;
              digs++;
            }
            if (blocked || digs > 8) continue;
            let ok = true;
            for (let i = 0; i <= 3 && ok; i++) ok = solid(axis === "x" ? o.offset(i, -1, 0) : o.offset(0, -1, i));
            if (!ok) continue;
            // Stand two blocks in front of the middle, on solid ground.
            for (const side of [2, -2]) {
              const stand = axis === "x" ? o.offset(1, 0, side) : o.offset(side, 0, 1);
              if (!SOFT.test(name(stand)) || !SOFT.test(name(stand.offset(0, 1, 0))) || !solid(stand.offset(0, -1, 0))) continue;
              const score = bot.entity.position.distanceTo(stand) + Math.abs(dy) * 2 + digs * 3;
              if (!best || score < best.score) best = { site: { origin: o, axis, stand }, score };
            }
          }
        }
      }
  return best?.site ?? null;
}

const siteTries = new Map<string, number>();

async function buildPortal(bot: Bot): Promise<boolean> {
  doing(bot, "building the Nether portal");
  if (count(bot, "obsidian") < 10 || !count(bot, "flint_and_steel")) {
    console.log(`[Speedrun] ${bot.username} cannot build: obsidian ${count(bot, "obsidian")}, flint_and_steel ${count(bot, "flint_and_steel")}`);
    return false;
  }
  const site = findPortalSite(bot);
  if (!site) {
    // Dig-capable march 32 blocks on the next compass heading (a boxed-in bot digs out).
    const tries = (siteTries.get(bot.username) ?? 0) + 1;
    siteTries.set(bot.username, tries);
    const a = (tries * 135 * Math.PI) / 180;
    const p = bot.entity.position;
    const goal = { x: p.x + Math.cos(a) * 32, z: p.z + Math.sin(a) * 32 };
    console.log(`[Speedrun] ${bot.username}: no portal site within 14 blocks; marching to ${Math.round(goal.x)},${Math.round(goal.z)}`);
    await march(bot, goal, 45_000, () => flat(bot.entity.position, goal) < 6);
    return false;
  }
  const { origin, axis, stand } = site;
  console.log(`[Speedrun] ${bot.username}: portal at ${origin} axis ${axis}, standing at ${stand}`);
  await goNear(bot, stand, 0, 20_000, false);
  if (bot.entity.position.distanceTo(stand.offset(0.5, 0, 0.5)) > 1.5) return false;
  bot.pathfinder.setGoal(null);
  const cells = frameCells(origin, axis);
  // Clear grass and flowers out of the frame and its doorway.
  for (const c of cells) {
    const b = bot.blockAt(c.pos);
    if (b && b.name !== "air" && b.name !== "cave_air") await bot.dig(b, true).catch(() => {});
  }
  const along = axis === "x" ? new Vec3(1, 0, 0) : new Vec3(0, 0, 1);
  // Bottom row, then both columns upward, then the top row from the left column.
  const order = [
    ...cells.filter((c) => c.j === 0),
    ...cells.filter((c) => c.frame && c.j >= 1 && c.j <= 4 && (c.i === 0 || c.i === 3)).sort((a, b) => a.j - b.j),
    ...cells.filter((c) => c.j === 4 && (c.i === 1 || c.i === 2)).sort((a, b) => a.i - b.i),
  ];
  for (const c of order) {
    const corner = (c.i === 0 || c.i === 3) && (c.j === 0 || c.j === 4);
    const want = corner && count(bot, "cobblestone") ? "cobblestone" : "obsidian";
    const here = bot.blockAt(c.pos);
    if (here && (here.name === "obsidian" || (corner && here.boundingBox === "block"))) continue;
    if (!(await equip(bot, want))) return false;
    const ref = c.j === 0 || c.i === 0 || c.i === 3 ? bot.blockAt(c.pos.offset(0, -1, 0)) : bot.blockAt(c.pos.minus(along));
    const face = c.j === 0 || c.i === 0 || c.i === 3 ? new Vec3(0, 1, 0) : along;
    if (!ref || ref.boundingBox !== "block") {
      console.log(`[Speedrun] ${bot.username}: no support for ${want} at ${c.pos}`);
      return false;
    }
    try {
      await bot.placeBlock(ref, face);
    } catch (err) {
      // placeBlock rejects on a slow block update even when the block landed.
      await sleep(300);
      if (bot.blockAt(c.pos)?.name !== want) {
        console.log(`[Speedrun] ${bot.username}: placing ${want} at ${c.pos} failed: ${(err as Error).message}`);
        return false;
      }
    }
  }
  const bottom = bot.blockAt(origin.plus(along));
  if (!bottom || !(await equip(bot, "flint_and_steel"))) return false;
  await bot.lookAt(bottom.position.offset(0.5, 1, 0.5), true).catch(() => {});
  await bot.activateBlock(bottom, new Vec3(0, 1, 0)).catch(() => {});
  await sleep(800);
  const lit = bot.blockAt(origin.plus(along).offset(0, 1, 0))?.name === "nether_portal";
  if (lit) {
    state.overworldPortal = origin.plus(along).offset(0, 1, 0);
    save();
  }
  console.log(`[Speedrun] ${bot.username}: portal ${lit ? "LIT" : "did not light"}`);
  return lit;
}

/**
 * Our frames stand on the ground, so the doorway is one block up. Lay a
 * cobblestone step in front of both doorway columns on both sides so the
 * crossing routine can walk straight in.
 */
async function buildSteps(bot: Bot, door: XYZ): Promise<void> {
  const d = v(door);
  if (bot.blockAt(d)?.name !== "nether_portal") return;
  const alongX = bot.blockAt(d.offset(1, 0, 0))?.name === "nether_portal" || bot.blockAt(d.offset(-1, 0, 0))?.name === "nether_portal";
  const along = alongX ? new Vec3(1, 0, 0) : new Vec3(0, 0, 1);
  const across = alongX ? new Vec3(0, 0, 1) : new Vec3(1, 0, 0);
  // Both doorway columns: the one on record and its portal neighbour.
  const cols = [d, bot.blockAt(d.plus(along))?.name === "nether_portal" ? d.plus(along) : d.minus(along)];
  for (const c of cols)
    for (const side of [1, -1]) {
      const step = c.plus(across.scaled(side)).offset(0, -1, 0);
      const here = bot.blockAt(step);
      const below = bot.blockAt(step.offset(0, -1, 0));
      if (!here || here.boundingBox === "block" || !below || below.boundingBox !== "block") continue;
      if (bot.entity.position.distanceTo(step) > 4) await goNear(bot, step.offset(0, 1, 0).plus(across.scaled(side)), 1, 10_000, false);
      if (!(await equip(bot, "cobblestone"))) return;
      if (here.name !== "air" && here.name !== "cave_air") await bot.dig(here, true).catch(() => {});
      await bot.placeBlock(below, new Vec3(0, 1, 0)).catch(() => {});
      console.log(`[Speedrun] ${bot.username}: step at ${step} -> ${bot.blockAt(step)?.name}`);
    }
}

async function crossTo(bot: Bot, doorway: XYZ, want: "nether" | "overworld" | "end"): Promise<boolean> {
  doing(bot, `heading through the portal to the ${want}`);
  const { crossPortal } = await import("../skills/nether-portal.js");
  const arrived = (d: string) => (want === "nether" ? d.includes("nether") : want === "end" ? d.includes("end") : !d.includes("nether") && !d.includes("end"));
  if (bot.entity.position.distanceTo(v(doorway)) > 40) {
    await march(bot, doorway, 120_000, () => bot.entity.position.distanceTo(v(doorway)) < 12);
    // Still far (a respawn 2,000 blocks off): keep marching on the next step, don't try the portal from here.
    if (bot.entity.position.distanceTo(v(doorway)) > 40) return false;
  }
  if (want === "nether" && state.overworldPortal && flat(doorway, state.overworldPortal) < 1) {
    await bedAtPortal(bot, doorway).catch((e) => console.warn(`[Speedrun] ${bot.username} bed failed: ${(e as Error).message}`));
    await buildSteps(bot, doorway);
    if (await walkInto(bot, doorway, "nether_portal", () => arrived(dim(bot)))) return true;
  }
  return crossPortal(bot, v(doorway), 60_000, arrived);
}

/**
 * Walk into a portal: stand on a solid block beside its lowest cells (same
 * height), face the cell and press forward. Returns true once `done()`.
 */
async function walkInto(bot: Bot, near: XYZ, block: string, done: () => boolean): Promise<boolean> {
  const id = bot.registry.blocksByName[block]?.id;
  if (id === undefined) return false;
  const cells = bot.findBlocks({ matching: id, maxDistance: 8, count: 12, point: v(near) }).map((c) => bot.blockAt(c)!.position);
  if (!cells.length) return false;
  const low = Math.min(...cells.map((c) => c.y));
  const isCell = (q: Vec3) => cells.some((c) => c.equals(q));
  const stands: { stand: Vec3; cell: Vec3 }[] = [];
  for (const c of cells.filter((c) => c.y === low))
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const st = c.offset(dx, 0, dz);
      if (isCell(st)) continue;
      const feet = bot.blockAt(st);
      const head = bot.blockAt(st.offset(0, 1, 0));
      const floor = bot.blockAt(st.offset(0, -1, 0));
      if (feet?.boundingBox === "empty" && head?.boundingBox === "empty" && floor?.boundingBox === "block") stands.push({ stand: st, cell: c });
    }
  stands.sort((a, b) => a.stand.distanceTo(bot.entity.position) - b.stand.distanceTo(bot.entity.position));
  for (const { stand, cell } of stands.slice(0, 3)) {
    bot.pathfinder.setMovements(moves(bot, false));
    await safeGoto(bot, new goals.GoalBlock(stand.x, stand.y, stand.z), 20_000).catch(() => {});
    if (bot.entity.position.distanceTo(stand.offset(0.5, 0, 0.5)) > 1.2) continue;
    bot.pathfinder.setGoal(null);
    const centre = cell.offset(0.5, 0, 0.5);
    bot.setControlState("forward", true);
    const t = Date.now();
    while (Date.now() - t < 2500 && bot.blockAt(bot.entity.position)?.name !== block && !done()) {
      await bot.lookAt(centre.offset(0, 1.6, 0), true).catch(() => {});
      await sleep(100);
    }
    bot.setControlState("forward", false);
    const wait = Date.now();
    while (Date.now() - wait < 7000 && !done()) await sleep(250);
    if (done()) return true;
    console.log(`[Speedrun] ${bot.username}: walked into ${block} from ${stand} but did not cross (in=${bot.blockAt(bot.entity.position)?.name})`);
  }
  return done();
}

const bedFailAt = new Map<string, number>();

/** Place a bed beside the overworld portal and click it: a death then respawns here, not 1,700 blocks away. */
async function bedAtPortal(bot: Bot, door: XYZ): Promise<void> {
  doing(bot, "setting a respawn bed at the portal");
  const key = `${door.x},${door.y},${door.z}`;
  state.beds ??= {};
  if (state.beds[bot.username] === key) return;
  if (Date.now() - (bedFailAt.get(bot.username) ?? 0) < 600_000) return;
  const bedItem = bot.inventory.items().find((i) => i.name.endsWith("_bed"));
  if (!bedItem) {
    state.beds[bot.username] = key;
    return;
  }
  const d = v(door);
  if (bot.entity.position.distanceTo(d) > 24) return; // chunks around the portal must be in view
  const free = (q: Vec3) => {
    const b = bot.blockAt(q);
    return !!b && (b.name === "air" || b.name === "cave_air" || SOFT.test(b.name)) && b.name !== "nether_portal";
  };
  const solid = (q: Vec3) => bot.blockAt(q)?.boundingBox === "block";
  const dirs: [number, number][] = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  // Any existing bed of ours nearby is reused.
  const existing = bot.findBlock({ matching: (b) => b.name.endsWith("_bed"), maxDistance: 10, point: d });
  let target = existing?.position ?? null;
  const why = { spots: 0, reached: 0, placed: 0, last: "" };
  if (!target) {
    outer: for (let r = 3; r <= 8; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          for (let dy = -2; dy <= 1; dy++) {
            const foot = d.offset(dx, dy - 1, dz);
            if (!free(foot) || !solid(foot.offset(0, -1, 0))) continue;
            for (const [ax, az] of dirs) {
              const head = foot.offset(ax, 0, az);
              const stand = foot.offset(-ax, 0, -az);
              if (!free(head) || !solid(head.offset(0, -1, 0)) || !free(stand) || !free(stand.offset(0, 1, 0)) || !solid(stand.offset(0, -1, 0))) continue;
              why.spots++;
              if (why.spots > 6) break outer;
              await goNear(bot, stand, 1, 15_000, false);
              if (bot.entity.position.offset(0, 1.62, 0).distanceTo(foot.offset(0.5, 0, 0.5)) > 4.2) continue;
              why.reached++;
              await bot.lookAt(head.offset(0.5, 0, 0.5), true).catch(() => {});
              if (!(await equip(bot, bedItem.name))) break outer;
              why.placed++;
              await bot.placeBlock(bot.blockAt(foot.offset(0, -1, 0))!, new Vec3(0, 1, 0)).catch((e: Error) => (why.last = e.message));
              await sleep(300);
              why.last += ` -> ${bot.blockAt(foot)?.name}`;
              if (bot.blockAt(foot)?.name.endsWith("_bed")) {
                target = foot;
                break outer;
              }
            }
          }
        }
  }
  if (!target) {
    console.log(`[Speedrun] ${bot.username}: no room for a bed by the portal (spots ${why.spots}, reached ${why.reached}, placed ${why.placed}, last ${why.last.slice(0, 120)})`);
    bedFailAt.set(bot.username, Date.now()); // retry in 10 min, not on every crossing
    return;
  }
  await goNear(bot, target, 2, 10_000, false);
  const bed = bot.blockAt(target);
  if (bed) await bot.activateBlock(bed).catch(() => {});
  await sleep(400);
  state.beds[bot.username] = key;
  save();
  console.log(`[Speedrun] ${bot.username}: respawn point set at the bed by the portal (${target})`);
  await talk(bot, "bed", `Spawn set at our portal bed`, 60_000);
}

/** Step out of the portal so the bot is not sent back and teammates can arrive. */
async function stepOffPortal(bot: Bot): Promise<void> {
  const here = bot.blockAt(bot.entity.position);
  if (here?.name !== "nether_portal") return;
  const p = bot.entity.position;
  for (const [dx, dz] of [
    [3, 0],
    [-3, 0],
    [0, 3],
    [0, -3],
  ]) {
    if (await goNear(bot, { x: p.x + dx, y: p.y, z: p.z + dz }, 1, 5000)) return;
  }
}

// ── Nether ──────────────────────────────────────────────────────────────────
const heading = new Map<string, number>();

function seeBricks(bot: Bot): Vec3 | null {
  const id = bot.registry.blocksByName.nether_bricks?.id;
  if (id === undefined) return null;
  return bot.findBlock({ matching: id, maxDistance: 96 })?.position ?? null;
}

async function searchFortress(bot: Bot, index: number): Promise<void> {
  doing(bot, "searching for a fortress");
  const seen = seeBricks(bot);
  if (seen) {
    if (!state.fortress) {
      state.fortress = { x: seen.x, y: seen.y, z: seen.z };
      save();
      setPhase("blaze", `${bot.username} sees a fortress at ${seen.x} ${seen.y} ${seen.z}. Everyone there!`);
    }
    return;
  }
  const round = heading.get(bot.username) ?? 0;
  heading.set(bot.username, round + 1);
  const from = state.netherPortal ?? bot.entity.position;
  const angle = ((index * 72 + round * 36) * Math.PI) / 180;
  const radius = 200 + 80 * Math.floor(round / 2);
  const target = { x: from.x + Math.cos(angle) * radius, z: from.z + Math.sin(angle) * radius };
  console.log(`[Speedrun] ${bot.username}: fortress sweep ${round + 1} toward ${Math.round(target.x)},${Math.round(target.z)}`);
  await march(bot, target, 150_000, () => !!state.fortress || !!seeBricks(bot));
  const now = seeBricks(bot);
  if (now && !state.fortress) {
    state.fortress = { x: now.x, y: now.y, z: now.z };
    save();
    setPhase("blaze", `${bot.username} found a fortress at ${now.x} ${now.y} ${now.z}. Everyone there!`);
  }
}

async function fightBlaze(bot: Bot, blaze: Entity): Promise<void> {
  doing(bot, `fighting a blaze (${Math.round(blaze.position.distanceTo(bot.entity.position))} blocks away)`);
  const until = Date.now() + 40_000;
  const vel = tracker(blaze);
  let chaseFails = 0;
  while (blaze.isValid && Date.now() < until && bot.entity && currentMode() === "game") {
    vel();
    await topUp(bot);
    const me = bot.entity.position;
    const gap = blaze.position.distanceTo(me);
    if (gap <= 3.3) {
      await equipSword(bot);
      await bot.lookAt(blaze.position.offset(0, 1, 0), true).catch(() => {});
      bot.attack(blaze);
      await sleep(620);
      continue;
    }
    // Sword kills drop more rods (Looting III); shoot only what the sword cannot reach.
    const high = blaze.position.y - me.y > 2.5;
    if ((high || chaseFails >= 2) && gap <= 40 && !blockInLine(bot, blaze.position.offset(0, 1, 0))) {
      await shoot(bot, blaze, 1.0, vel);
      continue;
    }
    const before = gap;
    await goNear(bot, blaze.position, 2, 5000, false);
    if (blaze.isValid && blaze.position.distanceTo(bot.entity.position) > before - 1) chaseFails++;
  }
  await sleep(600);
  const before = count(bot, "blaze_rod");
  await pickUpNear(bot, ["blaze_rod"], 16, 10_000);
  if (count(bot, "blaze_rod") > before) {
    await talk(bot, "rod", `Got ${count(bot, "blaze_rod") - before} blaze rod(s)! Squad has ${squadCount("blaze_rod")}/${state.rodTarget}`, 5000);
  } else if (!blaze.isValid) {
    await talk(bot, "kill", `Blaze down, no rod. Squad ${squadCount("blaze_rod")}/${state.rodTarget}`, 15_000);
  }
}

async function huntBlazes(bot: Bot): Promise<void> {
  doing(bot, "hunting blazes");
  const f = state.fortress!;
  if (flat(bot.entity.position, f) > 48) {
    await march(bot, f, 120_000, () => flat(bot.entity.position, f) < 24 || squadCount("blaze_rod") >= state.rodTarget);
    return;
  }
  // Under the fortress (the lava sea is at y=31, bridges near y=60): climb to its height first.
  if (bot.entity.position.y < f.y - 6) {
    console.log(`[Speedrun] ${bot.username}: ${Math.round(f.y - bot.entity.position.y)} blocks below the fortress, climbing`);
    await talk(bot, "climb", `Under the fortress, climbing up to it`, 60_000);
    await goNear(bot, { x: f.x, y: f.y + 1, z: f.z }, 3, 45_000, true);
    return;
  }
  await defend(bot, 6);
  await topUp(bot);
  const me = bot.entity.position;
  const blaze = bot.nearestEntity((e) => e.name === "blaze" && e.isValid && e.position.distanceTo(me) < 48);
  if (blaze) {
    await fightBlaze(bot, blaze);
    return;
  }
  await pickUpNear(bot, ["blaze_rod"], 24, 8000);
  if (!state.spawner) {
    const id = bot.registry.blocksByName.spawner?.id;
    const sp = id !== undefined ? bot.findBlock({ matching: id, maxDistance: 128 }) : null;
    if (sp) {
      // Blaze spawners stand on raised brick platforms; other spawners in a fortress do not exist.
      state.spawner = { x: sp.position.x, y: sp.position.y, z: sp.position.z };
      save();
      announce(`${bot.username} found the blaze spawner at ${sp.position.x} ${sp.position.y} ${sp.position.z}`);
    }
  }
  if (state.spawner) {
    await goNear(bot, state.spawner, 5, 20_000);
    await defend(bot, 8);
    await sleep(2000);
    return;
  }
  // Explore the fortress: walk to a random brick in view.
  const id = bot.registry.blocksByName.nether_bricks?.id;
  const bricks = id !== undefined ? bot.findBlocks({ matching: id, maxDistance: 64, count: 200 }) : [];
  if (bricks.length) {
    const b = bricks[Math.floor(Math.random() * bricks.length)];
    await goNear(bot, b.offset(0, 1, 0), 2, 25_000);
  } else {
    await goNear(bot, f, 3, 30_000);
  }
}

// ── Eyes and the stronghold ─────────────────────────────────────────────────
async function craftEyes(bot: Bot): Promise<void> {
  if (count(bot, "blaze_rod") || count(bot, "blaze_powder")) await keepRoom(bot, 6);
  const before = { rods: count(bot, "blaze_rod"), powder: count(bot, "blaze_powder"), eyes: count(bot, "ender_eye") };
  if (count(bot, "blaze_rod") || count(bot, "blaze_powder")) doing(bot, "crafting eyes of ender");
  const rods = count(bot, "blaze_rod");
  if (rods) await craft(bot, "blaze_powder", rods);
  const n = Math.min(count(bot, "blaze_powder"), count(bot, "ender_pearl"));
  if (n) {
    const made = await craft(bot, "ender_eye", n);
    console.log(`[Speedrun] ${bot.username} crafted ${made}/${n} eyes of ender (holds ${count(bot, "ender_eye")})`);
    await talk(bot, "eyes", `Crafted ${n} eyes of ender, bringing them to ${leaderName()}`, 10_000);
  }
  const value = (r: number, p: number, e: number) => r * 2 + p + e;
  const after = value(count(bot, "blaze_rod"), count(bot, "blaze_powder"), count(bot, "ender_eye"));
  if (after < value(before.rods, before.powder, before.eyes)) {
    console.warn(`[Speedrun] ${bot.username}: crafting LOST items (rods ${before.rods}->${count(bot, "blaze_rod")}, powder ${before.powder}->${count(bot, "blaze_powder")}, eyes ${before.eyes}->${count(bot, "ender_eye")}, free slots ${bot.inventory.emptySlotCount()})`);
  }
}

/**
 * Least-squares intersection of eye lines. Each line is a point and a unit
 * heading; returns null when the lines are near-parallel or the point lies
 * behind any throw.
 */
export function intersectLines(lines: EyeLine[]): { x: number; z: number } | null {
  if (lines.length < 2) return null;
  let a11 = 0,
    a12 = 0,
    a22 = 0,
    b1 = 0,
    b2 = 0;
  for (const l of lines) {
    // Projector onto the line's normal: I - d d^T.
    const p11 = 1 - l.dx * l.dx;
    const p12 = -l.dx * l.dz;
    const p22 = 1 - l.dz * l.dz;
    a11 += p11;
    a12 += p12;
    a22 += p22;
    b1 += p11 * l.x + p12 * l.z;
    b2 += p12 * l.x + p22 * l.z;
  }
  const det = a11 * a22 - a12 * a12;
  if (Math.abs(det) < 0.004) return null; // under ~3.6 degrees apart
  const x = (a22 * b1 - a12 * b2) / det;
  const z = (a11 * b2 - a12 * b1) / det;
  for (const l of lines) if ((x - l.x) * l.dx + (z - l.z) * l.dz < -24) return null;
  return { x, z };
}

interface EyeReading {
  dx: number;
  dz: number;
  descended: boolean;
  end: Vec3;
}

/** Throw one eye of ender and read its heading from its flight. */
async function throwEye(bot: Bot): Promise<EyeReading | null> {
  doing(bot, `throwing an eye of ender (${count(bot, "ender_eye")} left)`);
  if (!(await equip(bot, "ender_eye"))) return null;
  bot.pathfinder.setGoal(null);
  bot.clearControlStates();
  await sleep(300);
  const origin = bot.entity.position.clone();
  let eyeEnt: Entity | null = null;
  const onSpawn = (e: Entity) => {
    if (!eyeEnt && e.name === "eye_of_ender" && e.position.distanceTo(origin) < 5) eyeEnt = e;
  };
  bot.on("entitySpawn", onSpawn);
  // Look at the sky so the throw never lands on a block as a placement.
  await bot.look(bot.entity.yaw, 0.6, true).catch(() => {});
  bot.activateItem();
  const pts: Vec3[] = [];
  const start = Date.now();
  while (Date.now() - start < 3500) {
    await sleep(100);
    const e = eyeEnt as Entity | null;
    if (e && e.isValid) pts.push(e.position.clone());
    else if (e && pts.length) break;
  }
  bot.removeListener("entitySpawn", onSpawn);
  if (pts.length < 4) {
    console.log(`[Speedrun] ${bot.username}: eye throw unread (${pts.length} samples)`);
    return null;
  }
  const a = pts[0];
  const b = pts[pts.length - 1];
  const len = Math.hypot(b.x - a.x, b.z - a.z);
  if (len < 0.5) return null;
  const top = Math.max(...pts.map((q) => q.y));
  const descended = b.y < top - 1.5 && b.y < origin.y + 1;
  // The eye drops as an item 80% of the time; pick it back up.
  await sleep(1200);
  await pickUpNear(bot, ["ender_eye"], 16, 8000);
  return { dx: (b.x - a.x) / len, dz: (b.z - a.z) / len, descended, end: b };
}

function findFrames(bot: Bot, radius = 128): Vec3[] {
  const id = bot.registry.blocksByName.end_portal_frame?.id;
  if (id === undefined) return [];
  return bot.findBlocks({ matching: id, maxDistance: radius, count: 12 });
}
const frameHasEye = (bot: Bot, p: Vec3) => {
  const props = bot.blockAt(p)?.getProperties() as Record<string, unknown> | undefined;
  return props?.eye === true || props?.eye === "true";
};

function noteFrames(bot: Bot): boolean {
  const frames = findFrames(bot);
  if (!frames.length) return false;
  const cx = frames.reduce((n, f) => n + f.x, 0) / frames.length;
  const cz = frames.reduce((n, f) => n + f.z, 0) / frames.length;
  state.endPortal = { x: Math.round(cx), y: frames[0].y, z: Math.round(cz) };
  save();
  setPhase("fill", `End portal frames found at ${state.endPortal.x} ${state.endPortal.y} ${state.endPortal.z} by ${bot.username}`);
  return true;
}

async function strongholdLeg(bot: Bot): Promise<void> {
  doing(bot, "leading the stronghold search");
  if (noteFrames(bot)) return;
  const me = bot.entity.position;
  const eyes = count(bot, "ender_eye");
  const est = state.stronghold;
  // Near the estimate with no frames in view: throw again here (the eye dives when within 12 blocks).
  // Never throw into the 12 the portal needs (counting what squadmates carry),
  // except once right on top of the estimate, where one dive settles it.
  const squadEyes = squadCount("ender_eye");
  const mayThrow = eyes > 0 && (squadEyes > PORTAL_EYES || (!!est && flat(me, est) < 32));
  if (mayThrow) {
    const r = await throwEye(bot);
    if (r) {
      if (r.descended) {
        state.stronghold = { x: r.end.x, z: r.end.z, exact: true };
        announce(`Eye dove at ${Math.round(r.end.x)} ${Math.round(r.end.z)}: the stronghold is right here, digging down.`);
      } else {
        state.eyeLines.push({ x: me.x, z: me.z, dx: r.dx, dz: r.dz });
        if (state.eyeLines.length > 6) state.eyeLines.shift();
        const fix = intersectLines(state.eyeLines);
        const deg = Math.round((Math.atan2(r.dz, r.dx) * 180) / Math.PI);
        if (fix) {
          state.stronghold = { ...fix, exact: false };
          announce(`Eye heading ${deg} deg; stronghold estimate ${Math.round(fix.x)} ${Math.round(fix.z)}, ${Math.round(flat(me, { x: fix.x, z: fix.z }))} blocks. Follow me!`);
        } else {
          announce(`Eye heading ${deg} deg, following it. Squad, on me!`);
        }
      }
      save();
    }
  }
  const s = state.stronghold;
  if (s && s.exact && flat(me, { x: s.x, z: s.z }) < 16) {
    // Right above it: dig down in a staircase toward y=30 and look again.
    await digDownToward(bot, 30);
    noteFrames(bot);
    return;
  }
  let target: { x: number; z: number };
  const last = state.eyeLines[state.eyeLines.length - 1];
  if (s && flat(me, { x: s.x, z: s.z }) < 3000) {
    const d = flat(me, { x: s.x, z: s.z });
    const step = Math.min(LEG, d);
    target = { x: me.x + ((s.x - me.x) / d) * step, z: me.z + ((s.z - me.z) / d) * step };
  } else if (last) {
    // Walk the heading, sidestepping a little each leg so the next throw has a new angle.
    const side = state.eyeLines.length % 2 ? 1 : -1;
    target = { x: me.x + last.dx * LEG - last.dz * 40 * side, z: me.z + last.dz * LEG + last.dx * 40 * side };
  } else {
    await sleep(2000);
    return;
  }
  await march(bot, target, 180_000, () => findFrames(bot).length > 0 || flat(bot.entity.position, { x: target.x, z: target.z }) < 8);
  noteFrames(bot);
}

/** Staircase down (two blocks forward per block down) to `y`; never straight down. */
async function digDownToward(bot: Bot, y: number): Promise<void> {
  const p = bot.entity.position.floored();
  if (p.y <= y) return;
  const target = p.offset(Math.max(4, Math.min(24, (p.y - y) * 1)), -(p.y - y), 0);
  bot.pathfinder.setMovements(moves(bot, true));
  await safeGoto(bot, new goals.GoalNear(target.x, target.y, target.z, 3), 90_000).catch(() => {});
}

async function fillPortal(bot: Bot): Promise<void> {
  doing(bot, "filling the End portal frames");
  const ep = state.endPortal!;
  const frames = findFrames(bot, 64);
  if (!frames.length) {
    await march(bot, ep, 120_000, () => findFrames(bot, 64).length > 0);
    return;
  }
  const empty = frames.filter((f) => !frameHasEye(bot, f));
  if (!empty.length) {
    setPhase("end", "End portal is open. Everyone jump in!");
    return;
  }
  const eyes = count(bot, "ender_eye");
  if (eyes < empty.length) {
    const short = empty.length - eyes;
    const held = squadBots()
      .filter((b) => b !== bot)
      .reduce((n, b) => n + count(b, "ender_eye"), 0);
    if (confirmedGone("portal-short", held === 0)) {
      state.rodTarget = squadCount("blaze_rod") + Math.ceil(short / 2) + 1;
      save();
      setPhase("nether", `${short} eyes short for the portal; back to the Nether for more rods`);
      return;
    }
    announce(`Need ${short} more eyes at the portal, bring them to ${bot.username}`);
  }
  for (const f of empty.sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))) {
    if (!count(bot, "ender_eye")) break;
    if (bot.entity.position.offset(0, 1.62, 0).distanceTo(f.offset(0.5, 0.8, 0.5)) > 4.2) {
      await goNear(bot, f.offset(0, 1, 0), 2, 45_000);
    }
    if (bot.entity.position.offset(0, 1.62, 0).distanceTo(f.offset(0.5, 0.8, 0.5)) > 4.8) continue;
    const block = bot.blockAt(f);
    if (!block || !(await equip(bot, "ender_eye"))) continue;
    await bot.lookAt(f.offset(0.5, 0.85, 0.5), true).catch(() => {});
    await bot.activateBlock(block, new Vec3(0, 1, 0)).catch(() => {});
    await sleep(350);
    console.log(`[Speedrun] ${bot.username}: frame ${f} ${frameHasEye(bot, f) ? "filled" : "did not take the eye"}`);
  }
  if (findFrames(bot, 64).every((f) => frameHasEye(bot, f))) setPhase("end", "End portal is open. Everyone jump in!");
}

async function jumpIn(bot: Bot): Promise<void> {
  doing(bot, "jumping into the End portal");
  const id = bot.registry.blocksByName.end_portal?.id;
  const cell = id !== undefined ? bot.findBlock({ matching: id, maxDistance: 48 }) : null;
  if (!cell) {
    if (state.endPortal) await goNear(bot, v(state.endPortal).offset(0, 1, 2), 3, 60_000);
    return;
  }
  if (await walkInto(bot, cell.position, "end_portal", () => inEnd(bot))) return;
  // Fallback: stand on the nearest frame next to the portal and walk into it.
  const frames = findFrames(bot, 48).sort((a, b) => a.distanceTo(cell.position) - b.distanceTo(cell.position));
  const stand = frames[0]?.offset(0, 1, 0) ?? cell.position.offset(0, 1, 2);
  await goNear(bot, stand, 1, 30_000);
  bot.pathfinder.setGoal(null);
  const centre = cell.position.offset(0.5, 0.5, 0.5);
  bot.setControlState("forward", true);
  const until = Date.now() + 4000;
  while (Date.now() < until && !inEnd(bot)) {
    await bot.lookAt(centre, true).catch(() => {});
    await sleep(150);
  }
  bot.setControlState("forward", false);
  if (!inEnd(bot)) await sleep(1500);
}

// ── The End ─────────────────────────────────────────────────────────────────
function exitPortalOpen(bot: Bot): boolean {
  const id = bot.registry.blocksByName.end_portal?.id;
  if (id === undefined) return false;
  const b = bot.findBlock({ matching: id, maxDistance: 160 });
  return !!b && Math.hypot(b.position.x, b.position.z) < 8;
}

const dragonVel = new WeakMap<Entity, () => Vec3>();

async function fightDragon(bot: Bot, index: number): Promise<void> {
  doing(bot, "fighting the Ender Dragon");
  if (exitPortalOpen(bot)) {
    setPhase("done", `THE DRAGON IS DEAD. Squad ${SQUAD} finished in ${elapsed()}!`);
    return;
  }
  await topUp(bot);
  const me = bot.entity.position;
  // Lingering dragon breath: step out of it.
  const cloud = bot.nearestEntity((e) => e.name === "area_effect_cloud" && e.position.distanceTo(me) < 5);
  if (cloud) {
    const away = me.minus(cloud.position);
    const n = Math.max(0.1, Math.hypot(away.x, away.z));
    await goNear(bot, { x: me.x + (away.x / n) * 7, y: me.y, z: me.z + (away.z / n) * 7 }, 2, 4000, false);
    return;
  }
  const centreGap = Math.hypot(me.x, me.z);
  if (centreGap > 45) {
    // From the arrival platform to the island: march (it bridges over the void with cobblestone).
    await march(bot, { x: 0, y: 64, z: 0 }, 90_000, () => Math.hypot(bot.entity.position.x, bot.entity.position.z) < 30);
    return;
  }
  const dragon = bot.nearestEntity((e) => e.name === "ender_dragon" && e.isValid);
  if (dragon) {
    let vel = dragonVel.get(dragon);
    if (!vel) dragonVel.set(dragon, (vel = tracker(dragon)));
    const speed = vel().norm();
    const dHoriz = Math.hypot(dragon.position.x, dragon.position.z);
    const perched = dHoriz < 6 && speed < 0.25 && dragon.position.y < 80;
    if (perched) {
      // On the fountain: everyone into melee range of the head.
      const gap = dragon.position.distanceTo(me);
      if (gap > 4) {
        await goNear(bot, dragon.position, 3, 5000, false);
      } else {
        await equipSword(bot);
        await bot.lookAt(dragon.position.offset(0, 1.5, 0), true).catch(() => {});
        bot.attack(dragon);
        await sleep(620);
      }
      return;
    }
  }
  // Crystals in the open first (those in iron cages block the arc and are skipped).
  const crystals = Object.values(bot.entities)
    .filter((e) => e.name === "end_crystal" && e.isValid && e.position.distanceTo(me) < 90)
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  for (const c of crystals) {
    if (await shoot(bot, c, 0.5, () => new Vec3(0, 0, 0))) return;
  }
  if (dragon && dragon.position.distanceTo(me) < 70) {
    const vel = dragonVel.get(dragon)!;
    if (await shoot(bot, dragon, 1.5, vel)) return;
  }
  // Nothing to shoot from here: take this bot's post on a ring around the fountain.
  const a = (index * 2 * Math.PI) / 5;
  const post = { x: Math.cos(a) * 18, y: me.y, z: Math.sin(a) * 18 };
  if (flat(me, post) > 6) await goNear(bot, post, 3, 10_000);
  else {
    await defend(bot, 4);
    await sleep(800);
  }
}

/**
 * Giving up (sending the squad back to the Nether) is expensive and wrong when
 * the "missing" items are just carried by a bot that is offline for a moment
 * (restart, rejoin). Only trust the condition when all five bots are online and
 * it has held for 90 s without a break.
 */
const giveUpSince = new Map<string, number>();
function confirmedGone(key: string, cond: boolean): boolean {
  const everyone = squadBots().filter((b) => b.entity).length >= 5;
  if (!cond || !everyone) {
    giveUpSince.delete(key);
    return false;
  }
  const t = giveUpSince.get(key) ?? Date.now();
  giveUpSince.set(key, t);
  return Date.now() - t > 90_000;
}

// ── Team talk and self-recovery ─────────────────────────────────────────────
async function talk(bot: Bot, kind: string, text: string, cooldownMs = 20_000): Promise<void> {
  const { say } = await import("./team-comms.js");
  say(bot, `sr-${kind}`, text, cooldownMs);
}

/** Dig out of a pocket: clear feet and head cells on each side in turn and step through. */
async function unstick(bot: Bot): Promise<void> {
  doing(bot, "stuck, digging out");
  const p = bot.entity.position.floored();
  console.log(`[Speedrun] ${bot.username}: pinned at ${p} for a while, digging out`);
  await talk(bot, "stuck", `I'm stuck at ${p.x} ${p.y} ${p.z}, digging out`, 60_000);
  for (const [dx, dz] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].sort(() => Math.random() - 0.5)) {
    let open = true;
    for (const dy of [0, 1]) {
      const b = bot.blockAt(p.offset(dx, dy, dz));
      if (!b || b.boundingBox !== "block") continue;
      if (/water|lava|bedrock|obsidian|portal/.test(b.name)) {
        open = false;
        break;
      }
      await equip(bot, "netherite_pickaxe");
      await bot.dig(b, true).catch(() => {});
      if (bot.blockAt(b.position)?.boundingBox === "block") open = false;
    }
    if (!open) continue;
    bot.pathfinder.setGoal(null);
    await bot.lookAt(p.offset(dx + 0.5, 1.6, dz + 0.5), true).catch(() => {});
    bot.setControlState("forward", true);
    bot.setControlState("jump", true);
    await sleep(1200);
    bot.clearControlStates();
    if (bot.entity.position.distanceTo(p.offset(0.5, 0, 0.5)) > 1.5) return;
  }
  // Nothing sideways: pillar up two blocks on cobblestone.
  for (let i = 0; i < 2 && (await equip(bot, "cobblestone")); i++) {
    const above = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0));
    if (above && above.boundingBox === "block" && !/water|lava|bedrock/.test(above.name)) {
      await equip(bot, "netherite_pickaxe");
      await bot.dig(above, true).catch(() => {});
      await equip(bot, "cobblestone");
    }
    bot.setControlState("jump", true);
    await sleep(350);
    const under = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
    if (under) await bot.placeBlock(under, new Vec3(0, 1, 0)).catch(() => {});
    bot.setControlState("jump", false);
    await sleep(300);
  }
}

// ── Per-bot driver ──────────────────────────────────────────────────────────
interface Pausable {
  pause(): void;
  resume(): void;
}

const order = (name: string) => squadBots().map((b) => b.username).sort().indexOf(name);

async function step(bot: Bot): Promise<void> {
  const me = bot.username;
  await keepRoom(bot);
  if (inNether(bot)) await topUp(bot);
  // The overworld half of the route is run by the captain (the leader when it is there).
  const lead = ["home", "eyes", "stronghold", "fill"].includes(state.phase) ? captain() : leader();
  const idx = Math.max(0, order(me));
  switch (state.phase) {
    case "portal": {
      if (!inOverworld(bot)) {
        setPhase("nether", `${me} is already in the Nether`);
        return;
      }
      if (state.overworldPortal && bot.blockAt(v(state.overworldPortal))?.name === "nether_portal") {
        setPhase("nether", `portal lit at ${state.overworldPortal.x} ${state.overworldPortal.y} ${state.overworldPortal.z}. Everyone in!`);
        return;
      }
      // Only bots near the leader may build: a far one would drag the squad across the map.
      const anchor = lead?.entity?.position ?? bot.entity.position;
      const builders = squadBots()
        .filter((b) => b.entity && inOverworld(b) && b.entity.position.distanceTo(anchor) < 64)
        .sort((a, b) => (isLeader(b.username) ? 1 : 0) - (isLeader(a.username) ? 1 : 0) || count(b, "obsidian") - count(a, "obsidian"));
      const usable = builders.filter((b) => (siteTries.get(b.username) ?? 0) < 4 || builders.every((x) => (siteTries.get(x.username) ?? 0) >= 4));
      builders.splice(0, builders.length, ...usable);
      const builder =
        builders.find((b) => count(b, "obsidian") >= 10 && count(b, "flint_and_steel")) ??
        [...builders].sort((a, b) => count(b, "obsidian") - count(a, "obsidian"))[0];
      if (builder === bot) {
        if (state.builder !== me) {
          state.builder = me;
          save();
          announce(`${me} is building our Nether portal. Squad, on me!`);
        }
        if (count(bot, "obsidian") < 10 || !count(bot, "flint_and_steel")) {
          await pickUpNear(bot, ["obsidian", "flint_and_steel"], 8, 3000);
          await sleep(2000);
          return;
        }
        if (await buildPortal(bot)) setPhase("nether", `${me} lit the portal. Everyone in!`);
      } else {
        // Pool obsidian into a builder that is short of it.
        if (builder?.entity && count(builder, "obsidian") < 10 && count(bot, "obsidian")) {
          if (bot.entity.position.distanceTo(builder.entity.position) > 12) await follow(bot, builder, 4);
          else await handTo(bot, builder, ["obsidian"]);
          return;
        }
        if (builder && !count(builder, "flint_and_steel") && count(bot, "flint_and_steel")) {
          await handTo(bot, builder, ["flint_and_steel"]);
          return;
        }
        await follow(bot, builder, 5);
      }
      return;
    }
    case "nether":
    case "fortress":
    case "blaze": {
      if (state.phase === "blaze" && squadCount("blaze_rod") >= state.rodTarget) {
        setPhase("home", `squad holds ${squadCount("blaze_rod")} blaze rods. Back to the portal!`);
        return;
      }
      if (inEnd(bot)) return;
      if (inOverworld(bot)) {
        const door = state.overworldPortal;
        if (!door) {
          setPhase("portal", "no portal on record; building one");
          return;
        }
        if (await crossTo(bot, door, "nether")) {
          const p = bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 8 });
          if (p && !state.netherPortal) {
            state.netherPortal = { x: p.position.x, y: p.position.y, z: p.position.z };
            save();
          }
          await stepOffPortal(bot);
        }
        return;
      }
      await stepOffPortal(bot);
      if (state.phase === "nether") {
        const allIn = squadBots().every((b) => !b.entity || inNether(b));
        const since = Date.now() - Date.parse(state.splits.nether ?? state.startedAt);
        if (lead && inNether(lead) && (allIn || since > 90_000)) {
          setPhase(state.fortress ? "blaze" : "fortress", state.fortress ? "back to the fortress" : "fan out and find a fortress. Call it when you see nether bricks!");
        } else {
          await defend(bot, 8);
          await sleep(1500);
        }
        return;
      }
      if (state.phase === "fortress") return searchFortress(bot, idx);
      return huntBlazes(bot);
    }
    case "home": {
      if (inNether(bot)) {
        const door = state.netherPortal ?? bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 64 })?.position;
        if (!door) {
          // Lost the way: walk back along the 8:1 rule from the overworld portal.
          const o = state.overworldPortal;
          if (o) await march(bot, { x: o.x / 8, z: o.z / 8 }, 120_000, () => !!bot.findBlock({ matching: (b) => b.name === "nether_portal", maxDistance: 48 }));
          return;
        }
        await crossTo(bot, door, "overworld");
        return;
      }
      await stepOffPortal(bot);
      const allOut = squadBots().every((b) => !b.entity || inOverworld(b));
      // Never leave the rod carriers behind: they are the whole point of the trip.
      const rodsOut = squadBots().every((b) => !count(b, "blaze_rod") || inOverworld(b));
      const since = Date.now() - Date.parse(state.splits.home ?? state.startedAt);
      if (lead && inOverworld(lead) && rodsOut && (allOut || since > 120_000)) setPhase("eyes", "home with the rods. Craft eyes and give them to the leader!");
      else await follow(bot, lead, 6);
      return;
    }
    case "eyes": {
      if (!inOverworld(bot)) {
        // A straggler still in the Nether walks home; the squad phase stays.
        if (inNether(bot) && state.netherPortal) await crossTo(bot, state.netherPortal, "overworld");
        return;
      }
      await craftEyes(bot);
      if (lead && bot !== lead && count(bot, "ender_eye")) {
        await handTo(bot, lead, ["ender_eye"]);
        return;
      }
      if (bot === lead) {
        await pickUpNear(bot, ["ender_eye"], 8, 3000);
        // Wait for every rod, powder and eye in the squad (any dimension) to reach the leader.
        const others = squadBots().filter((b) => b !== bot && b.entity);
        const pending = others.some((b) => count(b, "ender_eye") || count(b, "blaze_rod") || count(b, "blaze_powder"));
        const since = Date.now() - Date.parse(state.splits.eyes ?? state.startedAt);
        const eyes = count(bot, "ender_eye");
        if (eyes >= PORTAL_EYES + 2 && (!pending || since > 120_000)) setPhase("stronghold", `${eyes} eyes of ender in hand. Throwing the first one!`);
        else if (eyes > 0 && !pending) setPhase("stronghold", `${eyes} eyes of ender in hand. Throwing the first one!`);
        else if (confirmedGone("eyes-gone", eyes === 0 && !pending && !squadCount("blaze_rod") && !squadCount("blaze_powder"))) {
          state.rodTarget = 8;
          save();
          setPhase("nether", "no rods or eyes left in the squad; back to the Nether");
        } else await sleep(2000);
        return;
      }
      await follow(bot, lead, 3);
      return;
    }
    case "stronghold": {
      if (!inOverworld(bot)) {
        if (inNether(bot) && state.netherPortal) await crossTo(bot, state.netherPortal, "overworld");
        return;
      }
      if (bot === lead) {
        if (!count(bot, "ender_eye") && squadBots().some((b) => count(b, "ender_eye") || count(b, "blaze_rod") || count(b, "blaze_powder"))) {
          setPhase("eyes", `${me} has no eyes; squad, bring rods and eyes to me`);
          return;
        }
        if (confirmedGone("lead-no-eyes", !count(bot, "ender_eye") && !squadCount("ender_eye") && !squadCount("blaze_rod") && !state.stronghold?.exact && !findFrames(bot).length)) {
          state.rodTarget = 8;
          save();
          setPhase("nether", "no eyes and no rods left in the squad; back to the Nether for rods");
          return;
        }
        return strongholdLeg(bot);
      }
      await craftEyes(bot);
      if (lead && count(bot, "ender_eye") && lead.entity && bot.entity.position.distanceTo(lead.entity.position) < 10) {
        await handTo(bot, lead, ["ender_eye"]);
        return;
      }
      if (noteFrames(bot)) return;
      await follow(bot, lead, 8);
      return;
    }
    case "fill": {
      if (!inOverworld(bot)) return;
      // Whoever holds the most eyes fills the frames (the leader, normally).
      const filler = squadBots()
        .filter((b) => b.entity && inOverworld(b))
        .sort((a, b) => count(b, "ender_eye") - count(a, "ender_eye"))[0];
      if (bot === filler) return fillPortal(bot);
      if (count(bot, "ender_eye") && filler) {
        await handTo(bot, filler, ["ender_eye"]);
        return;
      }
      await follow(bot, filler, 5);
      return;
    }
    case "end":
    case "dragon": {
      if (inEnd(bot)) {
        if (state.phase === "end") setPhase("dragon", `${me} is in the End. Shoot the crystals, hit the dragon when it lands!`);
        return fightDragon(bot, idx);
      }
      if (inNether(bot) && state.netherPortal) {
        await crossTo(bot, state.netherPortal, "overworld");
        return;
      }
      if (state.endPortal && flat(bot.entity.position, state.endPortal) > 40) {
        await march(bot, state.endPortal, 180_000, () => flat(bot.entity.position, state.endPortal!) < 24);
        return;
      }
      return jumpIn(bot);
    }
    case "done":
      await defend(bot, 6);
      await sleep(3000);
      return;
  }
}

/** Drive this bot through the speedrun while SPEEDRUN_DIRECTOR=true and the mode is "game". */
export function startSpeedrun(bot: Bot, brain: Pausable): void {
  if (process.env.SPEEDRUN_DIRECTOR !== "true") return;
  captureChat(bot);
  void import("../stream/race.js")
    .then(({ startRaceServers }) => startRaceServers(raceSnapshot))
    .catch((e) => console.warn(`[Race] ${(e as Error).message}`));
  bot.on("death", () => {
    doing(bot, "died, respawning");
    // Learn from it: every later route in this dimension prices this spot up.
    const p = bot.entity?.position;
    if (p) recordDeath(dimKey(bot.game?.dimension), p);
  });
  // The pathfinder swallows dig errors ("dig_error" resets): log the first few of each bot.
  {
    const origDig = bot.dig.bind(bot) as (...a: unknown[]) => Promise<void>;
    let logged = 0;
    (bot as unknown as { dig: (...a: unknown[]) => Promise<void> }).dig = (...a: unknown[]) =>
      origDig(...a).catch((err: Error) => {
        const b = a[0] as { name?: string; position?: Vec3 } | undefined;
        if (logged++ < 5) console.warn(`[DigError] ${bot.username}: ${b?.name} at ${b?.position}: ${err?.message ?? err}`);
        throw err;
      });
  }
  let driving = false;
  let busy = false;
  let gaze: (() => void) | null = null;
  let anchor: { p: Vec3; at: number } | null = null;
  let lastStatus = 0;
  bot.on("death", () => {
    if (driving) void talk(bot, "died", `I died (${state.phase}). Respawning and coming back!`, 30_000);
  });
  const timer = setInterval(() => {
    if (busy || !bot.entity || bot.health <= 0) return;
    if (currentMode() !== "game") {
      if (driving) {
        driving = false;
        gaze?.();
        gaze = null;
        brain.resume();
        console.log(`[Speedrun] ${bot.username}: mode is ${currentMode()}, handing back to the brain`);
      }
      return;
    }
    if (!driving) {
      driving = true;
      brain.pause();
      if (isSkillRunning(bot)) abortActiveSkill(bot);
      void import("../skills/enderman-gaze.js").then(({ installEndermanGazeGuard }) => {
        gaze = installEndermanGazeGuard(bot, "speedrun");
      });
      console.log(`[Speedrun] ${bot.username}: director driving (squad ${SQUAD}, phase ${state.phase}, leader ${leaderName()})`);
      if (!state.splits.portal) {
        state.splits.portal = state.startedAt;
        save();
      }
    }
    // Pinned in one spot for 90 s while the phase wants movement: dig out.
    const pos = bot.entity.position;
    if (!anchor || pos.distanceTo(anchor.p) > 3) anchor = { p: pos.clone(), at: Date.now() };
    const lb = leader();
    const nearLeader = !!lb?.entity && lb !== bot && dim(lb) === dim(bot) && pos.distanceTo(lb.entity.position) < 10;
    const waiting =
      state.phase === "done" ||
      state.phase === "eyes" ||
      nearLeader ||
      (state.phase === "blaze" && !!state.spawner && pos.distanceTo(v(state.spawner)) < 10);
    if (!waiting && Date.now() - anchor.at > 90_000) {
      anchor = { p: pos.clone(), at: Date.now() };
      busy = true;
      void unstick(bot).finally(() => (busy = false));
      return;
    }
    // The leader posts squad status every two minutes.
    if (isLeader(bot.username) && Date.now() - lastStatus > 120_000) {
      lastStatus = Date.now();
      const where = squadBots()
        .filter((b) => b.entity)
        .map((b) => `${b.username}:${inNether(b) ? "N" : inEnd(b) ? "E" : "O"}`)
        .join(" ");
      void talk(bot, "status", `[${SQUAD} ${elapsed()}] ${state.phase} | rods ${squadCount("blaze_rod")}/${state.rodTarget} eyes ${squadCount("ender_eye")} | ${where}`, 60_000);
    }
    busy = true;
    const phaseAtStart = state.phase;
    const t0 = Date.now();
    step(bot)
      .catch((err) => console.warn(`[Speedrun] ${bot.username} ${phaseAtStart} step failed: ${(err as Error).message}`))
      .finally(() => {
        busy = false;
        if (Date.now() - t0 > 30_000) {
          const p = bot.entity?.position;
          console.log(`[Speedrun] ${bot.username}: ${phaseAtStart} step took ${Math.round((Date.now() - t0) / 1000)} s, now at ${p ? p.floored() : "?"} (${dim(bot)})`);
        }
      });
  }, 1000);
  bot.once("end", () => {
    clearInterval(timer);
    gaze?.();
  });
}

/** Status line for chat and logs. */
export function speedrunStatus(): string {
  return `squad ${SQUAD}: ${state.phase} after ${elapsed()}, rods ${squadCount("blaze_rod")}/${state.rodTarget}, eyes ${squadCount("ender_eye")}`;
}
