// src/bot/pursuit.ts
//
// Long-range pursuit of a moving target. Re-planning the full path every time
// the target moves a few blocks starves A* on long routes: a bot 370 blocks
// away recomputed forever and never took a step. Instead:
//
//   far (> 64 blocks)   walk 48-block waypoints along the bearing to where he
//                       will be; re-aim only when the bearing swings > 25° or
//                       the waypoint is reached
//   near (≤ 64)         head for his predicted position; re-plan only when it
//                       has moved more than max(3, 10% of the distance)
//   in water            the pathfinder cannot plan swims: the Swimmer takes over
//                       (air management, underwater sprint-swim, climbing out)
//   stuck               no ≥ 2-block progress for 6 s: try an ender-pearl hop
//                       toward him; otherwise detour ±60° for a few seconds;
//                       after repeated stalls (caves, cliffs) switch to short
//                       12-block routes with more patience, i.e. tunnel out
//   pinned              routes found but the bot has not moved 1.5 blocks in
//                       60 s: the client disagrees with the server; rejoin
//
// Progress, not motion, is what counts: walking in circles is stuck too.

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import pkg from "mineflayer-pathfinder";
import { Swimmer } from "./swim.js";

const { goals } = pkg;

const FAR = 64;
const WAYPOINT = 32;
const STUCK_MS = 6000;
const TUNNEL_STUCK_MS = 12_000;
const TUNNEL_STEP = 12;
const DETOUR_MS = 4000;
// The pathfinder reports "not moving" while it is still computing a route, and
// with five bots on one thread it gets only a few ms per tick: a hard 30-block
// route can take many seconds. Its own path_update event says when a search
// ended (success / partial / timeout / noPath); until then, let it run, up to
// SEARCH_MAX_MS, instead of cancelling it with a re-issue or a detour.
const SEARCH_MAX_MS = 15_000;

export interface PursuitHooks {
  /** Try a pearl hop toward a point; true if a throw was started. */
  hop?: (point: Vec3) => boolean;
  /** Last resort when pinned in place: reconnect for a fresh client. */
  rejoin?: () => boolean;
  log?: (msg: string) => void;
}

const bearing = (from: Vec3, to: Vec3) => Math.atan2(to.z - from.z, to.x - from.x);
const angleDiff = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
const flat = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

export class Pursuit {
  private goalPoint: Vec3 | null = null;
  private goalBearing = 0;
  private best = Infinity;
  private bestAt = Date.now();
  private detourUntil = 0;
  private detourSide = 1;
  private lastSetAt = 0;
  private swimming = false;
  /** Shared with the hunter, which also swims in fights. */
  readonly swimmer: Swimmer;
  private lastPathAt = 0;
  private noPath = false;
  /** Consecutive stalls without progress; ≥ 2 means short tunnelling steps. */
  private stalls = 0;
  private anchor: { p: Vec3; at: number } | null = null;

  constructor(
    private readonly bot: Bot,
    private readonly hooks: PursuitHooks = {},
  ) {
    this.swimmer = new Swimmer(bot);
    bot.on("path_update" as never, ((r: { status: string; path?: unknown[]; visitedNodes?: number; time?: number }) => {
      this.lastPathAt = Date.now();
      this.noPath = r.status === "noPath";
      if (process.env.PURSUIT_DEBUG === "true") {
        const at = bot.entity?.position;
        const feet = at ? bot.blockAt(at.floored()) : null;
        const below = at ? bot.blockAt(at.floored().offset(0, -1, 0)) : null;
        hooks.log?.(
          `path ${r.status}: ${r.path?.length ?? 0} steps, ${r.visitedNodes ?? "?"} nodes, ${r.time?.toFixed?.(0) ?? "?"} ms; ` +
            `at ${at?.floored()} feet=${feet?.name} below=${below?.name} goal=${JSON.stringify(bot.pathfinder.goal ?? null)?.slice(0, 60)}`,
        );
      }
    }) as never);
  }

  /** A search started by our last goal is still running (and not hopelessly long). */
  private searching(now: number): boolean {
    return this.lastPathAt < this.lastSetAt && now - this.lastSetAt < SEARCH_MAX_MS;
  }

  /** Forget the current route (e.g. after melee, a teleport, or a tactic took over). */
  reset(): void {
    this.stopSwimming();
    this.goalPoint = null;
    this.best = Infinity;
    this.bestAt = Date.now();
    this.detourUntil = 0;
    this.stalls = 0;
    this.anchor = null;
  }

