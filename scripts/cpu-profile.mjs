// Sample a running Node process's CPU via the inspector (CDP) and print the hottest code.
// Usage: kill -USR1 <pid>; node cpu-profile.mjs [seconds]
const secs = Number(process.argv[2] || 20);
const targets = await (await fetch("http://127.0.0.1:9229/json/list")).json();
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } };
await new Promise((r) => (ws.onopen = r));
await send("Profiler.enable"); await send("Profiler.setSamplingInterval", { interval: 1000 }); await send("Profiler.start");
await new Promise((r) => setTimeout(r, secs * 1000));
const { profile } = await send("Profiler.stop");
ws.close();
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map(); let total = 0;
for (const s of profile.samples) { total++; self.set(s, (self.get(s) || 0) + 1); }
const fn = new Map(), mod = new Map();
for (const [nid, c] of self) {
  const f = byId.get(nid).callFrame;
  const url = f.url.replace(/^.*node_modules\//, "nm/").replace(/^.*agent-swarm\//, "");
  const key = `${f.functionName || "(anon)"} ${url}:${f.lineNumber}`;
  fn.set(key, (fn.get(key) || 0) + c);
  const m = url.startsWith("nm/") ? url.split("/").slice(0, url.startsWith("nm/@") ? 3 : 2).join("/") : url.split("/").slice(0, 2).join("/") || f.functionName;
  mod.set(m, (mod.get(m) || 0) + c);
}
const top = (map, n) => [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${((100 * v) / total).toFixed(1).padStart(5)}%  ${k}`).join("\n");
// Inclusive time per project (src/) function: walk each sample's stack once.
const parent = new Map(); for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
const incl = new Map();
for (const [nid, c] of self) {
  const seen = new Set();
  for (let cur = nid; cur !== undefined; cur = parent.get(cur)) {
    const f = byId.get(cur).callFrame;
    if (!f.url.includes("/agent-swarm/src/")) continue;
    const key = `${f.functionName || "(anon)"} ${f.url.replace(/^.*agent-swarm\//, "")}:${f.lineNumber + 1}`;
    if (seen.has(key)) continue; seen.add(key);
    incl.set(key, (incl.get(key) || 0) + c);
  }
}
console.log(`== inclusive, project code\n${top(incl, 20)}`);
console.log(`samples ${total}\n== by module\n${top(mod, 12)}\n== by function\n${top(fn, 15)}`);
