// src/learn/combat-learner.ts
//
// Online reinforcement learning for player combat (v2): Q-learning with a
// linear function approximator over hand-designed state features, trained
// from every decision of every bot in the squad.
//
//   features φ(s) (22) = bias, distance bucket (5), own health (3), target
//            shielding, height difference (3), allies near target (3), target
//            motion relative to the bot (still / approaching / fleeing), target
//            busy fighting, hostile mob on the bot, a teammate calling for help
//   Q(s,a)  = w_a · φ(s)                       one weight vector per tactic
//   update  = w_a += (η/|φ|²) · (r + γ·max_a' Q(s',a') − Q(s,a)) · φ(s)
//             (semi-gradient Q-learning, normalized LMS step)
//   choice  = ε-greedy, ε(s) = max(0.05, 0.5/√(1+visits(s))) per discrete state
//
// v1 was a lookup table: every one of 270 situations had to be learned on its
// own. With features, "pearls are slow when he is already fighting" learned at
// 20 blocks also applies at 10. The reward (computed by the hunter) pays for
// team damage, so bots learn to commit together rather than solo.
//
// Persisted to logs/learning/combat-v2-<squad>.json; every decision is
// appended to combat-experience-v2-<squad>.jsonl.

import fs from "node:fs";
import path from "node:path";

export const TACTICS = ["rush", "crit", "wtap", "shield", "strafe", "retreat", "pearl_close", "pearl_escape", "defend", "backup"] as const;
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
  defend: "turn on the hostile mob hitting you and kill it",
  backup: "run to a teammate who called for help and fight beside them",
};

export type TargetMotion = "still" | "approaching" | "fleeing";

export interface CombatState {
  dist: number; // blocks to target
  hp: number; // own health 0..20
  targetShielding: boolean;
  dy: number; // target y − own y
  alliesNearTarget: number;
  targetMotion?: TargetMotion;
  /** He swung or was hit in the last 2 s, or a teammate is on him: he is fighting, not running. */
  targetBusy?: boolean;
  /** A hostile mob within 4 blocks of this bot. */
  mobAdjacent?: boolean;
  /** A teammate within 40 blocks has called for help (low health). */
  allyHurt?: boolean;
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
  teamHits: number;
  mobHits: number;
  damageTaken: number;
  closed: number;
  terminal: string | null;
}

const GAMMA = 0.8;
const ETA = 0.3; // normalized step size
const EPS_SCALE = 0.5;
const EPS_MIN = 0.05;

const distBucket = (d: number) => (d <= 3 ? 0 : d <= 6 ? 1 : d <= 12 ? 2 : d <= 24 ? 3 : 4);
const hpBucket = (hp: number) => (hp <= 6 ? 0 : hp <= 12 ? 1 : 2);
const heightBucket = (dy: number) => (dy < -1.5 ? 0 : dy > 1.5 ? 2 : 1);
const allyBucket = (n: number) => (n === 0 ? 0 : n <= 2 ? 1 : 2);
const motionIndex = (m: TargetMotion | undefined) => (m === "approaching" ? 1 : m === "fleeing" ? 2 : 0);

export const FEATURE_NAMES = [
  "bias",
  "d≤3", "d3-6", "d6-12", "d12-24", "d>24",
  "hp≤6", "hp≤12", "hp>12",
  "shielding",
  "below", "level", "above",
  "allies0", "allies1-2", "allies3+",
  "still", "approaching", "fleeing",
  "busy",
  "mob",
  "ally hurt",
];

/** Feature vector φ(s): one-hot buckets plus binary flags. */
export function features(s: CombatState): number[] {
  const f = new Array(FEATURE_NAMES.length).fill(0);
  f[0] = 1;
  f[1 + distBucket(s.dist)] = 1;
  f[6 + hpBucket(s.hp)] = 1;
  f[9] = s.targetShielding ? 1 : 0;
  f[10 + heightBucket(s.dy)] = 1;
  f[13 + allyBucket(s.alliesNearTarget)] = 1;
  f[16 + motionIndex(s.targetMotion)] = 1;
  f[19] = s.targetBusy ? 1 : 0;
  f[20] = s.mobAdjacent ? 1 : 0;
  f[21] = s.allyHurt ? 1 : 0;
  return f;
}

