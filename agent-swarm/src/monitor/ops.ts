// src/monitor/ops.ts
// Server-truth monitoring for Mission Control: civilization milestones verified
// from the Paper world's own advancement/stat files (never from LLM claims),
// API spend, deaths, server TPS and host resource usage.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "../project-root.js";
import { getLedger, budgetConfig } from "../llm/budget.js";
import { offlineUUID, levelName } from "../bot/advancement-progress.js";
import { mirrorUrl, mirrorServerInfo } from "./mirror-sync.js";

const ROOT = resolveProjectRoot(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_DIR = path.join(ROOT, "server");
const MILESTONE_FILE = path.join(ROOT, "logs", "milestones.json");

type Json = Record<string, any>;

interface PlayerFiles {
  advancements: Json;
  stats: Json;
}

function readJson(file: string): Json {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function playerFiles(name: string): PlayerFiles {
  const world = path.join(SERVER_DIR, levelName(SERVER_DIR));
  const uuid = offlineUUID(name);
  return {
    advancements: readJson(path.join(world, "advancements", `${uuid}.json`)),
    stats: readJson(path.join(world, "stats", `${uuid}.json`)).stats ?? {},
  };
}

const adv = (p: PlayerFiles, id: string) => p.advancements[`minecraft:${id}`]?.done === true;
const stat = (p: PlayerFiles, cat: string, key: string): number => Number(p.stats[`minecraft:${cat}`]?.[`minecraft:${key}`] ?? 0);

export interface MilestoneDef {
  id: number;
  title: string;
  evidence: string;
  check: (team: PlayerFiles[]) => boolean;
}

const any = (team: PlayerFiles[], f: (p: PlayerFiles) => boolean) => team.some(f);
const sum = (team: PlayerFiles[], f: (p: PlayerFiles) => number) => team.reduce((n, p) => n + f(p), 0);

// Each check reads only what the server wrote to disk. Paper flushes these on
// autosave (every few minutes) and on logout, so verification lags reality a bit.
export const MILESTONES: MilestoneDef[] = [
  {
    id: 1,
    title: "Survive the first night",
    evidence: "a bot's time_since_death stat >= 24000 ticks (a full day/night cycle alive)",
    check: (t) => any(t, (p) => stat(p, "custom", "time_since_death") >= 24_000),
  },
  {
    id: 2,
    title: "Establish a safe home",
    evidence: "advancement adventure/sleep_in_bed (a placed bed, slept in at night)",
    check: (t) => any(t, (p) => adv(p, "adventure/sleep_in_bed")),
  },
  {
    id: 3,
    title: "Build a reliable food supply",
    evidence: "husbandry/plant_seed AND team crafted >= 16 bread or bred >= 4 animals",
    check: (t) =>
      any(t, (p) => adv(p, "husbandry/plant_seed")) &&
      (sum(t, (p) => stat(p, "crafted", "bread")) >= 16 || sum(t, (p) => stat(p, "custom", "animals_bred")) >= 4),
  },
  {
    id: 4,
    title: "Acquire iron equipment",
    evidence: "story/iron_tools (iron pickaxe) AND story/obtain_armor (iron armor piece)",
    check: (t) => any(t, (p) => adv(p, "story/iron_tools")) && any(t, (p) => adv(p, "story/obtain_armor")),
  },
  {
    id: 5,
    title: "Acquire diamonds",
    evidence: "story/mine_diamond",
    check: (t) => any(t, (p) => adv(p, "story/mine_diamond")),
  },
  {
    id: 6,
    title: "Prepare for the Nether",
    evidence: "story/form_obsidian AND story/enter_the_nether",
    check: (t) => any(t, (p) => adv(p, "story/form_obsidian")) && any(t, (p) => adv(p, "story/enter_the_nether")),
  },
  {
    id: 7,
    title: "Obtain blaze rods and ender pearls",
    evidence: "nether/obtain_blaze_rod AND team picked up >= 1 ender pearl",
    check: (t) =>
      any(t, (p) => adv(p, "nether/obtain_blaze_rod")) && sum(t, (p) => stat(p, "picked_up", "ender_pearl")) >= 1,
  },
  {
    id: 8,
    title: "Find the stronghold",
    evidence: "story/follow_ender_eye",
    check: (t) => any(t, (p) => adv(p, "story/follow_ender_eye")),
  },
  {
    id: 9,
    title: "Prepare for the Ender Dragon",
    evidence: "team crafted >= 12 eyes of ender AND story/shiny_gear (diamond armor)",
    check: (t) => sum(t, (p) => stat(p, "crafted", "ender_eye")) >= 12 && any(t, (p) => adv(p, "story/shiny_gear")),
  },
  {
    id: 10,
    title: "Defeat the Ender Dragon",
    evidence: "end/kill_dragon",
    check: (t) => any(t, (p) => adv(p, "end/kill_dragon")),
  },
];

/** Evaluate milestones; the first verification time of each is kept forever. */
export function evaluateMilestones(botNames: string[]) {
  const team = botNames.map(playerFiles);
  const saved = readJson(MILESTONE_FILE) as Record<string, string>;
  let changed = false;
  const result = MILESTONES.map((m) => {
    const done = m.check(team);
    if (done && !saved[m.id]) {
      saved[m.id] = new Date().toISOString();
      changed = true;
      console.log(`[Milestone] VERIFIED #${m.id} ${m.title} — ${m.evidence}`);
    }
    return { id: m.id, title: m.title, evidence: m.evidence, done: !!saved[m.id], verifiedAt: saved[m.id] ?? null };
  });
  if (changed) {
    fs.mkdirSync(path.dirname(MILESTONE_FILE), { recursive: true });
    fs.writeFileSync(MILESTONE_FILE, JSON.stringify(saved, null, 2));
  }
  const perBot = botNames.map((name, i) => ({
    name,
    deaths: stat(team[i], "custom", "deaths"),
    playTimeMin: Math.round(stat(team[i], "custom", "play_time") / 1200),
    minutesSinceDeath: Math.round(stat(team[i], "custom", "time_since_death") / 1200),
    advancements: Object.entries(team[i].advancements).filter(([k, v]) => !k.includes("recipes/") && (v as Json)?.done)
      .length,
  }));
  return { milestones: result, perBot };
}

// ── Server TPS via RCON ─────────────────────────────────────────────────────
const require = createRequire(path.join(ROOT, "package.json"));
let tpsCache: { tps: string; players: string; at: number } = { tps: "?", players: "?", at: 0 };

async function refreshServer(): Promise<void> {
  // Remote mode: no local RCON (and no password on this host); the mirror polls it for us.
  if (mirrorUrl()) return;
  try {
    const props = fs.readFileSync(path.join(SERVER_DIR, "server.properties"), "utf8");
    const password = props.match(/^rcon\.password=(.*)$/m)?.[1]?.trim();
    const port = Number(props.match(/^rcon\.port=(\d+)$/m)?.[1] ?? 25575);
    const { Rcon } = require("rcon-client");
    const rcon = await Rcon.connect({ host: "127.0.0.1", port, password, timeout: 4000 });
    const strip = (s: string) => s.replace(/§./g, "").trim();
    const tps = strip(await rcon.send("tps"));
    const players = strip(await rcon.send("list"));
    await rcon.end();
    tpsCache = { tps, players, at: Date.now() };
  } catch (e) {
    tpsCache = { tps: `unreachable (${(e as Error).message})`, players: "?", at: Date.now() };
  }
}

// No `ps` on Windows: report this agents process from its own counters (CPU % of one core).
let lastCpu = { usage: process.cpuUsage(), at: Date.now() };
function selfProcess(): { name: string; rssMb: number; cpu: number }[] {
  const usage = process.cpuUsage();
  const at = Date.now();
  const busyUs = usage.user - lastCpu.usage.user + usage.system - lastCpu.usage.system;
  const cpu = Math.round((busyUs / 10 / Math.max(1, at - lastCpu.at)) * 10) / 10;
  lastCpu = { usage, at };
  return [{ name: "agents", rssMb: Math.round(process.memoryUsage().rss / 1048576), cpu }];
}

function processes(): Promise<{ name: string; rssMb: number; cpu: number }[]> {
  if (process.platform === "win32") return Promise.resolve(selfProcess());
  return new Promise((resolve) => {
    execFile("ps", ["-eo", "rss,pcpu,args", "--no-headers"], (err, out) => {
      if (err) return resolve([]);
      const rows = out
        .split("\n")
        .map((l) => l.trim().match(/^(\d+)\s+([\d.]+)\s+(.*)$/))
        .filter((m): m is RegExpMatchArray => !!m)
        .map((m) => {
          const args = m[3];
          const name = args.includes("paper.jar")
            ? "paper"
            : args.includes("velocity.jar") && args.includes("proxy-bots")
              ? "proxy-bots"
              : args.includes("velocity.jar")
                ? "velocity"
                : args.includes("src/index.ts")
                  ? "agents"
                  : args.includes("playit")
                    ? "playit"
                    : "";
          return { name, rssMb: Math.round(Number(m[1]) / 1024), cpu: Number(m[2]) };
        })
        .filter((r) => r.name);
      resolve(rows);
    });
  });
}

export function startOpsPolling(): void {
  void refreshServer();
  setInterval(() => void refreshServer(), 30_000).unref();
}

export async function opsSnapshot(botNames: string[]) {
  const ledger = getLedger();
  return {
    at: new Date().toISOString(),
    server: mirrorUrl() ? mirrorServerInfo() : tpsCache,
    host: {
      load: os.loadavg().map((n) => n.toFixed(2)),
      memUsedMb: Math.round((os.totalmem() - os.freemem()) / 1048576),
      memTotalMb: Math.round(os.totalmem() / 1048576),
      processes: await processes(),
    },
    api: {
      dailyCapUsd: budgetConfig.dailyCapUsd,
      totalCapUsd: budgetConfig.totalCapUsd,
      pausedReason: ledger.pausedReason,
      today: ledger.today,
      todayByBot: ledger.todayByBot,
      todayByModel: ledger.todayByModel,
      lifetime: ledger.lifetime,
    },
    ...evaluateMilestones(botNames),
  };
}

// ── Milestone goal for planning prompts ─────────────────────────────────────
// Per-role contribution to each milestone, so five bots pull toward the same
// verified objective without a coordinator.
const ROLE_HINTS: Record<number, Record<string, string>> = {
  1: { default: "stay alive through the night: sleep in your bed at dusk, or wall yourself in and fight only with a weapon" },
  2: { Mason: "build a roofed, lit shelter at base and place beds in it", default: "help Mason with logs/cobblestone, then sleep in a bed at night" },
  3: { Flora: "till soil by water, plant wheat seeds, breed cows/sheep", default: "bring Flora seeds and wheat; hunt animals for meat" },
  4: { Forge: "mine iron ore with a stone pickaxe and smelt it in a furnace", default: "bring Forge coal and raw iron; craft an iron pickaxe and armor from ingots" },
  5: { Forge: "strip-mine at y=-58 with an iron pickaxe for diamonds", Atlas: "find caves with exposed diamond ore", default: "supply torches, food and iron to the miners" },
  6: { Forge: "collect obsidian (water on lava) for a portal", default: "gather flint, iron and food for a Nether trip" },
  7: { Blade: "find a Nether fortress and kill blazes for rods", Atlas: "hunt endermen for ender pearls", default: "support the Nether team with food, armor and blocks" },
  8: { Atlas: "craft eyes of ender and follow them to the stronghold", default: "gather supplies for the stronghold trip" },
  9: { default: "craft eyes of ender, beds, bows and diamond armor for the End" },
  10: { default: "travel to the End and defeat the Ender Dragon together" },
};

let goalCache: { at: number; text: string } = { at: 0, text: "" };

/** One line naming the next unverified milestone and this bot's part in it (cached 60 s). */
export function milestoneGoalLine(botName: string, teamNames: string[]): string {
  if (Date.now() - goalCache.at > 60_000) {
    try {
      const { milestones } = evaluateMilestones(teamNames);
      const done = milestones.filter((m) => m.done).length;
      const next = milestones.find((m) => !m.done);
      goalCache = {
        at: Date.now(),
        text: next ? `${done}/10|${next.id}|${next.title}|${next.evidence}` : `${done}/10|`,
      };
    } catch {
      goalCache = { at: Date.now(), text: "" };
    }
  }
  if (!goalCache.text) return "";
  const [progress, id, title, evidence] = goalCache.text.split("|");
  if (!id) return `CIVILIZATION GOAL: all 10 milestones verified (${progress}). Keep the settlement thriving.`;
  const hints = ROLE_HINTS[Number(id)] ?? {};
  const hint = hints[botName] ?? hints.default ?? "";
  return `CIVILIZATION GOAL (server-verified ${progress}): next milestone #${id} "${title}" — verified when: ${evidence}. YOUR PART: ${hint}.`;
}
