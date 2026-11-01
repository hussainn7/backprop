// src/learn/ballistics.ts
//
// Projectile flight for aiming: per tick, position += velocity, then
// velocity *= drag, then velocity.y -= gravity. Solved for the low-arc pitch
// that passes a target at horizontal distance d and height dy (relative to the
// launch point's feet). Used for arrows; ender pearls use their own learned
// model in pearl-aim.ts.

export interface Projectile {
  speed: number; // blocks per tick at launch
  gravity: number; // blocks per tick², applied after drag
  drag: number; // velocity kept per tick
  launchHeight: number; // above the shooter's feet
}

/** A fully drawn bow: 3 blocks/tick, gravity 0.05, drag 0.99, from eye height. */
export const ARROW: Projectile = { speed: 3.0, gravity: 0.05, drag: 0.99, launchHeight: 1.52 };

const DEG = Math.PI / 180;

/** Flight path [forward, height] per tick until it passes height dy (or 200 ticks). */
export function flightPath(p: Projectile, pitch: number, dy: number, maxForward = 200): [number, number][] {
  const pts: [number, number][] = [[0, p.launchHeight]];
  let x = 0;
  let y = p.launchHeight;
  let vx = Math.cos(pitch) * p.speed;
  let vy = Math.sin(pitch) * p.speed;
  for (let t = 0; t < 200 && x < maxForward; t++) {
    const py = y;
    x += vx;
    y += vy;
    vx *= p.drag;
    vy = vy * p.drag - p.gravity;
    pts.push([x, y]);
    if (vy < 0 && py >= dy && y < dy) break; // coming down through the target height
  }
  return pts;
}

/** Height of the flight when it reaches horizontal distance d (null if it falls short). */
export function heightAt(p: Projectile, pitch: number, d: number): number | null {
  const path = flightPath(p, pitch, -1e9, d + 5);
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1];
    const [bx, by] = path[i];
    if (bx >= d) return ay + ((by - ay) * (d - ax)) / (bx - ax || 1);
  }
  return null;
}

/** Ticks of flight to reach horizontal distance d at this pitch. */
export function flightTicks(p: Projectile, pitch: number, d: number): number {
  const path = flightPath(p, pitch, -1e9, d + 5);
  const i = path.findIndex(([x]) => x >= d);
  return i < 0 ? path.length : i;
}

/**
 * Low-arc pitch (radians, up positive) whose flight passes (d, dy); null when
 * out of range. Height at distance d rises with pitch up to the max-range
 * angle, so scan upward for the first pitch that reaches dy, then bisect.
 */
export function solvePitch(p: Projectile, d: number, dy: number): number | null {
  let prev = -60 * DEG;
  let prevH = heightAt(p, prev, d);
  for (let deg = -59; deg <= 88; deg += 1) {
    const cur = deg * DEG;
    const h = heightAt(p, cur, d);
    if (prevH !== null && h !== null && prevH < dy && h >= dy) {
      let lo = prev;
      let hi = cur;
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2;
        const hm = heightAt(p, mid, d);
        if (hm !== null && hm >= dy) hi = mid;
        else lo = mid;
      }
      return (lo + hi) / 2;
    }
    prev = cur;
    prevH = h;
  }
  return null;
}
