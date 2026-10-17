// The team's logins: invite → own password → session; removal and a new password end
// sessions; the cookie over HTTP (owner-only routes, JSON-only POSTs, logout); the call's
// summary on demand.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { openPgMemory } from "../src/memory/pg.ts";
import { createAuth } from "../src/admin/auth.ts";
import type { Auth } from "../src/admin/auth.ts";
import { createTeam, hashPassword, verifyPassword } from "../src/admin/team.ts";
import type { Team, Member } from "../src/admin/team.ts";
import { createApi } from "../src/http/api.ts";
import type { ApiDeps } from "../src/http/deps.ts";
import type { HttpError } from "../src/types/common.ts";
import { recapPrompt, spokenText } from "../src/calls/recap.ts";
import { loadSkillFromTemplates } from "../src/skills/from-templates.ts";

const skill = loadSkillFromTemplates("pilot");
const ENV = { ADMIN_CODE: "the-owners-code", SESSION_SECRET: "s" };
// login's result readable on any side: the assertions check which one came back.
type Outcome = Partial<{ token: string; needTotp: true; error: string; status: number }>;
type TestAuth = Omit<Auth, "login"> & { login(o: Parameters<Auth["login"]>[0]): Outcome };
type TestTeam = Omit<Team, "login"> & { login(o: Parameters<Team["login"]>[0]): Promise<Partial<{ member: Member; token: string; error: string; status: number }>> };
// The API from what a test uses: the deps it leaves out, or fills in part, stay unset.
type SomeDeps = Partial<Omit<ApiDeps, "cfg" | "monitor">> & { cfg: Partial<ApiDeps["cfg"]>; monitor: Partial<ApiDeps["monitor"]> };
const apiOf = (deps: SomeDeps) => createApi(deps as ApiDeps);
type Res = Omit<Response, "json"> & { json(): Promise<any> }; // a response whose JSON the assertions read deep
const portOf = (s: http.Server) => (s.address() as AddressInfo).port;
let db, memory;
before(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
  memory = openPgMemory({ db, skill });
  await memory.ensureUser();
});
after(async () => { await db?.close(); });

test("passwords: scrypt, salted, checked in constant time", async () => {
  const h = await hashPassword("correct horse battery");
  assert.match(h, /^scrypt:16384:8:1:/);
  assert.notEqual(h, await hashPassword("correct horse battery"), "salted");
  assert.equal(await verifyPassword("correct horse battery", h), true);
  assert.equal(await verifyPassword("correct horse batterY", h), false);
  assert.equal(await verifyPassword("x", "garbage"), false);
});

test("team: invite, set a password, log in; a new link resets it; removal ends the session", async () => {
  const auth: TestAuth = createAuth(ENV);
  const team: TestTeam = createTeam({ db, auth });
  const { member, token } = await team.invite({ email: " Chris@Example.com ", by: "Max" });
  assert.deepEqual([member.email, member.role, member.status], ["chris@example.com", "member", "invited"]);
  assert.deepEqual(await team.inviteInfo(token), { email: "chris@example.com", name: "", existing: false });
  await assert.rejects(team.accept({ token, password: "short" }), /at least 10/);
  const accepted = await team.accept({ token, name: "Chris", password: "a long enough password" });
  assert.equal(accepted.member.status, "active");
  const first = auth.session(accepted.token);
  assert.deepEqual([first.n, first.r, first.e], ["Chris", "member", "chris@example.com"]);
  assert.ok(await team.check(first));
  await assert.rejects(team.accept({ token, password: "a long enough password" }), /used already/, "a link works once");
  assert.equal(await team.inviteInfo(token), null);

  assert.equal((await team.login({ email: "chris@example.com", password: "wrong one!!", ip: "t1" })).status, 401);
  assert.equal((await team.login({ email: "nobody@example.com", password: "whatever123", ip: "t1" })).status, 401);
  const login = await team.login({ email: "CHRIS@example.com", password: "a long enough password", ip: "t1" });
  assert.ok(auth.session(login.token));

  // A new link keeps the role and, once used, ends the old sessions.
  const again = await team.invite({ email: "chris@example.com", role: "owner", by: "Max" });
  assert.equal(again.member.role, "member");
  assert.equal((await team.inviteInfo(again.token)).existing, true);
  const fresh = await team.accept({ token: again.token, password: "another long password" });
  const fresh2 = createTeam({ db, auth }); // another instance: no cache
  assert.equal(await fresh2.check(auth.session(login.token)), null, "the old password's session is over");
  assert.ok(await fresh2.check(auth.session(fresh.token)));

  await assert.rejects(team.remove(fresh.member.id, { by: fresh.member.id }), /yourself/);
  await team.remove(fresh.member.id, { by: "code" });
  assert.equal(await team.check(auth.session(fresh.token)), null, "removed: logged out");
  assert.equal((await team.check(auth.session(auth.login({ code: ENV.ADMIN_CODE }).token)))?.m, "code");
});

