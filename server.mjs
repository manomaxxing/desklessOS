// DesklessOS server. One WebSocket protocol (Dial's self-hosted audio
// protocol), two kinds of caller:
//   - Dial, on a real phone call: wss://<host>/dial/<call_id>, signed with
//     X-Dial-Signature (HMAC-SHA256 over "<t>.<call_id>").
//   - The browser test page (web/index.html), which pretends to be Dial:
//     ws://localhost:8787/dial/<id>?dev=1 and also receives debug frames.
//
//   npm run dev            → http://localhost:8787
//   npm run tunnel         → public https URL for Dial (cloudflared)

import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { geminiEndpoint } from "./src/engine/gemini-endpoint.mjs";
import { createFish } from "./src/engine/fish.mjs";
import { createCallSession } from "./src/engine/session.mjs";
import { createLiveSession } from "./src/engine/live-session.mjs";
import { warmModel, extractJsonResilient } from "./src/engine/gemini.mjs";
import { createAuth } from "./src/admin/auth.mjs";
import { createRequests } from "./src/admin/requests.mjs";
import { createNotifier } from "./src/notify.mjs";
import { createGeminiTts } from "./src/engine/gemini-tts.mjs";
import { typingLoop } from "./src/engine/ambience.mjs";
import { gain } from "./src/engine/audio.mjs";
import { locales } from "./src/locale/index.mjs";
import { consolidateCall } from "./src/engine/consolidate.mjs";
import { createMonitor } from "./src/monitor.mjs";
import { openMemory } from "./src/memory/index.mjs";
import { createCallHost } from "./src/telephony/host.mjs";
import { dialAdapter } from "./src/telephony/dial.mjs";
import { twilioAdapter } from "./src/telephony/twilio.mjs";
import { fakeAdapter } from "./src/telephony/fake.mjs";
import { createScheduler } from "./src/jobs/scheduler.mjs";
import { createTurnDetector } from "./src/engine/turn-detector.mjs";
import { adminTools } from "./src/tools/admin.mjs";
import { loadSkillFromTemplates } from "./src/skills/from-templates.mjs";
import { e164 } from "./src/memory/pg.mjs";
import { loadSkill } from "./src/skills/index.mjs";
import { createCalendar } from "./src/store/calendar.mjs";
import { createQuotes } from "./src/store/quotes.mjs";
import { createOffice } from "./src/workflow/order.mjs";
import { renderQuoteHtml } from "./src/workflow/quote-template.mjs";
import { renameSync, mkdirSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const SECRET = process.env.DIAL_SIGNING_SECRET?.trim() || "";
const DEV_TOKEN = process.env.DEV_TOKEN?.trim() || "";
const RECONNECT_GRACE_MS = 20000; // Dial re-dials for ~15 s after a drop
const SKILL = process.env.SKILL || "pilot";
const skill = await loadSkill(SKILL);

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const endpoint = geminiEndpoint();
const fish = createFish();
const monitor = createMonitor();
// Notes, customers, to-dos, the pilot's research, objectives ("find out X"):
// MEMORY_BACKEND=json (DATA_DIR files) or pg (DATABASE_URL). Calendar and quotes stay JSON.
const memory = await openMemory({ skill, endpoint, log });
// Admin: login (ADMIN_CODE + TOTP), and requests: "find out X" → plan → card → approve → result.
const auth = createAuth();
const notifier = createNotifier();
const plannerModels = [process.env.PLANNER_MODEL, MODEL, "gemini-2.5-flash"];
const requests = createRequests({
  memory, skill, auth, notifier, publicUrl: process.env.PUBLIC_URL ?? "", log,
  onCancel: objectiveId => scheduler?.cancelFor(objectiveId),
  outbound: () => Boolean(scheduler),
  llm: args => extractJsonResilient({ endpoint, models: plannerModels, think: true, timeoutMs: 45000, retries429: 2, ...args }),
});
const calendar = createCalendar();
const quotes = createQuotes();
const company = JSON.parse(readFileSync(path.join(here, "config", "company.json"), "utf8"));
const catalog = JSON.parse(readFileSync(path.join(here, "config", "catalog.json"), "utf8"));
const office = SKILL === "office" ? createOffice({ company, catalog, calendar, quotes }) : null;

// Demo reset: move all data aside (data/backups/<time>/) and start clean
// (on Postgres, memory's rows are deleted: the demo's database only).
async function resetDemo() {
  const root = process.env.DATA_DIR || "data";
  const backup = path.join(root, "backups", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(backup, { recursive: true });
  for (const sub of ["notes", "memory", "discovery", "calls", "calendar", "quotes", "agenda"]) {
    try { renameSync(path.join(root, sub), path.join(backup, sub)); } catch {}
  }
  for (const s of [calendar, quotes, monitor]) s.reset();
  await memory.reset();
  return backup;
}
const geminiTts = endpoint ? createGeminiTts({ endpoint }) : null;

// Modes for the selector. The phone default applies to real Dial calls; the
// browser test phone sends its own choice with each call.
const MODES = {
  engines: ["cascade", "live"],
  models: ["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  tts: ["fish", "gemini"],
  masks: ["typing", "filler", "none"],
  // Probed 2026-10-11: all four connect; Vertex EU keeps audio in the EU and runs on the Vertex credits.
  liveModels: (process.env.LIVE_MODELS || "vertex-eu:gemini-3.8-live,vertex@us-central1:gemini-3.8-live,studio:gemini-3.8-live,vertex@europe-west4:gemini-live-2.5-flash-native-audio").split(","),
  liveVoices: ["Kore", "Aoede", "Leda", "Zephyr", "Callirrhoe", "Puck", "Charon", "Fenrir", "Orus", "Achird"],
};
let phoneConfig = { engine: process.env.ENGINE || "cascade", model: MODEL, tts: "fish", mask: process.env.MASK || "typing", liveModel: MODES.liveModels[0], liveVoice: "Kore" };
if (!endpoint) throw new Error("no Gemini: set GOOGLE_CLOUD_PROJECT (Vertex) or GEMINI_API_KEY");
if (!fish) throw new Error("no Fish: set FISH_AUDIO_API_KEY");

// Gemini auth before the first caller, and ahead of token expiry.
const warmGemini = () => endpoint.warm().then(() => warmModel({ endpoint, model: MODEL })).catch(err => log("gemini warm-up failed:", err.message));
warmGemini();
setInterval(warmGemini, 5 * 60 * 1000).unref();

// Max's own line (phase 7): calls from ADMIN_PHONE get the admin persona (personas/admin.md):
// draft requests, approve them with ADMIN_PIN, hear the answers. Nothing goes into memory.
const adminPhones = new Set((process.env.ADMIN_PHONE ?? "").split(",").map(e164).filter(Boolean));
const adminSkill = adminPhones.size ? loadSkillFromTemplates("admin") : null;
const isAdminCaller = from => adminPhones.has(e164(from));

// Pre-synthesised clips per language and persona: the greeting plays the instant a call connects.
const assets = {};
const adminAssets = {};
const synthPersona = (persona, target) => Promise.all(
  locales().enabled().map(async lang => {
    const lines = locales().persona(lang, persona);
    const synth = text => fish.synth(text, { lang }).catch(err => { log(`asset synth failed (${lang}):`, text, err.message); return null; });
    const oopsLines = [].concat(lines.oops);
    const [greeting, outboundGreeting, wrapUp, mhm, working, looking, ...rest] = await Promise.all([lines.greeting, lines.outboundGreeting ?? "", lines.wrapUp, lines.backchannel ?? "", lines.working ?? "", lines.looking ?? "", ...oopsLines, ...lines.fillers].map(t => (t ? synth(t) : null)));
    // The backchannel plays while he's still thinking, so it's quieter than the agent's own turns.
    // working / looking: said before a tool runs when the model called it without a word.
    target[lang] = { greeting, outboundGreeting, wrapUp, backchannel: mhm && gain(mhm, 0.5), working, looking, oops: rest.slice(0, oopsLines.length).filter(Boolean), fillers: rest.slice(oopsLines.length).filter(Boolean) };
  }),
);
const assetsReady = Promise.all([synthPersona(skill.PERSONA, assets), adminSkill && synthPersona(adminSkill.PERSONA, adminAssets)])
  .then(() => log(`voice assets ready (${locales().enabled().map(l => `${l}: ${assets[l].fillers.length} fillers, ${assets[l].oops.length} oops`).join("; ")}${adminSkill ? "; admin line too" : ""})`));
assets.typing = typingLoop();
adminAssets.typing = assets.typing;

// Memory updates that failed during a call (API down) are retried here.
async function retryPending() {
  try {
    for (const { job, scope, done, failed } of await memory.pendingConsolidations()) {
      try {
        const { changed } = await consolidateCall({ endpoint, model: MODEL, skill, memory: scope, ...job });
        await done();
        monitor.system(`memory retry ok for ${job.callId}: +${changed.added.length} to-dos, ${changed.completed.length} done`);
      } catch (err) {
        await failed(err);
        log("memory retry failed", job.callId, err.message);
      }
    }
  } catch (err) {
    log("memory retry error", err.message);
  }
}
setTimeout(retryPending, 10000);
// The admin's outbox: results he hasn't been told about yet (webhook / email).
setInterval(() => requests.flushNotifications().catch(err => log("notify error", err.message)), 60 * 1000).unref();
setInterval(retryPending, 5 * 60 * 1000).unref();

const describe = c => (c.engine === "live" ? `Gemini Live · ${c.liveModel} · ${c.liveVoice}` : `${c.model} + ${c.tts === "gemini" ? "Gemini TTS" : "Fish"} · ${c.mask}`);

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

// With DEV_TOKEN set (do that on a public deploy), the API, monitor and test phone need ?token=.
// An admin session (Authorization: Bearer …, or ?token= for the monitor's links) opens it too.
const adminToken = (req, url) => req?.headers.authorization?.replace(/^Bearer\s+/i, "") || url.searchParams.get("token");
const authorized = (url, req = null) => !DEV_TOKEN || url.searchParams.get("token") === DEV_TOKEN || Boolean(auth.session(adminToken(req, url)));
// Admin routes: an admin session once ADMIN_CODE is set; before that, the dev rule above.
const isAdmin = (req, url) => (auth.enabled ? Boolean(auth.session(adminToken(req, url))) : authorized(url, req));
const readBody = req => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(Object.assign(new Error("not JSON"), { status: 400 })); } });
  req.on("error", reject);
});
const clientIp = req => req.headers["fly-client-ip"] || req.socket.remoteAddress || "?";
const json = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };

