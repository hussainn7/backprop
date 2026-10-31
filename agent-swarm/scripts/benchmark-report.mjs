#!/usr/bin/env node
// scripts/benchmark-report.mjs
//
// Print a benchmark report from one or two scoreboard session JSON files.
//
//   node scripts/benchmark-report.mjs                        # latest session
//   node scripts/benchmark-report.mjs <session-id>           # named session
//   node scripts/benchmark-report.mjs <current> <baseline>   # compare

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SESSIONS_DIR = resolve("logs", "sessions");

function latestSessionFile() {
  const entries = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ f, mtime: statSync(join(SESSIONS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (entries.length === 0) throw new Error(`No sessions in ${SESSIONS_DIR}`);
  return join(SESSIONS_DIR, entries[0].f);
}

function resolveSessionArg(arg) {
  if (!arg) return latestSessionFile();
  const direct = resolve(arg);
  try {
    statSync(direct);
    return direct;
  } catch {
    // not a direct path; treat as a session id prefix
  }
  const match = readdirSync(SESSIONS_DIR).find((f) => f.includes(arg));
  if (!match) throw new Error(`No session file matching ${arg}`);
  return join(SESSIONS_DIR, match);
}

async function main() {
  const [currentArg, baselineArg] = process.argv.slice(2);
  const currentPath = resolveSessionArg(currentArg);
  const baselinePath = baselineArg ? resolveSessionArg(baselineArg) : null;

  // Load the compiled TS report from dist/ when present (fast), else from
  // tsx-compatible source. The script runs under plain node; buildReport
  // and renderReport are pure.
  const reportModule = await import(pathToFileURL(resolve("dist", "eval", "benchmark-report.js")).href).catch(
    async () =>
      await import(pathToFileURL(resolve("src", "eval", "benchmark-report.ts")).href).catch(() => {
        throw new Error(
          'benchmark-report module not found. Run "npm run build" first, or run via tsx: npx tsx scripts/benchmark-report.mjs',
        );
      }),
  );
  const { buildReport, renderReport } = reportModule;

  const current = JSON.parse(readFileSync(currentPath, "utf-8"));
  const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, "utf-8")) : null;

  const currentReport = buildReport(current);
  const baselineReport = baseline ? buildReport(baseline) : undefined;

  if (baselinePath) {
    console.log(`Comparing ${currentPath}\n       to ${baselinePath}\n`);
  }
  console.log(renderReport(currentReport, baselineReport));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
