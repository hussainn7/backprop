import { test } from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { intersectLines, frameCells, type EyeLine } from "./speedrun.js";

const line = (x: number, z: number, tx: number, tz: number): EyeLine => {
  const d = Math.hypot(tx - x, tz - z);
  return { x, z, dx: (tx - x) / d, dz: (tz - z) / d };
};

test("two eye throws from different spots meet at the stronghold", () => {
  const sh = { x: 1800, z: -1500 };
  const fix = intersectLines([line(1100, -2900, sh.x, sh.z), line(1300, -2700, sh.x, sh.z)]);
  assert.ok(fix);
  assert.ok(Math.hypot(fix!.x - sh.x, fix!.z - sh.z) < 1);
});

test("near-parallel throws give no fix rather than a wild one", () => {
  const sh = { x: 3000, z: 0 };
  assert.equal(intersectLines([line(0, 0, sh.x, sh.z), line(5, 1, sh.x, sh.z)]), null);
});

test("a fix behind the throws is rejected", () => {
  // Diverging headings meet behind the throwers.
  assert.equal(intersectLines([{ x: 0, z: 0, dx: 1, dz: 0 }, { x: 0, z: 100, dx: Math.SQRT1_2, dz: Math.SQRT1_2 }]), null);
});

test("portal frame: 14 border cells around a 2x3 doorway", () => {
  const cells = frameCells(new Vec3(0, 64, 0), "x");
  assert.equal(cells.length, 20);
  assert.equal(cells.filter((c) => c.frame).length, 14);
  const door = cells.filter((c) => !c.frame).map((c) => `${c.pos.x},${c.pos.y}`);
  assert.deepEqual(door.sort(), ["1,65", "1,66", "1,67", "2,65", "2,66", "2,67"]);
});
