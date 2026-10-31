// Minimal connectivity probe: join as a bot through a proxy, report spawn info, quit.
// Usage: node join-test.mjs <host> <port> <username>
import { createRequire } from "module";
const require = createRequire("/home/hussain/minecraft-server/agent-swarm/package.json");
const mineflayer = require("mineflayer");
const [host = "127.0.0.1", port = "25567", username = "Atlas"] = process.argv.slice(2);
const bot = mineflayer.createBot({ host, port: Number(port), username, version: "1.21.4", auth: "offline" });
const timer = setTimeout(() => { console.log("TIMEOUT"); process.exit(2); }, 60000);
bot.once("spawn", () => {
  const p = bot.entity.position;
  console.log(`SPAWNED ${username} uuid=${bot.player?.uuid} pos=${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)} health=${bot.health} food=${bot.food} gamemode=${bot.game.gameMode} difficulty=${bot.game.difficulty}`);
  setTimeout(() => { console.log("block below:", bot.blockAt(p.offset(0, -1, 0))?.name); clearTimeout(timer); bot.quit(); setTimeout(() => process.exit(0), 500); }, 3000);
});
bot.on("kicked", (r) => { console.log("KICKED", typeof r === "string" ? r : JSON.stringify(r)); process.exit(1); });
bot.on("error", (e) => { console.log("ERROR", e.message); process.exit(1); });
