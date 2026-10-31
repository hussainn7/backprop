// src/llm/budget.ts
// Spend ledger, caps, pacing and rate limiting for paid LLM APIs (Anthropic).
// Everything is computed from the provider's own usage numbers, never estimated
// from text length. State lives in logs/api-usage.json so caps survive restarts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "../project-root.js";

const ROOT = resolveProjectRoot(path.dirname(fileURLToPath(import.meta.url)));
const projectPath = (...parts: string[]) => path.join(ROOT, ...parts);

/** USD per million tokens. Cache write = 5-minute TTL write (1.25x input). */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// First-party Claude API rates (cached 2026-10-06). Haiku 5.5 doubles above
// 100K prompt tokens; our prompts are ~3-6K, so the base tier applies — we
// still price the long tier in case a prompt ever grows past it.
export const PRICES: Record<string, ModelPrice> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  "claude-sonnet-5-5": { input: 2.0, output: 10.0, cacheWrite: 2.5, cacheRead: 0.2 },
};
const HAIKU_LONG = { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 };

export interface UsageNumbers {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export function costFor(model: string, u: UsageNumbers): number {
  let p = PRICES[model];
  if (!p) throw new Error(`No price for model ${model} — add it to PRICES before using it`);
  const promptTokens = u.inputTokens + u.cacheCreationTokens + u.cacheReadTokens;
  if (model === "claude-haiku-5-5" && promptTokens > 100_000) p = HAIKU_LONG;
  return (
    (u.inputTokens * p.input +
      u.outputTokens * p.output +
      u.cacheCreationTokens * p.cacheWrite +
      u.cacheReadTokens * p.cacheRead) /
    1_000_000
  );
}

export interface Bucket extends UsageNumbers {
  calls: number;
  errors: number;
  costUsd: number;
}

const emptyBucket = (): Bucket => ({
  calls: 0,
  errors: 0,
  costUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
});

export interface Ledger {
  day: string; // local date YYYY-MM-DD
  today: Bucket;
  todayByBot: Record<string, Bucket>;
  todayByModel: Record<string, Bucket>;
  lifetime: Bucket;
  lifetimeByBot: Record<string, Bucket>;
  history: Record<string, number>; // day -> cost
  pausedReason: string | null;
  updatedAt: string;
}

const LEDGER_FILE = projectPath("logs", "api-usage.json");
const CALL_LOG = projectPath("logs", "api-calls.jsonl");

function localDay(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export const budgetConfig = {
  /** Hard cap per local calendar day. */
  get dailyCapUsd() {
    return num("ANTHROPIC_DAILY_CAP_USD", 2);
  },
  /** Hard lifetime cap — the testing budget. Raise it deliberately once trusted. */
  get totalCapUsd() {
    return num("ANTHROPIC_TOTAL_CAP_USD", 5);
  },
  /** Fraction of the daily cap that may be spent ahead of an even pace. */
  get burstFraction() {
    return num("ANTHROPIC_PACING_BURST", 0.15);
  },
  get maxRequestsPerMinute() {
    return num("ANTHROPIC_MAX_RPM", 20);
  },
};

let ledger: Ledger | null = null;

function freshLedger(prev?: Ledger): Ledger {
  return {
    day: localDay(),
    today: emptyBucket(),
    todayByBot: {},
    todayByModel: {},
    lifetime: prev?.lifetime ?? emptyBucket(),
    lifetimeByBot: prev?.lifetimeByBot ?? {},
    history: prev?.history ?? {},
    pausedReason: null,
    updatedAt: new Date().toISOString(),
  };
}

export function getLedger(): Ledger {
  if (!ledger) {
    try {
      ledger = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")) as Ledger;
    } catch {
      ledger = freshLedger();
    }
  }
  if (ledger.day !== localDay()) ledger = freshLedger(ledger);
  return ledger;
}

function save(): void {
  const l = getLedger();
  l.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
  const tmp = LEDGER_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(l, null, 2));
  fs.renameSync(tmp, LEDGER_FILE);
}

function add(b: Bucket, u: UsageNumbers, cost: number): void {
  b.calls++;
  b.costUsd += cost;
  b.inputTokens += u.inputTokens;
  b.outputTokens += u.outputTokens;
  b.cacheCreationTokens += u.cacheCreationTokens;
  b.cacheReadTokens += u.cacheReadTokens;
}

export function recordUsage(botId: string, model: string, source: string, u: UsageNumbers, durationMs: number): number {
  const cost = costFor(model, u);
  const l = getLedger();
  add(l.today, u, cost);
  add((l.todayByBot[botId] ??= emptyBucket()), u, cost);
  add((l.todayByModel[model] ??= emptyBucket()), u, cost);
  add(l.lifetime, u, cost);
  add((l.lifetimeByBot[botId] ??= emptyBucket()), u, cost);
  l.history[l.day] = l.today.costUsd;
  save();
  fs.appendFileSync(
    CALL_LOG,
    JSON.stringify({ ts: new Date().toISOString(), botId, model, source, ...u, costUsd: cost, durationMs }) + "\n",
  );
  return cost;
}

export function recordError(botId: string, model: string, source: string, error: string): void {
  const l = getLedger();
  l.today.errors++;
  (l.todayByBot[botId] ??= emptyBucket()).errors++;
  save();
  fs.appendFileSync(
    CALL_LOG,
    JSON.stringify({ ts: new Date().toISOString(), botId, model, source, error: error.slice(0, 300) }) + "\n",
  );
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/**
 * Throws when a call may not be made. Hard caps block everything; the pacing
 * check (spend ahead of an even daily schedule) blocks only deferrable calls,
 * so reactive survival decisions keep working until the hard cap.
 * The estimate covers the worst case of the call about to be made.
 */
export function assertCanSpend(estimateUsd: number, deferrable: boolean): void {
  const l = getLedger();
  const { dailyCapUsd, totalCapUsd, burstFraction } = budgetConfig;
  let reason: string | null = null;
  if (l.lifetime.costUsd + estimateUsd > totalCapUsd) {
    reason = `lifetime cap $${totalCapUsd.toFixed(2)} reached ($${l.lifetime.costUsd.toFixed(4)} spent)`;
  } else if (l.today.costUsd + estimateUsd > dailyCapUsd) {
    reason = `daily cap $${dailyCapUsd.toFixed(2)} reached ($${l.today.costUsd.toFixed(4)} spent today)`;
  }
  if (reason) {
    if (l.pausedReason !== reason) {
      l.pausedReason = reason;
      save();
      console.warn(`[Budget] API PAUSED — ${reason}. Bots fall back to idle + deterministic reflexes.`);
    }
    throw new BudgetExceededError(reason);
  }
  if (l.pausedReason) {
    l.pausedReason = null;
    save();
  }
  if (deferrable) {
    const now = new Date();
    const fraction = (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86_400;
    const allowed = dailyCapUsd * (fraction + burstFraction);
    if (l.today.costUsd + estimateUsd > allowed) {
      throw new BudgetExceededError(
        `paced: $${l.today.costUsd.toFixed(4)} spent, $${allowed.toFixed(4)} allowed by ${now.toTimeString().slice(0, 5)}`,
      );
    }
  }
}

// ── Rate limiting ───────────────────────────────────────────────────────────
// Sliding one-minute window shared by every bot in this process. Callers wait
// for a slot instead of failing, so bursts from five bots queue up politely.

const recentStarts: number[] = [];
let chain: Promise<void> = Promise.resolve();

export function acquireRateSlot(): Promise<void> {
  const next = chain.then(async () => {
    for (;;) {
      const now = Date.now();
      while (recentStarts.length && now - recentStarts[0] > 60_000) recentStarts.shift();
      if (recentStarts.length < Math.max(1, budgetConfig.maxRequestsPerMinute)) {
        recentStarts.push(now);
        return;
      }
      await new Promise((r) => setTimeout(r, 60_000 - (now - recentStarts[0]) + 50));
    }
  });
  chain = next.catch(() => {});
  return next;
}
