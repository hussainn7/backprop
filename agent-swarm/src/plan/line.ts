// src/plan/line.ts
//
// One-line "where are you / what next" prompt injection. Called from
// buildContext in brain.ts next to the TECH TREE line. If the planner has
// nothing active, returns "" and the existing curriculum line takes over.

import type { Bot } from "mineflayer";
import { MEDIUM_SPECS, snapshotBot, type BotSnapshot } from "./hierarchy.js";
import { nextStep } from "./compile.js";
import { getBotPlan } from "./registry.js";

export interface PlanLineOpts {
  earnedAdvancements?: Set<string>;
  hasShelter?: boolean;
  hasFarm?: boolean;
}

/** Tick the planner for `bot`: refresh the active medium against the
 *  snapshot, record milestones if any medium flipped done, and return the
 *  prompt line. */
export function getPlanLine(bot: Bot, opts: PlanLineOpts = {}): string {
  const store = getBotPlan(bot);
  if (!store) return "";
  const snap = snapshotBot(bot, opts);

  // Did whatever medium we were on just complete? If so record it and
  // clear active; the next pickMedium call will choose the next one.
  const wasActive = store.snapshot().activeMedium;
  if (store.tryCompleteActive(snap)) {
    console.log(`[Plan] ${bot.username ?? "?"} completed medium "${wasActive}"`);
  }

  // Choose or re-choose the active medium. The chain order means the first
  // unmet medium is always the right next target; a medium can be blocked
  // temporarily if a short step repeatedly fails (see brain.ts wiring).
  const active = store.pickMedium(snap);
  store.setActiveMedium(active);
  if (!active) return "PLAN: dragon chain complete — no outstanding medium goal";

  const step = nextStep(active, snap);
  store.observeShort(step?.id ?? null);

  return formatLine(active, step, snap);
}

function formatLine(active: string, step: ReturnType<typeof nextStep>, snap: BotSnapshot): string {
  const spec = MEDIUM_SPECS[active as keyof typeof MEDIUM_SPECS];
  const header = `PLAN: defeat_dragon → ${spec.summary}`;
  if (!step) return `${header} — compiled, awaiting completion`;
  const argNote = step.argsHint ? ` ${step.argsHint}` : "";
  return `${header}\nNEXT STEP: ${step.advice} — ${step.verb}${argNote}`;
  void snap;
}