/** Discrete key, used for visit counts (exploration) and the dashboard. */
export function stateKey(s: CombatState): string {
  return (
    `d${distBucket(s.dist)}.hp${hpBucket(s.hp)}.sh${s.targetShielding ? 1 : 0}.h${heightBucket(s.dy)}` +
    `.al${allyBucket(s.alliesNearTarget)}.m${motionIndex(s.targetMotion)}.b${s.targetBusy ? 1 : 0}.mob${s.mobAdjacent ? 1 : 0}.help${s.allyHurt ? 1 : 0}`
  );
}

/** Tactics that are physically possible in a state with the bot's current kit. Which is GOOD is learned. */
export function availableTactics(s: CombatState, pearls: number, hasShield: boolean): Tactic[] {
  return TACTICS.filter((t) => {
    if (t === "pearl_close") return pearls > 0 && s.dist >= 8 && s.dist <= 40;
    if (t === "pearl_escape") return pearls > 0 && s.hp <= 8 && s.dist <= 8;
    if (t === "shield") return hasShield && s.dist <= 8;
    if (t === "crit" || t === "wtap" || t === "strafe") return s.dist <= 8;
    if (t === "defend") return !!s.mobAdjacent;
    if (t === "backup") return !!s.allyHurt;
    return true;
  });
}

interface Model {
  version: 2;
  w: Record<string, number[]>;
  visits: Record<string, number>;
  updates: number;
  /** Mean reward of each block of 25 consecutive updates: the learning curve. */
  curve: number[];
  pending: number[];
  tacticStats: Partial<Record<Tactic, { uses: number; hits: number; reward: number }>>;
  kills: number;
  deaths: number;
}

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

export class CombatLearner {
  private m: Model;
  private dirty = false;
  readonly file: string;
  readonly logFile: string;

