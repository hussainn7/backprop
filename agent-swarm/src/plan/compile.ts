// src/plan/compile.ts
//
// Deterministic MediumGoal → ShortGoal[] compiler. Backward chains from the
// target using Minecraft's recipe/tool-tier reality, skipping any step the
// current inventory already satisfies.
//
// Why hand-authored chains per medium rather than a generic graph walk over
// minecraft-data recipes? Two reasons.
//
// 1. The recipes are not the plan. A plan for iron_pickaxe is NOT "craft
//    iron_pickaxe"; it's "gather logs, make planks, make sticks, make a
//    crafting table, make a wooden pickaxe, mine stone, upgrade to stone
//    pickaxe, mine iron, make a furnace, smelt, THEN craft iron_pickaxe."
//    A generic walker produces the leaf but not the ladder; the ladder is
//    the thing the bot was missing.
// 2. The medium goals are ~10 items. A per-goal expansion fits in one file
//    and is easy to audit when a plan goes wrong. A full dependency graph
//    would be strictly more code for strictly more surface area.
//
// Chains are advisory: each step reports the natural verb the LLM already
// knows (invoke_skill wood_run, craft, mine_block, …). The planner never
// executes them.

import { MEDIUM_SPECS, type BotSnapshot, type MediumGoal, type ShortGoal } from "./hierarchy.js";

const have = (s: BotSnapshot, name: string, qty = 1): boolean => (s.inv.get(name) ?? 0) >= qty;
const haveAnyPlanks = (s: BotSnapshot): number => {
  let n = 0;
  for (const [k, v] of s.inv) if (k.endsWith("_planks")) n += v;
  return n;
};
const haveAnyLog = (s: BotSnapshot): number => {
  let n = 0;
  for (const [k, v] of s.inv) if (k.endsWith("_log")) n += v;
  return n;
};

/** Build a short goal that is already satisfied — used to pre-filter chain
 *  entries. Returning null means "include this step". */
const skip = (): null => null;

// ── Shared sub-chains ──────────────────────────────────────────────────────

/** Produce the chain to reach a wooden pickaxe (idempotent — returns an
 *  empty prefix if the bot already has one). */
function toWoodenPickaxe(s: BotSnapshot): ShortGoal[] {
  if (s.pickaxeTier >= 0) return [];
  const chain: ShortGoal[] = [];
  // Need at least 1 log → 4 planks → 2 sticks → 3 planks for the pick head.
  // The wood_run skill harvests a full tree, which comfortably covers both.
  if (haveAnyLog(s) + Math.floor(haveAnyPlanks(s) / 4) < 2) {
    chain.push({
      id: "logs_for_wooden_pickaxe",
      advice: "gather at least 2 logs — wood_run harvests a full tree",
      verb: "invoke_skill",
      argsHint: '{"skillName":"wood_run"}',
      doneWhen: (snap) => haveAnyLog(snap) + Math.floor(haveAnyPlanks(snap) / 4) >= 2,
    });
  }
  if (!have(s, "crafting_table")) {
    chain.push({
      id: "crafting_table",
      advice: "craft a crafting_table (4 planks)",
      verb: "craft",
      argsHint: '{"item":"crafting_table"}',
      doneWhen: (snap) => have(snap, "crafting_table"),
    });
  }
  chain.push({
    id: "wooden_pickaxe",
    advice: "craft a wooden_pickaxe (3 planks + 2 sticks, at a crafting_table)",
    verb: "craft",
    argsHint: '{"item":"wooden_pickaxe"}',
    doneWhen: (snap) => snap.pickaxeTier >= 0,
  });
  return chain;
}

/** Produce the chain to reach a stone pickaxe. Assumes wooden chain runs first. */
function toStonePickaxe(s: BotSnapshot): ShortGoal[] {
  if (s.pickaxeTier >= 1) return [];
  const chain: ShortGoal[] = [];
  if (!have(s, "cobblestone", 3)) {
    chain.push({
      id: "cobblestone_for_stone_pickaxe",
      advice: "mine 3+ stone for cobblestone (needs a wooden pickaxe)",
      verb: "mine_block",
      argsHint: '{"blockType":"stone"}',
      doneWhen: (snap) => have(snap, "cobblestone", 3),
    });
  }
  chain.push({
    id: "stone_pickaxe",
    advice: "craft a stone_pickaxe (3 cobblestone + 2 sticks)",
    verb: "craft",
    argsHint: '{"item":"stone_pickaxe"}',
    doneWhen: (snap) => snap.pickaxeTier >= 1,
  });
  return chain;
}

/** Furnace step — a crafting_table and 8 cobble get you one. */
function toFurnace(s: BotSnapshot): ShortGoal[] {
  if (have(s, "furnace")) return [];
  const chain: ShortGoal[] = [];
  if (!have(s, "cobblestone", 8)) {
    chain.push({
      id: "cobblestone_for_furnace",
      advice: "mine 8+ stone for a furnace",
      verb: "mine_block",
      argsHint: '{"blockType":"stone"}',
      doneWhen: (snap) => have(snap, "cobblestone", 8),
    });
  }
  chain.push({
    id: "furnace",
    advice: "craft a furnace (8 cobblestone)",
    verb: "craft",
    argsHint: '{"item":"furnace"}',
    doneWhen: (snap) => have(snap, "furnace"),
  });
  return chain;
}