const server = http.createServer((req, res) => {
  route(req, res).catch(err => { log("http error", req.url, err.message); if (!res.headersSent) json(res, { error: err.message }, 500); });
});
async function route(req, res) {
  const url = new URL(req.url, "http://x");
  for (const a of adapters) if (a.http && (await a.http(req, res, url))) return; // Twilio's webhooks carry their own signature
  if (url.pathname === "/api/admin/login" && req.method === "POST") {
    const { code, totp } = await readBody(req);
    const out = auth.login({ code, totp, ip: clientIp(req) });
    if (out.error) log(`admin login refused (${out.status})`);
    return json(res, out.error ? { error: out.error } : out, out.status ?? 200);
  }
  if (url.pathname === "/admin") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(path.join(here, "web", "admin.html")));
  }
  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health" && !authorized(url, req)) return json(res, { error: "token required" }, 401);
  if (url.pathname === "/api/admin/me") return json(res, { admin: isAdmin(req, url), login: auth.enabled, twoFactor: auth.twoFactor, notify: notifier.channels });
  if (/^\/api\/(requests|users|objectives|jobs)/.test(url.pathname) && !isAdmin(req, url)) return json(res, { error: "admin login required" }, 401);
  if (url.pathname === "/api/users") return json(res, { users: await memory.listUsers(), outbound: Boolean(scheduler) });
  const userMatch = url.pathname.match(/^\/api\/users\/([\w-]+)$/);
  if (userMatch && req.method === "POST") {
    try {
      const u = await memory.updateUser(userMatch[1], await readBody(req));
      if (u) monitor.system(`person ${u.name}: phone ${u.phone || "-"}, outbound calls ${u.consentOutboundAt ? "agreed" : "not agreed"}${u.outboundPaused ? " (paused)" : ""}`);
      return u ? json(res, { user: u }) : json(res, { error: "no such person" }, 404);
    } catch (err) { return json(res, { error: err.message }, err.status ?? 500); }
  }
  if (url.pathname === "/api/jobs") return json(res, { jobs: scheduler ? await scheduler.list() : [], outbound: Boolean(scheduler) });
  if (url.pathname === "/api/requests") {
    if (req.method !== "POST") return json(res, { requests: (await requests.list()).map(r => requests.view(r)) });
    try { return json(res, await requests.plan({ instruction: (await readBody(req)).instruction, by: "admin" }), 201); }
    catch (err) { return json(res, { error: err.message }, err.status ?? 502); }
  }
  const requestMatch = url.pathname.match(/^\/api\/requests\/(req_[\w-]+)(?:\/(revise|approve|cancel))?$/);
  if (requestMatch) {
    const [, id, action] = requestMatch;
    try {
      if (!action) { const r = await requests.get(id); return r ? json(res, requests.view(r)) : json(res, { error: "no such request" }, 404); }
      if (req.method !== "POST") return json(res, { error: "POST" }, 405);
      const body = await readBody(req);
      if (action === "revise") return json(res, await requests.revise(id, body));
      if (action === "approve") { const r = await requests.approve(id, body); monitor.system(`request ${id} approved: ${r.card.summary || r.instruction}`); return json(res, { request: r }); }
      return json(res, { request: await requests.cancel(id) });
    } catch (err) { return json(res, { error: err.message }, err.status ?? 500); }
  }
  if (url.pathname === "/api/calls") return json(res, { calls: monitor.list(), system: monitor.systemLog(), recording: monitor.record });
  if (url.pathname === "/api/config") {
    if (req.method === "POST") {
      let body = "";
      req.on("data", c => (body += c));
      req.on("end", () => {
        try {
          const next = { ...phoneConfig, ...JSON.parse(body || "{}") };
          if (!MODES.engines.includes(next.engine)) throw new Error("bad engine");
          phoneConfig = next;
          monitor.system(`phone calls now use ${describe(phoneConfig)}`);
          json(res, { phone: phoneConfig, modes: MODES });
        } catch (err) { json(res, { error: err.message }, 400); }
      });
      return;
    }
    return json(res, { phone: phoneConfig, modes: MODES });
  }
  if (url.pathname === "/api/memory") return json(res, await memory.memoryOverview());
  if (url.pathname === "/api/discovery") {
    const overview = await memory.discoveryOverview();
    return overview ? json(res, overview) : json(res, { error: `no research framework in skill ${SKILL}` }, 404);
  }
  if (url.pathname === "/api/catalog") return json(res, { company: { name: company.name, vatRate: company.vatRate }, catalog });
  if (url.pathname === "/api/calendar") return json(res, { events: calendar.list({ from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined }) });
  if (url.pathname === "/api/quotes") return json(res, { quotes: quotes.list(), outbox: quotes.outbox(), company: { name: company.name } });
  if (url.pathname === "/api/demo/reset" && req.method === "POST") {
    const backup = await resetDemo();
    monitor.system(`demo reset; previous data moved to ${backup}`, "warn");
    return json(res, { ok: true, backup });
  }
  // Objectives: GET lists them; POST { template: "inquiry", params: { questions: [{ ask, probe? }], purpose? }, mode?, priority?, lang? }.
  if (url.pathname === "/api/objectives") {
    if (req.method !== "POST") return json(res, { objectives: await memory.objectives.list(), templates: [...skill.templates.values()].filter(t => t.kind === "objective" && t.params).map(({ id, version, description, params, modes }) => ({ id, version, description, params, modes })) });
    let body = "";
    req.on("data", c => (body += c));
    req.on("end", async () => {
      try {
        const o = await memory.objectives.create({ ...JSON.parse(body || "{}"), createdBy: "api" });
        monitor.system(`objective ${o.id} (${o.template}): ${o.params.questions?.map(q => q.ask).join(" / ") ?? ""}`);
        json(res, { objective: o }, 201);
      } catch (err) { json(res, { error: err.message }, 400); }
    });
    return;
  }
  const objectiveMatch = url.pathname.match(/^\/api\/objectives\/([^/]+)\/cancel$/);
  if (objectiveMatch && req.method === "POST") {
    const o = await memory.objectives.cancel(decodeURIComponent(objectiveMatch[1]));
    return o ? json(res, { objective: o }) : json(res, { error: "unknown objective" }, 404);
  }
  const quoteMatch = url.pathname.match(/^\/quote\/([^/]+)$/);
  if (quoteMatch) {
    if (!authorized(url)) return json(res, { error: "token required" }, 401);
    const q = quotes.get(decodeURIComponent(quoteMatch[1]));
    if (!q) return json(res, { error: "unknown quote" }, 404);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(renderQuoteHtml(q, company));
  }
  const actionMatch = url.pathname.match(/^\/api\/actions\/([^/]+)$/);
  if (actionMatch && req.method === "POST") {
    const status = url.searchParams.get("status");
    const a = await memory.setTaskStatus(decodeURIComponent(actionMatch[1]), status);
    if (a) monitor.system(`to-do ${status === "done" ? "ticked off" : "reopened"} in the UI: ${a.customerName}: ${a.text}`);
    return a ? json(res, a) : json(res, { error: "unknown action" }, 404);
  }
  const callMatch = url.pathname.match(/^\/api\/calls\/([^/]+)(?:\/audio\/([^/]+))?$/);
  if (callMatch) {
    const id = decodeURIComponent(callMatch[1]);
    if (callMatch[2]) {
      const file = monitor.audioFile(id, decodeURIComponent(callMatch[2]));
      if (!file) return json(res, { error: "no audio" }, 404);
      res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" });
      return res.end(readFileSync(file));
    }
    const call = monitor.get(id);
    return call ? json(res, call) : json(res, { error: "unknown call" }, 404);
  }
  if (url.pathname === "/monitor") {
    if (!authorized(url, req)) return json(res, { error: "token required" }, 401);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(path.join(here, "web", "monitor.html")));
  }
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, gemini: endpoint.door, model: MODEL, fishModel: fish.model, dialSigned: Boolean(SECRET), sessions: host.calls.size }));
  }
  if (url.pathname === "/api/notes") return json(res, (await memory.listNotes()).map(({ transcript, ...n }) => ({ ...n, turns: transcript?.length ?? 0 })));
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = path.join(here, "web", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  if (full.startsWith(path.join(here, "web")) && existsSync(full)) {
    res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream", "cache-control": "no-store" });
    return res.end(readFileSync(full));
  }
  res.writeHead(404).end("not found");
}

