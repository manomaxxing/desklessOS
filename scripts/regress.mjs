// Regression calls: real scripted calls against a fresh server, checked against
// what they must (and should) produce. Run before every merge.
//   npm run regress                      all scenarios in test/calls/<skill>/*.json
//   npm run regress -- pilot/02-briefing only these (scenarios before them in the same skill run too,
//                                        because later calls build on earlier memory)
//   npm run regress -- --keep            keep the scratch data dirs
//   npm run regress -- --show            print every conversation, not only failed ones
//   npm run regress -- --backend pg      memory on Postgres (PGlite in each scratch dir; seeds go
//                                        through scripts/migrate-json-to-pg.mjs first)
//
// Each folder gets its own server (SKILL=<dir name>) on a scratch DATA_DIR, so
// scenarios in a folder share memory in file order. "pilot+memory" runs SKILL=pilot
// and starts from a copy of its _seed/ directory (an existing DATA_DIR). A scenario:
//   { "lang": "de", "says": ["…", "…"], "config": {…},
//     "must":   [ <check>, … ],   failing one fails the run
//     "should": [ <check>, … ] }  failing one only warns (models vary run to run)
// Checks: {"saved": true} {"hangup": true} {"event": "workflow"} {"noEvent": "error"}
//   {"heard": "regex"} {"heardNext": "wait"} {"said": "regex"} {"note": "regex"}
//   {"falseStart": true} {"maxFirstAudioMs": 4000}
//   {"tool": "order_execute"}  the tool ran (status ok)    {"count": {"workflow": 1}}  exactly n such events
//   {"api": {"path": "/api/objectives", "match": "regex"}}  what the server says after the call
// "before": [{ "post": "/api/objectives", "body": {…} }] runs before the call (e.g. Max's question);
//   [{ "adminRequest": "Frag Niko, …" }] plans it like the admin page and approves the card.

import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, rmSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCall, describeEvent } from "../src/testing/caller.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const callsDir = path.join(root, "test", "calls");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const show = args.includes("--show");
const backend = args.includes("--backend") ? args[args.indexOf("--backend") + 1] : "json";
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--backend");

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const re = s => new RegExp(s, "i");

// `saved` is the note the server stored for this call (fetched after the post-call step):
// the call's socket is closed by then, so its "saved" event never reaches the caller.
function check(spec, events, saved, api = {}) {
  const of = name => events.filter(e => e.event === name);
  const said = of("say").filter(e => !e.note?.startsWith("stage")).map(e => e.text).join(" ");
  const lastNote = saved ?? of("note").at(-1)?.note;
  const [[kind, value]] = Object.entries(spec);
  switch (kind) {
    case "saved": return Boolean(saved) === value;
    case "hangup": return of("end_call").length > 0 === value;
    case "event": return of(value).length > 0;
    case "noEvent": return of(value).length === 0;
    case "heard": return of("heard").some(e => re(value).test(e.text ?? ""));
    case "heardNext": return of("heard").some(e => e.next === value) || (value === "wait" && of("dangling").length > 0);
    case "said": return re(value).test(said);
    case "note": return Boolean(lastNote) && re(value).test(JSON.stringify(lastNote));
    case "falseStart": return of("barge_in").some(e => e.falseStart) === value;
    case "maxFirstAudioMs": { const p50 = median(of("latency").map(e => e.firstAudioMs)); return p50 != null && p50 <= value; }
    case "tool": return of("tool").some(e => e.name === value && e.status === "ok");
    case "count": return Object.entries(value).every(([name, n]) => of(name).length === n);
    case "api": return re(value.match).test(api[value.path] ?? "");
    default: throw new Error(`unknown check ${kind}`);
  }
}

const backendEnv = dataDir => (backend === "pg" ? { MEMORY_BACKEND: "pg", DATABASE_URL: `pglite:${path.join(dataDir, "pg")}` } : { MEMORY_BACKEND: "json" });

function startServer(skill, dataDir, port) {
  const env = { ...process.env, SKILL: skill, DATA_DIR: dataDir, PORT: String(port), DEV_TOKEN: "", RECORD_CALLS: "0", ...backendEnv(dataDir) };
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "server.mjs"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  const waiters = [];
  const onData = chunk => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      log.push(line);
      for (const w of [...waiters]) if (w.test(line)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(line); }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const waitFor = (pattern, ms) => new Promise((resolve, reject) => {
    const hit = log.find(l => pattern.test(l));
    if (hit) return resolve(hit);
    const w = { test: l => pattern.test(l), resolve };
    waiters.push(w);
    setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) { waiters.splice(i, 1); reject(new Error(`timeout waiting for ${pattern}`)); } }, ms);
  });
  return { child, log, waitFor, stop: () => child.kill() };
}

