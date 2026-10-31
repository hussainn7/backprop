// src/plan/registry.ts
//
// Per-bot PlanStore registry, mirroring memory-registry.ts. Lives in its
// own leaf module to avoid cycles if a skill ever needs to read the plan.

import type { Bot } from "mineflayer";
import type { PlanStore } from "./state.js";

const stores = new Map<Bot, PlanStore>();

export function registerBotPlan(bot: Bot, store: PlanStore): void {
  stores.set(bot, store);
}

export function getBotPlan(bot: Bot): PlanStore | undefined {
  return stores.get(bot);
}

export function getAllBotPlans(): PlanStore[] {
  return [...new Set(stores.values())];
}
