import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, renderReport, BENCHMARKS } from "./benchmark-report.js";
import type { SessionStats } from "../bot/scoreboard.js";

function emptyStats(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    sessionId: "test",
    sessionStart: new Date().toISOString(),
    durationSec: 0,
    perBot: {},
    milestones: [],
    duplicateMediumMinutes: 0,
    minutesSampled: 0,
    costUsdNow: 0,
    ...overrides,
  };
}

test("report marks every benchmark unreached on an empty session", () => {
  const r = buildReport(emptyStats());
  assert.equal(r.rows.length, BENCHMARKS.length);
  for (const row of r.rows) assert.equal(row.reached, false);
  assert.equal(r.costPerReachedMilestone, 0);
});

test("report surfaces reached milestones with their cost snapshot", () => {
  const stats = emptyStats({
    durationSec: 1200,
    costUsdNow: 0.42,
    milestones: [
      { name: "first_crafting_table", bot: "Atlas", atSec: 300, costUsdAt: 0.05, source: "inventory" },
      { name: "first_iron_tool", bot: "Forge", atSec: 900, costUsdAt: 0.3, source: "inventory" },
      { name: "plan_iron_tier", bot: "Forge", atSec: 920, costUsdAt: 0.31, source: "plan" },
    ],
  });
  const r = buildReport(stats);
  const table = r.rows.find((row) => row.milestone === "first_crafting_table")!;
  assert.equal(table.reached, true);
  assert.equal(table.atSec, 300);
  assert.equal(table.costUsdAt, 0.05);
  assert.equal(table.bot, "Atlas");
  // 3 of the ~9 benchmarks hit -> cost per reached = 0.42 / 3
  assert.ok(Math.abs(r.costPerReachedMilestone - 0.42 / 3) < 1e-9);
});

test("duplicate-medium rate is the minute fraction", () => {
  const r = buildReport(emptyStats({ duplicateMediumMinutes: 7, minutesSampled: 20 }));
  assert.equal(r.duplicateMediumRate, 7 / 20);
});

test("per-bot roll-up gives action, success rate, death counts", () => {
  const r = buildReport(
    emptyStats({
      perBot: {
        Atlas: {
          actions: 100,
          successes: 80,
          failures: 20,
          deaths: 2,
          deposits: 0,
          itemsDeposited: 0,
          skillSuccesses: 10,
          skillFailures: 5,
        },
      },
    }),
  );
  const atlas = r.perBot[0];
  assert.equal(atlas.name, "Atlas");
  assert.equal(atlas.successRate, 0.8);
  assert.equal(atlas.deaths, 2);
  assert.ok(Math.abs(atlas.skillSuccessRate - 10 / 15) < 1e-9);
});

test("renderReport shows a delta vs baseline for the shared milestones", () => {
  const base = buildReport(
    emptyStats({
      milestones: [{ name: "first_iron_tool", bot: "Forge", atSec: 1800, costUsdAt: 1.0, source: "inventory" }],
    }),
  );
  const cur = buildReport(
    emptyStats({
      milestones: [{ name: "first_iron_tool", bot: "Forge", atSec: 1500, costUsdAt: 0.7, source: "inventory" }],
    }),
  );
  const text = renderReport(cur, base);
  // 1500 - 1800 = -300s (improvement). Delta prefix shows no "+" for faster.
  assert.ok(text.includes("First iron tool"));
  assert.ok(text.includes("Δ 5m00s"));
});

test("renderReport flags regressions when a baseline milestone no longer reaches", () => {
  const base = buildReport(
    emptyStats({
      milestones: [{ name: "plan_iron_tier", bot: "Forge", atSec: 1800, costUsdAt: 1.0, source: "plan" }],
    }),
  );
  const cur = buildReport(emptyStats()); // no milestones hit
  const text = renderReport(cur, base);
  assert.ok(/regression/i.test(text));
});
