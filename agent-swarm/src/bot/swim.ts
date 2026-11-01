// src/bot/swim.ts
//
// Swimming like a player, for hunters. The pathfinder plans poorly in water
// and the old fallback (face him, hold forward + sprint + jump) paddled on the
// surface at walking pace, never refilled air on purpose and could not climb
// out: 20 drownings and 14 deaths to Drowned in one session.
//
// Each step (called every 250 ms while in water), in priority order:
//   air       head under and air below ~40%: face straight up, swim up
//   shore     a 1-block ledge with headroom ahead: face it, jump and climb out
//   shallow   floor within reach under the feet: sprint-walk, hop
//   dive      deep water with air to spare: pitch down slightly and
//             sprint-swim underwater (≈2.5x faster than paddling)
//   paddle    otherwise: head up, jump-swim forward on the surface
// Air is refilled on the surface before diving again (porpoising).

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

const WATERY = new Set(["water", "bubble_column", "kelp", "kelp_plant", "seagrass", "tall_seagrass"]);
const MAX_AIR = 20;
const SURFACE_BELOW = 11; // surface when air drops under this (of 20): leave room to swim up from depth
const DIVE_ABOVE = 16; // dive again only with this much air

export type SwimMode = "air" | "shore" | "shallow" | "dive" | "paddle" | "dry";

export class Swimmer {
  private refilling = false;
  mode: SwimMode = "dry";

  constructor(private readonly bot: Bot) {}

  private block(p: Vec3) {
    return this.bot.blockAt?.(p.floored()) ?? null;
  }

  private isWater(p: Vec3): boolean {
    const b = this.block(p);
    if (!b) return false;
    return WATERY.has(b.name) || (b as unknown as { _properties?: { waterlogged?: boolean } })._properties?.waterlogged === true;
  }

  private solid(p: Vec3): boolean {
    return this.block(p)?.boundingBox === "block";
  }

  /** Feet or eyes in water. */
  inWater(): boolean {
    const p = this.bot.entity?.position;
    if (!p) return false;
    if ((this.bot.entity as unknown as { isInWater?: boolean }).isInWater) return true;
    return this.isWater(p) || this.isWater(p.offset(0, 1.62, 0));
  }

  private air(): number {
    const o = (this.bot as unknown as { oxygenLevel?: number }).oxygenLevel;
    return typeof o === "number" ? o : MAX_AIR;
  }

  /** Release the swimming controls (when back on land or handing over). */
  stop(): void {
    if (this.mode === "dry") return;
    this.mode = "dry";
    this.refilling = false;
    for (const c of ["forward", "sprint", "jump", "back", "left", "right"] as const) this.bot.setControlState(c, false);
  }

  /** One swimming step toward `target`. Returns false when not in water (nothing done). */
  step(target: Vec3): boolean {
    const before = this.mode;
    const done = this.stepInner(target);
    if (process.env.SWIM_DEBUG === "true" && this.mode !== before) {
      console.log(`[Swim] ${this.bot.username} ${before} -> ${this.mode} (air ${this.air()})`);
    }
    return done;
  }

  private stepInner(target: Vec3): boolean {
    const me = this.bot.entity?.position;
    if (!me || !this.inWater()) {
      this.stop();
      return false;
    }
    const dx = target.x - me.x;
    const dz = target.z - me.z;
    const len = Math.hypot(dx, dz) || 1;
    const fx = dx / len;
    const fz = dz / len;
    const yaw = Math.atan2(-dx, -dz);
    const headUnder = this.isWater(me.offset(0, 1.62, 0));
    const air = this.air();
    const set = (forward: boolean, sprint: boolean, jump: boolean) => {
      this.bot.setControlState("forward", forward);
      this.bot.setControlState("sprint", sprint);
      this.bot.setControlState("jump", jump);
    };

    // 1. Air.
    if (headUnder && air < SURFACE_BELOW) this.refilling = true;
    if (this.refilling && air >= MAX_AIR - 1) this.refilling = false;
    if (this.refilling && headUnder) {
      this.mode = "air";
      void this.bot.look(yaw, Math.PI / 2, true);
      set(false, false, true);
      return true;
    }

    // 2. Shore: a solid block ahead at water level with two blocks of air on top.
    const ahead = me.offset(fx * 1.2, 0, fz * 1.2);
    const ledge = this.solid(ahead) || this.solid(ahead.offset(0, 0.5, 0));
    const headroom = !this.solid(ahead.offset(0, 1, 0)) && !this.solid(ahead.offset(0, 2, 0));
    if (ledge && headroom && !headUnder) {
      this.mode = "shore";
      void this.bot.look(yaw, 0, true);
      set(true, false, true);
      return true;
    }

    // 3. Shallow: something to stand on right under the feet.
    const floor = this.solid(me.offset(0, -0.6, 0));
    if (floor && !headUnder) {
      this.mode = "shallow";
      void this.bot.look(yaw, 0, true);
      set(true, true, true);
      return true;
    }

    // 4. Dive: deep water and air to spare: sprint-swim underwater toward him,
    //    pitched so we neither sink to the floor nor breach the surface.
    const deep = this.isWater(me.offset(0, -1, 0)) && this.isWater(me.offset(0, -2, 0));
    if (deep && air >= DIVE_ABOVE && !this.refilling) {
      this.mode = "dive";
      const wantY = Math.min(target.y, me.y + 0.5); // never dive deeper than his level
      const pitch = Math.max(-0.35, Math.min(0.25, Math.atan2(wantY - me.y, len)));
      void this.bot.look(yaw, pitch, true);
      set(true, true, false);
      return true;
    }

    // 5. Paddle on the surface (also while refilling with the head already out).
    this.mode = "paddle";
    void this.bot.look(yaw, 0, true);
    set(true, true, true);
    return true;
  }
}
