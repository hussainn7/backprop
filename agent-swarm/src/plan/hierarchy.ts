// src/plan/hierarchy.ts
//
// Three-level goal hierarchy for the swarm. ADVISORY — the planner reports
// "what you're working on and the next concrete step" into the prompt; the
// LLM still invokes skills through the existing infrastructure. The planner
// never calls a skill itself. If the LLM ignores the plan, trajectory logs
// surface it and the audit layer can act.
//
// Why advisory and not a controller? Three reasons.
//
// 1. The brain already has reactive overrides (drown escape, hunger, flee,
//    hostiles) that MUST win over any plan. A controller would need its own
//    permission layer; a reporter inherits brain's.
// 2. Every existing skill handles its own preconditions. Duplicating that
//    inside the planner would drift from the skills.
// 3. The LLM can refuse a bad plan with context the planner lacks (teammate
//    position, chat intent). Keeping it strategic preserves that.

import type { Bot } from "mineflayer";

/** The one long-term goal the swarm pursues. */
export type LongGoal = "defeat_dragon";

/** Medium goals in rough progression order. The planner picks the first
 *  unmet goal; the LLM can override via chat if it has reason to. */
export const MEDIUM_GOALS = [
  "shelter",
  "renewable_food",
  "iron_tier",
  "diamond_tier",
  "nether_entry",
  "blaze_rods",
  "ender_pearls",
  "stronghold_found",
  "end_kit",
  "dragon_kill",
] as const;
export type MediumGoal = (typeof MEDIUM_GOALS)[number];

/** Compact view of bot state the planner reads. Pulled from the live bot
 *  by `snapshotBot`; the compiler is pure over this type so tests can run
 *  without a mineflayer instance. */
export interface BotSnapshot {
  /** Item name → total count across the inventory. */
  inv: Map<string, number>;
  /** Does the bot have any pickaxe at this tier or better? 0..4. */
  pickaxeTier: number;
  /** Does the bot have any sword at this tier or better? 0..4. */
  swordTier: number;
  /** Advancements the bot (or any teammate) has recorded earned. */
  earnedAdvancements: Set<string>;
  /** Known structures: used to answer "do we have a shelter / farm already". */
  hasShelter: boolean;
  hasFarm: boolean;
  /** Current dimension — "overworld" | "nether" | "end". */
  dimension: "overworld" | "nether" | "end";
}

/** One concrete step. The planner emits these as advice; it does NOT run
 *  them. `doneWhen` is the inventory condition that marks completion. */
export interface ShortGoal {
  /** Human-readable advice line injected into the prompt. */
  advice: string;
  /** Which action verb or skill the LLM should invoke. One of actions.ts's
   *  verbs (e.g. "mine_block", "craft") or "invoke_skill". */
  verb: string;
  /** Argument hint for the LLM. Keeps the plan line short. */
  argsHint?: string;
  /** When this predicate is true for the live bot, the short goal is done
   *  and the plan advances. Pure over the snapshot for testability. */
  doneWhen: (snap: BotSnapshot) => boolean;
  /** Stable identifier for logging and attempt tracking. */
  id: string;
}

/** Static metadata for each medium goal. `isDone` must be pure over the
 *  snapshot; `summary` is a short label for the plan line. */
export interface MediumSpec {
  readonly id: MediumGoal;
  readonly summary: string;
  readonly isDone: (snap: BotSnapshot) => boolean;
}

const anyWith = (snap: BotSnapshot, suffix: string): boolean => {
  for (const name of snap.inv.keys()) if (name.endsWith(suffix)) return true;
  return false;
};

const have = (snap: BotSnapshot, name: string, qty = 1): boolean => (snap.inv.get(name) ?? 0) >= qty;