// ---------- calls: lines from Dial, Twilio and the test phone, one host ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });

// One call: what we know about the caller (read once, within a budget), its agenda
// (his capabilities plus what the agent brings), and the engine.
// Max on his own line: the admin persona, the request tools, and a memory that keeps nothing.
function startAdminCall({ id, msg, send, dev, config }) {
  monitor.system(`call ${id}: Max on the admin line`);
  const nothing = async () => null;
  const scope = {
    user: null, context: "", hidden: 0, discovery: null, objectives: [], consolidates: false,
    search: async () => [], saveNote: nothing, endCall: nothing, snapshot: async () => ({}), apply: async () => ({ skipped: true }),
    consolidationFailed: nothing, upsertCustomer: nothing, addAction: nothing, recordObjectives: async () => [], recordToolRun: nothing,
  };
  const session = createCallSession({
    send, dev, skill: adminSkill, agenda: adminSkill.createAgenda(), endpoint, extractModel: MODEL, memory: scope, office: null, config: { ...config, engine: "cascade" },
    model: MODEL, fish, geminiTts, assets: adminAssets, turnDetector, tools: adminTools({ requests, auth }),
    log: (...a) => log(`[${id.slice(-6)}]`, ...a), onEvent: ev => monitor.event(id, ev), onEnd: reason => monitor.end(id, reason),
    recordDir: monitor.record ? callId => monitor.audioDir(callId) : null,
  });
  return { session, userId: null };
}

