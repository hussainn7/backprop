// src/llm/anthropic.ts
// Native Anthropic Messages API transport (official SDK) for LLM_PROVIDER=anthropic.
//
// Routing: every call goes to the fast model (Haiku) except a strategic call
// that is due for a periodic replan, which is upgraded to the planner model
// (Sonnet) at most once per ANTHROPIC_PLANNER_INTERVAL_MIN per bot, and only
// while today's spend is under ANTHROPIC_PLANNER_MAX_SHARE of the daily cap.
// Spend is capped, paced and logged in budget.ts. Keys are read from the
// environment by the SDK and never logged.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { resolveProjectRoot } from "../project-root.js";
import type { ChatRequest, ProviderTransportResult } from "./provider.js";
import {
  acquireRateSlot,
  assertCanSpend,
  budgetConfig,
  costFor,
  getLedger,
  recordError,
  recordUsage,
  type UsageNumbers,
} from "./budget.js";

export const anthropicConfig = {
  fastModel: process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-5-5",
  plannerModel: process.env.ANTHROPIC_PLANNER_MODEL || "claude-sonnet-5-5",
  plannerIntervalMs: Number(process.env.ANTHROPIC_PLANNER_INTERVAL_MIN || "120") * 60_000,
  plannerMaxShare: Number(process.env.ANTHROPIC_PLANNER_MAX_SHARE || "0.35"),
  maxAttempts: Number(process.env.ANTHROPIC_MAX_ATTEMPTS || "5"),
  haikuStrategicThinking: process.env.ANTHROPIC_HAIKU_STRATEGIC_THINKING !== "false",
};

const JSON_RULE =
  "\n\nOUTPUT FORMAT: reply with exactly one JSON object and nothing else — no prose, no markdown fences.";

let client: Anthropic | null = null;
function getClient(): Anthropic {
  // Retries are ours (budget-aware backoff), so the SDK's are off.
  client ??= new Anthropic({ maxRetries: 0, timeout: 60_000 });
  return client;
}

// Persisted so an agent restart doesn't trigger a fresh Sonnet call per bot.
const PLANNER_STATE = path.join(
  resolveProjectRoot(path.dirname(fileURLToPath(import.meta.url))),
  "logs",
  "planner-state.json",
);
const lastPlannerCall = new Map<string, number>(
  Object.entries(
    (() => {
      try {
        return JSON.parse(fs.readFileSync(PLANNER_STATE, "utf8")) as Record<string, number>;
      } catch {
        return {};
      }
    })(),
  ),
);

/** Which model serves this request. Exported for tests. */
export function pickModel(req: ChatRequest, now = Date.now()): string {
  const botId = req.telemetry?.botId ?? "unknown";
  if (req.telemetry?.source !== "strategic" || anthropicConfig.plannerIntervalMs <= 0) return anthropicConfig.fastModel;
  const last = lastPlannerCall.get(botId) ?? 0;
  const today = getLedger().today.costUsd;
  if (now - last < anthropicConfig.plannerIntervalMs) return anthropicConfig.fastModel;
  if (today > budgetConfig.dailyCapUsd * anthropicConfig.plannerMaxShare) return anthropicConfig.fastModel;
  lastPlannerCall.set(botId, now);
  try {
    fs.writeFileSync(PLANNER_STATE, JSON.stringify(Object.fromEntries(lastPlannerCall)));
  } catch {
    /* best effort */
  }
  return anthropicConfig.plannerModel;
}

