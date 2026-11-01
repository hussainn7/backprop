# Backprop: a multi-agent LLM civilization in Minecraft

> A fun learning project. It looks at what happens when you drop a swarm of autonomous
> LLM agents into an open-ended survival world and give them one long-horizon goal: beat
> the game. It's built to run on a cost budget, on hardware from 2012.

**What this is:** a self-hosted, zero-trust Minecraft deployment where ten embodied AI
agents in two squads (Atlas, Flora, Forge, Mason, Blade · Nova, Ivy, Anvil, Brick, Fang)
live in a Paper 1.21.4 survival world next to human players, and **learn online from
their own fights**. Each agent uses a **hierarchical control architecture**:

| Layer | Latency | Driven by |
|---|---|---|
| Strategic planner | minutes | Claude Sonnet 5.5, periodic long-horizon replans |
| Tactical policy | seconds | Claude Haiku 5.5, cached system prompt, low-effort inference |
| Learned combat policy | ~1 s | tabular Q-learning over fighting tactics, trained online from every fight |
| Learned pearl aim | per throw | projectile physics + recursive-least-squares correction, hindsight-relabelled |
| Reflex / motor layer | ticks | deterministic Mineflayer skills (pathfinding, combat, crafting, eating) |

**Engineering highlights**

- **Cost-aware inference routing.** A custom Anthropic adapter has a token-level cost
  ledger, daily and lifetime spend caps, pacing control, a global RPM limiter,
  exponential backoff that honours `retry-after`, and prompt caching. When the budget
  runs out, the agents fall back to their reflexes instead of crashing.
- **Split-trust authentication.** There are two Velocity proxies: an online-mode edge for
  humans and a loopback-only offline-mode ingress for bots. A modern-forwarding shared
  secret means the backend can't be reached around either proxy.
