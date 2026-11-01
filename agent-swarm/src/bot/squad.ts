// src/bot/squad.ts
//
// Two squads of five, one Node process each (one thread cannot path-find for
// ten bots). SQUAD=alpha runs Atlas, Flora, Forge, Mason, Blade; SQUAD=bravo
// runs the same five roles as Nova, Ivy, Anvil, Brick, Fang. Role behaviour
// throughout the code is keyed by archetype (the alpha name), so a bravo bot
// behaves exactly like its alpha counterpart.
//
// The explorer of each squad (Atlas / Nova) is its leader: the others stay
// within SQUAD_RADIUS of it and see its latest plan in their prompts.

import type { Bot } from "mineflayer";

export type Archetype = "Atlas" | "Flora" | "Forge" | "Mason" | "Blade";
export const ARCHETYPES: Archetype[] = ["Atlas", "Flora", "Forge", "Mason", "Blade"];

const BRAVO: Record<Archetype, string> = { Atlas: "Nova", Flora: "Ivy", Forge: "Anvil", Mason: "Brick", Blade: "Fang" };

export const SQUAD = (process.env.SQUAD || "alpha").toLowerCase() === "bravo" ? "bravo" : "alpha";

/** Every bot name in both squads, so neither treats the other as a human. */
export const ALL_BOT_NAMES: string[] = [...ARCHETYPES, ...ARCHETYPES.map((a) => BRAVO[a])];

/** This squad's name for an archetype ("Blade" → "Fang" in bravo). */
export function squadName(archetype: Archetype, squad = SQUAD): string {
  return squad === "bravo" ? BRAVO[archetype] : archetype;
}

/** The role a bot plays, whichever squad it is in ("Fang" → "Blade"). Unknown names pass through. */
export function archetypeOf(username: string | undefined): string {
  if (!username) return "";
  const hit = ARCHETYPES.find((a) => BRAVO[a] === username);
  return hit ?? username;
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
