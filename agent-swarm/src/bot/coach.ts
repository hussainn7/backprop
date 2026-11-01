// src/bot/coach.ts
//
// Scores every bot's behaviour so good habits are reinforced and bad ones are caught early.
// Every 30 s the director measures what a bot did and turns it into a reward:
//   + progress     it got closer to its goal
//   - stalling     it hardly moved while it had no reason to wait
//   - dying        more so if it died while stalled (a stall that ended in a death is the worst outcome)
//   - not following  far from its squad's lead for too long (the team is not being listened to)
//   + staying with the team, + calling things out in chat
// The running score adapts how aggressively the bot is corrected: a bot that keeps stalling gets its
// stuck-timer shortened, and one that keeps drifting from the lead is regrouped sooner. All results go to
// logs/learning/behavior.jsonl so the history can be audited.

import fs from "node:fs";
import path from "node:path";

export interface Signals {
  moved: number; // blocks moved (horizontal) during the window
  closer: number; // blocks closer to its destination (negative = farther)
  intentionalWait: boolean; // crafting, waiting at a portal, near the lead: stillness is fine
  secondsFarFromLead: number; // seconds of this window spent beyond the regroup distance
  nearLead: boolean;
  died: boolean;
  diedWhileStalled: boolean;
  spoke: boolean; // said something useful to the team
}

export interface Reward {
  total: number;
  parts: Record<string, number>;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function reward(sig: Signals): Reward {
  const parts: Record<string, number> = {};
  parts.progress = clamp(sig.closer / 30, -1, 1);
  parts.stall = !sig.intentionalWait && sig.moved < 3 ? -1 : 0;
  parts.death = sig.died ? (sig.diedWhileStalled ? -5 : -2) : 0;
  parts.follow = sig.secondsFarFromLead > 20 ? -clamp(sig.secondsFarFromLead / 30, 0.3, 1) : sig.nearLead ? 0.3 : 0;
  parts.talk = sig.spoke ? 0.2 : 0;
  const total = Object.values(parts).reduce((a, b) => a + b, 0);
  return { total: Math.round(total * 100) / 100, parts };
}

export interface Adapt {
  stuckMs: number; // how long to stand still before an escape is tried
  regroupDistance: number; // how far from the lead before being brought back
}

const FILE = path.join("logs", "learning", "behavior.jsonl");

export class Coach {
  private score = new Map<string, number>(); // exponential moving average of the reward
  private stalls = new Map<string, number[]>(); // timestamps of recent stalls
  private far = new Map<string, number[]>(); // timestamps of recent not-following windows

  /** Record one 30 s window for a bot; returns the reward. */
  record(bot: string, sig: Signals, now = Date.now()): Reward {
    const r = reward(sig);
    this.score.set(bot, (this.score.get(bot) ?? 0) * 0.8 + r.total * 0.2);
    if (r.parts.stall < 0 || r.parts.death <= -5) this.push(this.stalls, bot, now);
    if (r.parts.follow < 0) this.push(this.far, bot, now);
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.appendFileSync(FILE, JSON.stringify({ bot, at: now, total: r.total, ...r.parts }) + String.fromCharCode(10));
    } catch {
      /* best effort */
    }
    return r;
  }

  private push(m: Map<string, number[]>, bot: string, now: number): void {
    const a = (m.get(bot) ?? []).filter((t) => now - t < 600_000);
    a.push(now);
    m.set(bot, a);
  }

  scoreOf(bot: string): number {
    return Math.round((this.score.get(bot) ?? 0) * 100) / 100;
  }

  /** More correction for a bot with a recent habit: 3+ stalls in 10 min halves its stuck timer; 3+ drifts shrink its leash. */
  adapt(bot: string, base: Adapt, now = Date.now()): Adapt {
    const stalls = (this.stalls.get(bot) ?? []).filter((t) => now - t < 600_000).length;
    const drifts = (this.far.get(bot) ?? []).filter((t) => now - t < 600_000).length;
    return {
      stuckMs: stalls >= 3 ? Math.max(8_000, base.stuckMs * 0.5) : base.stuckMs,
      regroupDistance: drifts >= 3 ? Math.max(60, base.regroupDistance * 0.6) : base.regroupDistance,
    };
  }
}
