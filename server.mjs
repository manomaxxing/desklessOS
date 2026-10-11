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
import { createHmac, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { geminiEndpoint } from "./src/engine/gemini-endpoint.mjs";
import { createFish } from "./src/engine/fish.mjs";
import { createCallSession } from "./src/engine/session.mjs";
import { createLiveSession } from "./src/engine/live-session.mjs";
import { warmModel } from "./src/engine/gemini.mjs";
import { createGeminiTts } from "./src/engine/gemini-tts.mjs";
import { typingLoop } from "./src/engine/ambience.mjs";
import { consolidateCall } from "./src/engine/consolidate.mjs";
import { createNotesStore } from "./src/store/notes.mjs";
import { createMonitor } from "./src/monitor.mjs";
import { createMemory } from "./src/store/memory.mjs";
import * as skill from "./src/skills/termin-notiz.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const SECRET = process.env.DIAL_SIGNING_SECRET?.trim() || "";
const DEV_TOKEN = process.env.DEV_TOKEN?.trim() || "";
const RECONNECT_GRACE_MS = 20000; // Dial re-dials for ~15 s after a drop

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const endpoint = geminiEndpoint();
const fish = createFish();
const store = createNotesStore();
const monitor = createMonitor();
const memory = createMemory();
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

// Pre-synthesised clips per language: the greeting plays the instant a call connects.
const assets = {};
const assetsReady = Promise.all(
  skill.LANGS.map(async lang => {
    const lines = skill.VOICE_LINES[lang];
    const synth = text => fish.synth(text, { lang }).catch(err => { log(`asset synth failed (${lang}):`, text, err.message); return null; });
    const oopsLines = [].concat(lines.oops);
    const [greeting, wrapUp, ...rest] = await Promise.all([lines.greeting, lines.wrapUp, ...oopsLines, ...lines.fillers].map(synth));
    assets[lang] = { greeting, wrapUp, oops: rest.slice(0, oopsLines.length).filter(Boolean), fillers: rest.slice(oopsLines.length).filter(Boolean) };
  }),
).then(() => log(`voice assets ready (${skill.LANGS.map(l => `${l}: ${assets[l].fillers.length} fillers, ${assets[l].oops.length} oops`).join("; ")})`));
assets.typing = typingLoop();

// Memory updates that failed during a call (API down) are retried here.
async function retryPending() {
  for (const job of memory.listPending()) {
    try {
      const { changed } = await consolidateCall({ endpoint, model: MODEL, skill, memory, ...job });
      memory.removePending(job);
      monitor.system(`memory retry ok for ${job.callId}: +${changed.added.length} to-dos, ${changed.completed.length} done`);
    } catch (err) {
      log("memory retry failed", job.callId, err.message);
    }
  }
}
setTimeout(retryPending, 10000);
setInterval(retryPending, 5 * 60 * 1000).unref();

const describe = c => (c.engine === "live" ? `Gemini Live · ${c.liveModel} · ${c.liveVoice}` : `${c.model} + ${c.tts === "gemini" ? "Gemini TTS" : "Fish"} · ${c.mask}`);

// ---------- HTTP ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

// With DEV_TOKEN set (do that on a public deploy), the API, monitor and test phone need ?token=.
const authorized = url => !DEV_TOKEN || url.searchParams.get("token") === DEV_TOKEN;
const json = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(body)); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/") && url.pathname !== "/api/health" && !authorized(url)) return json(res, { error: "token required" }, 401);
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
  if (url.pathname === "/api/memory") return json(res, { actions: memory.actions(), customers: Object.values(memory.customers()) });
  const actionMatch = url.pathname.match(/^\/api\/actions\/([^/]+)$/);
  if (actionMatch && req.method === "POST") {
    const status = url.searchParams.get("status");
    const a = memory.setActionStatus(decodeURIComponent(actionMatch[1]), status);
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
    if (!authorized(url)) return json(res, { error: "token required" }, 401);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(readFileSync(path.join(here, "web", "monitor.html")));
  }
  if (url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, gemini: endpoint.door, model: MODEL, fishModel: fish.model, dialSigned: Boolean(SECRET), sessions: sessions.size }));
  }
  if (url.pathname === "/api/notes") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(store.list().map(({ transcript, ...n }) => ({ ...n, turns: transcript?.length ?? 0 }))));
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = path.join(here, "web", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  if (full.startsWith(path.join(here, "web")) && existsSync(full)) {
    res.writeHead(200, { "content-type": MIME[path.extname(full)] ?? "application/octet-stream", "cache-control": "no-store" });
    return res.end(readFileSync(full));
  }
  res.writeHead(404).end("not found");
});

// ---------- WebSocket (Dial protocol) ----------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
const sessions = new Map(); // call_id → { session, out, graceTimer }

