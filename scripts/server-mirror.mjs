#!/usr/bin/env node
// Read-only server-state mirror for a remote agents host (the Windows PC).
// GET /state → { levelName, advancements: {uuid: {...}}, stats: {uuid: {...}}, server: {tps, players, at} }
// Binds 127.0.0.1 only; the PC reaches it through `ssh -L 25580:127.0.0.1:25580`.
// Never returns server.properties, the RCON password or anything outside <level>/advancements|stats.
//
// Failover (AGENTS_FAILOVER=true): a request carrying X-Agents-Host is the remote agents
// host checking in (it pulls every 60 s). While it checks in, local mc-agents is stopped;
// after 5 min of silence, local mc-agents is started (only if mc-paper is up).
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const BASE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_DIR = path.join(BASE, "server");
const HOST = "127.0.0.1";
const PORT = Number(process.env.MIRROR_PORT || 25580);
const { Rcon } = createRequire(path.join(BASE, "agent-swarm", "package.json"))("rcon-client");

const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

function props() {
  try {
    return fs.readFileSync(path.join(SERVER_DIR, "server.properties"), "utf8");
  } catch {
    return "";
  }
}

const levelName = () => props().match(/^level-name=(.+)$/m)?.[1]?.trim() || "world";

// Last good parse per file, so a read that lands mid-autosave serves the previous copy.
const lastGood = new Map();

function readDir(sub) {
  const dir = path.join(SERVER_DIR, levelName(), sub);
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => UUID_FILE.test(n));
  } catch {
    return out;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      lastGood.set(file, parsed);
    } catch {
      /* torn read: fall back to the last good copy */
    }
    if (lastGood.has(file)) out[name.slice(0, -5)] = lastGood.get(file);
  }
  return out;
}

// ── TPS + player list via local RCON, every 30 s ───────────────────────────
let server = { tps: "?", players: "?", at: null };

async function refreshServer() {
  const p = props();
  try {
    const rcon = await Rcon.connect({
      host: "127.0.0.1",
      port: Number(p.match(/^rcon\.port=(\d+)$/m)?.[1] ?? 25575),
      password: p.match(/^rcon\.password=(.*)$/m)?.[1]?.trim(),
      timeout: 4000,
    });
    const strip = (s) => s.replace(/§./g, "").trim();
    const tps = strip(await rcon.send("tps"));
    const players = strip(await rcon.send("list"));
    await rcon.end();
    server = { tps, players, at: new Date().toISOString() };
  } catch (e) {
    server = { tps: `unreachable (${e.message})`, players: "?", at: new Date().toISOString() };
  }
}

void refreshServer();
setInterval(() => void refreshServer(), 30_000);

// ── Failover between remote and local agents ───────────────────────────────
const FAILOVER = process.env.AGENTS_FAILOVER === "true";
const REMOTE_GONE_MS = 5 * 60_000;
const REMOTE_PRESENT_MS = 2 * 60_000;
let remoteSeenAt = Date.now(); // grace period after (re)start
let remoteHost = null;
let localAgentsActive = false;

const systemctl = (...args) =>
  new Promise((resolve) => execFile("systemctl", ["--user", ...args], (err, out) => resolve((out || "").trim())));

async function failoverTick() {
  localAgentsActive = (await systemctl("is-active", "mc-agents")) === "active";
  if (!FAILOVER) return;
  const silentMs = Date.now() - remoteSeenAt;
  if (localAgentsActive && remoteHost && silentMs < REMOTE_PRESENT_MS) {
    console.log(`[mirror] remote agents host ${remoteHost} is back — stopping local mc-agents`);
    await systemctl("stop", "mc-agents");
    localAgentsActive = false;
  } else if (!localAgentsActive && silentMs > REMOTE_GONE_MS && (await systemctl("is-active", "mc-paper")) === "active") {
    console.log(`[mirror] no remote agents host for ${Math.round(silentMs / 60_000)} min — starting local mc-agents`);
    remoteHost = null;
    await systemctl("start", "mc-agents");
    localAgentsActive = true;
  }
}

void failoverTick();
setInterval(() => void failoverTick(), 15_000);

http
  .createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/state") {
      res.writeHead(404).end();
      return;
    }
    const agentsHost = req.headers["x-agents-host"];
    if (typeof agentsHost === "string" && agentsHost) {
      remoteSeenAt = Date.now();
      remoteHost = agentsHost.slice(0, 64);
    }
    const body = JSON.stringify({
      levelName: levelName(),
      generatedAt: new Date().toISOString(),
      advancements: readDir("advancements"),
      stats: readDir("stats"),
      server,
      // The remote host must not log its bots in while these are online.
      serverHostAgentsActive: localAgentsActive,
    });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
  })
  .listen(PORT, HOST, () => console.log(`[mirror] serving http://${HOST}:${PORT}/state from ${SERVER_DIR}`));
