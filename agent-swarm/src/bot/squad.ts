// src/bot/squad.ts
//
// Squads of five, one Node process each (one thread cannot path-find for more).
// Every squad plays the same five roles under its own names; role behaviour
// throughout the code is keyed by archetype (the alpha name), so any squad's
// bot behaves exactly like its alpha counterpart. Add a squad by adding a row.
//
// The explorer of each squad (its Atlas) is its leader: the others stay within
// SQUAD_RADIUS of it and see its latest plan in their prompts.

import type { Bot } from "mineflayer";

export type Archetype = "Atlas" | "Flora" | "Forge" | "Mason" | "Blade";
export const ARCHETYPES: Archetype[] = ["Atlas", "Flora", "Forge", "Mason", "Blade"];

/** Squad → its names for the five roles, in ARCHETYPES order. */
export const SQUADS: Record<string, Record<Archetype, string>> = {
  alpha: { Atlas: "Atlas", Flora: "Flora", Forge: "Forge", Mason: "Mason", Blade: "Blade" },
  bravo: { Atlas: "Nova", Flora: "Ivy", Forge: "Anvil", Mason: "Brick", Blade: "Fang" },
  charlie: { Atlas: "Orion", Flora: "Sage", Forge: "Ember", Mason: "Stone", Blade: "Viper" },
  delta: { Atlas: "Rex", Flora: "Willow", Forge: "Cinder", Mason: "Granite", Blade: "Raven" },
};
export const SQUAD_NAMES = Object.keys(SQUADS);

const requested = (process.env.SQUAD || "alpha").toLowerCase();
export const SQUAD = SQUADS[requested] ? requested : "alpha";

/** Index of a squad (0 = alpha): offsets its ports and the like. */
export const squadIndex = (squad = SQUAD): number => Math.max(0, SQUAD_NAMES.indexOf(squad));

/** Every bot name in every squad, so none treats another as a human. */
export const ALL_BOT_NAMES: string[] = SQUAD_NAMES.flatMap((sq) => ARCHETYPES.map((a) => SQUADS[sq][a]));

/** This squad's name for an archetype ("Blade" → "Fang" in bravo). */
export function squadName(archetype: Archetype, squad = SQUAD): string {
  return (SQUADS[squad] ?? SQUADS.alpha)[archetype];
}

/** The role a bot plays, whichever squad it is in ("Fang" → "Blade"). Unknown names pass through. */
export function archetypeOf(username: string | undefined): string {
  if (!username) return "";
  for (const sq of SQUAD_NAMES) {
    const hit = ARCHETYPES.find((a) => SQUADS[sq][a] === username);
    if (hit) return hit;
  }
  return username;
}

export const leaderName = (): string => squadName("Atlas");
export const isLeader = (username: string): boolean => username === leaderName();

/** How far squad members may drift from their leader before regrouping. */
export const SQUAD_RADIUS = Number(process.env.SQUAD_RADIUS || 48);

// ── Shared squad state (all five bots live in this process) ────────────────
const liveBots = new Map<string, Bot>();
let order: { text: string; at: number } | null = null;

export function registerSquadBot(bot: Bot): void {
  liveBots.set(bot.username, bot);
  bot.once("end", () => {
    if (liveBots.get(bot.username) === bot) liveBots.delete(bot.username);
  });
}

/** This process's live squad bots. */
export function squadBots(): Bot[] {
  return [...liveBots.values()];
}

/** The leader's bot handle when it is online in this process. */
export function leaderBot(): Bot | undefined {
  return liveBots.get(leaderName());
}

/** The leader records its latest plan; squad members see it for 10 minutes. */
export function setLeaderOrder(text: string): void {
  order = { text: text.slice(0, 240), at: Date.now() };
}

export function leaderOrderLine(username: string): string {
  if (isLeader(username)) {
    return `SQUAD: you LEAD squad ${SQUAD} (${ARCHETYPES.map((a) => squadName(a)).join(", ")}). Your plan is shared with them; keep the squad moving toward the next milestone fast.`;
  }
  const plan = order && Date.now() - order.at < 600_000 ? ` Latest plan from ${leaderName()}: "${order.text}"` : "";
  return `SQUAD: your leader is ${leaderName()}. Stay within ${SQUAD_RADIUS} blocks of ${leaderName()} and support the plan.${plan}`;
}

// ── Secondary goal: hunt the owner while he plays survival ─────────────────
/** HUNT_PLAYER names the one human the bots may attack, and only in survival. */
export const huntPlayer = (): string => process.env.HUNT_PLAYER || "";

/** The hunt target's entity when he is a valid target: in survival and in view. */
export function huntTargetEntity(bot: Bot) {
  const name = huntPlayer();
  if (!name) return undefined;
  const p = bot.players[name];
  // gamemode 0 = survival (creative 1, adventure 2, spectator 3).
  if (!p || p.gamemode !== 0 || !p.entity) return undefined;
  return p.entity;
}