test("the owner's code: a new ADMIN_CODE ends the code's sessions", () => {
  const { token }: Outcome = createAuth(ENV).login({ code: ENV.ADMIN_CODE });
  assert.ok(createAuth(ENV).session(token));
  assert.equal(createAuth({ ...ENV, ADMIN_CODE: "rotated" }).session(token), null);
});

test("HTTP: the session cookie, owner-only routes, JSON-only POSTs, logout; the summary on demand", async () => {
  const auth = createAuth(ENV);
  const team = createTeam({ db, auth });
  const written = [];
  const writeRecap = async ({ turns, name }) => { written.push(name); return { title: "Angebot Klinik", overview: "…", topics: [], actions: [], open_questions: [], turns: turns.length }; };
  const api = apiOf({
    cfg: { devToken: "dev", tickToken: "tick", model: "m", mask: "typing", dialSecret: "" }, skill, auth, team, memory, writeRecap, adapters: [], log: () => {},
    queue: { list: async () => [] }, notifier: { channels: [] }, monitor: { list: async () => [], systemLog: () => [], record: false, system() {} },
    background: { tick: async () => ({}), mode: "http" }, scheduler: null,
  });
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise<void>(r => server.listen(0, r));
  const base = `http://localhost:${portOf(server)}`;
  const call = (path: string, { cookie, body, type = "application/json" }: { cookie?: string; body?: unknown; type?: string } = {}): Promise<Res> => fetch(base + path, {
    method: body ? "POST" : "GET", headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": type } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const cookieOf = res => res.headers.get("set-cookie")?.split(";")[0];
  try {
    // The owner logs in with the code and invites a member.
    const owner = await call("/api/admin/login", { body: { code: ENV.ADMIN_CODE } });
    assert.equal(owner.status, 200);
    assert.match(owner.headers.get("set-cookie"), /HttpOnly; SameSite=Lax; Max-Age=43200/);
    const ownerCookie = cookieOf(owner);
    assert.deepEqual((await (await call("/api/admin/me", { cookie: ownerCookie })).json()).me, { name: "Admin", email: "", role: "owner", id: "code" });
    const inv = await (await call("/api/team/invite", { cookie: ownerCookie, body: { email: "nina@example.com" } })).json();
    assert.equal(inv.member.status, "invited");

    // She sets her password on the link and is logged in.
    assert.equal((await (await call("/api/team/invite-info", { body: { token: inv.token } })).json()).email, "nina@example.com");
    const accepted = await call("/api/team/accept", { body: { token: inv.token, name: "Nina", password: "ninas own password" } });
    assert.equal(accepted.status, 200);
    const nina = cookieOf(accepted);
    assert.equal((await call("/api/users", { cookie: nina })).status, 200);
    assert.equal((await call("/api/team", { cookie: nina })).status, 200);
    assert.equal((await call("/api/team/invite", { cookie: nina, body: { email: "x@example.com" } })).status, 403, "only an owner invites");
    assert.equal((await call("/api/requests", { cookie: nina, body: { instruction: "x" }, type: "text/plain" })).status, 415, "no form posts on the cookie");

    // Email and password from now on; a wrong one is refused.
    assert.equal((await call("/api/admin/login", { body: { email: "nina@example.com", password: "nope nope nope" } })).status, 401);
    const again = await call("/api/admin/login", { body: { email: "nina@example.com", password: "ninas own password" } });
    assert.match(again.headers.get("set-cookie"), /Max-Age=2592000/, "a month");

    // The summary for a call that ended without one.
    const scope = await memory.openCall({ callId: "call-r", source: "whatsapp" });
    await scope.endCall({ turns: [{ role: "user", text: "Angebot für die Klinik ist raus." }, { role: "model", text: "Super. [did order_execute: ok]" }], reason: "caller_hangup", lang: "de" });
    const r = await (await call(`/api/calls/${encodeURIComponent("call-r")}/recap`, { cookie: nina, body: {} })).json();
    assert.equal(r.recap.title, "Angebot Klinik");
    assert.deepEqual(written, ["Niko"]);
    assert.equal((await memory.getCall("call-r")).recap.title, "Angebot Klinik");
    assert.equal((await call("/api/calls/nope/recap", { cookie: nina, body: {} })).status, 404);

    // Removed: her cookie stops working at once on this instance.
    const ninaId = (await team.list()).find(m => m.email === "nina@example.com").id;
    assert.equal((await call(`/api/team/${ninaId}/remove`, { cookie: ownerCookie, body: {} })).status, 200);
    assert.equal((await call("/api/users", { cookie: nina })).status, 401);

    const out = await call("/api/admin/logout", { body: {} });
    assert.match(out.headers.get("set-cookie"), /deskless_session=; .*Max-Age=0/);
  } finally { server.close(); }
});

test("summary prompt: who said what, without the engine's notes", () => {
  assert.equal(spokenText("Erledigt. [did order_execute: {\"ok\":true}]"), "Erledigt.");
  assert.equal(spokenText("Also das war [interrupted by the caller; not heard: \"…\"]"), "Also das war");
  const p = recapPrompt({ turns: [{ role: "user", text: "(You called him. He picked up; …)" }, { role: "user", text: "Hallo" }, { role: "model", text: "[called memory_search]" }, { role: "model", text: "Hi!" }, { role: "user", text: "(Silence: the caller has said nothing for a few seconds.)" }], name: "Niko", agent: "Toni", date: "2026-10-14" });
  assert.equal(p, "The call was on 2026-10-14.\n\nTranscript:\nNiko: Hallo\nToni: Hi!");
});

test("a feature switched on: Toni mentions it once, in his next call; switching it again doesn't repeat it", async () => {
  const auth = createAuth(ENV);
  const api = apiOf({
    cfg: { devToken: "", tickToken: "t", model: "m", mask: "typing", dialSecret: "" }, skill, auth, team: createTeam({ db, auth }), memory, adapters: [], log: () => {},
    queue: { list: async () => [] }, notifier: { channels: [] }, monitor: { list: async () => [], systemLog: () => [], record: false, system() {} },
    background: { tick: async () => ({}), mode: "http" }, scheduler: null,
  });
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise<void>(r => server.listen(0, r));
  const base = `http://localhost:${portOf(server)}`;
  const owner = (await fetch(`${base}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: ENV.ADMIN_CODE }) })).headers.get("set-cookie").split(";")[0];
  const save = patch => fetch(`${base}/api/users/${niko.id}`, { method: "POST", headers: { cookie: owner, "content-type": "application/json" }, body: JSON.stringify(patch) }).then((r: Res) => r.json());
  const niko = (await memory.listUsers()).find(u => !u.demo);
  const intros = async () => (await memory.objectives.list()).filter(o => o.template === "feature.intro" && o.userId === niko.id);
  try {
    const { user } = await save({ features: { note_whatsapp: true } });
    assert.ok(user.features.note_whatsapp);
    const [intro] = await intros();
    assert.equal(intro.params.feature, "note_whatsapp");
    assert.match(intro.params.message, /^Ab jetzt schick ich dir nach jedem Anruf die Notiz auf WhatsApp/);
    await save({ features: { note_whatsapp: true }, timezone: "Europe/Berlin" });
    assert.equal((await intros()).length, 1, "already on: no second intro");
    const since = (await save({ features: { quotes: true } })).user.features;
    assert.equal(since.note_whatsapp, user.features.note_whatsapp, "an untouched feature keeps its date");
    assert.equal((await intros()).length, 2);
    assert.deepEqual((await save({ features: { note_whatsapp: false, quotes: false } })).user.features, {});
  } finally { server.close(); }
});

test("Toni calls him from the People card: WhatsApp's permission, asking for it, call now, a rehearsal on the demo's phone", async () => {
  const auth = createAuth(ENV);
  const dialed = [], asked = [];
  const whatsapp = { id: "whatsapp", dialOut: async o => { dialed.push(o); return { callId: `wacid.${dialed.length}`, carrier: "whatsapp" }; } };
  const whatsappOut = {
    callPermission: async to => (to === "+4915100000001" ? { status: "permanent", until: null, canCall: true, canAsk: true } : { status: "no_permission", until: null, canCall: false, canAsk: true }),
    requestCallPermission: async o => { asked.push(o); return { messageId: "m1" }; },
  };
  const monitorLog = [];
  const api = apiOf({
    cfg: { devToken: "", tickToken: "t", model: "m", mask: "typing", dialSecret: "", whatsappCallsUrl: "" }, skill, auth, team: createTeam({ db, auth }), memory, adapters: [whatsapp], whatsappOut, log: () => {},
    queue: { list: async () => [] }, notifier: { channels: [] }, monitor: { list: async () => [], systemLog: () => [], record: false, system: t => monitorLog.push(t) },
    background: { tick: async () => ({}), mode: "http" }, scheduler: null,
  });
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise<void>(r => server.listen(0, r));
  const base = `http://localhost:${portOf(server)}`;
  const owner = (await fetch(`${base}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: ENV.ADMIN_CODE }) })).headers.get("set-cookie").split(";")[0];
  const call = (path: string, body?: unknown) => fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { cookie: owner, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r: Res) => ({ status: r.status, ...(await r.json()) }));
  await memory.ensureDemoUser();
  const users = await memory.listUsers();
  const niko = users.find(u => !u.demo), demo = users.find(u => u.demo);
  try {
    await memory.updateUser(niko.id, { phone: "+4915100000001" });
    await memory.updateUser(demo.id, { phone: "+41780000009" });
    assert.equal((await call(`/api/users/${niko.id}/whatsapp`)).status, "permanent");
    assert.equal((await call(`/api/users/${demo.id}/whatsapp`)).status, "no_permission");

    const asking = await call(`/api/users/${demo.id}/whatsapp/ask`, {});
    assert.equal(asking.ok, true);
    assert.equal(asked[0].to, "+41780000009");
    assert.match(asked[0].text, /Darf ich dich ab und zu anrufen/, "in his language, from the locale pack");

    const placed = await call(`/api/users/${niko.id}/call`, { focus: "wie sein letztes Angebot lief" });
    assert.equal(placed.callId, "wacid.1");
    assert.equal(dialed[0].to, "+4915100000001");
    assert.equal(dialed[0].extra.rehearsal_of, null);
    assert.deepEqual(dialed[0].extra.objectives, [{ template: "discovery.day", params: { focus: "wie sein letztes Angebot lief" } }]);

    await call(`/api/users/${niko.id}/call`, { rehearse: true });
    assert.equal(dialed[1].to, "+41780000009", "a rehearsal rings the demo's phone");
    assert.equal(dialed[1].extra.rehearsal_of, niko.id);
    assert.ok(monitorLog.some(t => /playing a call to/.test(t)));

    await memory.updateUser(niko.id, { outboundPaused: true });
    const paused = await call(`/api/users/${niko.id}/call`, {});
    assert.equal(paused.status, 409);
    assert.equal(dialed.length, 2, "paused: no call");
    assert.equal((await call(`/api/users/${demo.id}/call`, { rehearse: true })).status, 400, "the demo isn't rehearsed on itself");
    assert.equal((await call(`/internal/whatsapp/call`, { to: "+4900000000" })).status, 401, "the internal route needs the tick token");
  } finally {
    await memory.updateUser(niko.id, { outboundPaused: false, phone: "" });
    await db.query("delete from users where demo");
    server.close();
  }
});

test("Call now on the main service is placed on the WhatsApp service (it holds the call's audio)", async () => {
  const auth = createAuth(ENV);
  const dialed = [];
  const common = { skill, auth, team: createTeam({ db, auth }), memory, log: () => {}, queue: { list: async () => [] }, notifier: { channels: [] }, monitor: { list: async () => [], systemLog: () => [], record: false, system() {} }, background: { tick: async () => ({}), mode: "http" }, scheduler: null };
  const cfg: SomeDeps["cfg"] = { devToken: "", tickToken: "t", model: "m", mask: "typing", dialSecret: "" };
  const serve = async api => { const s = http.createServer((req, res) => api.handle(req, res)); await new Promise<void>(r => s.listen(0, r)); return s; };
  const wa = await serve(apiOf({ ...common, cfg: { ...cfg, whatsappCallsUrl: "" }, adapters: [{ id: "whatsapp", dialOut: async o => { dialed.push(o); return { callId: "wacid.wa", carrier: "whatsapp" }; } }] }));
  const main = await serve(apiOf({ ...common, cfg: { ...cfg, whatsappCallsUrl: `http://localhost:${portOf(wa)}` }, adapters: [] }));
  const base = `http://localhost:${portOf(main)}`;
  const niko = (await memory.listUsers()).find(u => !u.demo);
  try {
    await memory.updateUser(niko.id, { phone: "+4915100000002" });
    const owner = (await fetch(`${base}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: ENV.ADMIN_CODE }) })).headers.get("set-cookie").split(";")[0];
    const out: any = await (await fetch(`${base}/api/users/${niko.id}/call`, { method: "POST", headers: { cookie: owner, "content-type": "application/json" }, body: "{}" })).json();
    assert.equal(out.callId, "wacid.wa");
    assert.equal(dialed[0].to, "+4915100000002");
  } finally {
    await memory.updateUser(niko.id, { phone: "" });
    main.close(); wa.close();
  }
});

test("team: a made-up link is turned away before any scrypt; one login guessed from many addresses locks that login", async () => {
  const auth = createAuth(ENV);
  const team: TestTeam = createTeam({ db, auth });
  let t = performance.now();
  await hashPassword("one scrypt, for scale");
  const scryptMs = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < 5; i++) await assert.rejects(team.accept({ token: `made-up-${i}`, password: "a long enough password" }), (err: HttpError) => err.status === 410);
  const fiveMs = performance.now() - t;
  assert.ok(fiveMs < scryptMs * 2, `five made-up links took ${fiveMs.toFixed(0)} ms; one scrypt takes ${scryptMs.toFixed(0)} ms`);

  const { token } = await team.invite({ email: "dana@example.com", by: "Max" });
  await team.accept({ token, password: "dana's long password" });
  for (let i = 0; i < 20; i++) assert.equal((await team.login({ email: "dana@example.com", password: "a wrong guess", ip: `192.0.2.${i}` })).status, 401);
  assert.equal((await team.login({ email: "Dana@example.com", password: "dana's long password", ip: "198.51.100.1" })).status, 429, "locked for everyone for a while");
  const eli = await team.invite({ email: "eli@example.com", by: "Max" });
  await team.accept({ token: eli.token, password: "eli's long password" });
  assert.ok((await team.login({ email: "eli@example.com", password: "eli's long password", ip: "198.51.100.1" })).token, "other logins aren't");
});