/** Convert the codebase's Ollama-shaped messages into a Messages API request. */
export function toAnthropicRequest(req: ChatRequest, model: string): Anthropic.MessageCreateParamsNonStreaming {
  const systemText = req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns: Anthropic.MessageParam[] = [];
  for (const m of req.messages) {
    if (m.role === "system" || !m.content.trim()) continue;
    const prev = turns[turns.length - 1];
    if (prev && prev.role === m.role) prev.content = `${prev.content as string}\n\n${m.content}`;
    else turns.push({ role: m.role, content: m.content });
  }
  // The API needs a leading user turn and no trailing assistant turn (no prefill).
  if (!turns.length || turns[0].role !== "user") turns.unshift({ role: "user", content: "(earlier context follows)" });
  if (turns[turns.length - 1].role !== "user") turns.push({ role: "user", content: "Continue. Respond with JSON." });

  const isPlanner = model === anthropicConfig.plannerModel;
  // Routine strategic plans on Haiku get a little thinking (cheap at Haiku
  // output prices); reactive/critic/chat stay instant.
  const thinkCheap = !isPlanner && req.telemetry?.source === "strategic" && anthropicConfig.haikuStrategicThinking;
  const maxTokens = isPlanner ? 4000 : thinkCheap ? 2048 : Math.max(256, Math.min(req.options?.num_predict ?? 512, 1024));
  const system = systemText + (req.format === "json" ? JSON_RULE : "");
  return {
    model,
    max_tokens: maxTokens,
    // Stable role prompt first with an explicit breakpoint; auto-caching covers the tail.
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    cache_control: { type: "ephemeral" },
    messages: turns,
    // Planner: think a little. Routine Haiku decisions: no thinking, low effort.
    ...(isPlanner || thinkCheap
      ? { thinking: { type: "adaptive" as const }, output_config: { effort: "low" as const } }
      : { thinking: { type: "disabled" as const }, output_config: { effort: "low" as const } }),
  };
}

function usageOf(msg: Anthropic.Message): UsageNumbers {
  return {
    inputTokens: msg.usage.input_tokens ?? 0,
    outputTokens: msg.usage.output_tokens ?? 0,
    cacheCreationTokens: msg.usage.cache_creation_input_tokens ?? 0,
    cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
  };
}

function retryDelayMs(error: unknown, attempt: number): number | null {
  if (error instanceof Anthropic.RateLimitError || error instanceof Anthropic.InternalServerError) {
    const header = Number((error as InstanceType<typeof Anthropic.APIError>).headers?.get?.("retry-after"));
    const base = Number.isFinite(header) && header > 0 ? header * 1000 : 2000 * 2 ** attempt;
    return Math.min(base, 120_000) + Math.random() * 1000;
  }
  if (error instanceof Anthropic.APIConnectionError) return Math.min(2000 * 2 ** attempt, 60_000) + Math.random() * 1000;
  if (error instanceof Anthropic.APIError && (error.status === 529 || error.status === 408)) {
    return Math.min(4000 * 2 ** attempt, 120_000);
  }
  return null; // 400/401/403/404 etc. — not retryable
}

/** Worst-case cost of a request, so the cap can never be overshot by a single call. */
function estimateUsd(params: Anthropic.MessageCreateParamsNonStreaming): number {
  const chars = JSON.stringify(params.system).length + JSON.stringify(params.messages).length;
  return costFor(params.model, {
    inputTokens: Math.ceil(chars / 3),
    outputTokens: params.max_tokens,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  });
}

export async function anthropicTransport(req: ChatRequest): Promise<ProviderTransportResult> {
  const botId = req.telemetry?.botId ?? "unknown";
  const source = req.telemetry?.source ?? "legacy";
  const model = pickModel(req);
  const params = toAnthropicRequest(req, model);
  // Reactive = hostiles/damage: keep it alive until the hard cap. Everything else is paced.
  assertCanSpend(estimateUsd(params), source !== "reactive");

  for (let attempt = 0; ; attempt++) {
    await acquireRateSlot();
    const started = performance.now();
    try {
      const msg = await getClient().messages.create(params);
      const usage = usageOf(msg);
      const cost = recordUsage(botId, model, source, usage, performance.now() - started);
      const text = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (msg.stop_reason === "refusal") recordError(botId, model, source, "refusal");
      return {
        response: { message: { content: text } },
        raw: {
          id: msg.id,
          model: msg.model,
          stop_reason: msg.stop_reason,
          usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens + usage.cacheCreationTokens + usage.cacheReadTokens, costUsd: cost },
        },
      };
    } catch (error) {
      const message = (error as Error)?.message ?? String(error);
      recordError(botId, model, source, message);
      const delay = retryDelayMs(error, attempt);
      if (delay === null || attempt + 1 >= anthropicConfig.maxAttempts) throw error;
      console.warn(`[Anthropic] ${botId}/${source} attempt ${attempt + 1} failed (${message.slice(0, 120)}); retrying in ${Math.round(delay / 1000)}s`);
      await new Promise((r) => setTimeout(r, delay));
      assertCanSpend(estimateUsd(params), source !== "reactive");
    }
  }
}
