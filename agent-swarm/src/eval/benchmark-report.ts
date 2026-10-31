// src/eval/benchmark-report.ts
//
// Pure report builder over a SessionStats JSON (as written by scoreboard).
// No I/O, no mineflayer — safe to unit-test and run from a CLI.
//
// The report answers the questions in the "Test the intelligence" ask:
//   - time to first crafting table / shelter / renewable food / iron / etc.
//   - deaths, successful vs failed actions
//   - duplicate tasks between agents
//   - API cost per successful milestone
//   - progress toward the Ender Dragon
//
// Side-by-side comparison with a baseline session is intentionally terse:
// the caller renders what matters.

import type { SessionStats, Milestone } from "../bot/scoreboard.js";

/** Which named milestones correspond to the user-visible benchmarks. The
 *  benchmark list is small on purpose — a dashboard of 50 bars means the
 *  user has to read all 50; six headline numbers tell a story at a glance. */
export const BENCHMARKS: Array<{ label: string; milestone: string }> = [
  { label: "First crafting table", milestone: "first_crafting_table" },
  { label: "First shelter (house)", milestone: "first_complete_house" },
  { label: "First farm", milestone: "first_farm" },
  { label: "First iron tool", milestone: "first_iron_tool" },
  { label: "First diamond", milestone: "first_diamond" },
  { label: "Iron tier (plan)", milestone: "plan_iron_tier" },
  { label: "Nether entered (plan)", milestone: "plan_nether_entry" },
  { label: "Diamond tier (plan)", milestone: "plan_diamond_tier" },
  { label: "Ender Dragon slain", milestone: "plan_dragon_kill" },
];

export interface BenchmarkRow {
  label: string;
  milestone: string;
  reached: boolean;
  atSec?: number;
  costUsdAt?: number;
  bot?: string;
}

export interface BenchmarkReport {
  sessionId: string;
  durationSec: number;
  costUsdTotal: number;
  rows: BenchmarkRow[];
  /** Per-bot totals rolled up to one row the user can scan. */
  perBot: Array<{
    name: string;
    actions: number;
    successRate: number;
    deaths: number;
    skillSuccessRate: number;
  }>;
  duplicateMediumRate: number;
  costPerReachedMilestone: number;
}

function findMilestone(stats: SessionStats, name: string): Milestone | undefined {
  return stats.milestones.find((m) => m.name === name);
}

export function buildReport(stats: SessionStats): BenchmarkReport {
  const rows: BenchmarkRow[] = BENCHMARKS.map(({ label, milestone }) => {
    const m = findMilestone(stats, milestone);
    if (!m) return { label, milestone, reached: false };
    return { label, milestone, reached: true, atSec: m.atSec, costUsdAt: m.costUsdAt, bot: m.bot };
  });

  const perBot = Object.entries(stats.perBot).map(([name, b]) => {
    const total = b.successes + b.failures;
    const skillTotal = b.skillSuccesses + b.skillFailures;
    return {
      name,
      actions: b.actions,
      successRate: total > 0 ? b.successes / total : 0,
      deaths: b.deaths,
      skillSuccessRate: skillTotal > 0 ? b.skillSuccesses / skillTotal : 0,
    };
  });

  const dupRate = stats.minutesSampled > 0 ? stats.duplicateMediumMinutes / stats.minutesSampled : 0;
  const reached = rows.filter((r) => r.reached).length;
  const costPer = reached > 0 ? (stats.costUsdNow ?? 0) / reached : 0;

  return {
    sessionId: stats.sessionId,
    durationSec: stats.durationSec,
    costUsdTotal: stats.costUsdNow ?? 0,
    rows,
    perBot,
    duplicateMediumRate: dupRate,
    costPerReachedMilestone: costPer,
  };
}

function fmtDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}

function fmtCost(usd: number | undefined): string {
  if (usd === undefined || !Number.isFinite(usd)) return "—";
  return `$${usd.toFixed(4)}`;
}

/** Render a human-friendly text report. Fixed-width columns so stdout, a
 *  Discord code block, and the dashboard all look the same. */
export function renderReport(report: BenchmarkReport, baseline?: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`Session: ${report.sessionId}`);
  lines.push(`Duration: ${fmtDuration(report.durationSec)}`);
  lines.push(`Total session cost: ${fmtCost(report.costUsdTotal)}`);
  lines.push(`Duplicate-medium rate: ${(report.duplicateMediumRate * 100).toFixed(1)}%`);
  lines.push(`Cost per reached milestone: ${fmtCost(report.costPerReachedMilestone)}`);
  lines.push("");
  lines.push("MILESTONES");
  lines.push("─".repeat(68));
  for (const r of report.rows) {
    const prefix = r.reached ? "✓" : "·";
    const timePart = r.reached ? fmtDuration(r.atSec ?? 0).padStart(8) : "       —";
    const costPart = r.reached ? fmtCost(r.costUsdAt).padStart(10) : "         —";
    const botPart = r.reached && r.bot ? ` by ${r.bot}` : "";
    const baseRow = baseline?.rows.find((b) => b.milestone === r.milestone);
    let delta = "";
    if (baseRow?.reached && r.reached) {
      const dt = (r.atSec ?? 0) - (baseRow.atSec ?? 0);
      const sign = dt < 0 ? "" : "+";
      delta = `  Δ ${sign}${fmtDuration(Math.abs(dt))}`;
    } else if (baseRow?.reached && !r.reached) {
      delta = "  (regression — not reached)";
    } else if (!baseRow?.reached && r.reached) {
      delta = "  (new)";
    }
    lines.push(`  ${prefix} ${r.label.padEnd(26)} ${timePart}  ${costPart}${botPart}${delta}`);
  }
  lines.push("");
  lines.push("PER-BOT");
  lines.push("─".repeat(68));
  for (const b of report.perBot) {
    lines.push(
      `  ${b.name.padEnd(10)} actions=${String(b.actions).padEnd(5)} ok=${(b.successRate * 100).toFixed(0).padStart(3)}%  skill-ok=${(b.skillSuccessRate * 100).toFixed(0).padStart(3)}%  deaths=${b.deaths}`,
    );
  }
  return lines.join("\n");
}
