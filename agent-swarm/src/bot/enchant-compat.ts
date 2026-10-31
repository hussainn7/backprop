// src/bot/enchant-compat.ts
//
// 1.21 item components vs. prismarine: for an enchanted item received from the
// server, Item#enchants returns the raw component ({ enchantments: [{ id,
// level }] }) instead of [{ name, lvl }]. mineflayer's dig passes that to
// Block#digTime, which iterates it and throws "enchantments is not iterable".
// Every bot wears enchanted netherite, so every dig failed: the pathfinder
// reset on dig_error, re-planned the same one-step route and never moved,
// and any bot boxed in by stone stayed boxed in.
//
// Normalize whatever arrives into [{ name, lvl }] at the one place it is used.

import type { Bot } from "mineflayer";

type Ench = { name: string | null; lvl: number };

export function normalizeEnchants(raw: unknown, idToName: (id: number) => string | null): Ench[] {
  const fromList = (list: unknown[]): Ench[] =>
    list
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
      .map((x) =>
        typeof x.name === "string"
          ? { name: x.name.replace(/^minecraft:/, ""), lvl: Number(x.lvl ?? x.level ?? 1) }
          : { name: typeof x.id === "number" ? idToName(x.id) : null, lvl: Number(x.level ?? x.lvl ?? 1) },
      );
  if (Array.isArray(raw)) return fromList(raw);
  if (raw && typeof raw === "object") {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.enchantments)) return fromList(r.enchantments);
    const levels = (r.levels ?? r.enchantments) as Record<string, unknown> | undefined;
    if (levels && typeof levels === "object") {
      return Object.entries(levels).map(([k, v]) => ({ name: k.replace(/^minecraft:/, ""), lvl: Number(v) }));
    }
  }
  return [];
}

/** Patch this bot's Block#digTime (one class per registry, so once is enough). */
export function installEnchantFix(bot: Bot): void {
  const sample = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0)) ?? bot.blockAt(bot.entity.position.floored());
  if (!sample) return;
  const proto = Object.getPrototypeOf(sample) as {
    digTime: (...a: unknown[]) => number;
    __enchantFix?: boolean;
  };
  if (proto.__enchantFix) return;
  const orig = proto.digTime;
  const registry = bot.registry as unknown as { enchantments?: Record<number, { name: string }> };
  const idToName = (id: number) => registry.enchantments?.[id]?.name ?? null;
  proto.digTime = function (heldItemType, creative, inWater, notOnGround, enchantments, effects) {
    return orig.call(this, heldItemType, creative, inWater, notOnGround, normalizeEnchants(enchantments, idToName), effects);
  };
  proto.__enchantFix = true;
}
