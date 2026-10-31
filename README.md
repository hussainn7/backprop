# Backprop: a multi-agent LLM civilization in Minecraft

> A fun learning project. It looks at what happens when you drop a swarm of autonomous
> LLM agents into an open-ended survival world and give them one long-horizon goal: beat
> the game. It's built to run on a cost budget, on hardware from 2012.

**What this is:** a self-hosted, zero-trust Minecraft deployment where five embodied AI
agents (Atlas, Flora, Forge, Mason, Blade) live in a Paper 1.21.4 survival world next to
human players. Each agent uses a **hierarchical control architecture**:

| Layer | Latency | Driven by |
|---|---|---|
| Strategic planner | minutes | Claude Sonnet 5.5, periodic long-horizon replans |
| Tactical policy | seconds | Claude Haiku 5.5, cached system prompt, low-effort inference |
| Reflex / motor layer | ticks | deterministic Mineflayer skills (pathfinding, combat, crafting, eating) |

**Engineering highlights**

- **Cost-aware inference routing.** A custom Anthropic adapter has a token-level cost
  ledger, daily and lifetime spend caps, pacing control, a global RPM limiter,
  exponential backoff that honours `retry-after`, and prompt caching. When the budget
  runs out, the agents fall back to their reflexes instead of crashing.
- **Split-trust authentication.** There are two Velocity proxies: an online-mode edge for
  humans and a loopback-only offline-mode ingress for bots. A modern-forwarding shared
  secret means the backend can't be reached around either proxy.
- **Ground-truth evaluation.** Progress is measured against a 10-stage milestone
  curriculum, read straight from the server's advancement and stats files and never from
  what the model says about itself. No hallucinated wins.
- **Guardrails.** Agents can't run commands, can't attack players, and get no operator
  privileges. Every network listener binds to localhost.
- **Ops.** Everything runs under `systemd --user` units, no root. There are zstd world
  snapshots every 6 h, a tunnel watchdog, and a Mission Control telemetry dashboard (TPS,
  RAM/CPU, spend, deaths, milestones).