// ── Per-medium expansions ──────────────────────────────────────────────────

function expandIronTier(s: BotSnapshot): ShortGoal[] {
  const chain = [...toWoodenPickaxe(s), ...toStonePickaxe(s), ...toFurnace(s)];
  if (!have(s, "iron_ingot", 3)) {
    if (!have(s, "iron_ore", 3) && !have(s, "raw_iron", 3)) {
      chain.push({
        id: "mine_iron_ore",
        advice: "mine 3+ iron_ore (needs a stone pickaxe) — strip_mine around y=16 or around y=-10 in deepslate",
        verb: "mine_block",
        argsHint: '{"blockType":"iron_ore"}',
        doneWhen: (snap) => have(snap, "iron_ore", 3) || have(snap, "raw_iron", 3) || have(snap, "iron_ingot", 3),
      });
    }
    chain.push({
      id: "smelt_iron",
      advice: "smelt the iron (invoke_skill smelt_ores — needs furnace + fuel)",
      verb: "invoke_skill",
      argsHint: '{"skillName":"smelt_ores"}',
      doneWhen: (snap) => have(snap, "iron_ingot", 3),
    });
  }
  chain.push({
    id: "iron_pickaxe",
    advice: "craft an iron_pickaxe (3 iron_ingot + 2 sticks)",
    verb: "craft",
    argsHint: '{"item":"iron_pickaxe"}',
    doneWhen: (snap) => snap.pickaxeTier >= 2,
  });
  return chain;
}

function expandDiamondTier(s: BotSnapshot): ShortGoal[] {
  if (s.pickaxeTier < 2) return [...expandIronTier(s), ...expandDiamondTier({ ...s, pickaxeTier: 2 })];
  const chain: ShortGoal[] = [];
  if (!have(s, "diamond", 3)) {
    chain.push({
      id: "mine_diamond",
      advice: "strip_mine deep (y=-58 is prime, iron pickaxe required) for 3+ diamond",
      verb: "invoke_skill",
      argsHint: '{"skillName":"strip_mine"}',
      doneWhen: (snap) => have(snap, "diamond", 3),
    });
  }
  chain.push({
    id: "diamond_pickaxe",
    advice: "craft a diamond_pickaxe (3 diamond + 2 sticks)",
    verb: "craft",
    argsHint: '{"item":"diamond_pickaxe"}',
    doneWhen: (snap) => snap.pickaxeTier >= 3,
  });
  return chain;
}

function expandShelter(s: BotSnapshot): ShortGoal[] {
  if (s.hasShelter) return [];
  const chain = [...toWoodenPickaxe(s)];
  chain.push({
    id: "build_house",
    advice: "invoke_skill build_house to raise a shelter near base",
    verb: "invoke_skill",
    argsHint: '{"skillName":"build_house"}',
    doneWhen: (snap) => snap.hasShelter,
  });
  return chain;
}

function expandFood(s: BotSnapshot): ShortGoal[] {
  if (s.hasFarm) return [];
  const chain = [...toWoodenPickaxe(s)];
  if (!have(s, "wooden_hoe") && !have(s, "stone_hoe") && !have(s, "iron_hoe")) {
    chain.push({
      id: "hoe",
      advice: "craft a wooden_hoe (2 planks + 2 sticks)",
      verb: "craft",
      argsHint: '{"item":"wooden_hoe"}',
      doneWhen: (snap) => have(snap, "wooden_hoe") || have(snap, "stone_hoe") || have(snap, "iron_hoe"),
    });
  }
  chain.push({
    id: "build_farm",
    advice: "invoke_skill build_farm to plant a renewable food plot",
    verb: "invoke_skill",
    argsHint: '{"skillName":"build_farm"}',
    doneWhen: (snap) => snap.hasFarm,
  });
  return chain;
}

function expandNetherEntry(s: BotSnapshot): ShortGoal[] {
  // The portal skill needs flint_and_steel and either a bucket+lava or
  // obsidian; it has its own preconditions, so advise the skill and trust it.
  const chain = [...expandIronTier(s)];
  chain.push({
    id: "nether_portal",
    advice: "invoke_skill build_nether_portal — handles flint_and_steel, lava/obsidian, and ignition",
    verb: "invoke_skill",
    argsHint: '{"skillName":"build_nether_portal"}',
    doneWhen: (snap) => snap.earnedAdvancements.has("story/enter_the_nether") || snap.dimension === "nether",
  });
  return chain;
}

function expandBlazeRods(s: BotSnapshot): ShortGoal[] {
  const chain: ShortGoal[] = [];
  if (s.dimension !== "nether" && !s.earnedAdvancements.has("story/enter_the_nether")) {
    chain.push(...expandNetherEntry(s));
  }
  chain.push({
    id: "find_fortress",
    advice: "invoke_skill find_fortress — Nether fortress housing blazes",
    verb: "invoke_skill",
    argsHint: '{"skillName":"find_fortress"}',
    doneWhen: (snap) => have(snap, "blaze_rod", 7),
  });
  return chain;
}

