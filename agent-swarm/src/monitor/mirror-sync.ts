// src/monitor/mirror-sync.ts
// Remote mode: when the agents run on a different machine from Paper, pull the
// server's advancement/stat files from scripts/server-mirror.mjs (reached via an
// SSH tunnel) into ./server, so advancement-progress.ts and ops.ts read them
// exactly as they would on the server host.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectRoot } from "../project-root.js";

const ROOT = resolveProjectRoot(path.dirname(fileURLToPath(import.meta.url)));
const SERVER_DIR = path.join(ROOT, "server");
const SYNC_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const mirrorUrl = (): string => process.env.SERVER_MIRROR_URL || "";

export interface MirrorServerInfo {
  tps: string;
  players: string;
  at: number;
}

let serverInfo: MirrorServerInfo = { tps: "? (mirror not polled yet)", players: "?", at: 0 };

/** Latest TPS/player list the mirror reported (or why it could not). */
export function mirrorServerInfo(): MirrorServerInfo {
  return serverInfo;
}

/** Write via temp file + rename so readers never see a half-written file. */
function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows refuses to replace a file another reader has open; one retry is enough at this cadence.
    try {
      fs.renameSync(tmp, file);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

/**
 * ./server is a symlink to the real Paper directory on the server host and a
 * plain directory here. Never write through a symlink (that would be the live
 * world), and replace git's text placeholder for the symlink on Windows.
 */
function prepareServerDir(): boolean {
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(SERVER_DIR);
  } catch {
    /* missing */
  }
  if (st?.isSymbolicLink()) {
    console.warn(`[Mirror] ${SERVER_DIR} is a symlink to a real server; not overwriting it with mirror data.`);
    return false;
  }
  if (st?.isFile() && st.size < 256) fs.rmSync(SERVER_DIR);
  fs.mkdirSync(SERVER_DIR, { recursive: true });
  return true;
}

export async function syncMirrorOnce(): Promise<boolean> {
  const url = mirrorUrl();
  try {
    // The header is our check-in: while it arrives, the server host keeps its own agents stopped.
    const res = await fetch(url, { headers: { "X-Agents-Host": os.hostname() }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = (await res.json()) as {
      levelName: string;
      advancements: Record<string, unknown>;
      stats: Record<string, unknown>;
      server?: { tps: string; players: string; at: string | null };
    };
    const level = path.basename(state.levelName || "world");
    for (const sub of ["advancements", "stats"] as const) {
      const dir = path.join(SERVER_DIR, level, sub);
      fs.mkdirSync(dir, { recursive: true });
      for (const [uuid, data] of Object.entries(state[sub] ?? {})) {
        if (UUID.test(uuid)) writeAtomic(path.join(dir, `${uuid}.json`), JSON.stringify(data));
      }
    }
    writeAtomic(path.join(SERVER_DIR, "server.properties"), `level-name=${level}\n`);
    serverInfo = {
      tps: state.server?.tps ?? "?",
      players: state.server?.players ?? "?",
      at: state.server?.at ? Date.parse(state.server.at) : Date.now(),
    };
    return true;
  } catch (err) {
    serverInfo = { tps: `mirror unreachable (${(err as Error).message})`, players: "?", at: Date.now() };
    console.warn(`[Mirror] sync from ${url} failed: ${(err as Error).message}`);
    return false;
  }
}

/** Start pulling every 60 s when SERVER_MIRROR_URL is set; resolves after the first attempt. */
export async function startMirrorSync(): Promise<void> {
  if (!mirrorUrl() || !prepareServerDir()) return;
  console.log(`[Mirror] remote mode: syncing server state from ${mirrorUrl()} every ${SYNC_MS / 1000}s`);
  if (await syncMirrorOnce()) console.log("[Mirror] initial sync ok");
  setInterval(() => void syncMirrorOnce(), SYNC_MS).unref();
}
