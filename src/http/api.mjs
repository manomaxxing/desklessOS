// The HTTP API and pages, as one table: method, path, who may call it, handler.
// Who may call it:
//   public  anyone (pages, health, login; Twilio's and WhatsApp's webhooks are the adapters' and carry a signature)
//   user    DEV_TOKEN (?token=) or an admin session
//   admin   an admin session once ADMIN_CODE is set (before that, the user rule)
//   owner   an owner's session: the ADMIN_CODE login, or a team member with role owner (managing the team)
//   tick    X-Tick-Token: TICK_TOKEN (Cloud Scheduler, and the instance that just ended a call)
// An admin session is the HttpOnly cookie the login sets (SameSite=Lax), or a token as
// Authorization: Bearer … (scripts, tests). A team member's is checked against the team
// on every request (src/admin/team.mjs). POSTs on the cookie must be JSON (no forms from
// other sites).
// With neither DEV_TOKEN nor ADMIN_CODE set (a local run) everything is open; on Cloud Run
// the config refuses to start that way.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { renderQuotePdf, quoteFileName } from "../quotes/pdf.mjs";
import { FEATURES } from "../features.mjs";
import { locales } from "../locale/index.mjs";
import { e164 } from "../memory/pg.mjs";

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg" };
const same = (a, b) => {
  if (!a || !b) return false;
  const [x, y] = [Buffer.from(String(a)), Buffer.from(String(b))];
  return x.length === y.length && timingSafeEqual(x, y);
};
const fail = (status, message) => Object.assign(new Error(message), { status });
const COOKIE = "deskless_session";
const cookieOf = req => (req.headers.cookie ?? "").split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";