const folders = readdirSync(callsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
const results = [];
let port = 8890;
for (const folder of folders) {
  const skill = folder.split("+")[0];
  const files = readdirSync(path.join(callsDir, folder)).filter(f => f.endsWith(".json")).sort();
  const wanted = only.length ? files.filter((f, i) => files.slice(i).some(g => only.some(o => `${folder}/${g}`.startsWith(o)))) : files;
  if (!wanted.length) continue;
  const dataDir = mkdtempSync(path.join(tmpdir(), `regress-${folder}-`));
  const seed = path.join(callsDir, folder, "_seed");
  if (existsSync(seed)) cpSync(seed, dataDir, { recursive: true });
  if (existsSync(seed) && backend === "pg") {
    const r = spawnSync(process.execPath, ["--env-file-if-exists=.env", "scripts/migrate-json-to-pg.mjs"], { cwd: root, env: { ...process.env, SKILL: skill, DATA_DIR: dataDir, ...backendEnv(dataDir) }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`seed migration failed: ${r.stdout}${r.stderr}`);
  }
  const server = startServer(skill, dataDir, ++port);
  try {
    await server.waitFor(/voice assets ready/, 60000).catch(err => {
      throw new Error(`${skill} server didn't start: ${err.message}\n${server.log.slice(-15).join("\n")}`);
    });
    for (const file of wanted) {
      const name = `${folder}/${file.replace(/\.json$/, "")}`;
      const sc = JSON.parse(readFileSync(path.join(callsDir, folder, file), "utf8"));
      process.stdout.write(`${name} … `);
      const started = Date.now();
      let events = [];
      let saved = null;
      let error = null;
      const api = {};
      try {
        const post = async (p, body) => {
          const res = await fetch(`http://localhost:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
          if (!res.ok) throw new Error(`before: POST ${p} → ${res.status} ${await res.text()}`);
          return res.json();
        };
        for (const b of sc.before ?? []) {
          if (b.post) await post(b.post, b.body);
          if (b.adminRequest) {
            const { request, confirmToken } = await post("/api/requests", { instruction: b.adminRequest });
            if (!confirmToken) throw new Error(`before: the card can't be approved: ${JSON.stringify(request.card)}`);
            console.log(`\n   card: ${request.card.summary} · ${request.card.questions.map(q => `"${q.ask}"`).join(" ")}`);
            await post(`/api/requests/${request.id}/approve`, { confirmToken });
          }
        }
        let callId;
        ({ events, callId } = await runCall({ url: `ws://localhost:${port}/dial`, lang: sc.lang, says: sc.says, config: sc.config ?? {}, from: sc.from }));
        // Later scenarios build on this call's memory: wait for the post-call step.
        await server.waitFor(new RegExp(`\\[${callId.slice(-6)}\\] (memory:|memory error|finalize error)`), 45000).catch(() => {});
        const notes = await fetch(`http://localhost:${port}/api/notes`).then(r => r.json());
        saved = notes.find(n => n.call_id === callId) ?? null;
        for (const spec of [...(sc.must ?? []), ...(sc.should ?? [])].filter(c => c.api)) {
          api[spec.api.path] ??= await fetch(`http://localhost:${port}${spec.api.path}`).then(r => r.text());
        }
      } catch (err) { error = err; }
      const must = (sc.must ?? []).map(spec => ({ spec, ok: !error && check(spec, events, saved, api) }));
      const should = (sc.should ?? []).map(spec => ({ spec, ok: !error && check(spec, events, saved, api) }));
      const p50 = median(events.filter(e => e.event === "latency").map(e => e.firstAudioMs));
      const failed = Boolean(error) || must.some(m => !m.ok);
      results.push({ name, failed, must, should, p50, error });
      console.log(`${failed ? "FAIL" : "ok"} (${Math.round((Date.now() - started) / 1000)} s, first audio p50 ${p50 ?? "-"} ms)`);
      if (error) console.log(`   error: ${error.message}`);
      for (const m of must.filter(m => !m.ok)) console.log(`   must  ✗ ${JSON.stringify(m.spec)}`);
      for (const s of should.filter(s => !s.ok)) console.log(`   should ~ ${JSON.stringify(s.spec)}`);
      if (failed || show) {
        // The conversation, so a failure can be read without rerunning it.
        for (const e of events.filter(e => ["heard", "say", "tool", "tool_latency", "workflow", "objective", "retry", "end_call", "barge_in", "nudge"].includes(e.event))) {
          console.log(`   ${e.at.toFixed(1).padStart(5)}s ${describeEvent(e) ?? e.event}`);
        }
      }
      const errors = events.filter(e => e.event === "error");
      for (const e of errors) console.log(`   server error: ${e.where}: ${e.message}`);
    }
  } finally {
    server.stop();
    if (!keep) rmSync(dataDir, { recursive: true, force: true });
    else console.log(`   data kept in ${dataDir}`);
  }
}

const failed = results.filter(r => r.failed);
const warned = results.filter(r => r.should.some(s => !s.ok));
console.log(`\n${results.length - failed.length}/${results.length} passed${warned.length ? `, ${warned.length} with warnings` : ""} (memory: ${backend})`);
process.exit(failed.length ? 1 : 0);
