// The HTTP API and pages, as one table: method, path, who may call it, handler.
// Who may call it:
//   public  anyone (pages, health, login; Twilio's webhooks are the adapters' and carry a signature)
//   user    DEV_TOKEN (?token=) or an admin session (Authorization: Bearer …, or ?token=)
//   admin   an admin session once ADMIN_CODE is set (before that, the user rule)
//   tick    X-Tick-Token: TICK_TOKEN (Cloud Scheduler, and the instance that just ended a call)
// With neither DEV_TOKEN nor ADMIN_CODE set (a local run) everything is open; on Cloud Run
// the config refuses to start that way.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
const same = (a, b) => {
  if (!a || !b) return false;
  const [x, y] = [Buffer.from(String(a)), Buffer.from(String(b))];
  return x.length === y.length && timingSafeEqual(x, y);
};
const fail = (status, message) => Object.assign(new Error(message), { status });

export function createApi({ cfg, skill, memory, queue, requests, auth, notifier, monitor, background, scheduler, host, clips, endpoint, fish, adapters, log }) {
  const open = !cfg.devToken && !auth.enabled;
  const tokenOf = (req, url) => req.headers.authorization?.replace(/^Bearer\s+/i, "") || url.searchParams.get("token") || "";
  const isUser = (req, url) => open || same(url.searchParams.get("token"), cfg.devToken) || Boolean(auth.session(tokenOf(req, url)));
  const isAdmin = (req, url) => (auth.enabled ? Boolean(auth.session(tokenOf(req, url))) : isUser(req, url));
  const allowed = {
    public: () => true,
    user: isUser,
    admin: isAdmin,
    tick: req => (cfg.tickToken ? same(req.headers["x-tick-token"], cfg.tickToken) : open),
  };

  const readBody = req => new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(fail(400, "not JSON")); } });
    req.on("error", reject);
  });
  const clientIp = req => req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "?";
  const page = name => ({ html: readFileSync(path.join(WEB, name)) });
  const objectiveTemplates = () => [...skill.templates.values()].filter(t => t.kind === "objective" && t.params).map(({ id, version, description, params, modes }) => ({ id, version, description, params, modes }));

  // [method, path (a regex's groups are the handler's params), access, handler({ req, url, params, body }) → JSON | { html } | { file, type }]
  const routes = [
    // ---------- health ----------
    ["GET", "/healthz", "public", () => ({ ok: true })],
    ["GET", "/api/health", "public", async () => {
      const db = await memory.db.query("select 1").then(() => true, () => false);
      return { ok: db, db, clips: Boolean(await Promise.race([clips.then(() => true), new Promise(r => setTimeout(() => r(false), 10))])), gemini: endpoint.door, model: cfg.model, fishModel: fish.model, dialSigned: Boolean(cfg.dialSecret), calls: host.calls.size, background: background.mode };
    }],

    // ---------- background work (Cloud Scheduler, every minute) ----------
    ["POST", "/internal/tick", "tick", () => background.tick()],

    // ---------- pages ----------
    ["GET", "/admin", "public", () => page("admin.html")],
    ["GET", "/monitor", "user", () => page("monitor.html")],

    // ---------- admin: login, people, requests, objectives, jobs ----------
    ["POST", "/api/admin/login", "public", async ({ req, body }) => {
      const out = auth.login({ code: body.code, totp: body.totp, ip: clientIp(req) });
      if (out.error) { log(`admin login refused (${out.status})`); throw fail(out.status ?? 401, out.error); }
      return out;
    }],
    ["GET", "/api/admin/me", "user", ({ req, url }) => ({ admin: isAdmin(req, url), login: auth.enabled, twoFactor: auth.twoFactor, notify: notifier.channels })],
    ["GET", "/api/users", "admin", async () => ({ users: await memory.listUsers(), outbound: Boolean(scheduler) })],
    ["POST", /^\/api\/users\/([\w-]+)$/, "admin", async ({ params: [id], body }) => {
      const u = await memory.updateUser(id, body);
      if (!u) throw fail(404, "no such person");
      monitor.system(`person ${u.name}: phone ${u.phone || "-"}, outbound calls ${u.consentOutboundAt ? "agreed" : "not agreed"}${u.outboundPaused ? " (paused)" : ""}`);
      return { user: u };
    }],
    ["GET", "/api/requests", "admin", async () => ({ requests: (await requests.list()).map(r => requests.view(r)) })],
    ["POST", "/api/requests", "admin", async ({ body }) => requests.plan({ instruction: body.instruction, by: "admin" })],
    // A conversation about his day (problem discovery): { userId?, focus?, mode? } → a card to approve.
    ["POST", "/api/requests/conversation", "admin", async ({ body }) => requests.planConversation({ userId: body.userId ?? null, focus: body.focus ?? "", mode: body.mode ?? "outbound", by: "admin" })],
    ["GET", /^\/api\/requests\/(req_[\w-]+)$/, "admin", async ({ params: [id] }) => {
      const r = await requests.get(id);
      if (!r) throw fail(404, "no such request");
      return requests.view(r);
    }],
    ["POST", /^\/api\/requests\/(req_[\w-]+)\/revise$/, "admin", ({ params: [id], body }) => requests.revise(id, body)],
    ["POST", /^\/api\/requests\/(req_[\w-]+)\/approve$/, "admin", async ({ params: [id], body }) => {
      const r = await requests.approve(id, body);
      monitor.system(`request ${id} approved: ${r.card.summary || r.instruction}`);
      return { request: r };
    }],
    ["POST", /^\/api\/requests\/(req_[\w-]+)\/cancel$/, "admin", async ({ params: [id] }) => ({ request: await requests.cancel(id) })],
    // Objectives by hand: { template: "inquiry", params: { questions: [{ ask, probe? }], purpose? }, mode?, priority?, lang? }.
    ["GET", "/api/objectives", "admin", async () => ({ objectives: await memory.objectives.list(), templates: objectiveTemplates() })],
    ["POST", "/api/objectives", "admin", async ({ body }) => {
      const o = await memory.objectives.create({ ...body, createdBy: "api" }).catch(err => { throw fail(400, err.message); });
      monitor.system(`objective ${o.id} (${o.template}): ${o.params.questions?.map(q => q.ask).join(" / ") ?? ""}`);
      return { objective: o };
    }],
    ["POST", /^\/api\/objectives\/([^/]+)\/cancel$/, "admin", async ({ params: [id] }) => {
      const o = await memory.objectives.cancel(id);
      if (!o) throw fail(404, "unknown objective");
      return { objective: o };
    }],
    ["GET", "/api/jobs", "admin", async () => ({ jobs: scheduler ? await scheduler.list() : [], outbound: Boolean(scheduler), queue: await queue.list() })],

    // ---------- what we know, and the calls ----------
    ["GET", "/api/memory", "user", () => memory.memoryOverview()],
    ["GET", "/api/notes", "user", async () => (await memory.listNotes()).map(({ transcript, ...n }) => ({ ...n, turns: transcript?.length ?? 0 }))],
    ["GET", "/api/discovery", "user", async () => {
      const overview = await memory.discoveryOverview();
      if (!overview) throw fail(404, "no research framework");
      return overview;
    }],
    ["POST", /^\/api\/actions\/([^/]+)$/, "user", async ({ params: [id], url }) => {
      const status = url.searchParams.get("status");
      const a = await memory.setTaskStatus(id, status);
      if (!a) throw fail(404, "unknown action");
      monitor.system(`to-do ${status === "done" ? "ticked off" : "reopened"} in the UI: ${a.customerName}: ${a.text}`);
      return a;
    }],
    // What phone calls use (ENGINE, GEMINI_MODEL, MASK, LIVE_MODEL, LIVE_VOICE), and what the test phone can pick.
    ["GET", "/api/config", "user", () => ({
      phone: { engine: cfg.engine, model: cfg.model, mask: cfg.mask, liveModel: cfg.liveModel, liveVoice: cfg.liveVoice },
      modes: {
        engines: ["cascade", "live"],
        models: ["gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
        masks: ["typing", "filler", "none"],
        // Probed 2026-10-11 (npm run live-probe): vertex-eu keeps audio in the EU and runs on the Vertex credits.
        liveModels: [...new Set([cfg.liveModel, "vertex-eu:gemini-3.8-live", "vertex@us-central1:gemini-3.8-live", "vertex@europe-west4:gemini-live-2.5-flash-native-audio"])],
        liveVoices: ["Kore", "Aoede", "Leda", "Zephyr", "Callirrhoe", "Puck", "Charon", "Fenrir", "Orus", "Achird"],
      },
    })],
    ["GET", "/api/calls", "user", async () => ({ calls: await monitor.list(), system: monitor.systemLog(), recording: monitor.record })],
    ["GET", /^\/api\/calls\/([^/]+)$/, "user", async ({ params: [id] }) => {
      const call = await monitor.get(id);
      if (!call) throw fail(404, "unknown call");
      return call;
    }],
    ["GET", /^\/api\/calls\/([^/]+)\/audio\/([^/]+)$/, "user", ({ params: [id, name] }) => {
      const file = monitor.audioFile(id, name);
      if (!file) throw fail(404, "no audio");
      return { file, type: "audio/wav" };
    }],
  ];

  const send = (res, status, out) => {
    if (out?.html) { res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(out.html); }
    if (out?.file) { res.writeHead(status, { "content-type": out.type, "cache-control": "no-store" }); return res.end(readFileSync(out.file)); }
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(out ?? null));
  };

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    for (const a of adapters) if (a.http && (await a.http(req, res, url))) return; // Twilio's webhooks carry their own signature
    for (const [method, match, access, fn] of routes) {
      const m = typeof match === "string" ? (url.pathname === match ? [] : null) : url.pathname.match(match)?.slice(1).map(decodeURIComponent);
      if (!m || (req.method !== method && !(method === "GET" && req.method === "HEAD"))) continue;
      if (!allowed[access](req, url)) return send(res, 401, { error: access === "admin" ? "admin login required" : "token required" });
      try {
        const body = req.method === "POST" ? await readBody(req) : {};
        return send(res, 200, await fn({ req, url, params: m, body }));
      } catch (err) {
        if (!err.status || err.status >= 500) log("http error", req.method, url.pathname, err.message);
        return send(res, err.status ?? 500, { error: err.message });
      }
    }
    // Static files: the test phone (/), and what the pages load.
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const full = path.join(WEB, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
    if (req.method === "GET" && full.startsWith(WEB) && existsSync(full) && !full.endsWith(path.sep)) return send(res, 200, { file: full, type: MIME[path.extname(full)] ?? "application/octet-stream" });
    send(res, 404, { error: "not found" });
  }

  /** WebSocket upgrades: the monitor's live feed, then the phone lines (Dial, Twilio, the test phone). */
  function upgrade(req, socket, head, wss) {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/monitor-ws") {
      if (!isUser(req, url)) return socket.destroy();
      return wss.handleUpgrade(req, socket, head, ws => {
        const unsubscribe = monitor.subscribe(msg => ws.readyState === 1 && ws.send(JSON.stringify(msg)));
        ws.on("close", unsubscribe);
      });
    }
    for (const a of adapters) if (a.upgrade?.(req, socket, head, url)) return;
    socket.destroy();
  }

  return { handle, upgrade, isUser };
}