export function createApi({ cfg, skill, memory, queue, requests, auth, team = null, notifier, monitor, background, scheduler, host, clips, endpoint, fish, adapters, writeRecap = null, quotes = null, log }) {
  const open = !cfg.devToken && !auth.enabled;
  /** Who's asking: { dev } for DEV_TOKEN (or a local run with no login at all), { session } for an admin session. */
  async function identify(req, url) {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
    const cookie = cookieOf(req);
    const param = url.searchParams.get("token") || "";
    const signed = [bearer, cookie, param].map(t => (t ? auth.session(t) : null));
    const i = signed.findIndex(Boolean);
    const session = i < 0 ? null : team ? await team.check(signed[i]) : signed[i].m === "code" ? signed[i] : null;
    return { dev: open || same(param, cfg.devToken), session, viaCookie: i === 1 };
  }
  const isUser = who => who.dev || Boolean(who.session);
  const isAdmin = who => (auth.enabled ? Boolean(who.session) : isUser(who));
  const allowed = {
    public: () => true,
    user: isUser,
    admin: isAdmin,
    owner: who => (auth.enabled ? who.session?.r === "owner" : isUser(who)),
    tick: (who, req) => (cfg.tickToken ? same(req.headers["x-tick-token"], cfg.tickToken) : open),
  };
  const me = who => (who.session ? { name: who.session.n, email: who.session.e ?? "", role: who.session.r, id: who.session.m } : null);
  const sessionCookie = (req, token, maxAgeMs) => `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.round(maxAgeMs / 1000))}${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`;
  const loggedIn = ({ req, setCookie }, out) => { setCookie(sessionCookie(req, out.token, auth.session(out.token).exp - Date.now())); return { ok: true }; };

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

    // ---------- a call Toni makes on WhatsApp, now (on the WhatsApp service: it holds the call's audio) ----------
    // { to: one of our users' numbers, rehearsalOf?: a user id (Max plays that person: his memory, read only),
    //   objectives?: [{ template, params }] (what the call is for) } → { callId }
    ["POST", "/internal/whatsapp/call", "tick", async ({ body }) => {
      const whatsapp = adapters.find(a => a.id === "whatsapp");
      if (!whatsapp?.dialOut) throw fail(503, "no WhatsApp here");
      const users = await memory.listUsers();
      const to = users.find(u => u.phone && u.phone === e164(body.to))?.phone;
      if (!to) throw fail(400, "to: only our own users' numbers");
      if (body.rehearsalOf && !users.some(u => u.id === body.rehearsalOf)) throw fail(400, "rehearsalOf: no such user");
      const objectives = [].concat(body.objectives ?? []).map(o => ({ template: o.template, params: skill.objectiveParams(o.template, o.params ?? {}) }));
      const placed = await whatsapp.dialOut({ to, extra: { rehearsal_of: body.rehearsalOf ?? null, objectives } });
      log(`whatsapp: calling ${to}${body.rehearsalOf ? ` (a rehearsal of a call to ${users.find(u => u.id === body.rehearsalOf).name})` : ""}`);
      return placed;
    }],

    // ---------- pages ----------
    ["GET", "/admin", "public", () => page("admin.html")],
    ["GET", "/monitor", "user", () => page("monitor.html")],

    // ---------- admin: login, people, requests, objectives, jobs ----------
    // { email, password } (the team), or { code, totp? } (the owner's code). Sets the session cookie.
    ["POST", "/api/admin/login", "public", async ctx => {
      const { req, body } = ctx;
      const ip = clientIp(req);
      const out = body.email ? (team ? await team.login({ email: body.email, password: body.password, ip }) : { error: "no team logins here", status: 503 }) : auth.login({ code: body.code ?? body.password, totp: body.totp, ip });
      if (out.error) { log(`admin login refused (${out.status})`); throw fail(out.status ?? 401, out.error); }
      if (out.needTotp) return out;
      if (out.member) log(`admin login: ${out.member.email}`);
      return loggedIn(ctx, out);
    }],
    ["POST", "/api/admin/logout", "public", ({ req, setCookie }) => { setCookie(sessionCookie(req, "", 0)); return { ok: true }; }],
    ["GET", "/api/admin/me", "user", ({ who }) => ({ admin: isAdmin(who), login: auth.enabled, twoFactor: auth.twoFactor, notify: notifier.channels, me: me(who), team: Boolean(team), agent: skill.persona?.agentLabel ?? null })],

    // ---------- the team: who can log in ----------
    ["GET", "/api/team", "admin", async () => ({ members: team ? await team.list() : [] })],
    // { email, role? } → { member, token }; the page turns the token into the link (/admin#invite=…).
    ["POST", "/api/team/invite", "owner", async ({ body, who }) => {
      if (!team) throw fail(503, "no team logins here");
      const out = await team.invite({ email: body.email, role: body.role, by: who.session?.n ?? "dev" });
      monitor.system(`login invite for ${out.member.email} (${out.member.role}) by ${who.session?.n ?? "dev"}`);
      return out;
    }],
    ["POST", "/api/team/invite-info", "public", async ({ body }) => {
      const info = team && (await team.inviteInfo(String(body.token ?? "")));
      if (!info) throw fail(410, "this link was used already or has expired: ask for a new one");
      return info;
    }],
    ["POST", "/api/team/accept", "public", async ctx => {
      if (!team) throw fail(503, "no team logins here");
      const out = await team.accept({ token: String(ctx.body.token ?? ""), name: ctx.body.name, password: ctx.body.password });
      monitor.system(`${out.member.email} set up their login`);
      return loggedIn(ctx, out);
    }],
    ["POST", /^\/api\/team\/([\w-]+)\/remove$/, "owner", async ({ params: [id], who }) => {
      if (!team) throw fail(503, "no team logins here");
      const m = await team.remove(id, { by: who.session?.m ?? null });
      monitor.system(`login removed: ${m.email} by ${who.session?.n ?? "dev"}`);
      return { member: m };
    }],
    ["GET", "/api/users", "admin", async () => ({ users: await memory.listUsers(), outbound: Boolean(scheduler) })],
    ["POST", /^\/api\/users\/([\w-]+)$/, "admin", async ({ params: [id], body, who }) => {
      const before = await memory.getUser(id);
      const u = await memory.updateUser(id, body);
      if (!u) throw fail(404, "no such person");
      // A feature just switched on: Toni tells him once, at the end of his next call (src/features.mjs).
      for (const f of FEATURES.filter(f => u.features[f] && !before?.features?.[f])) {
        const message = locales().persona(u.lang, skill.PERSONA)?.features?.[f];
        if (!message) continue;
        const o = await memory.objectives.create({ template: "feature.intro", params: { feature: f, message }, userId: u.id, lang: u.lang, createdBy: who.session?.n ?? "admin" });
        monitor.system(`${u.name}: ${f} on; Toni tells him in his next call (${o.id})`);
      }
      monitor.system(`person ${u.name}: phone ${u.phone || "-"}, outbound calls ${u.consentOutboundAt ? "agreed" : "not agreed"}${u.outboundPaused ? " (paused)" : ""}`);
      return { user: u };
    }],
    ["GET", "/api/requests", "admin", async () => ({ requests: (await requests.list()).map(r => requests.view(r)) })],
    ["POST", "/api/requests", "admin", async ({ body, who }) => requests.plan({ instruction: body.instruction, by: who.session?.n ?? "admin" })],
    // A conversation about his day (problem discovery): { userId?, focus?, mode? } → a card to approve.
    ["POST", "/api/requests/conversation", "admin", async ({ body, who }) => requests.planConversation({ userId: body.userId ?? null, focus: body.focus ?? "", mode: body.mode ?? "outbound", by: who.session?.n ?? "admin" })],
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
        models: ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.8-flash"],
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
      return { ...call, quotes: quotes ? await quotes.forCall(id) : [] };
    }],
    // A quote's PDF, made again from its data (nothing is stored as a file).
    ["GET", /^\/api\/quotes\/([\w-]+)\/pdf$/, "user", async ({ params: [id] }) => {
      const q = quotes && (await quotes.get(id));
      if (!q) throw fail(404, "no such quote");
      return { bytes: await renderQuotePdf(q.data, { agent: skill.persona?.agentLabel }), type: "application/pdf", filename: quoteFileName(q.data) };
    }],
    // The call's summary, written now: for a call that ended without one, or again.
    ["POST", /^\/api\/calls\/([^/]+)\/recap$/, "admin", async ({ params: [id] }) => {
      if (!writeRecap) throw fail(503, "no summaries here");
      const call = await memory.getCall(id);
      if (!call) throw fail(404, "unknown call");
      if (!call.endedAt) throw fail(409, "the summary is written when the call has ended");
      if (!call.transcript?.some(t => t.role === "user")) throw fail(409, "nothing was said in this call");
      const recap = await writeRecap({ turns: call.transcript, name: call.rehearsalOf ?? call.userName, lang: call.lang, startedAt: call.startedAt });
      await memory.saveRecap(id, recap);
      return { recap };
    }],
    ["GET", /^\/api\/calls\/([^/]+)\/audio\/([^/]+)$/, "user", ({ params: [id, name] }) => {
      const file = monitor.audioFile(id, name);
      if (!file) throw fail(404, "no audio");
      return { file, type: "audio/wav" };
    }],
  ];

  const send = (res, status, out, cookies = []) => {
    const base = { "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) };
    if (out?.html) { res.writeHead(status, { ...base, "content-type": "text/html; charset=utf-8" }); return res.end(out.html); }
    if (out?.file) { res.writeHead(status, { ...base, "content-type": out.type }); return res.end(readFileSync(out.file)); }
    if (out?.bytes) { res.writeHead(status, { ...base, "content-type": out.type, "content-disposition": `inline; filename="${out.filename.replace(/[^\w.-]/g, "_")}"` }); return res.end(Buffer.from(out.bytes)); }
    res.writeHead(status, { ...base, "content-type": "application/json" });
    res.end(JSON.stringify(out ?? null));
  };

  async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    for (const a of adapters) if (a.http && (await a.http(req, res, url))) return; // Twilio's and WhatsApp's webhooks carry their own signature
    for (const [method, match, access, fn] of routes) {
      const m = typeof match === "string" ? (url.pathname === match ? [] : null) : url.pathname.match(match)?.slice(1).map(decodeURIComponent);
      if (!m || (req.method !== method && !(method === "GET" && req.method === "HEAD"))) continue;
      const who = access === "public" ? { dev: false, session: null, viaCookie: false } : await identify(req, url);
      if (!allowed[access](who, req)) return send(res, access === "owner" && who.session ? 403 : 401, { error: access === "owner" ? "only an owner can do this" : access === "admin" ? "admin login required" : "token required" });
      if (req.method === "POST" && who.viaCookie && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return send(res, 415, { error: "JSON only" });
      const cookies = [];
      try {
        const body = req.method === "POST" ? await readBody(req) : {};
        return send(res, 200, await fn({ req, url, params: m, body, who, setCookie: c => cookies.push(c) }), cookies);
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
      identify(req, url).then(who => {
        if (!isUser(who)) return socket.destroy();
        wss.handleUpgrade(req, socket, head, ws => {
          const unsubscribe = monitor.subscribe(msg => ws.readyState === 1 && ws.send(JSON.stringify(msg)));
          ws.on("close", unsubscribe);
        });
      }, () => socket.destroy());
      return;
    }
    for (const a of adapters) if (a.upgrade?.(req, socket, head, url)) return;
    socket.destroy();
  }

  return { handle, upgrade };
}
