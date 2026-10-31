// src/learn/combat-learner.ts
//
// Online reinforcement learning for player combat: tabular Q-learning over a
// small discrete state space and a menu of fighting tactics. Every bot in a
// squad process shares one Q-table, so each fight anyone has trains everyone.
//
//   state  = (distance bucket, own health bucket, target shielding?,
//             height difference, allies near the target)        270 states
//   action = one tactic held for a ~1.2 s decision window             8 tactics
//   reward = hits landed − damage taken + closing distance + kill/death bonus
//   update = Q(s,a) += α · (r + γ · max_a' Q(s',a') − Q(s,a)),  ε-greedy choice
//
// Persisted to logs/learning/combat-q-<squad>.json; every decision is appended
// to combat-experience-<squad>.jsonl so learning can be audited and replayed.

import fs from "node:fs";
import path from "node:path";

export const TACTICS = ["rush", "crit", "wtap", "shield", "strafe", "retreat", "pearl_close", "pearl_escape"] as const;
export type Tactic = (typeof TACTICS)[number];

export const TACTIC_INFO: Record<Tactic, string> = {
  rush: "sprint straight in, swing on full cooldown",
  crit: "jump and hit while falling: 1.5x critical damage",
  wtap: "sprint-hit then release for extra knockback",
  shield: "advance behind a raised shield, drop it to swing",
  strafe: "circle-strafe while swinging, harder to hit",
  retreat: "back off to regenerate",
  pearl_close: "throw an ender pearl to land next to the target",
  pearl_escape: "throw an ender pearl away from the target",
};

export interface CombatState {
  dist: number; // blocks to target
  hp: number; // own health 0..20
  targetShielding: boolean;
  dy: number; // target y − own y
  alliesNearTarget: number;
}

export interface Experience {
  ts: string;
  bot: string;
  state: string;
  tactic: Tactic;
  explored: boolean;
  epsilon: number;
  reward: number;
  hits: number;
  damageTaken: number;
  closed: number;
  terminal: string | null;
}

const ALPHA = 0.2;
const GAMMA = 0.6;
const EPS_START = 0.35;
const EPS_MIN = 0.05;
const EPS_DECAY = 0.996; // per update

/** Discretize a raw combat state into its table key. */
export function stateKey(s: CombatState): string {
  const d = s.dist <= 3 ? 0 : s.dist <= 6 ? 1 : s.dist <= 12 ? 2 : s.dist <= 24 ? 3 : 4;
  const hp = s.hp <= 6 ? 0 : s.hp <= 12 ? 1 : 2;
  const sh = s.targetShielding ? 1 : 0;
  const h = s.dy < -1.5 ? 0 : s.dy > 1.5 ? 2 : 1;
  const al = s.alliesNearTarget === 0 ? 0 : s.alliesNearTarget <= 2 ? 1 : 2;
  return `d${d}.hp${hp}.sh${sh}.h${h}.al${al}`;
}

/** Tactics that make sense in a state with the bot's current kit. */
export function availableTactics(s: CombatState, pearls: number, hasShield: boolean): Tactic[] {
  return TACTICS.filter((t) => {
    if (t === "pearl_close") return pearls > 0 && s.dist >= 8 && s.dist <= 40;
    if (t === "pearl_escape") return pearls > 0 && s.hp <= 8 && s.dist <= 8;
    if (t === "shield") return hasShield && s.dist <= 8;
    if (t === "crit" || t === "wtap" || t === "strafe") return s.dist <= 8;
    return true;
  });
}

interface Table {
  q: Record<string, Partial<Record<Tactic, number>>>;
  n: Record<string, Partial<Record<Tactic, number>>>;
  updates: number;
  /** Mean reward of each block of 25 consecutive updates: the learning curve. */
  curve: number[];
  pending: number[];
  tacticStats: Partial<Record<Tactic, { uses: number; hits: number; reward: number }>>;
  kills: number;
  deaths: number;
}

export class CombatLearner {
  private t: Table;
  private dirty = false;
  readonly file: string;
  readonly logFile: string;

