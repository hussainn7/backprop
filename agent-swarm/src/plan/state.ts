// src/plan/state.ts
//
// Per-bot plan state, persisted alongside memory-<bot>.json so a restart
// does not forget what the bot was in the middle of. Writes are atomic
// (temp file + rename) because PaperMC and the swarm share one disk and
// a half-written JSON after an OS crash has to be survivable.
//
// Shape is intentionally flat and additive: every field has a safe default
// so an older file loaded by newer code reads as "nothing in progress."

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { DRAGON_CHAIN, type LongGoal, type MediumGoal, MEDIUM_SPECS, type BotSnapshot } from "./hierarchy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface PlanMilestone {
  readonly medium: MediumGoal;
  readonly at: string;
}

export interface PlanState {
  longGoal: LongGoal;
  /** The medium currently being pursued, or null when idle / all done. */
  activeMedium: MediumGoal | null;
  /** Short-goal id currently in flight (for attempt tracking only — the
   *  planner recomputes the chain every tick from the live snapshot). */
  activeShortId: string | null;
  /** Attempts logged against the active short goal — bumped by callers
   *  when a related action fails; cleared on advance. */
  activeShortAttempts: number;
  /** Mediums the planner has temporarily given up on, with a wall-clock
   *  TTL. Format: medium → epoch ms when the block expires. */
  blockedUntil: Partial<Record<MediumGoal, number>>;
  /** Append-only list of medium completions. First-completion only — if the
   *  swarm "re-earns" a milestone (e.g. after a wipe) the original stays. */
  milestones: PlanMilestone[];
  /** For diagnostics only. */
  lastUpdated: string;
}

const EMPTY: PlanState = {
  longGoal: "defeat_dragon",
  activeMedium: null,
  activeShortId: null,
  activeShortAttempts: 0,
  blockedUntil: {},
  milestones: [],
  lastUpdated: new Date(0).toISOString(),
};

/** Mirror BotMemoryStore's path convention: a filename relative to the
 *  project root. plan-<bot>.json sits next to memory-<bot>.json. */
function resolveFile(fileName: string): string {
  return path.join(__dirname, "../../", fileName);
}

export class PlanStore {
  private state: PlanState;
  private readonly file: string;

  constructor(fileName = "plan.json") {
    this.file = resolveFile(fileName);
    this.state = { ...EMPTY, blockedUntil: {}, milestones: [] };
  }

  /** Load from disk if present; migrate missing fields silently. */
  load(): PlanState {
    try {
      if (!fs.existsSync(this.file)) return this.state;
      const raw = fs.readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PlanState>;
      this.state = {
        longGoal: parsed.longGoal ?? EMPTY.longGoal,
        activeMedium: parsed.activeMedium ?? null,
        activeShortId: parsed.activeShortId ?? null,
        activeShortAttempts: parsed.activeShortAttempts ?? 0,
        blockedUntil: parsed.blockedUntil ?? {},
        milestones: Array.isArray(parsed.milestones) ? parsed.milestones : [],
        lastUpdated: parsed.lastUpdated ?? EMPTY.lastUpdated,
      };
    } catch (err) {
      console.error(`[Plan] Failed to load ${path.basename(this.file)}:`, err);
      // keep in-memory defaults; the next save overwrites the bad file
    }
    return this.state;
  }

  snapshot(): PlanState {
    return { ...this.state, blockedUntil: { ...this.state.blockedUntil }, milestones: [...this.state.milestones] };
  }

  private save(): void {
    try {
      this.state.lastUpdated = new Date().toISOString();
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error("[Plan] Failed to save:", err);
    }
  }

  /** Pick the next unmet medium given the live snapshot. Skips mediums that
   *  are either already done OR temporarily blocked. */
  pickMedium(snap: BotSnapshot, now = Date.now()): MediumGoal | null {
    for (const m of DRAGON_CHAIN) {
      const blockedUntil = this.state.blockedUntil[m];
      if (blockedUntil && blockedUntil > now) continue;
      if (MEDIUM_SPECS[m].isDone(snap)) continue;
      return m;
    }
    return null;
  }

  /** Commit a chosen medium. Resets attempt counters so the new goal starts
   *  with a clean slate. No-op (and no save) if the medium is unchanged. */
  setActiveMedium(medium: MediumGoal | null): void {
    if (this.state.activeMedium === medium) return;
    this.state.activeMedium = medium;
    this.state.activeShortId = null;
    this.state.activeShortAttempts = 0;
    this.save();
  }

  /** Track which concrete short goal is in flight. If it changed since last
   *  tick, reset the attempt counter. */
  observeShort(shortId: string | null): void {
    if (shortId === this.state.activeShortId) return;
    this.state.activeShortId = shortId;
    this.state.activeShortAttempts = 0;
    this.save();
  }

  /** Caller signals a failed attempt at the current short goal (e.g. the
   *  LLM invoked the suggested skill and it returned a non-success). */
  recordShortFailure(): number {
    this.state.activeShortAttempts += 1;
    this.save();
    return this.state.activeShortAttempts;
  }

  /** How many failures the current short goal has absorbed. */
  shortAttempts(): number {
    return this.state.activeShortAttempts;
  }

  /** Mark the current medium blocked until `until` (epoch ms). Clears the
   *  active medium so pickMedium selects something else next tick. */
  blockActiveMedium(until: number): void {
    if (!this.state.activeMedium) return;
    this.state.blockedUntil[this.state.activeMedium] = until;
    this.state.activeMedium = null;
    this.state.activeShortId = null;
    this.state.activeShortAttempts = 0;
    this.save();
  }

  /** If the active medium is now satisfied by the snapshot, record the
   *  milestone (idempotent) and clear active state. Returns true on
   *  transition. */
  tryCompleteActive(snap: BotSnapshot, now = Date.now()): boolean {
    const m = this.state.activeMedium;
    if (!m) return false;
    if (!MEDIUM_SPECS[m].isDone(snap)) return false;
    if (!this.state.milestones.some((x) => x.medium === m)) {
      this.state.milestones.push({ medium: m, at: new Date(now).toISOString() });
    }
    this.state.activeMedium = null;
    this.state.activeShortId = null;
    this.state.activeShortAttempts = 0;
    this.save();
    return true;
  }

  /** The frozen view of persisted milestones, for the scoreboard. */
  milestones(): PlanMilestone[] {
    return [...this.state.milestones];
  }

  /** Test and admin helper — forcibly reset. */
  reset(): void {
    this.state = { ...EMPTY, blockedUntil: {}, milestones: [] };
    this.save();
  }
}
