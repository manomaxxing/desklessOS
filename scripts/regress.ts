// Regression calls: real scripted calls against a fresh server, checked against
// what they must (and should) produce. Run before every merge.
//   npm run regress                      all scenarios in test/calls/<folder>/*.json
//   npm run regress -- pilot/02-briefing only these (scenarios before them in the same folder run too,
//                                        because later calls build on earlier memory)
//   npm run regress -- --keep            keep the scratch data dirs
//   npm run regress -- --show            print every conversation, not only failed ones
//
// Each folder gets its own server on a scratch DATA_DIR (memory in PGlite there), so
// scenarios in a folder share memory in file order. A folder's _seed/ is old-style JSON
// memory, moved in through scripts/migrate-json-to-pg.ts before the server starts. A scenario:
//   { "lang": "de", "says": ["…", "…"], "config": {…},
//     "must":   [ <check>, … ],   failing one fails the run
//     "should": [ <check>, … ] }  failing one only warns (models vary run to run)
// Checks: {"saved": true} {"hangup": true} {"event": "objective"} {"noEvent": "error"}
//   {"heard": "regex"} {"heardNext": "wait"} {"said": "regex"} {"note": "regex"}
//   {"falseStart": true} {"maxFirstAudioMs": 4000}
//   {"tool": "memory_search"}  the tool ran (status ok)    {"count": {"tool": 1}}  exactly n such events
//   {"notSaid": "regex"}  never said    {"maxQuestionsPerTurn": 1}  no turn of the agent asks more
//   {"hangupOnlyAfterBye": "regex"}  the agent hangs up only after his goodbye: his last words match, or
//                                    (the transcript of a last line can be off) every line of his was spoken
//   {"maxReplyGapMs": {"line": 1, "ms": 6500}}  the agent speaks within ms of the end of his line n
//   {"api": {"path": "/api/objectives", "match": "regex"}}  what the server says after the call
// "before": [{ "post": "/api/objectives", "body": {…} }] runs before the call (e.g. Max's question);
//   [{ "adminRequest": "Frag Niko, …" }] plans it like the admin page and approves the card;
//   [{ "conversation": { "mode": "next_inbound", "focus": "…" } }] the same for a talk about his day;
//   [{ "user": { phone, consentOutbound, callWindow } }] sets up the (first) user.
// "answer": "+49…" instead of calling: be that phone and wait for the server to call (OUTBOUND=fake).
// A folder's _config.json: { "env": { … } } for the server it needs ("{port}" is filled in).
// "carrier": "twilio": the call goes through the Twilio path (src/testing/caller.ts runTwilioCall).

import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, mkdtempSync, rmSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCall, answerCall, runTwilioCall, describeEvent } from "../src/testing/caller.ts";
import { locales } from "../src/locale/index.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const callsDir = path.join(root, "test", "calls");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const show = args.includes("--show");
const only = args.filter(a => !a.startsWith("--"));

const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
const re = s => new RegExp(s, "i");

// `saved` is the note the server stored for this call (fetched after its after-call job):
// the call's socket is closed by then, so its "saved" event never reaches the caller.
function check(spec: Record<string, any>, events, saved, api: Record<string, string> = {}, scenario = null) {
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
    case "notSaid": return !re(value).test(said);
    case "maxQuestionsPerTurn": {
      const perTurn = new Map();
      for (const e of of("say")) if (e.turn != null && !e.note?.startsWith("stage")) perTurn.set(e.turn, `${perTurn.get(e.turn) ?? ""} ${e.text}`);
      return [...perTurn.values()].every(t => (t.match(/\?/g) ?? []).length <= value);
    }
    case "maxReplyGapMs": {
      const line = of("caller_line").find(e => e.line === value.line);
      if (!line) return false;
      const end = line.at + line.seconds;
      const reply = of("say").find(e => e.at > end && !e.note?.startsWith("stage"));
      return Boolean(reply) && (reply.at - end) * 1000 <= value.ms;
    }
    case "hangupOnlyAfterBye": {
      const hangup = of("end_call")[0];
      if (!hangup) return true;
      const lines = of("caller_line");
      const allSpoken = lines.length > 0 && lines.length === lines.at(-1).line && lines.length === (scenario?.says?.length ?? -1) && hangup.at >= lines.at(-1).at;
      return allSpoken || re(value).test(of("heard").at(-1)?.text ?? "");
    }
    case "note": return Boolean(lastNote) && re(value).test(JSON.stringify(lastNote));
    case "falseStart": return of("barge_in").some(e => e.falseStart) === value;
    case "maxFirstAudioMs": { const p50 = median(of("latency").map(e => e.firstAudioMs)); return p50 != null && p50 <= value; }
    case "tool": return of("tool").some(e => e.name === value && e.status === "ok");
    case "count": return Object.entries(value).every(([name, n]) => of(name).length === n);
    case "api": return re(value.match).test(api[value.path] ?? "");
    default: throw new Error(`unknown check ${kind}`);
  }
}

