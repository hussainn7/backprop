import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEnchants } from "./enchant-compat.js";

const names: Record<number, string> = { 9: "efficiency", 2: "protection" };
const idToName = (id: number) => names[id] ?? null;

test("1.21 component shape becomes [{name, lvl}]", () => {
  assert.deepEqual(normalizeEnchants({ enchantments: [{ id: 9, level: 5 }], showTooltip: true }, idToName), [{ name: "efficiency", lvl: 5 }]);
});

test("level maps and plain arrays are accepted; junk is empty, never a throw", () => {
  assert.deepEqual(normalizeEnchants({ levels: { "minecraft:efficiency": 4 } }, idToName), [{ name: "efficiency", lvl: 4 }]);
  assert.deepEqual(normalizeEnchants([{ name: "efficiency", lvl: 3 }], idToName), [{ name: "efficiency", lvl: 3 }]);
  assert.deepEqual(normalizeEnchants(undefined, idToName), []);
  assert.deepEqual(normalizeEnchants(42, idToName), []);
});

test("the real digTime accepts the normalized list", () => {
  const Block = require("prismarine-block")("1.21.4");
  const reg = require("prismarine-registry")("1.21.4");
  const stone = Block.fromStateId(reg.blocksByName.stone.defaultState, 0);
  const pick = reg.itemsByName.netherite_pickaxe.id;
  const ench = normalizeEnchants({ enchantments: [{ id: reg.enchantmentsByName.efficiency.id, level: 5 }] }, (id) => reg.enchantments[id]?.name ?? null);
  const fast = stone.digTime(pick, false, false, false, ench, {});
  const plain = stone.digTime(pick, false, false, false, [], {});
  assert.ok(fast < plain, `efficiency still speeds digging (${fast} < ${plain})`);
});
