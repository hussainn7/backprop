// src/stream/race.ts
//
// Live race page: every squad, every bot, what it is doing, plus server chat.
//
// Each squad process serves its own snapshot on 127.0.0.1:(3030 + squad index).
// The alpha process also serves the page itself on RACE_PORT (default 3020),
// bound to RACE_BIND (default 0.0.0.0 so a phone on the same Wi-Fi can open
// it). The page and its API are read-only and require ?k=<key>; the key is
// RACE_KEY from .env or a random one saved in logs/race-key.txt.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { SQUAD_NAMES, squadIndex } from "../bot/squad.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERNAL_BASE = 3030;
let started = false;

type Snapshot = Record<string, unknown> & { squad: string; chat?: { at: number; text: string }[] };

function raceKey(): string {
  if (process.env.RACE_KEY) return process.env.RACE_KEY;
  const file = path.join("logs", "race-key.txt");
  try {
    const k = fs.readFileSync(file, "utf8").trim();
    if (k) return k;
  } catch {
    /* first run */
  }
  const k = crypto.randomBytes(9).toString("base64url");
  fs.mkdirSync("logs", { recursive: true });
  fs.writeFileSync(file, k);
  return k;
}

function fetchJson(port: number): Promise<Snapshot | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/snap", timeout: 1500 }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === "IPv4" && !a.internal)
    .map((a) => a.address);
}

export function startRaceServers(snapshot: () => Snapshot): void {
  if (started) return;
  started = true;
  const idx = squadIndex();

  // Internal per-squad snapshot (localhost only).
  const internal = http.createServer((req, res) => {
    if (req.url !== "/snap") {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(snapshot()));
  });
  internal.on("error", (e) => console.warn(`[Race] internal port ${INTERNAL_BASE + idx}: ${e.message}`));
  internal.listen(INTERNAL_BASE + idx, "127.0.0.1");

  if (idx !== 0) return; // only alpha serves the page

  const key = raceKey();
  const port = Number(process.env.RACE_PORT || 3020);
  const bind = process.env.RACE_BIND || "0.0.0.0";
  const page = path.join(__dirname, "../../dashboard/race.html");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.searchParams.get("k") !== key) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Add ?k=<race key> (logs/race-key.txt)");
      return;
    }
    if (url.pathname === "/" || url.pathname === "/race") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(fs.readFileSync(page));
      return;
    }
    if (url.pathname === "/api/race") {
      const squads = await Promise.all(
        SQUAD_NAMES.map((_, i) => (i === idx ? Promise.resolve(snapshot()) : fetchJson(INTERNAL_BASE + i))),
      );
      // Every process hears the same server chat: merge and drop repeats seen within 4 s.
      const chat: { at: number; text: string }[] = [];
      for (const s of squads) for (const c of s?.chat ?? []) chat.push(c);
      chat.sort((a, b) => a.at - b.at);
      const merged: { at: number; text: string }[] = [];
      for (const c of chat) {
        if (merged.some((m) => m.text === c.text && Math.abs(m.at - c.at) < 4000)) continue;
        merged.push(c);
      }
      const body = {
        at: Date.now(),
        squads: squads.map((s, i) => s ?? { squad: SQUAD_NAMES[i], offline: true }),
        chat: merged.slice(-120),
      };
      for (const s of body.squads) delete (s as Snapshot).chat;
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404).end();
  });
  server.on("error", (e) => console.warn(`[Race] page server on ${bind}:${port}: ${e.message}`));
  server.listen(port, bind, () => {
    const hosts = bind === "0.0.0.0" ? ["localhost", ...lanAddresses()] : [bind];
    for (const h of hosts) console.log(`[Race] live race page: http://${h}:${port}/?k=${key}`);
  });
}
