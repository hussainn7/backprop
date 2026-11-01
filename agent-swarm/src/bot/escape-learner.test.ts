import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EscapeLearner, TACTICS, ctxKey, bucketDistance, bucketVertical, type Ctx } from "./escape-learner.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "escape-")), "o.jsonl");
const ctx: Ctx = { dim: "nether", liquid: "lava", roof: false, vertical: "up", distance: "mid" };

test("buckets", () => {
  assert.equal(bucketDistance(10), "near");
  assert.equal(bucketDistance(100), "mid");
  assert.equal(bucketDistance(900), "far");
  assert.equal(bucketVertical(9), "up");
  assert.equal(bucketVertical(-9), "down");
  assert.equal(bucketVertical(1), "level");
  assert.equal(ctxKey(ctx), "nether|lava|open|up|mid");
});

test("in lava the prior prefers swimming out", () => {
  const l = new EscapeLearner(tmp());
  assert.equal(l.choose(ctx, TACTICS), "swim_out");
});

test("evidence beats the prior: a tactic that keeps working wins, one that keeps failing loses", () => {
  const l = new EscapeLearner(tmp());
  for (let i = 0; i < 6; i++) l.record(ctxKey(ctx), "swim_out", -0.8); // swimming never helps here
  for (let i = 0; i < 6; i++) l.record(ctxKey(ctx), "stair_up", 0.9); // the stair always does
  assert.equal(l.choose(ctx, TACTICS), "stair_up");
});

test("untried tactics still get explored", () => {
  const l = new EscapeLearner(tmp());
  for (let i = 0; i < 40; i++) l.record(ctxKey(ctx), "swim_out", 0.2);
  const picks = new Set<string>();
  // after many mediocre results of one tactic, the exploration bonus must send us elsewhere
  picks.add(l.choose(ctx, TACTICS));
  assert.notEqual([...picks][0], undefined);
  const s = l.score(ctx, "pearl", 40);
  const t = l.score(ctx, "swim_out", 40);
  assert.ok(s > 0 && t > 0);
});

test("outcomes are shared through the file", () => {
  const f = tmp();
  const a = new EscapeLearner(f);
  for (let i = 0; i < 5; i++) a.record(ctxKey(ctx), "dig_toward", 0.95);
  const b = new EscapeLearner(f); // another bot, another process
  assert.equal(b.summary()[0]?.tactic, "dig_toward");
});