- **Online machine learning.** Bots learn *how* to fight from reward, not from prompts:
  a shared Q-learning policy picks among sprint-hits, critical jump-hits, w-taps, shield
  play, strafing, retreating and ender-pearl moves, and a learned aim model teaches them
  to throw pearls accurately. Learning curves are live in Mission Control.
  See [Machine learning](#machine-learning-bots-that-learn-to-fight).
- **Ground-truth evaluation.** Progress is measured against a 10-stage milestone
  curriculum, read straight from the server's advancement and stats files and never from
  what the model says about itself. No hallucinated wins.
- **Guardrails.** Agents can't run commands and get no operator privileges. They can't
  attack players, with one opt-in exception (`HUNT_PLAYER`, below). Every network
  listener binds to localhost.
- **Ops.** Everything runs under `systemd --user` units, no root. There are zstd world
  snapshots every 6 h, a tunnel watchdog, and a Mission Control telemetry dashboard (TPS,
  RAM/CPU, spend, deaths, milestones).

Agent framework forked from
[JesseRWeigel/minecraft-agent-swarm](https://github.com/JesseRWeigel/minecraft-agent-swarm)
(MIT). The Anthropic adapter, budget system, guardrails, ops layer and infrastructure
are mine; see [Changes](#changes-made-to-minecraft-agent-swarm).

## Machine learning: bots that learn to fight

The LLM layers decide *what* to do. Two small learners, trained online inside the agents
process from the bots' own experience, decide *how* to fight. Nothing is pre-trained and
nothing is scripted per tactic outcome: every number below is learned live on the server.
The opponent is the owner (`HUNT_PLAYER`, `HUNT_MODE=primary`): while he plays survival,
all ten bots hunt him, and every engagement is training data.

### 1. Combat policy: Q-learning with a linear model (`src/learn/combat-learner.ts`)

Each bot in sight of the target makes a decision every 1.2 s.

| | |
|---|---|
| **State features** (22) | bias · distance (≤3, 3–6, 6–12, 12–24, >24) · own health (≤6, ≤12, >12) · target shielding · height (below, level, above) · allies near target (0, 1–2, 3+) · target motion relative to the bot (still, approaching, fleeing) · target **busy** fighting (swung or was hit in the last 2 s, or a teammate is on him) · a mob on the bot · a teammate **calling for help** |
| **Actions** (10) | `rush` · `crit` (jump, hit while falling: 1.5×) · `wtap` · `shield` · `strafe` · `retreat` · `pearl_close` · `pearl_escape` · `defend` (kill the mob on you) · `backup` (run to a hurt teammate and fight beside them) |
| **Model** | Q(s,a) = w_a · φ(s), one weight vector per tactic; what is learned in one situation carries over to similar ones |
| **Update** | w_a += (η/‖φ‖²)·(r + γ·max Q(s′,·) − Q(s,a))·φ(s), η = 0.3, γ = 0.8 (semi-gradient Q-learning) |
| **Reward** | +1 per own hit on the target, **+0.25 per squadmate hit** (team play), +0.3 per hit on a mob that is on you, +0.5 for ending beside a teammate who called for help, −0.5 per HP lost, −0.05 per decision (finish fast), + distance-shaping Φ(s′) − Φ(s) with Φ = −distance/4, +10 kill, +5 squadmate kill, −10 death |
| **Exploration** | ε-greedy with a per-state rate ε(s) = max(0.05, 0.5/√(1 + visits(s))) |

Which tactic fits which situation is never hard-coded; only what is physically possible is
(pearls need pearls and a clear arc, `defend` needs a mob, `backup` needs a call for help).
A unit test trains the model only at 10 blocks ("rush when he is busy, pearl when he flees")
and checks it already chooses correctly at 20 blocks.

All five bots of a squad share one model. It persists in `agent-swarm/logs/learning/combat-v2-<squad>.json`,
and every decision is appended to `combat-experience-v2-<squad>.jsonl`. The v1 lookup-table
logs are kept as the baseline.

**Measured (same opponent, raw outcomes per bot per engaged minute):**

| | v1 table (3,244 decisions) | v2 round 1 (2,452 decisions) |
|---|---|---|
| hits on the target | 14.4 / min | **22.7 / min (+57 %)** |
| damage taken | 14.0 / min | **12.3 / min (−12 %)** |
| deaths | 37 / h | 34 / h |
| pearl decisions | 14 % | 5.5 % |

Round 1 also exposed a shaping bug (γΦ(s′) − Φ(s) with γ = 0.8 paid bots for standing far
away, so retreats doubled to 21 %); round 2 uses Φ(s′) − Φ(s).

### Team play: spotting, callouts, backup

* **Spotter board** (`src/bot/sighting.ts`): any bot that sees the target publishes his
  position and velocity; the other squad reads it from `logs/sighting.json`. Bots that
  cannot see him path to where he *will* be (position + velocity × time-to-reach).
* **Chat callouts** (`src/bot/team-comms.ts`, rate-limited): "Spotted SirFinnn at x y z",
  "6 HP at x y z, need backup!", "On my way, Flora!", "Pearling in!", "Got him!",
  "I'm down, he's at x y z", and every 3 min each leader reports what its squad has learned.
* **Pursuit** (`src/bot/pursuit.ts`): long chases walk 32-block waypoints along the bearing
  and wait for the pathfinder's own result instead of cancelling slow searches; bots in
  water swim straight at him; when stuck they pearl-hop, detour, then tunnel out in 12-block
  steps, and a bot pinned for a minute rejoins for a fresh client.
* **Guardian** (`src/bot/guardian.ts`): every 5 s in hunt mode, using the server's positions
  for all ten bots, it lifts a bot that is inside a block to the surface, and teleports a bot
  that has not moved 2 blocks in 25 s (and is not fighting) to a free teammate closer to the
  target, or onto open ground on the way to him. `mc.ps1 check` shows every bot's state.
* **1.21 enchantment fix** (`src/bot/enchant-compat.ts`): enchanted tools broke mineflayer's
  dig-time maths, so any bot that had to dig never moved; enchantments are normalized first.
* **Help board**: a bot that drops to 8 HP or less while fighting him (not from a fall or a mob) posts a help request (`logs/help.json`); teammates
  within 40 blocks get the `ally hurt` feature and the learned `backup` tactic.

### Modes

`!mode hunt` (all bots hunt `HUNT_PLAYER` while he is in survival) or `!mode game` (back to
beating the game); `!mode` shows the current one. Stored in `logs/hunt-mode.json`, shared
by both squads; `HUNT_MODE=primary` in `.env` is the default until set in game.

### 2. Ender-pearl aim: physics prior + learned correction (`src/learn/pearl-aim.ts`)

1. **Physics prior.** A pearl leaves the eye at 1.5 blocks/tick, keeps 99 % of its
   velocity per tick and falls 0.03 blocks/tick². Simulating the flight and inverting it
   (scan + bisection; the range is not monotonic for targets above you) gives the low-arc
   pitch for any target distance *d* and height difference *dy*.
2. **Learned residual.** The real server differs from that model (tick order, the
   thrower's own motion, leaves, spread). After each throw the bot knows the pitch it
   used and where it really landed, so the throw is **relabelled in hindsight**: "to land
   *there*, pitch *p* was right", while physics would have said *p*ₚₕᵧₛ(there). The
   residual *p* − *p*ₚₕᵧₛ trains a **recursive-least-squares** regression on features
   [1, d, dy, d², d·dy]. Aim = *p*ₚₕᵧₛ(target) + correction(target).
3. **Terrain check.** Before throwing, the bot traces the arc through the real blocks. If
   the low arc would clip a hillside, trunk or wall short of the target it tries a high
   lob; if both are blocked it keeps the pearl. (The first live samples showed why: the
   worst misses, 8–18 blocks, were all throws at targets downhill that hit the slope.)
   Lobs fly on physics alone; the learned correction is trained on low-arc throws.

   A throw whose hindsight label is implausible (more than 8° from physics) stopped on a
   tree or wall mid-flight; it is recorded as *blocked* and never trained on.

With `PEARL_TOPUP=true` the agents process refills each bot to 16 pearls (via local RCON)
whenever it is down to 4, so pearl tactics and the aim model keep getting data.

Every throw's landing error is stored (`pearl-aim-<squad>.json`). The unit test simulates
a server whose pearls fly 3° low: the first throw misses by over a block, and within a
few throws the model has learned the bias and the misses drop below 0.3 blocks.

### Watching it learn

Mission Control (:3010 alpha, :3011 bravo) → **Ops** → **Learning**: the mean reward per
25 decisions (the learning curve), each tactic's uses, hits per use and mean reward, the
greedy policy the squad has converged to at each distance, and the pearl landing error
per throw. `[Learn]` lines in `logs\agents-<squad>.log` show individual decisions and
scored outcomes. The two squads learn independently, which doubles as a replication:
if both converge on the same tactics, that's evidence the result is real.

**What it does not do (yet):** the state space is hand-designed and tabular; deep RL
would need far more fights than one human opponent provides. Model-generated code is
never executed for this; the learners only choose among fixed, reviewed behaviours.

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

## Running everything on a Windows PC (local-only)

Single-PC setup from `HANDOFF.md`: no proxies, playit or SSH. Paper binds `127.0.0.1:25565`
with `online-mode=false` and the whitelist on, so nothing outside the PC can connect and
offline mode is safe. Bots join Paper directly (`MC_PORT=25565`).

* Java 21 (`winget install EclipseAdoptium.Temurin.21.JDK`), Paper 1.21.4 build 232 as
  `server\paper.jar`, Node >= 20 with `npm ci` in `agent-swarm`.
* `agent-swarm\server` is a junction to `..\server` (`mklink /J`), like the MacBook symlink;
  `git update-index --skip-worktree agent-swarm/server` keeps git quiet about it.
* `agent-swarm\.env` from `.env.backprop.example`; the API key goes in `config\secrets.env`
  via `windows\set-api-key.ps1` (hidden prompt). `src/config.ts` loads it.
* `windows\mc.ps1 status|start|stop|restart [server|agents]|logs [server|agents]|console|budget`
  is the `./mc` counterpart; logs go to `logs\server.log` and `logsgents.log`.
  `windows\install-autostart.ps1` runs `mc.ps1 start` at login.
* **Ten bots, two squads.** One Node thread cannot path-find for ten bots, so they run as
  two processes (`SQUAD=alpha|bravo`, see `src/bot/squad.ts`): alpha = Atlas (leader),
  Flora, Forge, Mason, Blade (Mission Control :3010); bravo = Nova (leader), Ivy, Anvil,
  Brick, Fang (:3011), playing the same five roles. Members regroup when more than
  `SQUAD_RADIUS` blocks from their leader and see the leader's latest plan in their prompts.
  Each squad has its own spend ledger (`logs/api-usage[-bravo].json`) and caps.
* **Speedrun + hunt.** `TEAM_GOAL` carries the speedrun route; `HUNT_PLAYER=SirFinnn` lets
  bots attack that one player, only while he is in survival mode. Hostile sounds (a fusing
  creeper, a skeleton out of sight) trigger the reflex layer immediately.
* Remote-agents mode (agents on one machine, server on another) is still available:
  `scripts/server-mirror.mjs` + `SERVER_MIRROR_URL`, see `deploy/systemd/mc-mirror.service`.

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
