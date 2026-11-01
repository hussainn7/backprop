// src/bot/kit.ts
//
// Full combat loadout for the bots named in KIT_BOTS (comma list, or "all"):
// enchanted unbreakable netherite armor and shield equipped in their slots,
// a netherite sword, a bow with arrows, food, golden apples, totems, pearls
// and cobblestone. Every 20 s each squad process checks its own kitted bots
// over local RCON and re-applies the kit when the chestplate or the sword is
// missing (a fresh bot, or gear lost some other way). Every bot of the squad,
// kitted or not, also gets a bow and arrows if it has no bow (BOWS_FOR_ALL,
// default on): the learned "shoot" tactic needs one.
//
// SPEEDRUN_KIT=true adds the tools and materials that skip the early game for
// the same bots: netherite pickaxe/axe/shovel, water bucket, flint and steel,
// 14 obsidian (a portal), crafting table, furnace, beds, torches, logs, iron
// and gold (piglin bartering). Blaze rods and eyes of ender are NOT given:
// those are the race. Re-applied when the netherite pickaxe is missing.

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

const TOOL = 'minecraft:unbreakable={}';
const SPEEDRUN = (n: string): string[] => [
  `give ${n} minecraft:netherite_pickaxe[minecraft:enchantments={levels:{"minecraft:efficiency":5,"minecraft:fortune":3}},${TOOL}] 1`,
  `give ${n} minecraft:netherite_axe[minecraft:enchantments={levels:{"minecraft:efficiency":5}},${TOOL}] 1`,
  `give ${n} minecraft:netherite_shovel[minecraft:enchantments={levels:{"minecraft:efficiency":5}},${TOOL}] 1`,
  `give ${n} minecraft:water_bucket 1`,
  `give ${n} minecraft:flint_and_steel[${TOOL}] 1`,
  `give ${n} minecraft:obsidian 14`,
  `give ${n} minecraft:crafting_table 1`,
  `give ${n} minecraft:furnace 1`,
  `give ${n} minecraft:white_bed 2`,
  `give ${n} minecraft:torch 64`,
  `give ${n} minecraft:oak_log 64`,
  `give ${n} minecraft:iron_ingot 16`,
  `give ${n} minecraft:gold_ingot 32`,
];

const BOW = (n: string): string[] => [
  `give ${n} minecraft:bow[minecraft:enchantments={levels:{"minecraft:power":5,"minecraft:punch":2,"minecraft:flame":1,"minecraft:infinity":1}},minecraft:unbreakable={}] 1`,
  `give ${n} minecraft:arrow 64`,
];

export function startKitKeeper(squadBots: string[]): void {
  const names = kitBots(squadBots);
  const bows = process.env.BOWS_FOR_ALL !== "false" ? squadBots : [];
  if (started || (!names.length && !bows.length)) return;
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
        if (!hasChest || !hasSword) {
          for (const cmd of KIT(n)) await rcon.send(cmd);
          console.log(`[Kit] ${n}: full loadout applied (${hasChest ? "" : "no armor"}${!hasChest && !hasSword ? ", " : ""}${hasSword ? "" : "no sword"})`);
        }
        if (process.env.SPEEDRUN_KIT === "true") {
          // Fire resistance (5 min per enchanted golden apple) is the lava insurance: never run out.
          const ap: string = await rcon.send(`clear ${n} minecraft:enchanted_golden_apple 0`);
          if (!/No player was found|No entity was found/.test(ap)) {
            const have = Number(ap.match(/Found (\d+)/)?.[1] ?? 0);
            if (have < 3) {
              await rcon.send(`give ${n} minecraft:enchanted_golden_apple ${8 - have}`);
              console.log(`[Kit] ${n}: enchanted golden apples ${have} -> 8`);
            }
          }
          // Respawn beds (portal, stronghold, End portal): keep 3 on hand.
          const bd: string = await rcon.send(`clear ${n} minecraft:white_bed 0`);
          if (!/No player was found|No entity was found/.test(bd)) {
            const haveBeds = Number(bd.match(/Found (\d+)/)?.[1] ?? 0);
            if (haveBeds < 2) {
              await rcon.send(`give ${n} minecraft:white_bed ${3 - haveBeds}`);
              console.log(`[Kit] ${n}: white_bed ${haveBeds} -> 3`);
            }
          }
          // A boat per bot: ~8 blocks/s on water against ~3 swimming.
          const bt: string = await rcon.send(`clear ${n} minecraft:oak_boat 0`);
          if (!/No player was found|No entity was found/.test(bt) && !/Found [1-9]\d* matching/.test(bt)) {
            await rcon.send(`give ${n} minecraft:oak_boat 1`);
            console.log(`[Kit] ${n}: oak_boat`);
          }
          const pick: string = await rcon.send(`clear ${n} minecraft:netherite_pickaxe 0`);
          if (!/Found [1-9]\d* matching/.test(pick)) {
            for (const cmd of SPEEDRUN(n)) await rcon.send(cmd);
            console.log(`[Kit] ${n}: speedrun tools and materials`);
          }
        }
      }
      for (const n of bows) {
        const bow: string = await rcon.send(`clear ${n} minecraft:bow 0`);
        if (/No player was found|No entity was found/.test(bow) || /Found [1-9]\d* matching/.test(bow)) continue;
        for (const cmd of BOW(n)) await rcon.send(cmd);
        console.log(`[Kit] ${n}: bow and arrows`);
      }
      await rcon.end();
    } catch (err) {
      console.warn(`[Kit] pass failed: ${(err as Error).message}`);
    }
  };
  void pass();
  setInterval(() => void pass(), 20_000).unref();
}