function verifySignature(header, callId) {
  const m = /t=(\d+),v1=([0-9a-f]+)/i.exec(header ?? "");
  if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > 300) return false;
  const expected = createHmac("sha256", SECRET).update(`${m[1]}.${callId}`).digest();
  const given = Buffer.from(m[2], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/monitor-ws") {
    if (!authorized(url)) return socket.destroy();
    return wss.handleUpgrade(req, socket, head, ws => {
      const unsubscribe = monitor.subscribe(msg => ws.readyState === 1 && ws.send(JSON.stringify(msg)));
      ws.on("close", unsubscribe);
    });
  }
  if (!url.pathname.startsWith("/dial")) return socket.destroy();
  const callId = decodeURIComponent(url.pathname.split("/").filter(Boolean).slice(1).join("/") || "");
  const dev = url.searchParams.get("dev") === "1";
  if (dev) {
    if (DEV_TOKEN && url.searchParams.get("token") !== DEV_TOKEN) return socket.destroy();
  } else if (SECRET) {
    if (!verifySignature(req.headers["x-dial-signature"], callId)) {
      log("rejected unsigned/invalid Dial connection for", callId || "(no call id)");
      monitor.system(`rejected connection ${callId || "(no call id)"}: ${req.headers["x-dial-signature"] ? "bad or stale signature" : "no X-Dial-Signature header"}`, "error");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
  } else {
    log("warning: accepting unsigned connection (set DIAL_SIGNING_SECRET for real calls)");
  }
  monitor.system(`${dev ? "test phone" : SECRET ? "Dial (signed)" : "unsigned caller"} connected: ${callId || "(no call id)"}`);
  wss.handleUpgrade(req, socket, head, ws => attach(ws, { callId, dev }));
});

function attach(ws, { callId, dev }) {
  const out = { ws };
  const send = frame => { if (out.ws.readyState === 1) out.ws.send(JSON.stringify(frame)); };
  let entry = null;

  ws.on("message", async data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === "call_connected") {
      const id = msg.call_id || callId || `dev-${Date.now()}`;
      const existing = sessions.get(id);
      if (existing && msg.reconnect) {
        clearTimeout(existing.graceTimer);
        existing.out.ws = ws; // same call, new socket
        entry = existing;
        monitor.system(`reconnect: ${id}`, "warn");
      } else {
        await assetsReady;
        const config = { ...phoneConfig, ...(dev && msg.config ? msg.config : {}) };
        monitor.start({ id, from: msg.from, to: msg.to, lang: null, mode: describe(config), source: dev ? (msg.from === "+49-browser" || msg.from === "+1-browser" ? "browser" : "script") : "dial" });
        const common = {
          send, dev, skill, endpoint, extractModel: MODEL, store, memory, config,
          log: (...a) => log(`[${id.slice(-6)}]`, ...a),
          onEvent: ev => monitor.event(id, ev),
          onEnd: reason => monitor.end(id, reason),
          recordDir: monitor.record ? callId => monitor.audioDir(callId) : null,
        };
        const cascade = (extra = {}) => createCallSession({ ...common, model: MODEL, fish, geminiTts, assets, ...extra, config: { ...config, engine: "cascade" } });
        entry = { out };
        if (config.engine === "live") {
          // If Gemini Live fails (setup refused, socket drop), carry the call on with the cascade engine.
          entry.session = createLiveSession({
            ...common,
            assets,
            onFatal: ({ reason, turns, lang, greeted }) => {
              monitor.system(`Live failed on ${id}: ${reason} → continuing on ${MODEL} + Fish`, "warn");
              entry.session.abandon();
              entry.session = cascade({ initialTurns: turns, initialLang: lang });
              entry.session.handle({ ...msg, reconnect: greeted });
            },
          });
        } else {
          entry.session = cascade();
        }
        sessions.set(id, entry);
      }
      entry.id = id;
    }
    entry?.session.handle(msg);
    if (msg.type === "call_ended") sessions.delete(entry?.id);
  });

  ws.on("close", () => {
    if (!entry || entry.session.ended) { if (entry) sessions.delete(entry.id); return; }
    if (dev) { entry.session.close("dev_hangup"); sessions.delete(entry.id); return; }
    // Dial keeps the call up and reconnects; only give up after the grace period.
    monitor.system(`socket dropped: ${entry.id}, waiting ${RECONNECT_GRACE_MS / 1000}s for Dial to reconnect`, "warn");
    entry.graceTimer = setTimeout(() => { entry.session.close("socket_lost"); sessions.delete(entry.id); }, RECONNECT_GRACE_MS);
  });
}

server.listen(PORT, () => log(`DesklessOS on http://localhost:${PORT}  (gemini: ${endpoint.door} ${MODEL}, fish: ${fish.model}, dial signature: ${SECRET ? "required" : "OFF"})`));
