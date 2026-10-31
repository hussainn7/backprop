import { test } from "node:test";
import assert from "node:assert/strict";
import { toAnthropicRequest } from "./anthropic.js";
import { costFor } from "./budget.js";

test("Ollama-shaped messages become a valid Messages API request", () => {
  const req = toAnthropicRequest(
    {
      model: "x",
      format: "json",
      messages: [
        { role: "system", content: "You are Atlas." },
        { role: "assistant", content: '{"action":"explore"}' },
        { role: "user", content: "What next?" },
        { role: "user", content: "Hurry." },
      ],
      options: { num_predict: 384 },
    },
    "claude-haiku-5-5",
  );
  const system = req.system as { text: string; cache_control: unknown }[];
  assert.match(system[0].text, /^You are Atlas\.[\s\S]*one JSON object/);
  assert.deepEqual(system[0].cache_control, { type: "ephemeral" });
  // leading user turn inserted, consecutive user turns merged, ends on user
  assert.deepEqual(
    req.messages.map((m) => m.role),
    ["user", "assistant", "user"],
  );
  assert.equal(req.messages[2].content, "What next?\n\nHurry.");
  assert.equal(req.max_tokens, 384);
  assert.deepEqual(req.thinking, { type: "disabled" });
});

test("trailing assistant turn is never sent as a prefill", () => {
  const req = toAnthropicRequest(
    { model: "x", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "ok" }] },
    "claude-haiku-5-5",
  );
  assert.equal(req.messages.at(-1)?.role, "user");
});

test("routine Haiku strategic plans think; reactive calls do not", () => {
  const strategic = toAnthropicRequest(
    { model: "x", messages: [{ role: "user", content: "plan" }], telemetry: { botId: "Atlas", source: "strategic" } },
    "claude-haiku-5-5",
  );
  assert.deepEqual(strategic.thinking, { type: "adaptive" });
  assert.equal(strategic.max_tokens, 2048);
  const reactive = toAnthropicRequest(
    { model: "x", messages: [{ role: "user", content: "zombie!" }], telemetry: { botId: "Atlas", source: "reactive" } },
    "claude-haiku-5-5",
  );
  assert.deepEqual(reactive.thinking, { type: "disabled" });
});

test("planner requests think adaptively with room for output", () => {
  const req = toAnthropicRequest({ model: "x", messages: [{ role: "user", content: "plan" }] }, "claude-sonnet-5-5");
  assert.deepEqual(req.thinking, { type: "adaptive" });
  assert.equal(req.max_tokens, 4000);
});

test("cost uses input, output and cache rates per million tokens", () => {
  const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);
  const u = { inputTokens: 10_000, outputTokens: 10_000, cacheCreationTokens: 0, cacheReadTokens: 0 };
  near(costFor("claude-haiku-5-5", u), 0.006);
  near(costFor("claude-sonnet-5-5", u), 0.12);
  const cached = { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 10_000, cacheReadTokens: 10_000 };
  near(costFor("claude-haiku-5-5", cached), 0.00135);
  // Haiku prompts above 100K tokens bill at the long-context tier
  near(costFor("claude-haiku-5-5", { ...u, inputTokens: 200_000 }), 0.125);
  assert.throws(() => costFor("unknown-model", u));
});