  constructor(readonly squad: string, dir = path.join("logs", "learning")) {
    this.file = path.join(dir, `combat-v2-${squad}.json`);
    this.logFile = path.join(dir, `combat-experience-v2-${squad}.jsonl`);
    this.m = { version: 2, w: {}, visits: {}, updates: 0, curve: [], pending: [], tacticStats: {}, kills: 0, deaths: 0 };
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (saved.version === 2) this.m = { ...this.m, ...saved };
    } catch {
      /* first run: all weights zero */
    }
    fs.mkdirSync(dir, { recursive: true });
  }

  private weights(a: Tactic): number[] {
    let w = this.m.w[a];
    if (!w) w = this.m.w[a] = new Array(FEATURE_NAMES.length).fill(0);
    // A feature added later starts at weight 0; everything already learned is kept.
    while (w.length < FEATURE_NAMES.length) w.push(0);
    return w;
  }

  q(s: CombatState, a: Tactic): number {
    return dot(this.weights(a), features(s));
  }

  visits(key: string): number {
    return this.m.visits[key] ?? 0;
  }

  stateEpsilon(key: string): number {
    return Math.max(EPS_MIN, EPS_SCALE / Math.sqrt(1 + this.visits(key)));
  }

  /** Visit-weighted mean ε over states seen so far (what the bots currently experience). */
  get epsilon(): number {
    const keys = Object.keys(this.m.visits);
    const total = keys.reduce((a, k) => a + this.visits(k), 0);
    if (!total) return EPS_SCALE;
    return keys.reduce((a, k) => a + this.visits(k) * this.stateEpsilon(k), 0) / total;
  }

  /** ε-greedy: explore uniformly with probability ε(s), else the highest Q. */
  choose(s: CombatState, options: Tactic[], rand = Math.random): { tactic: Tactic; explored: boolean } {
    const key = stateKey(s);
    this.m.visits[key] = this.visits(key) + 1;
    if (rand() < this.stateEpsilon(key)) return { tactic: options[Math.floor(rand() * options.length)], explored: true };
    let best = options[0];
    for (const a of options) if (this.q(s, a) > this.q(s, best)) best = a;
    return { tactic: best, explored: false };
  }

  /** One semi-gradient TD update. `next` null = terminal (kill or death). */
  update(s: CombatState, a: Tactic, reward: number, next: CombatState | null, nextOptions: Tactic[]): void {
    const phi = features(s);
    const future = next && nextOptions.length ? Math.max(...nextOptions.map((o) => this.q(next, o))) : 0;
    const w = this.weights(a);
    const td = reward + GAMMA * future - dot(w, phi);
    const norm = phi.reduce((x, v) => x + v * v, 0) || 1;
    for (let i = 0; i < w.length; i++) w[i] += (ETA / norm) * td * phi[i];
    this.m.updates++;
    this.m.pending.push(reward);
    if (this.m.pending.length >= 25) {
      this.m.curve.push(this.m.pending.reduce((x, y) => x + y, 0) / this.m.pending.length);
      this.m.pending = [];
      if (this.m.curve.length > 400) this.m.curve.shift();
    }
    this.dirty = true;
  }

  record(exp: Experience): void {
    const st = (this.m.tacticStats[exp.tactic] ??= { uses: 0, hits: 0, reward: 0 });
    st.uses++;
    st.hits += exp.hits;
    st.reward += exp.reward;
    if (exp.terminal === "kill") this.m.kills++;
    if (exp.terminal === "death") this.m.deaths++;
    fs.appendFile(this.logFile, JSON.stringify(exp) + "\n", () => {});
  }

  save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.m));
    fs.renameSync(tmp, this.file);
  }

  /** What the dashboard shows: curve, per-tactic stats, learned policy and weights. */
  summary() {
    const tactics = TACTICS.map((name) => {
      const st = this.m.tacticStats[name] ?? { uses: 0, hits: 0, reward: 0 };
      return { name, info: TACTIC_INFO[name], uses: st.uses, hitsPerUse: st.uses ? st.hits / st.uses : 0, meanReward: st.uses ? st.reward / st.uses : 0 };
    });
    // Greedy tactic per distance for a healthy bot on level ground, with him
    // (a) standing his ground while fighting a teammate, (b) running away.
    const policy = ["≤3", "3–6", "6–12", "12–24", ">24"].flatMap((label, i) => {
      const dist = [2, 5, 9, 18, 30][i];
      return (
        [
          ["fighting", { targetBusy: true, targetMotion: "still", alliesNearTarget: 1 }],
          ["fleeing", { targetBusy: false, targetMotion: "fleeing", alliesNearTarget: 0 }],
        ] as const
      ).map(([situation, extra]) => {
        const s: CombatState = { dist, hp: 20, targetShielding: false, dy: 0, ...extra };
        const opts = availableTactics(s, 16, true);
        const best = opts.reduce((x, y) => (this.q(s, y) > this.q(s, x) ? y : x));
        return { dist: label, situation, tactic: this.m.updates ? best : null, q: this.m.updates ? this.q(s, best) : null };
      });
    });
    // The most telling learned weights: what each feature does to each tactic's value.
    const weights = Object.fromEntries(TACTICS.map((t) => [t, Object.fromEntries(FEATURE_NAMES.map((f, i) => [f, +this.weights(t)[i].toFixed(3)]))]));
    return {
      model: `linear Q (${FEATURE_NAMES.length} features × ${TACTICS.length} tactics)`,
      updates: this.m.updates,
      epsilon: this.epsilon,
      statesVisited: Object.keys(this.m.visits).length,
      kills: this.m.kills,
      deaths: this.m.deaths,
      curve: this.m.curve,
      tactics,
      policy,
      weights,
    };
  }
}