const dbEnv = dataDir => ({ DATABASE_URL: `pglite:${path.join(dataDir, "pg")}` });

function startServer(dataDir, port, folderConfig: { env?: Record<string, unknown> } = {}) {
  const own = Object.fromEntries(Object.entries(folderConfig.env ?? {}).map(([k, v]) => [k, String(v).replace("{port}", port)])); // "{port}": this server's port
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), DEV_TOKEN: "", ADMIN_CODE: "", RECORD_CALLS: "0", OUTBOUND: "off", BACKGROUND: "inline", TICK_MS: "2000", TWILIO_ACCOUNT_SID: "", ...dbEnv(dataDir), ...own };
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "server.ts"], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
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
  const files = readdirSync(path.join(callsDir, folder)).filter(f => f.endsWith(".json") && !f.startsWith("_")).sort();
  const wanted = only.length ? files.filter((f, i) => files.slice(i).some(g => only.some(o => `${folder}/${g}`.startsWith(o)))) : files;
  if (!wanted.length) continue;
  const dataDir = mkdtempSync(path.join(tmpdir(), `regress-${folder}-`));
  const seed = path.join(callsDir, folder, "_seed");
  const configFile = path.join(callsDir, folder, "_config.json");
  const folderConfig = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")) : {};
  if (existsSync(seed)) {
    cpSync(seed, dataDir, { recursive: true });
    const r = spawnSync(process.execPath, ["--env-file-if-exists=.env", "scripts/migrate-json-to-pg.ts"], { cwd: root, env: { ...process.env, DATA_DIR: dataDir, ...dbEnv(dataDir) }, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`seed migration failed: ${r.stdout}${r.stderr}`);
  }
  const server = startServer(dataDir, ++port, folderConfig);
  try {
    await server.waitFor(/voice clips ready/, 60000).catch(err => {
      throw new Error(`${folder} server didn't start: ${err.message}\n${server.log.slice(-15).join("\n")}`);
    });
    // His number on file, as in production: the scripted caller dials from the locale's test
    // number, and a number that's nobody's gets an empty memory (src/memory/users.ts).
    {
      const { users } = await fetch(`http://localhost:${port}/api/users`).then((r): Promise<any> => r.json());
      const pilot = users.find(u => !u.demo);
      const res = await fetch(`http://localhost:${port}/api/users/${pilot.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: locales().get(locales().defaultId).testing?.from }) });
      if (!res.ok) throw new Error(`${folder}: couldn't put the test number on ${pilot.name}: ${res.status} ${await res.text()}`);
    }
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
        const post = async (p, body): Promise<any> => {
          const res = await fetch(`http://localhost:${port}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
          if (!res.ok) throw new Error(`before: POST ${p} → ${res.status} ${await res.text()}`);
          return res.json();
        };
        const before = async () => { for (const b of sc.before ?? []) {
          if (b.post) await post(b.post, b.body);
          if (b.user) {
            const { users } = await fetch(`http://localhost:${port}/api/users`).then((r): Promise<any> => r.json());
            await post(`/api/users/${users[0].id}`, b.user);
          }
          if (b.conversation) {
            const { request, confirmToken } = await post("/api/requests/conversation", b.conversation);
            await post(`/api/requests/${request.id}/approve`, { confirmToken });
          }
          if (b.adminRequest) {
            const { request, confirmToken } = await post("/api/requests", { instruction: b.adminRequest });
            if (!confirmToken) throw new Error(`before: the card can't be approved: ${JSON.stringify(request.card)}`);
            console.log(`\n   card: ${request.card.summary} · ${request.card.questions.map(q => `"${q.ask}"`).join(" ")}`);
            await post(`/api/requests/${request.id}/approve`, { confirmToken });
          }
        } };
        let callId;
        if (sc.carrier === "twilio") {
          // Through the Twilio path (signed webhook, TwiML, μ-law stream); checks go through the API.
          await before();
          ({ events, callId } = await runTwilioCall({ base: `http://localhost:${port}`, authToken: folderConfig.env?.TWILIO_AUTH_TOKEN, lang: sc.lang, says: sc.says }));
        } else if (sc.answer) {
          // Be the phone: listen first, then approve what makes the server call us.
          ({ events, callId } = await answerCall({ base: `ws://localhost:${port}`, number: sc.answer, beforeRing: before, lang: sc.lang, says: sc.says, config: sc.config ?? {} }));
        } else {
          await before();
          ({ events, callId } = await runCall({ url: `ws://localhost:${port}/dial`, lang: sc.lang, says: sc.says, config: sc.config ?? {}, from: sc.from }));
        }
        // Later scenarios build on this call's memory: wait for its after-call job.
        await server.waitFor(new RegExp(`\\[${callId.slice(-6)}\\] after-call done|job after_call after_call:${callId} failed|\\[${callId.slice(-6)}\\] finalize error`), 60000).catch(() => {});
        const notes = await fetch(`http://localhost:${port}/api/notes`).then((r): Promise<any> => r.json());
        saved = notes.find(n => n.call_id === callId) ?? null;
        // What happens after the call (objectives, requests, jobs) settles a moment after the memory step: poll.
        for (const spec of [...(sc.must ?? []), ...(sc.should ?? [])].filter(c => c.api)) {
          const until = Date.now() + 15000;
          do {
            api[spec.api.path] = await fetch(`http://localhost:${port}${spec.api.path}`).then(r => r.text());
            if (re(spec.api.match).test(api[spec.api.path])) break;
            await new Promise(r => setTimeout(r, 1000));
          } while (Date.now() < until);
        }
      } catch (err) { error = err; }
      const must = (sc.must ?? []).map(spec => ({ spec, ok: !error && check(spec, events, saved, api, sc) }));
      const should = (sc.should ?? []).map(spec => ({ spec, ok: !error && check(spec, events, saved, api, sc) }));
      const p50 = median(events.filter(e => e.event === "latency").map(e => e.firstAudioMs));
      const failed = Boolean(error) || must.some(m => !m.ok);
      results.push({ name, failed, must, should, p50, error });
      console.log(`${failed ? "FAIL" : "ok"} (${Math.round((Date.now() - started) / 1000)} s, first audio p50 ${p50 ?? "-"} ms)`);
      if (error) console.log(`   error: ${error.message}`);
      for (const m of must.filter(m => !m.ok)) console.log(`   must  ✗ ${JSON.stringify(m.spec)}`);
      for (const s of should.filter(s => !s.ok)) console.log(`   should ~ ${JSON.stringify(s.spec)}`);
      if (failed || show) {
        // The conversation, so a failure can be read without rerunning it.
        for (const e of events.filter(e => ["heard", "say", "tool", "tool_latency", "objective", "retry", "turn", "dangling", "end_call", "barge_in", "nudge", "heard_check", "prepared_dropped", "note_sent", "speculate", "speculation_used", "speculation_dropped", "recovered", "latency"].includes(e.event))) {
          console.log(`   ${e.at.toFixed(1).padStart(5)}s ${describeEvent(e) ?? e.event}`);
        }
      }
      const errors = events.filter(e => e.event === "error");
      for (const e of errors) console.log(`   server error: ${e.where}: ${e.message}`);
      // What the server logged that went wrong (the after-call job runs after the call's events end).
      if (failed) for (const line of server.log.filter(l => process.env.REGRESS_LOG || /error|failed|unhandled|uncaught/i.test(l)).slice(-40)) console.log(`   server log: ${line.slice(0, 300)}`);
    }
  } finally {
    server.stop();
    if (!keep) rmSync(dataDir, { recursive: true, force: true });
    else console.log(`   data kept in ${dataDir}`);
  }
}

const failed = results.filter(r => r.failed);
const warned = results.filter(r => r.should.some(s => !s.ok));
console.log(`\n${results.length - failed.length}/${results.length} passed${warned.length ? `, ${warned.length} with warnings` : ""}`);
process.exit(failed.length ? 1 : 0);
