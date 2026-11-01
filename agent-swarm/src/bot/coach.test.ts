import { test } from "node:test";
import assert from "node:assert/strict";
import { Coach, reward, type Signals } from "./coach.js";

const base: Signals = { moved: 40, closer: 30, intentionalWait: false, secondsFarFromLead: 0, nearLead: true, died: false, diedWhileStalled: false, spoke: false };

test("good behaviour is rewarded", () => {
  const r = reward({ ...base, spoke: true });
  assert.ok(r.total > 1);
  assert.equal(r.parts.stall, 0);
});

test("stalling is penalised, but waiting on purpose is not", () => {
  assert.equal(reward({ ...base, moved: 0, closer: 0 }).parts.stall, -1);
  assert.equal(reward({ ...base, moved: 0, closer: 0, intentionalWait: true }).parts.stall, 0);
});

test("dying while stalled is the worst outcome", () => {
  const plain = reward({ ...base, died: true });
  const stalled = reward({ ...base, died: true, diedWhileStalled: true });
  assert.ok(stalled.total < plain.total);
  assert.equal(stalled.parts.death, -5);
});

test("drifting from the lead is penalised, staying close is rewarded", () => {
  assert.ok(reward({ ...base, nearLead: false, secondsFarFromLead: 30 }).parts.follow < 0);
  assert.ok(reward({ ...base }).parts.follow > 0);
});

test("a bot that keeps stalling is corrected sooner", () => {
  const c = new Coach();
  const stall: Signals = { ...base, moved: 0, closer: 0 };
  const t = Date.now();
  const before = c.adapt("x", { stuckMs: 25_000, regroupDistance: 180 }, t);
  for (let i = 0; i < 3; i++) c.record("x", stall, t + i);
  const after = c.adapt("x", { stuckMs: 25_000, regroupDistance: 180 }, t + 10);
  assert.ok(after.stuckMs < before.stuckMs);
  assert.ok(c.scoreOf("x") < 0);
});
