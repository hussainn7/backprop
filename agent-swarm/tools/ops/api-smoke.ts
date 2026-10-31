import { chat } from "../../src/llm/provider.js";
import { getLedger } from "../../src/llm/budget.js";
const r = await chat({
  model: "x", format: "json",
  messages: [
    { role: "system", content: "You are a Minecraft survival bot. Allowed actions: gather_wood, craft, explore, idle." },
    { role: "user", content: "Position 0,64,0. Daytime. Inventory empty. Oak trees 6 blocks north. What should you do next? Respond with JSON {\"action\":..., \"thought\":...}." },
  ],
  options: { num_predict: 200 },
  telemetry: { botId: "SmokeTest", source: "reactive" },
});
console.log("REPLY:", r.message.content);
console.log("USAGE:", JSON.stringify(r.metadata?.usage), "model:", r.metadata?.providerModel);
console.log("LEDGER today $", getLedger().today.costUsd.toFixed(6));
