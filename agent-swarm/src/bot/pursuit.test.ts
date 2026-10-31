import { test } from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { Pursuit } from "./pursuit.js";

function fakeBot(pos: Vec3) {
  const goals: Array<{ x?: number; z?: number; constructor: { name: string } }> = [];
  const controls: Record<string, boolean> = {};
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  const bot = {
    on(ev: string, fn: (...a: unknown[]) => void) {
      (listeners[ev] ??= []).push(fn);
    },
    emit(ev: string, ...a: unknown[]) {
      for (const fn of listeners[ev] ?? []) fn(...a);
    },
    entity: { position: pos, isInWater: false },
    controls,
    setControlState(c: string, v: boolean) {
      controls[c] = v;
    },
    look: async () => {},
    pathfinder: {
      moving: true,
      setGoal(g: never) {
        goals.push(g);
      },
      isMoving() {
        return this.moving;
      },
    },
  };
  return { bot: bot as never, goals, raw: bot };
}

test("far target: walks 48-block waypoints and does not re-plan when he shifts a few blocks", () => {
  const { bot, goals } = fakeBot(new Vec3(0, 64, 0));
  const p = new Pursuit(bot);
  p.step(new Vec3(370, 64, 0));
  assert.equal(goals.length, 1);
  assert.equal(goals[0].constructor.name, "GoalNearXZ");
  assert.ok(Math.abs((goals[0].x ?? 0) - 32) < 0.01, "waypoint 32 blocks along the bearing");
  p.step(new Vec3(372, 64, 6)); // he moved a little: same bearing within 25°
  assert.equal(goals.length, 1, "no re-plan for a small move far away");
});

test("near target: re-plans only when his predicted spot moved more than 10% of the distance", () => {
  const { bot, goals } = fakeBot(new Vec3(0, 64, 0));
  const p = new Pursuit(bot);
  p.step(new Vec3(40, 64, 0));
  p.step(new Vec3(42, 64, 0)); // 2 blocks < max(3, 4)
  assert.equal(goals.length, 1);
  p.step(new Vec3(46, 64, 0));
  assert.equal(goals.length, 2);
});

test("a goal still being computed (not moving yet) is not re-issued while the search runs", () => {
  const { bot, goals, raw } = fakeBot(new Vec3(0, 64, 0));
  raw.pathfinder.moving = false;
  const p = new Pursuit(bot);
  p.step(new Vec3(370, 64, 0));
  p.step(new Vec3(370, 64, 0));
  p.step(new Vec3(370, 64, 0));
  assert.equal(goals.length, 1, "the search keeps running");
});

test("no progress for 6 s: tries a pearl hop, otherwise detours", () => {
  const { bot, goals, raw } = fakeBot(new Vec3(0, 64, 0));
  const hops: Vec3[] = [];
  const p = new Pursuit(bot, { hop: (pt) => (hops.push(pt), hops.length === 1) });
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  try {
    p.step(new Vec3(100, 64, 0));
    raw.emit("path_update", { status: "partial" }); // search done, yet no progress
    t += 7000;
    p.step(new Vec3(100, 64, 0));
    assert.equal(hops.length, 1, "first stall: pearl hop");
    assert.ok(Math.abs(hops[0].x - 35) < 0.01, "hop is capped at 35 blocks toward him");
    p.step(new Vec3(100, 64, 0));
    raw.emit("path_update", { status: "partial" });
    t += 7000;
    const before = goals.length;
    p.step(new Vec3(100, 64, 0));
    assert.equal(goals.length, before + 1, "second stall: a short tunnelling route");
    assert.ok(Math.abs((goals.at(-1)?.x ?? 0) - 12) < 0.01, "12 blocks along the bearing");
  } finally {
    Date.now = real;
  }
});

test("in water: swims straight at him instead of asking the pathfinder", () => {
  const { bot, goals, raw } = fakeBot(new Vec3(0, 62, 0));
  raw.entity.isInWater = true;
  const p = new Pursuit(bot);
  p.step(new Vec3(100, 64, 0));
  assert.equal(raw.controls.forward, true);
  assert.equal(raw.controls.jump, true);
  assert.equal(goals.at(-1), null, "pathfinder goal cleared while swimming");
  raw.entity.isInWater = false;
  p.step(new Vec3(100, 64, 0));
  assert.equal(raw.controls.forward, false, "controls released on land");
  assert.notEqual(goals.at(-1), null, "pathfinder takes over again");
});

test("a definite noPath triggers recovery at once; a running search does not", () => {
  const { bot, raw } = fakeBot(new Vec3(0, 64, 0));
  const hops: Vec3[] = [];
  const p = new Pursuit(bot, { hop: (pt) => (hops.push(pt), true) });
  p.step(new Vec3(200, 64, 0)); // goal set, search running
  p.step(new Vec3(200, 64, 0));
  assert.equal(hops.length, 0, "no recovery while searching");
  raw.emit("path_update", { status: "noPath" });
  p.step(new Vec3(200, 64, 0));
  assert.equal(hops.length, 1, "noPath: hop immediately");
});