async function startCall({ id, msg, send, dev, source }) {
  await assetsReady;
  const outbound = msg.direction === "outbound";
  const config = { ...phoneConfig, ...(dev && msg.config ? msg.config : {}) };
  if (!outbound && adminSkill && isAdminCaller(msg.from)) {
    monitor.start({ id, from: msg.from, to: msg.to, lang: null, mode: "admin line", source });
    return startAdminCall({ id, msg, send, dev, config });
  }
  monitor.start({ id, from: msg.from, to: msg.to, lang: null, mode: describe(config), source: source === "dev" ? (/-browser$/.test(msg.from ?? "") ? "browser" : "script") : source });
  const scope = await memory.openCall({ callId: id, from: outbound ? msg.to : msg.from, to: outbound ? msg.from : msg.to, userId: msg.user_id ?? null, direction: outbound ? "outbound" : "inbound" });
  if (scope.stats) monitor.event(id, { event: "context", ...scope.stats });
  if (!scope.user) monitor.system(`call ${id}: unknown caller ${msg.from ?? "?"}: empty memory, nothing saved`, "warn");
  const agenda = skill.createAgenda({ objectives: scope.objectives, discovery: scope.discovery, direction: outbound ? "outbound" : "inbound" });
  if (agenda.objectives.length) monitor.system(`call ${id}: agenda ${agenda.objectives.map(o => o.stored ? `${o.template.id} ${o.id}` : o.template.id).join(", ")}`);
  const common = {
    send, dev, skill, agenda, endpoint, extractModel: MODEL, memory: scope, office, config,
    log: (...a) => log(`[${id.slice(-6)}]`, ...a),
    onEvent: ev => monitor.event(id, ev),
    onEnd: reason => {
      scope.recordObjectives(agenda.results()).then(async changed => {
        for (const o of changed) monitor.system(`objective ${o.id}: ${o.status}${o.result?.questions ? ` · ${o.result.questions.map(q => `${q.id} ${q.status}${q.answer ? `: ${q.answer}` : ""}`).join("; ")}` : ""}`);
        for (const r of await requests.objectivesChanged(changed)) if (r.status !== "approved") monitor.system(`request ${r.id}: ${r.status}`);
        if (outbound) await scheduler?.callEnded({ callId: id, reason, outcome: agenda.callOutcome?.() ?? null, objectives: agenda.results() });
      }).catch(err => log("after-call error", err.message));
      monitor.end(id, reason);
    },
    recordDir: monitor.record ? callId => monitor.audioDir(callId) : null,
  };
  const cascade = (extra = {}) => createCallSession({ ...common, model: MODEL, fish, geminiTts, assets, turnDetector, ...extra, config: { ...config, engine: "cascade" } });
  // Calls the agent makes run on the cascade engine (it handles the outbound opening).
  // A call we made speaks his language from the start (our own number says nothing about him).
  if (config.engine !== "live" || outbound) return { session: cascade(outbound && scope.user?.lang ? { initialLang: scope.user.lang } : {}), userId: scope.user?.id ?? null };
  // If Gemini Live fails (setup refused, socket drop), carry the call on with the cascade engine.
  const holder = { session: null, userId: scope.user?.id ?? null };
  const live = createLiveSession({
    ...common,
    assets,
    onFatal: ({ reason, turns, lang, greeted }) => {
      monitor.system(`Live failed on ${id}: ${reason} → continuing on ${MODEL} + Fish`, "warn");
      live.abandon();
      const next = cascade({ initialTurns: turns, initialLang: lang });
      next.handle({ ...msg, reconnect: greeted });
      session.current = next;
    },
  });
  // The host keeps one object per call; Live may hand the call to the cascade engine mid-call.
  const session = { current: live, handle: m => session.current.handle(m), close: r => session.current.close(r), get ended() { return session.current.ended; } };
  holder.session = session;
  return holder;
}

