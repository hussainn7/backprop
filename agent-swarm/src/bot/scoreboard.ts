/**
 * Session scoreboard — the measurement layer for "are the bots getting
 * better over time?"
 *
 * Tracks per-session, per-bot performance plus team tech-tree milestones
 * (first log, first tool, first iron...) with timestamps relative to
 * session start. Written to logs/sessions/<sessionId>.json every minute so
 * sessions can be compared across code changes: if a change makes
 * time-to-first-tool worse, revert it.
 */

import fs from "fs";
import path from "path";
import type { Bot } from "mineflayer";
import { getLedger } from "../llm/budget.js";

interface BotStats {
  actions: number;
  successes: number;
  failures: number;
  deaths: number;
  deposits: number;
  itemsDeposited: number;
  skillSuccesses: number;
  skillFailures: number;
}

export interface Milestone {
  name: string;
  bot: string;
  /** Seconds since session start */
  atSec: number;
  /** Session-lifetime cost in USD at the moment this milestone was observed.
   *  Snapshot once, never updated — the point is "what did it cost to reach
   *  this?" and later spending on other milestones must not inflate it. */
  costUsdAt?: number;
  /** Which hierarchy this milestone belongs to. "inventory" entries come
   *  from first-time inventory scans (first_log, first_iron_tool…);
   *  "plan" entries come from the hierarchical planner (iron_tier,
   *  nether_entry, dragon_kill…). The report shows them side by side. */
  source?: "inventory" | "plan" | "event";
}

export interface SessionStats {
  sessionId: string;
  sessionStart: string;
  /** Updated on each save */
  durationSec: number;
  perBot: Record<string, BotStats>;
  milestones: Milestone[];
  /** Minutes observed where two or more bots held the same mediumGoal in
   *  the bulletin at the same time. One tick per minute; a single minute
   *  with three overlapping bots still counts as one. */
  duplicateMediumMinutes: number;
  /** Count of distinct minutes sampled, so the duplicate rate is a true
   *  fraction (duplicateMediumMinutes / minutesSampled). */
  minutesSampled: number;
  /** Lifetime cost in USD at the latest save, for the quick dashboard row. */
  costUsdNow: number;
}

const SESSION_START = Date.now();
const stats: SessionStats = {
  sessionId: new Date(SESSION_START).toISOString().replace(/[:.]/g, "-"),
  sessionStart: new Date(SESSION_START).toISOString(),
  durationSec: 0,
  perBot: {},
  milestones: [],
  duplicateMediumMinutes: 0,
  minutesSampled: 0,
  costUsdNow: 0,
};
/** Lifetime USD at the moment the session started. Every milestone's cost
 *  is reported as the delta from this baseline, so a scoreboard reset in a
 *  long-running budget doesn't carry prior days' spend into the "cost to
 *  reach first iron" number. */
const SESSION_COST_BASELINE: number = safeLifetimeCost();

function safeLifetimeCost(): number {
  try {
    return getLedger().lifetime.costUsd ?? 0;
  } catch {
    return 0;
  }
}

const reachedMilestones = new Set<string>();
let saveTimer: NodeJS.Timeout | null = null;
let dirty = false;

function botStats(name: string): BotStats {
  if (!stats.perBot[name]) {
    stats.perBot[name] = {
      actions: 0,
      successes: 0,
      failures: 0,
      deaths: 0,
      deposits: 0,
      itemsDeposited: 0,
      skillSuccesses: 0,
      skillFailures: 0,
    };
  }
  return stats.perBot[name];
}

/** Tech-tree milestones checked against inventory after each action. */
const INVENTORY_MILESTONES: { name: string; matches: (itemName: string) => boolean }[] = [
  { name: "first_log", matches: (n) => n.endsWith("_log") },
  { name: "first_planks", matches: (n) => n.endsWith("_planks") },
  { name: "first_crafting_table", matches: (n) => n === "crafting_table" },
  { name: "first_wooden_tool", matches: (n) => n.startsWith("wooden_") },
  { name: "first_stone_tool", matches: (n) => n.startsWith("stone_") && n !== "stone" },
  { name: "first_furnace", matches: (n) => n === "furnace" },
  { name: "first_coal", matches: (n) => n === "coal" || n === "charcoal" },
  { name: "first_iron_ingot", matches: (n) => n === "iron_ingot" },
  { name: "first_iron_tool", matches: (n) => n.startsWith("iron_") && n !== "iron_ingot" && n !== "iron_ore" },
  { name: "first_diamond", matches: (n) => n === "diamond" },
  { name: "first_bed", matches: (n) => n.endsWith("_bed") },
  { name: "first_chest", matches: (n) => n === "chest" },
];

