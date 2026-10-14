// The team's logins: invite → own password → session; removal and a new password end
// sessions; the cookie over HTTP (owner-only routes, JSON-only POSTs, logout); the call's
// summary on demand.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb } from "../src/db/client.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { openPgMemory } from "../src/memory/pg.mjs";
import { createAuth } from "../src/admin/auth.mjs";
import { createTeam, hashPassword, verifyPassword } from "../src/admin/team.mjs";
import { createApi } from "../src/http/api.mjs";
import { recapPrompt, spokenText } from "../src/calls/recap.mjs";
import { loadSkillFromTemplates } from "../src/skills/from-templates.mjs";

const skill = loadSkillFromTemplates("pilot");
const ENV = { ADMIN_CODE: "the-owners-code", SESSION_SECRET: "s" };
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
  const auth = createAuth(ENV);
  const team = createTeam({ db, auth });
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
  const { token } = createAuth(ENV).login({ code: ENV.ADMIN_CODE });
  assert.ok(createAuth(ENV).session(token));
  assert.equal(createAuth({ ...ENV, ADMIN_CODE: "rotated" }).session(token), null);
});

test("HTTP: the session cookie, owner-only routes, JSON-only POSTs, logout; the summary on demand", async () => {
  const auth = createAuth(ENV);
  const team = createTeam({ db, auth });
  const written = [];
  const writeRecap = async ({ turns, name }) => { written.push(name); return { title: "Angebot Klinik", overview: "…", topics: [], actions: [], open_questions: [], turns: turns.length }; };
  const api = createApi({
    cfg: { devToken: "dev", tickToken: "tick", model: "m", mask: "typing", dialSecret: "" }, skill, auth, team, memory, writeRecap, adapters: [], log: () => {},
    queue: { list: async () => [] }, notifier: { channels: [] }, monitor: { list: async () => [], systemLog: () => [], record: false, system() {} },
    background: { tick: async () => ({}), mode: "http" }, scheduler: null,
  });
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise(r => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const call = (path, { cookie, body, type = "application/json" } = {}) => fetch(base + path, {
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
  const p = recapPrompt({ turns: [{ role: "user", text: "Hallo" }, { role: "model", text: "[called memory_search]" }, { role: "model", text: "Hi!" }], name: "Niko", agent: "Toni", date: "2026-10-14" });
  assert.equal(p, "The call was on 2026-10-14.\n\nTranscript:\nNiko: Hallo\nToni: Hi!");
});