// Smart Turn v3 (TURN_DETECTOR=smart-turn): hears in his voice whether he's done.
const turnDetector = process.env.TURN_DETECTOR === "smart-turn" ? await createTurnDetector({ log }) : null;
const host = createCallHost({ startCall, monitor, log, graceMs: RECONNECT_GRACE_MS });
let scheduler = null; // outbound calls: set up below when a carrier can dial out
const onStatus = status => scheduler?.callStatus(status).catch(err => log("call status error", err.message));
const twilio = twilioAdapter({ host, wss, onStatus, monitor, log });
const fakeCarrier = process.env.OUTBOUND === "fake" ? fakeAdapter({ wss, devToken: DEV_TOKEN, onStatus, monitor, log }) : null;
const adapters = [dialAdapter({ host, wss, secret: SECRET, devToken: DEV_TOKEN, monitor, log }), twilio, fakeCarrier].filter(Boolean);

// Outbound calls (OUTBOUND=twilio, or fake for tests): only on Postgres memory, where users
// carry their consent, call times and phone number.
const carrier = process.env.OUTBOUND === "fake" ? fakeCarrier : process.env.OUTBOUND === "off" ? null : twilio;
if (carrier && memory.kind === "pg") {
  scheduler = createScheduler({ memory, carrier, host, requests, log, monitor, tickMs: Number(process.env.SCHEDULER_TICK_MS || 30000) });
  scheduler.start();
  log(`outbound calls: on (${carrier.id}${carrier.number ? ` from ${carrier.number}` : ""})`);
} else if (carrier) {
  log("outbound calls: off (they need MEMORY_BACKEND=pg)");
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/monitor-ws") {
    if (!authorized(url, req)) return socket.destroy();
    return wss.handleUpgrade(req, socket, head, ws => {
      const unsubscribe = monitor.subscribe(msg => ws.readyState === 1 && ws.send(JSON.stringify(msg)));
      ws.on("close", unsubscribe);
    });
  }
  for (const a of adapters) if (a.upgrade?.(req, socket, head, url)) return;
  socket.destroy();
});

server.listen(PORT, () => log(`DesklessOS on http://localhost:${PORT}  (skill: ${SKILL}, gemini: ${endpoint.door} ${MODEL}, fish: ${fish.model}, dial signature: ${SECRET ? "required" : "OFF"})`));
