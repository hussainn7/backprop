// src/learn/pearl-aim.ts
//
// Learned ender-pearl aiming: a physics prior plus an online-learned correction.
//
// 1. Physics prior. A thrown pearl leaves the eye at 1.5 blocks/tick, falls
//    0.03 blocks/tick² and keeps 99% of its velocity each tick. Simulating that
//    gives, for any pitch, where the pearl comes down; inverting it (search +
//    bisection) gives the low-arc pitch that should land on a target at
//    horizontal distance d and height difference dy.
// 2. Learned correction. The real game differs from the prior (tick order,
//    the thrower's own motion, hitting leaves, server-side spread). After every
//    throw we know the pitch used and where the bot actually landed, so we can
//    relabel the throw in hindsight: "to land THERE, the pitch needed was p",
//    while physics would have said p_phys(THERE). The residual p − p_phys is
//    the label for a recursive-least-squares regression on features of (d, dy).
//    Aim = p_phys(target) + correction(target).
//
// Every throw's landing error is recorded so the dashboard can show whether
// the aim actually improves. Persisted to logs/learning/pearl-aim-<squad>.json.

import fs from "node:fs";
import path from "node:path";

const SPEED = 1.5;
const GRAVITY = 0.03;
const DRAG = 0.99;
const EYE = 1.52; // launch height above the feet (eye height − 0.1)
const DEG = Math.PI / 180;

/** Horizontal distance where a pearl thrown at `pitch` comes down through height `dy` (relative to the feet). */
export function simulateRange(pitch: number, dy: number): number | null {
  let x = 0;
  let y = EYE;
  let vx = Math.cos(pitch) * SPEED;
  let vy = Math.sin(pitch) * SPEED;
  for (let tick = 0; tick < 400; tick++) {
    const py = y;
    x += vx;
    y += vy;
    vx *= DRAG;
    vy = vy * DRAG - GRAVITY;
    // First time the pearl passes the target height: coming down for targets
    // below the launch point, still rising for targets above it.
    if ((py - dy) * (y - dy) <= 0 && py !== dy) {
      const stepX = vx / DRAG;
      const f = (py - dy) / (py - y);
      return x - stepX + stepX * f; // interpolate inside the crossing tick
    }
    if (y < dy - 64) return null;
  }
  return null;
}

/** Flight path as [forward, height above the feet] per tick, up to where it passes height dy. */
export function trajectory(pitch: number, dy: number): [number, number][] {
  const pts: [number, number][] = [[0, EYE]];
  let x = 0;
  let y = EYE;
  let vx = Math.cos(pitch) * SPEED;
  let vy = Math.sin(pitch) * SPEED;
  for (let tick = 0; tick < 400; tick++) {
    const py = y;
    x += vx;
    y += vy;
    vx *= DRAG;
    vy = vy * DRAG - GRAVITY;
    pts.push([x, y]);
    if ((py - dy) * (y - dy) <= 0 && py !== dy) break;
    if (y < dy - 64) break;
  }
  return pts;
}

/**
 * Pitch (radians, positive = up) that physics says lands at (d, dy); null
 * when out of range. "low" is the flat, fast arc; "high" lobs over obstacles.
 * Range is not monotonic in pitch for targets above the thrower (some pitches
 * never reach that height), so scan for the first sign change between two
 * pitches that both reach it (upward for low, downward for high), then bisect.
 */
export function physicsPitch(d: number, dy: number, arc: "low" | "high" = "low"): number | null {
  const at = (p: number) => simulateRange(p, dy);
  const from = arc === "low" ? -40 : 85;
  const step = arc === "low" ? 0.5 : -0.5;
  let prevP = from * DEG;
  let prevR = at(prevP);
  for (let deg = from + step; arc === "low" ? deg <= 60 : deg >= 20; deg += step) {
    const p = deg * DEG;
    const r = at(p);
    if (prevR !== null && r !== null && (prevR - d) * (r - d) <= 0) {
      let lo = prevP;
      let hi = p;
      const loSign = Math.sign(prevR - d);
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        const rm = at(mid);
        if (rm === null) break;
        if (Math.sign(rm - d) === loSign) lo = mid;
        else hi = mid;
      }
      return (lo + hi) / 2;
    }
    prevP = p;
    prevR = r;
  }
  return null;
}

const features = (d: number, dy: number) => {
  const a = d / 32;
  const b = dy / 16;
  return [1, a, b, a * a, a * b];
};