Agent framework forked from
[JesseRWeigel/minecraft-agent-swarm](https://github.com/JesseRWeigel/minecraft-agent-swarm)
(MIT). The Anthropic adapter, budget system, guardrails, ops layer and infrastructure
are mine; see [Changes](#changes-made-to-minecraft-agent-swarm).

---

## Running it

Paper 1.21.4 survival (normal difficulty), up to five Mineflayer agents, everything as
your own user under `systemd --user`. Secrets live in `config/`, which git ignores.

## Layout

```
<repo>/
  mc                    control script (see below)
  server/               Paper backend, 127.0.0.1:25566 only (world, whitelist, ops)
  proxy-public/         Velocity, ONLINE mode, 0.0.0.0:25565  ← humans + playit tunnel
  proxy-bots/           Velocity, OFFLINE mode, 127.0.0.1:25567 ← bots only (local)
  agent-swarm/          JesseRWeigel/minecraft-agent-swarm + local changes
  config/               secrets.env, forwarding.secret, playit secret  (all chmod 600)
  runtime/              Java 21, Node 22, velocity.jar, playit
  backups/              world-YYYYMMDD-HHMMSS.tar.zst (newest 16 kept, every 6 h)
  logs/                 paper.log, proxy-*.log, agents.log, playit.log, backup.log
```

### Why two proxies (authentication)

Bots without paid Microsoft accounts can only join offline-mode servers, and an
offline-mode server on the internet lets anyone log in as anyone. So:

* Humans connect to the **online-mode** proxy: real Microsoft authentication and
  signed chat keys, then the backend whitelist (by real UUID).
* Bots connect to a **second, offline-mode** proxy that listens on `127.0.0.1` only,
  so nothing outside this MacBook can reach it.
* The backend accepts only Velocity-forwarded connections (shared secret), so the
  backend port can't be used to bypass either proxy.

Verified: whitelisted bot joins via the bot proxy; a non-whitelisted name is rejected;
direct backend connections are rejected; unauthenticated clients are rejected by the
public proxy.

## Daily commands

```bash
cd ~/minecraft-server
./mc status                      # services, TPS, who is online
./mc start | stop | restart      # everything
./mc restart agents              # one piece: paper | proxy | botproxy | tunnel | agents
./mc logs agents                 # follow a log (paper, proxy, tunnel, agents)
./mc console "say hello"         # server console command via RCON
./mc whitelist add <Name>        # add a friend (their Java Edition username)
./mc whitelist remove <Name>
./mc bots 3                      # run 1–5 bots
./mc budget                      # API spend today / lifetime, per bot and model
./mc backup                      # backup now
./mc dashboard                   # Mission Control URL (localhost only)
```

Restore a backup: `./mc stop`, move `server/world*` aside, `tar --zstd -xf backups/<file> -C ~/minecraft-server`, `./mc start`.

## Joining

* **Version:** Minecraft Java Edition **1.21.4**.
* **Address:** the playit.gg address shown on your playit dashboard (Tunnels → the
  Minecraft Java tunnel), e.g. `something.joinmc.link`. On the home network you can also use
  `<server-LAN-IP>:25565`.
* You must be on the whitelist: `./mc whitelist add <YourName>`.
* Bots are survival players with no operator rights; they won't attack players
  (`BOTS_MAY_ATTACK_PLAYERS=false`). To control them in chat, add your name to
  `BOT_COMMAND_WHITELIST` in `agent-swarm/.env` (`!status`, `!come`, `!stay`, `!goal set …`).
* Give yourself operator rights if you want them: `./mc console "op <YourName>"`.

## API budget

Settings live in `agent-swarm/.env`; the key lives in `config/secrets.env` (set it with
`scripts/set-api-key.sh`, never in chat or in `.env`).

| Setting | Default | Meaning |
|---|---|---|
| `ANTHROPIC_DAILY_CAP_USD` | 2 | hard stop per local day |
| `ANTHROPIC_TOTAL_CAP_USD` | 5 | lifetime testing budget — raise deliberately |
| `ANTHROPIC_PACING_BURST` | 0.15 | spend may run this far ahead of an even daily pace; non-urgent calls wait |
| `ANTHROPIC_MAX_RPM` | 20 | requests per minute, all bots |
| `ANTHROPIC_PLANNER_INTERVAL_MIN` | 120 | Sonnet strategic replans per bot (0 = never) |
| `BOT_IDLE_INTERVAL_MS` | 45000 | how often a bot re-plans when nothing happens |

Routine decisions use `claude-haiku-5-5` (no extended thinking, low effort, cached role
prompt); Sonnet 5.5 is used for periodic replans only while under 35 % of the daily cap.
Movement, crafting, combat reflexes, eating and repeated actions are deterministic
Mineflayer skills. When a cap is hit the API pauses and bots fall back to idle +
reflexes. Every call is logged without content in `agent-swarm/logs/api-calls.jsonl`;
totals in `agent-swarm/logs/api-usage.json`.

## Milestones

Verified from the server's own files (`world/advancements`, `world/stats`), never from
model output; first-verified time is stored in `agent-swarm/logs/milestones.json`.
Paper flushes these on autosave and logout, so the dashboard lags by a few minutes.

1. Survive the first night — `time_since_death` ≥ 24000 ticks
2. Safe home — `adventure/sleep_in_bed`
3. Reliable food — `husbandry/plant_seed` + 16 bread crafted or 4 animals bred
4. Iron equipment — `story/iron_tools` + `story/obtain_armor`
5. Diamonds — `story/mine_diamond`
6. Nether ready — `story/form_obsidian` + `story/enter_the_nether`
7. Blaze rods + pearls — `nether/obtain_blaze_rod` + an ender pearl picked up
8. Stronghold — `story/follow_ender_eye`
9. Dragon prep — 12 eyes of ender crafted + `story/shiny_gear`
10. Dragon defeated — `end/kill_dragon`

## Changes made to minecraft-agent-swarm

* `src/llm/anthropic.ts`, `src/llm/budget.ts` — native Anthropic adapter (official SDK),
  Haiku/Sonnet routing, prompt caching, real cost from response usage, per-bot/per-model/
  global ledgers, daily + lifetime caps, pacing, rate limit, exponential backoff
  honouring `retry-after`.
* `src/bot/index.ts` — no-cheat guard drops every slash command a bot tries to send;
  `bot.attack` refuses player targets.
* `src/stream/*` — every web listener binds to `127.0.0.1` (`BIND_HOST`).
* `src/stream/tts.ts` — Edge TTS (sends thoughts to Microsoft) off unless `TTS_ENABLED=true`.
* `src/monitor/ops.ts` + dashboard “Ops” panel — milestones, API spend, deaths, TPS, RAM/CPU.
* Upstream assumes bots are operators (gamerules, teleport rescue, rations). Here they
  are not, and `ALLOW_INTERVENTIONS=false`; vanilla gamerules (keepInventory off).

## One-time steps that need sudo (run them yourself)

```bash
# Start everything at boot even before you log in
sudo loginctl enable-linger $USER
# Firewall: allow Minecraft from the home LAN only (the tunnel arrives via localhost)
sudo ufw default deny incoming
sudo ufw allow from 10.0.0.0/24 to any port 25565 proto tcp
sudo ufw enable
```

Docker publishes your Postiz ports on 127.0.0.1 only, so ufw doesn't affect them.

## Known limits

* All tunnel players appear to come from 127.0.0.1 inside Velocity (no PROXY protocol);
  per-IP rate limiting therefore applies to the tunnel as a whole.
* The CPU idles near 89 °C; watch `./mc status` TPS and temps when adding bots.
* The Ender Dragon objective has **not** been demonstrated. Upstream's own runs
  report food supply and deaths as the main bottlenecks.
