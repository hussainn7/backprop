// src/bot/escape-learner.ts
//
// Learns how to get unstuck. A bot that has not made progress picks a tactic for its situation,
// runs it, and the outcome (how much closer to its goal it got, whether it left the liquid it was
// in, how long it took, whether it died) becomes the tactic's score for that situation. Tactics that
// produce the outcome get picked more; failures fade. Nothing about the world is hardcoded: the
// priors below only say which tactics are plausible, and any evidence outweighs them within a few tries.
//
// Every bot in every squad appends its outcomes to one file, so a discovery by one bot is used by the
// other nineteen. The file is append-only (no merge races); each process rebuilds its table from it.

import fs from "node:fs";
import path from "node:path";

export const TACTICS = [
  "stair_up",
  "stair_down",
  "pillar_up",
  "swim_out",
  "pearl",
  "dig_toward",
  "dig_out",
  "sidestep",
  "backtrack",
] as const;
export type Tactic = (typeof TACTICS)[number];

export interface Ctx {
  dim: "overworld" | "nether" | "end";
  liquid: "none" | "water" | "lava";
  roof: boolean; // solid block within 3 above the head
  vertical: "up" | "level" | "down"; // where the goal is relative to the bot
  distance: "near" | "mid" | "far";
}

export const ctxKey = (c: Ctx): string => `${c.dim}|${c.liquid}|${c.roof ? "roof" : "open"}|${c.vertical}|${c.distance}`;

export function bucketDistance(d: number): Ctx["distance"] {
  return d < 30 ? "near" : d < 150 ? "mid" : "far";
}
export function bucketVertical(dy: number): Ctx["vertical"] {
  return dy >= 4 ? "up" : dy <= -4 ? "down" : "level";
}

/** What is plausible before any evidence: small positive values, so exploration starts sensibly. */
export function prior(c: Ctx, t: Tactic): number {
  switch (t) {
    case "stair_up":
      return c.vertical === "up" || c.roof ? 0.35 : 0.05;
    case "stair_down":
      return c.vertical === "down" ? 0.3 : 0.0;
    case "pillar_up":
      return c.vertical === "up" && c.liquid === "none" ? 0.25 : 0.0;
    case "swim_out":
      return c.liquid !== "none" ? 0.5 : -0.2;
    case "pearl":
      return c.distance !== "near" && c.liquid === "none" ? 0.3 : 0.0;
    case "dig_toward":
      return c.vertical === "level" ? 0.3 : 0.1;
    case "dig_out":
      return c.roof ? 0.2 : 0.1;
    case "sidestep":
      return 0.1;
    case "backtrack":
      return 0.05;
  }
}

interface Stat {
  n: number;
  sum: number;
}

export class EscapeLearner {
  private table = new Map<string, Map<Tactic, Stat>>();
  private loadedAt = 0;
  private readonly file: string;

  constructor(file = path.join("logs", "learning", "escape-outcomes.jsonl")) {
    this.file = file;
    this.refresh(true);
  }

  /** Rebuild from the shared file (other bots add to it): at most every 20 s. */
  refresh(force = false): void {
    if (!force && Date.now() - this.loadedAt < 20_000) return;
    this.loadedAt = Date.now();
    let lines: string[] = [];
    try {
      lines = fs.readFileSync(this.file, "utf8").split(String.fromCharCode(10)).filter(Boolean).slice(-6000);
    } catch {
      /* none yet */
    }
    const fresh = new Map<string, Map<Tactic, Stat>>();
    for (const l of lines) {
      try {
        const o = JSON.parse(l) as { k: string; t: Tactic; r: number };
        this.add(fresh, o.k, o.t, o.r);
      } catch {
        /* skip a torn line */
      }
    }
    this.table = fresh;
  }

  private add(into: Map<string, Map<Tactic, Stat>>, k: string, t: Tactic, r: number): void {
    let row = into.get(k);
    if (!row) into.set(k, (row = new Map()));
    const s = row.get(t) ?? { n: 0, sum: 0 };
    s.n++;
    s.sum += r;
    row.set(t, s);
  }

  record(key: string, tactic: Tactic, reward: number): void {
    this.add(this.table, key, tactic, reward);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify({ k: key, t: tactic, r: Math.round(reward * 100) / 100, at: Date.now() }) + String.fromCharCode(10));
    } catch {
      /* best effort */
    }
  }

  /** Score = prior-weighted mean reward + exploration bonus (UCB). */
  score(ctx: Ctx, t: Tactic, total: number): number {
    const s = this.table.get(ctxKey(ctx))?.get(t) ?? { n: 0, sum: 0 };
    const p = prior(ctx, t);
    const PRIOR_WEIGHT = 2; // the prior counts as two observations
    const mean = (s.sum + p * PRIOR_WEIGHT) / (s.n + PRIOR_WEIGHT);
    const bonus = 0.55 * Math.sqrt(Math.log(total + 2) / (s.n + 1));
    return mean + bonus;
  }

  choose(ctx: Ctx, available: readonly Tactic[]): Tactic {
    this.refresh();
    const row = this.table.get(ctxKey(ctx));
    let total = 0;
    if (row) for (const s of row.values()) total += s.n;
    let best = available[0];
    let bestScore = -Infinity;
    for (const t of available) {
      const sc = this.score(ctx, t, total);
      if (sc > bestScore) {
        bestScore = sc;
        best = t;
      }
    }
    return best;
  }

  /** For logging / the dashboard: best known tactic per situation. */
  summary(): { ctx: string; tactic: Tactic; mean: number; n: number }[] {
    const out: { ctx: string; tactic: Tactic; mean: number; n: number }[] = [];
    for (const [k, row] of this.table) {
      let bt: Tactic | null = null;
      let bm = -Infinity;
      let bn = 0;
      for (const [t, s] of row) {
        const m = s.sum / s.n;
        if (s.n >= 2 && m > bm) {
          bm = m;
          bt = t;
          bn = s.n;
        }
      }
      if (bt) out.push({ ctx: k, tactic: bt, mean: Math.round(bm * 100) / 100, n: bn });
    }
    return out.sort((a, b) => b.n - a.n);
  }
}
