# Handoff — Backprop AI civilization (MacBook → main PC)

Written 2026-10-31 when the MacBook deployment was shut down so the whole stack can run
on the main PC (Windows). Everything below is what an agent needs to run it from this repo.

## What this repo is

| Path | What |
|---|---|
| `agent-swarm/` | Fork of JesseRWeigel/minecraft-agent-swarm: 5 Mineflayer bots (Atlas, Flora, Forge, Mason, Blade) driven by Claude |
| `server/` | Paper 1.21.4 config only (world, `server.properties`, `paper-global.yml`, whitelist, ops are git-ignored) |
| `proxy-public/`, `proxy-bots/` | Velocity configs: public ONLINE-mode proxy on :25565, bots-only OFFLINE proxy on 127.0.0.1:25567 |
| `scripts/` | Linux launchers/backup/watchdog (`run-paper.sh`, `run-proxy.sh`, `backup.sh`, `tunnel-watchdog.sh`, `inv.py`, `cpu-profile.mjs`) |
| `mc` | Linux control script (systemd --user). On Windows, recreate the same pieces as scripts/services |
| `README.md` | Full design notes: auth model, budget settings, milestones, sudo steps |

## Architecture to recreate on Windows

1. **Paper 1.21.4** (Java 21) on `127.0.0.1:25566`, `online-mode=false`, Velocity modern forwarding
   enabled in `server/config/paper-global.yml` (`proxies.velocity.enabled: true`, `secret: <forwarding secret>`),
   RCON on 127.0.0.1:25575. Heap `-Xms1G -Xmx2G` was enough on the MacBook; the PC can use more.
   Download: `https://fill.papermc.io/v3/projects/paper/versions/1.21.4/builds` (build 232 was used).
2. **Two Velocity 3.5.1 proxies** (Java 21; Velocity 4.x needs Java 25), sharing one `forwarding.secret`:
   - public: `bind 0.0.0.0:25565`, `online-mode = true`, `force-key-authentication = true` — humans + playit tunnel
   - bots: `bind 127.0.0.1:25567`, `online-mode = false` — **never expose to the LAN/internet**
   Generate a NEW forwarding secret on the PC (the MacBook's was never committed).
3. **Whitelist**: bots by offline UUID (Atlas `1d4a9c61-6828-3517-9704-a0518eccaaa5`, Flora `fca4d5a4-b8c1-3fcc-8a0a-eb752019a2bb`,
   Forge `2ddbb85b-90ad-320b-9e1f-c301c5383966`, Mason `c12cc45b-0377-32a5-8fa0-d0f7cc95b22c`, Blade `a1c25b56-6d84-3914-8d8a-b6642a89c3fa`),
   humans with `whitelist add <name>` (owner: **SirFinnn**, op level 4).
4. **Agents**: Node.js ≥ 20 in `agent-swarm/`: `npm ci`, copy `.env.backprop.example` → `.env`,
   run `node --max-old-space-size=4096 --import tsx src/index.ts`.
   The API key must be in the process environment as `ANTHROPIC_API_KEY` (on the MacBook systemd loaded it
   from `config/secrets.env`; dotenv only reads `agent-swarm/.env`). Never commit it or paste it in chat.
5. **playit.gg** tunnel → `127.0.0.1:25565`, Minecraft Java, **proxy protocol off**. Claim a new agent on the PC
   (or move the existing one); stop any other playit agent using the same tunnel.

## Settings worth keeping (`agent-swarm/.env.backprop.example`)

- `LLM_PROVIDER=anthropic`: Haiku 5.5 routine, Sonnet 5.5 strategic replan hourly per bot.
- Budget: `ANTHROPIC_DAILY_CAP_USD=2`, `ANTHROPIC_TOTAL_CAP_USD=5` (lifetime test budget, ~$0.13 used so far; the
  ledger is `agent-swarm/logs/api-usage.json`, git-ignored, so the PC starts a fresh count).
- `BASE_POS/FARM_POS/TREE_FARM_POS=342,64,-337`: the world spawn SirFinnn set. **Change these if you start a new
  world**; upstream's defaults are coordinates from the original developer's world.
- `PATHFINDER_TICK_MS=4` was for the 2012 MacBook (event loop was saturated at the library default 40).
  On a fast PC try 15–20; watch the `[Perf] event loop delay` log line (p99 should stay < 50 ms).
- `TEAM_GOAL=...`: endgame mission injected into every planning prompt.
- `VIEWER_ENABLED=false`, `TTS_ENABLED=false` (TTS sends text to Microsoft), `BIND_HOST=127.0.0.1`.

## Code changes since upstream (all in this repo)

- `src/llm/anthropic.ts`, `src/llm/budget.ts`: native Anthropic SDK adapter, cost ledger, caps, pacing, retries.
- `src/bot/index.ts`: no-cheat guard (drops bot slash commands), never attack players, pathfinder limits from env.
- `src/bot/brain.ts`: combat reflex (fight melee mobs when armed, flee creepers and trident drowned), damage-cause
  text in reactive prompts, junk shedding at ≥30 slots, milestone goal line, `TEAM_GOAL` override, critic honours config.
- `src/bot/role.ts`: `BASE_POS`/`FARM_POS` env overrides, Flora can attack, `ENDGAME_KEEP` so deposit_stash never
  banks eyes of ender, pearls, golden food, arrows, shield or netherite.
- `src/monitor/ops.ts` + dashboard Ops panel: milestones verified from server advancement/stat files, spend, TPS.
- `src/llm/prompts.ts`: reactive tactics rules.

## World state at shutdown

- World save is NOT in git. Latest backup on the MacBook: `~/minecraft-server/backups/world-20261031-152505.tar.zst`
  (20 MB; contains `server/world*`, whitelist, ops, bot memory files, milestones and API usage).
  Copy it over (USB/scp) and extract at the repo root to keep the same world, bots' memories and stash.
- Owner interventions are logged in `agent-swarm/ops/interventions.jsonl` (keepInventory on, max netherite kits,
  16 eyes of ender each). Milestones 4–9 are no longer "earned".
- The team stash (4 chests) is at 335,65,-335 near spawn and holds a reserve of 48 eyes of ender, 48 pearls, golden food.
- Flora, Mason and Blade had stashed their eyes/pearls/golden food before `ENDGAME_KEEP` existed; they may need a
  top-up (`give <bot> minecraft:ender_eye 16`, etc.) or to withdraw from the stash.

## Known gaps / next work

1. **No endgame skills.** Upstream stops at the Nether (portal, fortress). There is no skill to throw/follow an Eye of
   Ender, dig into a stronghold, fill the End portal, or fight the dragon. `TEAM_GOAL` alone only makes them explore.
   Build: `find_stronghold` (activate eye, track the eye entity's horizontal heading, travel, repeat; dig down when it
   descends), `activate_end_portal` (find `end_portal_frame`, place eyes), `fight_dragon` (bow at end crystals, melee
   when perched, avoid the void).
2. **Deaths**: before the reflexes most deaths were zombies/drowned at the shoreline near spawn. Re-measure on the PC.
3. Tests: `npm test` (1049 tests). Two are timing-sensitive and flaked only on the slow MacBook under load.
