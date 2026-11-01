import { test } from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { Swimmer } from "./swim.js";

/** A tiny world: `blocks(x,y,z)` names the block at integer coordinates. */
function fakeBot(pos: Vec3, blocks: (x: number, y: number, z: number) => string, oxygen = 20) {
  const controls: Record<string, boolean> = {};
  let looked: [number, number] | null = null;
  const bot = {
    entity: { position: pos },
    oxygenLevel: oxygen,
    blockAt(p: Vec3) {
      const name = blocks(p.x, p.y, p.z);
      return { name, boundingBox: name === "water" || name === "air" ? "empty" : "block" };
    },
    setControlState(c: string, v: boolean) {
      controls[c] = v;
    },
    look: async (yaw: number, pitch: number) => {
      looked = [yaw, pitch];
    },
  };
  return { bot: bot as never, controls, raw: bot, looked: () => looked };
}

// Deep ocean: water from y=40 to y=63, air above.
const ocean = (_x: number, y: number) => (y <= 63 && y >= 40 ? "water" : y < 40 ? "stone" : "air");

test("low air with the head under: swims straight up to breathe", () => {
  const { bot, controls, looked } = fakeBot(new Vec3(0.5, 55, 0.5), ocean, 5);
  const s = new Swimmer(bot);
  s.step(new Vec3(50, 64, 0));
  assert.equal(s.mode, "air");
  assert.equal(controls.jump, true);
  assert.equal(controls.forward, false);
  assert.ok(looked()![1] > 1.5, "looking straight up");
});

test("deep water with air to spare: sprint-swims underwater without jumping", () => {
  const { bot, controls } = fakeBot(new Vec3(0.5, 55, 0.5), ocean, 20);
  const s = new Swimmer(bot);
  s.step(new Vec3(50, 55, 0));
  assert.equal(s.mode, "dive");
  assert.equal(controls.sprint, true);
  assert.equal(controls.jump, false);
});

test("refills to full air before diving again", () => {
  const { bot, raw } = fakeBot(new Vec3(0.5, 55, 0.5), ocean, 5);
  const s = new Swimmer(bot);
  s.step(new Vec3(50, 55, 0));
  raw.oxygenLevel = 17; // head still under, not full yet: keep surfacing
  s.step(new Vec3(50, 55, 0));
  assert.equal(s.mode, "air");
  raw.oxygenLevel = 20;
  s.step(new Vec3(50, 55, 0));
  assert.equal(s.mode, "dive");
});

test("a ledge with headroom ahead: climbs out", () => {
  // Water around x<2 at y=63; a stone ledge at x>=2, y=63 with air above.
  const shore = (x: number, y: number) => (x >= 2 ? (y <= 63 ? "stone" : "air") : y <= 63 && y >= 60 ? "water" : y < 60 ? "stone" : "air");
  const { bot, controls } = fakeBot(new Vec3(1.2, 63.1, 0.5), shore, 20);
  const s = new Swimmer(bot);
  s.step(new Vec3(30, 64, 0.5));
  assert.equal(s.mode, "shore");
  assert.equal(controls.jump, true);
  assert.equal(controls.forward, true);
});

test("out of the water: does nothing and releases the controls", () => {
  const { bot, controls } = fakeBot(new Vec3(0.5, 70, 0.5), ocean, 20);
  const s = new Swimmer(bot);
  assert.equal(s.step(new Vec3(50, 70, 0)), false);
  assert.equal(controls.forward, undefined);
});