function recordMilestone(name: string, bot: string, source: Milestone["source"] = "event"): void {
  if (reachedMilestones.has(name)) return;
  reachedMilestones.add(name);
  const atSec = Math.round((Date.now() - SESSION_START) / 1000);
  // Session delta, not absolute lifetime — see SESSION_COST_BASELINE above.
  const costUsdAt = Math.max(0, safeLifetimeCost() - SESSION_COST_BASELINE);
  stats.milestones.push({ name, bot, atSec, costUsdAt, source });
  console.log(`[Scoreboard] 🏆 MILESTONE: ${name} by ${bot} at ${atSec}s ($${costUsdAt.toFixed(4)})`);
  dirty = true;
}

/** Public hook for the hierarchical planner (src/plan). The planner knows
 *  when a MediumGoal flipped done and calls here with a stable `name`
 *  (e.g. "plan_iron_tier"). Keeps plan + inventory milestones in one
 *  timeline for the benchmark report. */
export function recordPlanMilestone(mediumGoal: string, bot: string): void {
  recordMilestone(`plan_${mediumGoal}`, bot, "plan");
}

/** Call after every executed action. */
export function recordAction(botName: string, action: string, result: string, success: boolean): void {
  const b = botStats(botName);
  b.actions++;
  if (success) b.successes++;
  else b.failures++;

  const depositMatch = result.match(/Deposited (\d+) items/);
  if (depositMatch) {
    b.deposits++;
    b.itemsDeposited += parseInt(depositMatch[1]);
    if (parseInt(depositMatch[1]) > 0) recordMilestone("first_stash_deposit", botName);
  }
  if (/HOUSE BUILT/.test(result)) recordMilestone("first_complete_house", botName);
  if (/Farm complete|planted/i.test(result)) recordMilestone("first_farm", botName);
  if (/Stash bootstrapped/.test(result)) recordMilestone("first_stash", botName);
  dirty = true;
}

/** Call after skill executions (invoke_skill / direct skill actions). */
export function recordSkillResult(botName: string, success: boolean): void {
  const b = botStats(botName);
  if (success) b.skillSuccesses++;
  else b.skillFailures++;
  dirty = true;
}

export function recordDeath(botName: string): void {
  botStats(botName).deaths++;
  dirty = true;
}

/** Scan a bot's inventory for first-time tech milestones. */
export function checkInventoryMilestones(bot: Bot, botName: string): void {
  try {
    const names = bot.inventory.items().map((i) => i.name);
    for (const m of INVENTORY_MILESTONES) {
      if (!reachedMilestones.has(m.name) && names.some(m.matches)) {
        recordMilestone(m.name, botName, "inventory");
      }
    }
  } catch {
    /* inventory not ready */
  }
}

function save(): void {
  if (!dirty) return;
  dirty = false;
  stats.durationSec = Math.round((Date.now() - SESSION_START) / 1000);
  stats.costUsdNow = Math.max(0, safeLifetimeCost() - SESSION_COST_BASELINE);
  try {
    const dir = path.resolve("logs", "sessions");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${stats.sessionId}.json`), JSON.stringify(stats, null, 2));
  } catch (err) {
    console.error("[Scoreboard] Save failed:", err);
  }
}

/** Sample the bulletin: for every medium goal held by two or more bots at
 *  this instant, count the minute as "duplicated". Called from the
 *  session timer below so there is exactly one dedicated tick per minute
 *  and the ratio stays interpretable. */
function sampleDuplicateMediums(mediumsByBot: Record<string, string | undefined>): void {
  stats.minutesSampled += 1;
  const counts = new Map<string, number>();
  for (const m of Object.values(mediumsByBot)) {
    if (!m) continue;
    counts.set(m, (counts.get(m) ?? 0) + 1);
  }
  for (const n of counts.values()) {
    if (n >= 2) {
      stats.duplicateMediumMinutes += 1;
      break; // one minute is one minute, no matter how many mediums overlap
    }
  }
  dirty = true;
}

/** Start periodic persistence. Idempotent. Also samples the duplicate-medium
 *  counter once per minute: the caller provides a sampler because scoreboard
 *  does not import bulletin (bulletin → scoreboard imports flow one way). */
export function startScoreboard(sampleMediums?: () => Record<string, string | undefined>): void {
  if (saveTimer) return;
  saveTimer = setInterval(() => {
    if (sampleMediums) {
      try {
        sampleDuplicateMediums(sampleMediums());
      } catch (err) {
        console.warn("[Scoreboard] duplicate sample failed:", err);
      }
    }
    save();
  }, 60_000);
  saveTimer.unref?.();
  console.log(`[Scoreboard] Session ${stats.sessionId} started`);
}

/** Current stats — used by the dashboard. */
export function getSessionStats(): SessionStats {
  stats.durationSec = Math.round((Date.now() - SESSION_START) / 1000);
  return stats;
}