interface Throw {
  t: string;
  bot: string;
  d: number;
  dy: number;
  /** Distance between the aimed-at point and where the bot landed. */
  err: number;
  lateral: number;
  correction: number;
  /** Hit something mid-flight (a tree, a wall): not evidence about the aim. */
  blocked?: boolean;
  arc?: "low" | "high";
}

interface ModelState {
  w: number[];
  P: number[][];
  throws: Throw[];
  samples: number;
}

/** Recursive least squares: exact online linear regression, one sample at a time. */
function rlsUpdate(m: ModelState, x: number[], y: number): void {
  const n = x.length;
  const Px = m.P.map((row) => row.reduce((s, v, j) => s + v * x[j], 0));
  const denom = 1 + x.reduce((s, v, i) => s + v * Px[i], 0);
  const k = Px.map((v) => v / denom);
  const err = y - m.w.reduce((s, v, i) => s + v * x[i], 0);
  m.w = m.w.map((v, i) => v + k[i] * err);
  const next: number[][] = [];
  for (let i = 0; i < n; i++) {
    next.push([]);
    for (let j = 0; j < n; j++) next[i].push(m.P[i][j] - k[i] * Px[j]);
  }
  m.P = next;
}

export class PearlAim {
  private m: ModelState;
  readonly file: string;

  constructor(readonly squad: string, dir = path.join("logs", "learning")) {
    this.file = path.join(dir, `pearl-aim-${squad}.json`);
    const n = 5;
    this.m = {
      w: new Array(n).fill(0),
      P: Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 10 : 0))),
      throws: [],
      samples: 0,
    };
    try {
      this.m = { ...this.m, ...JSON.parse(fs.readFileSync(this.file, "utf8")) };
    } catch {
      /* first run: pure physics */
    }
    fs.mkdirSync(dir, { recursive: true });
  }

  correction(d: number, dy: number): number {
    const x = features(d, dy);
    const c = this.m.w.reduce((s, v, i) => s + v * x[i], 0);
    return Math.max(-15 * DEG, Math.min(15 * DEG, c));
  }

  /** Pitch to throw at for a target d blocks away horizontally and dy above the feet. */
  aim(d: number, dy: number, arc: "low" | "high" = "low"): number | null {
    const p = physicsPitch(d, dy, arc);
    // The correction is learned from low-arc throws only; lobs fly on physics.
    return p === null ? null : arc === "low" ? p + this.correction(d, dy) : p;
  }

  /**
   * Learn from one throw: pitch used, the target, and where the bot landed,
   * all relative to the thrower's start (forward = along the throw's yaw).
   */
  learn(
    bot: string,
    pitch: number,
    target: { d: number; dy: number },
    landed: { forward: number; lateral: number; dy: number },
    arc: "low" | "high" = "low",
  ): void {
    // A free flight is explained by physics up to a few degrees. A pearl that
    // stopped on a trunk or wall mid-air gives an implausible hindsight label,
    // so it is recorded but never trained on.
    const relabel = physicsPitch(landed.forward, landed.dy, arc);
    const label = relabel === null ? null : pitch - relabel;
    const blocked = label === null || landed.forward <= 1 || Math.abs(label) > 8 * DEG;
    if (!blocked && arc === "low") {
      rlsUpdate(this.m, features(landed.forward, landed.dy), label!);
      this.m.samples++;
    }
    const err = Math.hypot(landed.forward - target.d, landed.lateral, landed.dy - target.dy);
    this.m.throws.push({
      t: new Date().toISOString(),
      bot,
      d: +target.d.toFixed(1),
      dy: +target.dy.toFixed(1),
      err: +err.toFixed(2),
      lateral: +landed.lateral.toFixed(2),
      correction: +(this.correction(target.d, target.dy) / DEG).toFixed(2),
      blocked,
      arc,
    });
    if (this.m.throws.length > 500) this.m.throws.shift();
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.m));
    fs.renameSync(tmp, this.file);
  }

  summary() {
    const errs = this.m.throws.filter((t) => !t.blocked).map((t) => t.err);
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    return {
      throws: this.m.throws.length,
      blocked: this.m.throws.filter((t) => t.blocked).length,
      samples: this.m.samples,
      errors: errs.slice(-60),
      meanErrFirst10: mean(errs.slice(0, 10)),
      meanErrLast10: mean(errs.slice(-10)),
      weights: this.m.w.map((v) => +v.toFixed(4)),
      recent: this.m.throws.slice(-5),
    };
  }
}