function expandEnderPearls(_s: BotSnapshot): ShortGoal[] {
  // Pearls come from endermen (overworld warped forests/plains at night, or
  // Nether warped forest). The swarm has no "hunt endermen" skill yet, so
  // this is a chat-level directive rather than a mechanical step.
  return [
    {
      id: "hunt_endermen",
      advice: "hunt endermen for 16+ ender_pearl — safest in a Nether warped forest, or at night at home",
      verb: "attack",
      argsHint: '{"entityName":"enderman"}',
      doneWhen: (snap) => have(snap, "ender_pearl", 16),
    },
  ];
}

function expandStronghold(_s: BotSnapshot): ShortGoal[] {
  return [
    {
      id: "craft_eyes",
      advice: "craft 12+ ender_eye (blaze_powder from blaze_rod + ender_pearl)",
      verb: "craft",
      argsHint: '{"item":"ender_eye","count":12}',
      doneWhen: (snap) => have(snap, "ender_eye", 12),
    },
    {
      id: "follow_eye",
      advice: "throw ender eyes to locate and dig into the stronghold portal room",
      verb: "use_item",
      argsHint: '{"item":"ender_eye"}',
      doneWhen: (snap) => snap.earnedAdvancements.has("story/follow_ender_eye"),
    },
  ];
}

function expandEndKit(s: BotSnapshot): ShortGoal[] {
  const chain: ShortGoal[] = [];
  if (s.pickaxeTier < 2) chain.push(...expandIronTier(s));
  if ((s.inv.get("ender_eye") ?? 0) < 12) {
    chain.push({
      id: "end_kit_eyes",
      advice: "craft 12+ ender_eye for the portal (keep 2 spare)",
      verb: "craft",
      argsHint: '{"item":"ender_eye","count":12}',
      doneWhen: (snap) => have(snap, "ender_eye", 12),
    });
  }
  chain.push({
    id: "end_kit_craft_gear",
    advice: "invoke_skill craft_gear to upgrade armor and tools to the best available tier",
    verb: "invoke_skill",
    argsHint: '{"skillName":"craft_gear"}',
    doneWhen: (snap) => {
      // "Any helmet + any chestplate at diamond" is the proxy for a fit kit.
      // The spec can tighten later; for now this is what gates end_kit done.
      let anyDiaHelm = false;
      let anyDiaChest = false;
      for (const name of snap.inv.keys()) {
        if (name === "diamond_helmet") anyDiaHelm = true;
        if (name === "diamond_chestplate") anyDiaChest = true;
      }
      return anyDiaHelm && anyDiaChest;
    },
  });
  return chain;
}

function expandDragonKill(_s: BotSnapshot): ShortGoal[] {
  // Advisory only — no "slay dragon" skill. The LLM commands the fight.
  return [
    {
      id: "enter_end",
      advice: "activate the End portal (place all 12 eyes in the frame) and jump in",
      verb: "use_item",
      argsHint: '{"item":"ender_eye"}',
      doneWhen: (snap) => snap.dimension === "end",
    },
    {
      id: "slay_dragon",
      advice: "shatter the end_crystals from the pillars, then dps the dragon when it perches",
      verb: "attack",
      argsHint: '{"entityName":"ender_dragon"}',
      doneWhen: (snap) => snap.earnedAdvancements.has("end/kill_dragon"),
    },
  ];
}

/** Compile a medium goal into an ordered list of short goals. The first
 *  element whose `doneWhen` is false is "the next step". Pure over the
 *  snapshot. */
export function compileMedium(goal: MediumGoal, snap: BotSnapshot): ShortGoal[] {
  switch (goal) {
    case "shelter":
      return expandShelter(snap);
    case "renewable_food":
      return expandFood(snap);
    case "iron_tier":
      return expandIronTier(snap);
    case "diamond_tier":
      return expandDiamondTier(snap);
    case "nether_entry":
      return expandNetherEntry(snap);
    case "blaze_rods":
      return expandBlazeRods(snap);
    case "ender_pearls":
      return expandEnderPearls(snap);
    case "stronghold_found":
      return expandStronghold(snap);
    case "end_kit":
      return expandEndKit(snap);
    case "dragon_kill":
      return expandDragonKill(snap);
  }
}

/** Return the first short goal in the chain whose `doneWhen` is false,
 *  or null if the medium is already satisfied or every step is complete.
 *
 *  The isDone short-circuit matters: a bot with an iron pickaxe but no
 *  furnace is still iron-tier done — the furnace is a means to iron, not
 *  a goal of its own, and the compile chain still contains the furnace
 *  step as part of the historical ladder. */
export function nextStep(goal: MediumGoal, snap: BotSnapshot): ShortGoal | null {
  if (MEDIUM_SPECS[goal].isDone(snap)) return null;
  for (const step of compileMedium(goal, snap)) {
    if (!step.doneWhen(snap)) return step;
  }
  return null;
}

// Reference held so TypeScript doesn't warn about the unused helper in a
// future refactor that drops its last caller inside a chain.
void skip;
