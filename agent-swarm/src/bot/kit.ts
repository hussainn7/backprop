// src/bot/kit.ts
//
// Full combat loadout for the bots named in KIT_BOTS (comma list, or "all"):
// enchanted unbreakable netherite armor and shield equipped in their slots,
// a netherite sword, a bow with arrows, food, golden apples, totems, pearls
// and cobblestone. Every 20 s each squad process checks its own kitted bots
// over local RCON and re-applies the kit when the chestplate or the sword is
// missing (a fresh bot, or gear lost some other way).

import { createRequire } from "node:module";
import { rconSettings } from "./hunter.js";

const PROT = 'minecraft:enchantments={levels:{"minecraft:protection":4,"minecraft:unbreaking":3}},minecraft:unbreakable={}';
const KIT = (n: string): string[] => [
  `item replace entity ${n} armor.head with minecraft:netherite_helmet[${PROT}]`,
  `item replace entity ${n} armor.chest with minecraft:netherite_chestplate[${PROT}]`,
  `item replace entity ${n} armor.legs with minecraft:netherite_leggings[${PROT}]`,
  `item replace entity ${n} armor.feet with minecraft:netherite_boots[minecraft:enchantments={levels:{"minecraft:protection":4,"minecraft:feather_falling":4,"minecraft:depth_strider":3}},minecraft:unbreakable={}]`,
  `item replace entity ${n} weapon.offhand with minecraft:shield[minecraft:unbreakable={}]`,
  `give ${n} minecraft:netherite_sword[minecraft:enchantments={levels:{"minecraft:sharpness":5,"minecraft:fire_aspect":2,"minecraft:knockback":2,"minecraft:looting":3}},minecraft:unbreakable={}] 1`,
  `give ${n} minecraft:bow[minecraft:enchantments={levels:{"minecraft:power":5,"minecraft:punch":2,"minecraft:flame":1,"minecraft:infinity":1}},minecraft:unbreakable={}] 1`,
  `give ${n} minecraft:arrow 64`,
  `give ${n} minecraft:enchanted_golden_apple 8`,
  `give ${n} minecraft:golden_apple 32`,
  `give ${n} minecraft:cooked_beef 64`,
  `give ${n} minecraft:totem_of_undying 3`,
  `give ${n} minecraft:ender_pearl 16`,
  `give ${n} minecraft:cobblestone 64`,
];

let started = false;

export function kitBots(squadBots: string[]): string[] {
  const raw = (process.env.KIT_BOTS || "").trim();
  if (!raw) return [];
  if (raw.toLowerCase() === "all") return squadBots;
  const wanted = new Set(raw.split(",").map((s) => s.trim().toLowerCase()));
  return squadBots.filter((b) => wanted.has(b.toLowerCase()));
}

export function startKitKeeper(squadBots: string[]): void {
  const names = kitBots(squadBots);
  if (started || !names.length) return;
  started = true;
  const settings = rconSettings();
  if (!settings) {
    console.warn("[Kit] no RCON settings in server/server.properties: kits disabled");
    return;
  }
  const { Rcon } = createRequire(import.meta.url)("rcon-client");
  const pass = async () => {
    try {
      const rcon = await Rcon.connect({ host: "127.0.0.1", port: settings.port, password: settings.password, timeout: 6000 });
      for (const n of names) {
        const chest: string = await rcon.send(`data get entity ${n} Inventory[{Slot:102b}].id`);
        if (/No entity was found|No player was found/.test(chest)) continue; // offline
        const sword: string = await rcon.send(`clear ${n} minecraft:netherite_sword 0`);
        const hasChest = /netherite_chestplate/.test(chest);
        const hasSword = /Found [1-9]\d* matching/.test(sword);
        if (hasChest && hasSword) continue;
        for (const cmd of KIT(n)) await rcon.send(cmd);
        console.log(`[Kit] ${n}: full loadout applied (${hasChest ? "" : "no armor"}${!hasChest && !hasSword ? ", " : ""}${hasSword ? "" : "no sword"})`);
      }
      await rcon.end();
    } catch (err) {
      console.warn(`[Kit] pass failed: ${(err as Error).message}`);
    }
  };
  void pass();
  setInterval(() => void pass(), 20_000).unref();
}
