import { test } from "node:test";
import assert from "node:assert/strict";
import { _setZones, dangerCost } from "./danger.js";

test("cost is zero far away, high at a repeat killer, and dimension-specific", () => {
  _setZones([{ dim: "nether", x: 100, y: 30, z: -400, count: 3, last: "" }]);
  assert.equal(dangerCost("nether", { x: 300, y: 30, z: -400 }), 0);
  assert.equal(dangerCost("overworld", { x: 100, y: 30, z: -400 }), 0);
  const at = dangerCost("nether", { x: 100, y: 30, z: -400 });
  const near = dangerCost("nether", { x: 105, y: 30, z: -400 });
  assert.ok(at >= 30 && at <= 40);
  assert.ok(near > 0 && near < at);
});

test("overlapping zones are capped", () => {
  _setZones(Array.from({ length: 10 }, () => ({ dim: "nether", x: 0, y: 0, z: 0, count: 9, last: "" })));
  assert.ok(dangerCost("nether", { x: 0, y: 0, z: 0 }) <= 40);
});
