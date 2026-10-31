import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { PlanStore } from "./state.js";
import type { BotSnapshot } from "./hierarchy.js";

function tmpStore(): { store: PlanStore; file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plantest-"));
  const file = path.join(dir, "plan-test.json");
  const store = new PlanStore("plan-test.json");
  (store as unknown as { file: string }).file = file;
  return { store, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function snap(partial: Partial<BotSnapshot> = {}): BotSnapshot {
  return {
    inv: partial.inv ?? new Map(),
    pickaxeTier: partial.pickaxeTier ?? -1,
    swordTier: partial.swordTier ?? -1,
    earnedAdvancements: partial.earnedAdvancements ?? new Set(),
    hasShelter: partial.hasShelter ?? false,
    hasFarm: partial.hasFarm ?? false,
    dimension: partial.dimension ?? "overworld",
  };
}

test("empty store picks the first medium (shelter) and persists it", () => {
  const { store, cleanup } = tmpStore();
  try {
    const picked = store.pickMedium(snap());
    assert.equal(picked, "shelter");
    store.setActiveMedium(picked);
    assert.equal(store.snapshot().activeMedium, "shelter");
  } finally {
    cleanup();
  }
});

test("pickMedium skips mediums already satisfied", () => {
  const { store, cleanup } = tmpStore();
  try {
    // shelter + food already done — iron_tier is next.
    const picked = store.pickMedium(snap({ hasShelter: true, hasFarm: true }));
    assert.equal(picked, "iron_tier");
  } finally {
    cleanup();
  }
});

test("pickMedium skips blocked mediums until their TTL expires", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.setActiveMedium("iron_tier");
    const until = Date.now() + 10_000;
    store.blockActiveMedium(until);
    // active cleared, iron_tier blocked — pick jumps to diamond_tier
    const nextPick = store.pickMedium(snap({ hasShelter: true, hasFarm: true }), until - 1_000);
    assert.equal(nextPick, "diamond_tier");
    // after TTL, iron_tier is eligible again
    const laterPick = store.pickMedium(snap({ hasShelter: true, hasFarm: true }), until + 1_000);
    assert.equal(laterPick, "iron_tier");
  } finally {
    cleanup();
  }
});

test("recordShortFailure increments attempts and persists across loads", () => {
  const { store, file, cleanup } = tmpStore();
  try {
    store.setActiveMedium("iron_tier");
    store.observeShort("mine_iron_ore");
    store.recordShortFailure();
    store.recordShortFailure();
    assert.equal(store.shortAttempts(), 2);

    const reload = new PlanStore("plan-test.json");
    (reload as unknown as { file: string }).file = file;
    reload.load();
    assert.equal(reload.snapshot().activeShortAttempts, 2);
    assert.equal(reload.snapshot().activeShortId, "mine_iron_ore");
  } finally {
    cleanup();
  }
});

test("observeShort resets attempts when the step changes", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.setActiveMedium("iron_tier");
    store.observeShort("mine_iron_ore");
    store.recordShortFailure();
    store.recordShortFailure();
    store.observeShort("smelt_iron"); // step advanced
    assert.equal(store.shortAttempts(), 0);
  } finally {
    cleanup();
  }
});

test("tryCompleteActive records a milestone exactly once", () => {
  const { store, cleanup } = tmpStore();
  try {
    store.setActiveMedium("iron_tier");
    assert.equal(store.tryCompleteActive(snap({ pickaxeTier: 2 })), true);
    assert.equal(store.milestones().length, 1);
    assert.equal(store.milestones()[0].medium, "iron_tier");
    // calling again with the same completion does not duplicate
    store.setActiveMedium("iron_tier");
    assert.equal(store.tryCompleteActive(snap({ pickaxeTier: 2 })), true);
    assert.equal(store.milestones().length, 1);
  } finally {
    cleanup();
  }
});

test("load survives a missing file by returning defaults", () => {
  const { store, cleanup } = tmpStore();
  try {
    const state = store.load();
    assert.equal(state.activeMedium, null);
    assert.equal(state.milestones.length, 0);
  } finally {
    cleanup();
  }
});

test("load survives a corrupted file by resetting in-memory state", () => {
  const { store, file, cleanup } = tmpStore();
  try {
    fs.writeFileSync(file, "{ not valid json");
    const state = store.load();
    assert.equal(state.activeMedium, null);
    assert.equal(state.milestones.length, 0);
  } finally {
    cleanup();
  }
});
