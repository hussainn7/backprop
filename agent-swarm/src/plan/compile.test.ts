import { test } from "node:test";
import assert from "node:assert/strict";
import { compileMedium, nextStep } from "./compile.js";
import type { BotSnapshot } from "./hierarchy.js";
import { MEDIUM_SPECS } from "./hierarchy.js";

function snap(partial: Omit<Partial<BotSnapshot>, "inv"> & { inv?: Record<string, number> } = {}): BotSnapshot {
  const inv = new Map<string, number>();
  for (const [k, v] of Object.entries(partial.inv ?? {})) inv.set(k, v);
  return {
    inv,
    pickaxeTier: partial.pickaxeTier ?? -1,
    swordTier: partial.swordTier ?? -1,
    earnedAdvancements: partial.earnedAdvancements ?? new Set(),
    hasShelter: partial.hasShelter ?? false,
    hasFarm: partial.hasFarm ?? false,
    dimension: partial.dimension ?? "overworld",
  };
}

test("compile iron_tier from empty inventory produces full ladder", () => {
  const chain = compileMedium("iron_tier", snap());
  const ids = chain.map((s) => s.id);
  // The deterministic ladder every bot has to walk.
  assert.deepEqual(ids, [
    "logs_for_wooden_pickaxe",
    "crafting_table",
    "wooden_pickaxe",
    "cobblestone_for_stone_pickaxe",
    "stone_pickaxe",
    "cobblestone_for_furnace",
    "furnace",
    "mine_iron_ore",
    "smelt_iron",
    "iron_pickaxe",
  ]);
});

test("compile iron_tier skips wooden steps when wooden pickaxe exists", () => {
  const s = snap({ pickaxeTier: 0, inv: { crafting_table: 1 } });
  const ids = compileMedium("iron_tier", s).map((x) => x.id);
  assert.ok(!ids.includes("logs_for_wooden_pickaxe"));
  assert.ok(!ids.includes("crafting_table"));
  assert.ok(!ids.includes("wooden_pickaxe"));
  assert.ok(ids.includes("stone_pickaxe"));
});

test("compile iron_tier at stone tier starts from mining stone or crafting furnace", () => {
  const s = snap({ pickaxeTier: 1, inv: { cobblestone: 20, crafting_table: 1 } });
  const ids = compileMedium("iron_tier", s).map((x) => x.id);
  // With a stone pickaxe and plenty of cobble, the next real step is the
  // furnace and then iron, NOT re-mining stone.
  assert.ok(!ids.includes("cobblestone_for_stone_pickaxe"));
  assert.ok(!ids.includes("cobblestone_for_furnace"));
  assert.deepEqual(ids, ["furnace", "mine_iron_ore", "smelt_iron", "iron_pickaxe"]);
});

test("compile iron_tier at iron tier produces an empty short chain's trailing crafter", () => {
  // Already have an iron pickaxe — the medium is done, but compile still
  // returns the terminal step so nextStep collapses to null.
  const s = snap({ pickaxeTier: 2, inv: { crafting_table: 1 } });
  const step = nextStep("iron_tier", s);
  assert.equal(step, null);
});

test("compile diamond_tier chains iron tier first when below iron", () => {
  const s = snap({ pickaxeTier: 0 });
  const ids = compileMedium("diamond_tier", s).map((x) => x.id);
  assert.ok(ids.includes("stone_pickaxe"));
  assert.ok(ids.includes("iron_pickaxe"));
  assert.ok(ids.includes("mine_diamond"));
  assert.ok(ids.includes("diamond_pickaxe"));
});

test("compile nether_entry requires iron tier plus the portal skill", () => {
  const s = snap({ pickaxeTier: 2 });
  const ids = compileMedium("nether_entry", s).map((x) => x.id);
  // Iron ladder is skipped (pickaxe already tier 2) but the portal step
  // is always present until the advancement earns.
  assert.ok(ids.includes("nether_portal"));
});

test("compile nether_entry reports done once in the Nether", () => {
  const s = snap({ pickaxeTier: 2, dimension: "nether" });
  assert.equal(nextStep("nether_entry", s), null);
});

test("compile blaze_rods includes nether entry when not yet entered", () => {
  const s = snap({ pickaxeTier: 2 });
  const ids = compileMedium("blaze_rods", s).map((x) => x.id);
  assert.ok(ids.includes("nether_portal"));
  assert.ok(ids.includes("find_fortress"));
});

test("compile shelter is a short chain even with no wood", () => {
  const chain = compileMedium("shelter", snap());
  const ids = chain.map((x) => x.id);
  assert.ok(ids.includes("build_house"));
});

test("compile stronghold_found requires 12 eyes", () => {
  const s = snap({ inv: { ender_eye: 5 } });
  const first = nextStep("stronghold_found", s);
  assert.equal(first?.id, "craft_eyes");
});

test("MEDIUM_SPECS: iron_tier is done at pickaxeTier >= 2", () => {
  assert.equal(MEDIUM_SPECS.iron_tier.isDone(snap({ pickaxeTier: 1 })), false);
  assert.equal(MEDIUM_SPECS.iron_tier.isDone(snap({ pickaxeTier: 2 })), true);
  assert.equal(MEDIUM_SPECS.iron_tier.isDone(snap({ pickaxeTier: 4 })), true);
});

test("MEDIUM_SPECS: dragon_kill requires end/kill_dragon advancement", () => {
  const earned = new Set(["story/enter_the_end"]);
  assert.equal(MEDIUM_SPECS.dragon_kill.isDone(snap({ earnedAdvancements: earned })), false);
  earned.add("end/kill_dragon");
  assert.equal(MEDIUM_SPECS.dragon_kill.isDone(snap({ earnedAdvancements: earned })), true);
});