  /** One pursuit step toward `aim` (his predicted position). Call every tick while not in melee. */
  step(aim: Vec3): void {
    const me = this.bot.entity?.position;
    if (!me) return;
    const now = Date.now();
    const dist = flat(me, aim);

    // Pinned: has not moved at all for a minute while stalling.
    if (!this.anchor || this.anchor.p.distanceTo(me) > 1.5) this.anchor = { p: me.clone(), at: now };
    else if (this.stalls >= 3 && now - this.anchor.at > 60_000) {
      this.anchor = { p: me.clone(), at: now };
      if (this.hooks.rejoin?.()) {
        this.hooks.log?.(`pinned at ${me.floored()} for 60 s: rejoining for a fresh client`);
        return;
      }
    }

    // Progress watchdog: no progress and no search in flight, or a definite "no route".
    const tunnelling = this.stalls >= 2;
    const patience = tunnelling ? TUNNEL_STUCK_MS : STUCK_MS;
    if (dist < this.best - 2) {
      this.best = dist;
      this.bestAt = now;
      this.stalls = 0;
    } else if ((this.noPath || (now - this.bestAt > patience && !this.searching(now))) && now > this.detourUntil) {
      this.noPath = false;
      this.bestAt = now;
      this.best = dist;
      this.stalls++;
      if (this.stalls >= 2) {
        // Tunnel: a short route straight along the bearing is cheap to plan,
        // even when every step needs digging.
        const b = bearing(me, aim);
        this.setXZ(new Vec3(me.x + Math.cos(b) * TUNNEL_STEP, me.y, me.z + Math.sin(b) * TUNNEL_STEP), 2);
        this.hooks.log?.(`stuck ${dist.toFixed(0)} blocks out (${this.stalls} stalls): tunnelling in ${TUNNEL_STEP}-block steps`);
        if (this.stalls % 3 !== 0) return; // every third stall, also try a hop
      }
      if (this.hooks.hop?.(this.hopPoint(me, aim, dist))) {
        this.hooks.log?.(`stuck ${dist.toFixed(0)} blocks out: pearl hop`);
        this.goalPoint = null;
        return;
      }
      if (this.stalls >= 2) return;
      this.detourSide = -this.detourSide;
      this.detourUntil = now + DETOUR_MS;
      const b = bearing(me, aim) + (this.detourSide * Math.PI) / 3;
      const p = new Vec3(me.x + Math.cos(b) * 16, me.y, me.z + Math.sin(b) * 16);
      this.setXZ(p, 3);
      this.hooks.log?.(`stuck ${dist.toFixed(0)} blocks out: detour ${this.detourSide > 0 ? "left" : "right"}`);
      return;
    }
    if (now < this.detourUntil) return; // let the detour play out

    if (this.swimmer.inWater()) {
      if (!this.swimming) {
        this.swimming = true;
        this.bot.pathfinder.setGoal(null);
        this.goalPoint = null;
      }
      this.swimmer.step(aim);
      return;
    }
    this.stopSwimming();

    const pf = this.bot.pathfinder;
    const idle = !pf.isMoving() && !this.searching(now) && now - this.lastSetAt > 1000;
    if (dist > FAR) {
      const b = bearing(me, aim);
      const reached = this.goalPoint ? flat(me, this.goalPoint) < 8 : true;
      if (!this.goalPoint || reached || angleDiff(b, this.goalBearing) > (25 * Math.PI) / 180 || idle) {
        this.goalBearing = b;
        const step = tunnelling ? TUNNEL_STEP : WAYPOINT;
        this.setXZ(new Vec3(me.x + Math.cos(b) * step, me.y, me.z + Math.sin(b) * step), tunnelling ? 2 : 6);
      }
      return;
    }
    const moved = this.goalPoint ? this.goalPoint.distanceTo(aim) : Infinity;
    if (moved > Math.max(3, dist * 0.1) || idle) {
      this.goalPoint = aim.clone();
      this.lastSetAt = now;
      pf.setGoal(new goals.GoalNear(aim.x, aim.y, aim.z, 2));
    }
  }

  /** Far out, hop toward him: up to ~35 blocks along the bearing at our own height. */
  private hopPoint(me: Vec3, aim: Vec3, dist: number): Vec3 {
    if (dist <= 35) return aim.clone();
    const b = bearing(me, aim);
    return new Vec3(me.x + Math.cos(b) * 35, me.y, me.z + Math.sin(b) * 35);
  }

  private stopSwimming(): void {
    if (!this.swimming) return;
    this.swimming = false;
    this.swimmer.stop();
  }

  private setXZ(p: Vec3, range: number): void {
    this.goalPoint = p;
    this.lastSetAt = Date.now();
    this.bot.pathfinder.setGoal(new goals.GoalNearXZ(p.x, p.z, range));
  }
}