export const MEDIUM_SPECS: Record<MediumGoal, MediumSpec> = {
  shelter: {
    id: "shelter",
    summary: "secure a shelter",
    isDone: (s) => s.hasShelter,
  },
  renewable_food: {
    id: "renewable_food",
    summary: "secure renewable food",
    // A farm OR a working stockpile of carrots/potatoes/wheat/beets implying
    // seeds and tillage already happened. Lets Flora signal "farm built"
    // without a round trip through the structure memory for every tick.
    isDone: (s) =>
      s.hasFarm ||
      have(s, "wheat", 32) ||
      have(s, "carrot", 32) ||
      have(s, "potato", 32) ||
      have(s, "beetroot", 32),
  },
  iron_tier: {
    id: "iron_tier",
    summary: "obtain iron pickaxe",
    isDone: (s) => s.pickaxeTier >= 2,
  },
  diamond_tier: {
    id: "diamond_tier",
    summary: "obtain diamond pickaxe",
    isDone: (s) => s.pickaxeTier >= 3,
  },
  nether_entry: {
    id: "nether_entry",
    summary: "cross a Nether portal",
    isDone: (s) => s.earnedAdvancements.has("story/enter_the_nether") || s.dimension === "nether",
  },
  blaze_rods: {
    id: "blaze_rods",
    summary: "collect 7 blaze rods",
    isDone: (s) => have(s, "blaze_rod", 7),
  },
  ender_pearls: {
    id: "ender_pearls",
    summary: "collect 16 ender pearls",
    isDone: (s) => have(s, "ender_pearl", 16),
  },
  stronghold_found: {
    id: "stronghold_found",
    summary: "locate the stronghold",
    isDone: (s) => s.earnedAdvancements.has("story/follow_ender_eye"),
  },
  end_kit: {
    id: "end_kit",
    summary: "prepare End kit (diamond armor, 12 eyes, iron pick+)",
    isDone: (s) =>
      s.pickaxeTier >= 2 && have(s, "ender_eye", 12) && anyWith(s, "diamond_chestplate") && anyWith(s, "diamond_helmet"),
  },
  dragon_kill: {
    id: "dragon_kill",
    summary: "slay the Ender Dragon",
    isDone: (s) => s.earnedAdvancements.has("end/kill_dragon"),
  },
};

/** The ordered chain the LongGoal expands to. */
export const DRAGON_CHAIN: MediumGoal[] = [...MEDIUM_GOALS];

/** Build a snapshot from the live bot. Reads only — never mutates. */
export function snapshotBot(
  bot: Bot,
  opts: { hasShelter?: boolean; hasFarm?: boolean; earnedAdvancements?: Set<string> } = {},
): BotSnapshot {
  const inv = new Map<string, number>();
  try {
    for (const item of bot.inventory.items()) {
      inv.set(item.name, (inv.get(item.name) ?? 0) + item.count);
    }
  } catch {
    // bot not spawned yet; empty inventory is a safe default
  }

  const pickTier = (): number => {
    const order: Array<[string, number]> = [
      ["netherite_pickaxe", 4],
      ["diamond_pickaxe", 3],
      ["iron_pickaxe", 2],
      ["stone_pickaxe", 1],
      ["wooden_pickaxe", 0],
      ["golden_pickaxe", 0],
    ];
    for (const [name, tier] of order) if ((inv.get(name) ?? 0) > 0) return tier;
    return -1;
  };
  const swordTier = (): number => {
    const order: Array<[string, number]> = [
      ["netherite_sword", 4],
      ["diamond_sword", 3],
      ["iron_sword", 2],
      ["stone_sword", 1],
      ["wooden_sword", 0],
      ["golden_sword", 0],
    ];
    for (const [name, tier] of order) if ((inv.get(name) ?? 0) > 0) return tier;
    return -1;
  };

  const dim = String(bot.game?.dimension ?? "overworld");
  return {
    inv,
    pickaxeTier: pickTier(),
    swordTier: swordTier(),
    earnedAdvancements: opts.earnedAdvancements ?? new Set(),
    hasShelter: opts.hasShelter ?? false,
    hasFarm: opts.hasFarm ?? false,
    dimension: dim.includes("nether") ? "nether" : dim.includes("end") ? "end" : "overworld",
  };
}
