import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simulateRange, physicsPitch, trajectory, PearlAim } from "./pearl-aim.js";
import { CombatLearner, stateKey, availableTactics, type CombatState } from "./combat-learner.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "learn-"));

test("physics inversion round-trips: the solved pitch lands on the target", () => {
  for (const [d, dy] of [
    [8, 0],
    [20, 0],
    [30, -5],
    [15, 4],
  ]) {
    const p = physicsPitch(d, dy);
    assert.ok(p !== null, `no solution for d=${d} dy=${dy}`);
    const r = simulateRange(p!, dy)!;
    assert.ok(Math.abs(r - d) < 0.05, `d=${d} dy=${dy} landed at ${r}`);
  }
});

test("high-arc lobs also land on the target, at a steeper pitch than the low arc", () => {
  for (const [d, dy] of [
    [15, 0],
    [25, -4],
  ]) {
    const low = physicsPitch(d, dy, "low")!;
    const high = physicsPitch(d, dy, "high")!;
    assert.ok(high > low + 0.2, `high ${high} should be well above low ${low}`);
    assert.ok(Math.abs(simulateRange(high, dy)! - d) < 0.05, "the lob lands on target");
    const path = trajectory(high, dy);
    assert.ok(Math.max(...path.map((p) => p[1])) > Math.max(...trajectory(low, dy).map((p) => p[1])) + 3, "the lob clears higher");
  }
});

test("pearl aim learns a systematic pitch error from hindsight-relabelled throws", () => {
  const aim = new PearlAim("test", tmp());
  // The "real game" here throws 3° lower than physics predicts.
  const bias = (3 * Math.PI) / 180;
  const errors: number[] = [];
  for (let i = 0; i < 30; i++) {
    const d = 10 + ((i * 7) % 25);
    const pitch = aim.aim(d, 0)!;
    const landed = simulateRange(pitch - bias, 0)!;
    errors.push(Math.abs(landed - d));
    aim.learn("t", pitch, { d, dy: 0 }, { forward: landed, lateral: 0, dy: 0 });
  }
  const first = errors[0];
  const last = errors.slice(-5).reduce((a, b) => a + b) / 5;
  assert.ok(first > 1, `the uncorrected first throw should miss (error ${first.toFixed(2)})`);
  assert.ok(last < 0.3, `aim should converge: first ${first.toFixed(2)} → last5 mean ${last.toFixed(2)}`);
});

test("Q-learning prefers the tactic that pays off", () => {
  const learner = new CombatLearner("test", tmp());
  const s: CombatState = { dist: 2, hp: 18, targetShielding: false, dy: 0, alliesNearTarget: 0 };
  const options = availableTactics(s, 0, true);
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 400; i++) {
    const { tactic } = learner.choose(s, options, rand);
    const reward = tactic === "crit" ? 2 : tactic === "retreat" ? -1 : 0.3;
    learner.update(s, tactic, reward, s, options);
  }
  const best = options.reduce((a, b) => (learner.q(s, b) > learner.q(s, a) ? b : a));
  assert.equal(best, "crit");
  assert.ok(learner.stateEpsilon(stateKey(s)) < 0.1, "a well-visited state mostly exploits");
  const rare: CombatState = { ...s, dist: 30 };
  assert.equal(learner.stateEpsilon(stateKey(rare)), 0.5, "an unseen state still explores");
});

test("pearl tactics are only offered with pearls and at sensible ranges", () => {
  const far: CombatState = { dist: 20, hp: 20, targetShielding: false, dy: 0, alliesNearTarget: 0 };
  assert.ok(availableTactics(far, 4, true).includes("pearl_close"));
  assert.ok(!availableTactics(far, 0, true).includes("pearl_close"));
  const hurt: CombatState = { dist: 3, hp: 5, targetShielding: false, dy: 0, alliesNearTarget: 0 };
  assert.ok(availableTactics(hurt, 4, true).includes("pearl_escape"));
});

test("v2 generalizes: 'rush beats pearling when he is busy fighting' learned at one range applies at another", () => {
  const learner = new CombatLearner("gen", tmp());
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const busy = (dist: number): CombatState => ({ dist, hp: 20, targetShielding: false, dy: 0, alliesNearTarget: 2, targetMotion: "still", targetBusy: true });
  const fleeing = (dist: number): CombatState => ({ dist, hp: 20, targetShielding: false, dy: 0, alliesNearTarget: 0, targetMotion: "fleeing", targetBusy: false });
  // Training only at 10 blocks: when busy, running in pays; when he flees, the pearl pays.
  for (let i = 0; i < 600; i++) {
    const s = i % 2 ? busy(10) : fleeing(10);
    const opts = availableTactics(s, 16, true);
    const { tactic } = learner.choose(s, opts, rand);
    const good = s.targetBusy ? tactic === "rush" : tactic === "pearl_close";
    learner.update(s, tactic, good ? 2 : tactic.startsWith("pearl") || tactic === "rush" ? -0.5 : 0, null, []);
  }
  // Tested at 20 blocks, a distance bucket never trained on.
  assert.ok(learner.q(busy(20), "rush") > learner.q(busy(20), "pearl_close"), "busy target: rush in");
  assert.ok(learner.q(fleeing(20), "pearl_close") > learner.q(fleeing(20), "rush"), "fleeing target: pearl");
});

test("defend is only offered with a mob on the bot", () => {
  const s: CombatState = { dist: 5, hp: 20, targetShielding: false, dy: 0, alliesNearTarget: 0 };
  assert.ok(!availableTactics(s, 0, true).includes("defend"));
  assert.ok(availableTactics({ ...s, mobAdjacent: true }, 0, true).includes("defend"));
});

test("backup is offered only when a teammate called for help, and old weights survive a new feature", () => {
  const s: CombatState = { dist: 5, hp: 20, targetShielding: false, dy: 0, alliesNearTarget: 0 };
  assert.ok(!availableTactics(s, 0, true).includes("backup"));
  assert.ok(availableTactics({ ...s, allyHurt: true }, 0, true).includes("backup"));
  const dir = tmp();
  fs.writeFileSync(
    path.join(dir, "combat-v2-old.json"),
    JSON.stringify({ version: 2, w: { rush: new Array(21).fill(0.5) }, visits: {}, updates: 10, curve: [], pending: [], tacticStats: {}, kills: 0, deaths: 0 }),
  );
  const learner = new CombatLearner("old", dir);
  assert.equal(learner.q(s, "rush"), 0.5 * 6, "21 learned weights kept (6 active features here), new one starts at 0");
});

test("arrow ballistics: solved pitch passes the target, including straight up a tower", async () => {
  const { ARROW, solvePitch, heightAt } = await import("./ballistics.js");
  for (const [d, dy] of [
    [10, 1.2],
    [30, 1.2],
    [50, 0],
    [6, 30], // under a 30-block tower
  ]) {
    const p = solvePitch(ARROW, d, dy);
    assert.ok(p !== null, `no shot for d=${d} dy=${dy}`);
    assert.ok(Math.abs(heightAt(ARROW, p!, d)! - dy) < 0.05, `d=${d} dy=${dy}`);
  }
  assert.equal(solvePitch(ARROW, 40, 200), null, "out of reach");
});