  constructor(readonly squad: string, dir = path.join("logs", "learning")) {
    this.file = path.join(dir, `combat-q-${squad}.json`);
    this.logFile = path.join(dir, `combat-experience-${squad}.jsonl`);
    this.t = { q: {}, n: {}, updates: 0, curve: [], pending: [], tacticStats: {}, kills: 0, deaths: 0 };
    try {
      this.t = { ...this.t, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } catch {
      /* first run: empty table */
    }
    fs.mkdirSync(dir, { recursive: true });
  }

  get epsilon(): number {
    return Math.max(EPS_MIN, EPS_START * Math.pow(EPS_DECAY, this.t.updates));
  }

  q(key: string, a: Tactic): number {
    return this.t.q[key]?.[a] ?? 0;
  }

  /** ε-greedy choice; untried tactics are preferred during exploration. */
  choose(s: CombatState, options: Tactic[], rand = Math.random): { tactic: Tactic; explored: boolean } {
    const key = stateKey(s);
    if (rand() < this.epsilon) {
      const untried = options.filter((a) => !this.t.n[key]?.[a]);
      const pool = untried.length ? untried : options;
      return { tactic: pool[Math.floor(rand() * pool.length)], explored: true };
    }
    let best = options[0];
    for (const a of options) if (this.q(key, a) > this.q(key, best)) best = a;
    return { tactic: best, explored: false };
  }

  /** One temporal-difference update. `next` null = terminal (kill or death). */
  update(s: CombatState, a: Tactic, reward: number, next: CombatState | null, nextOptions: Tactic[]): void {
    const key = stateKey(s);
    const future = next ? Math.max(0, ...nextOptions.map((o) => this.q(stateKey(next), o))) : 0;
    const old = this.q(key, a);
    (this.t.q[key] ??= {})[a] = old + ALPHA * (reward + GAMMA * future - old);
    (this.t.n[key] ??= {})[a] = (this.t.n[key]?.[a] ?? 0) + 1;
    this.t.updates++;
    this.t.pending.push(reward);
    if (this.t.pending.length >= 25) {
      this.t.curve.push(this.t.pending.reduce((x, y) => x + y, 0) / this.t.pending.length);
      this.t.pending = [];
      if (this.t.curve.length > 400) this.t.curve.shift();
    }
    this.dirty = true;
  }

  record(exp: Experience): void {
    const st = (this.t.tacticStats[exp.tactic] ??= { uses: 0, hits: 0, reward: 0 });
    st.uses++;
    st.hits += exp.hits;
    st.reward += exp.reward;
    if (exp.terminal === "kill") this.t.kills++;
    if (exp.terminal === "death") this.t.deaths++;
    fs.appendFile(this.logFile, JSON.stringify(exp) + "\n", () => {});
  }

  save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.t));
    fs.renameSync(tmp, this.file);
  }

  /** What the dashboard shows: curve, per-tactic stats, and the greedy policy. */
  summary() {
    const tactics = TACTICS.map((name) => {
      const st = this.t.tacticStats[name] ?? { uses: 0, hits: 0, reward: 0 };
      return {
        name,
        info: TACTIC_INFO[name],
        uses: st.uses,
        hitsPerUse: st.uses ? st.hits / st.uses : 0,
        meanReward: st.uses ? st.reward / st.uses : 0,
      };
    });
    // Greedy tactic per distance bucket for a healthy bot, level ground, no allies, target not shielding.
    const policy = ["≤3", "3–6", "6–12", "12–24", ">24"].map((label, d) => {
      const key = `d${d}.hp2.sh0.h1.al0`;
      const row = this.t.q[key] ?? {};
      const best = (Object.entries(row) as [Tactic, number][]).sort((x, y) => y[1] - x[1])[0];
      return { dist: label, tactic: best?.[0] ?? null, q: best?.[1] ?? null };
    });
    return {
      updates: this.t.updates,
      epsilon: this.epsilon,
      statesVisited: Object.keys(this.t.n).length,
      kills: this.t.kills,
      deaths: this.t.deaths,
      curve: this.t.curve,
      tactics,
      policy,
    };
  }
}
