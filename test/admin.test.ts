import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createAuth, verifyTotp, hotp, base32Decode, generateSecret, planHash } from "../src/admin/auth.ts";
import type { Auth } from "../src/admin/auth.ts";
import { checkPlan, editPlan, plannerPrompt } from "../src/admin/planner.ts";
import { createRequests } from "../src/admin/requests.ts";
import { createNotifier } from "../src/notify.ts";
import type { Notifier } from "../src/notify.ts";
import { loadSkillFromTemplates } from "../src/skills/from-templates.ts";
import { openDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { openPgMemory } from "../src/memory/pg.ts";
import { createQueue } from "../src/jobs/queue.ts";

const skill = loadSkillFromTemplates("pilot");
const users = [{ id: "u1", name: "Niko", phone: "+4915100000000", lang: "de", role: "owner" }, { id: "u2", name: "Nina", phone: "", lang: "de", role: "staff" }];
// Auth with login's result readable on any side: the assertions check which one came back.
type Outcome = Partial<{ token: string; needTotp: true; error: string; status: number }>;
type TestAuth = Omit<Auth, "login"> & { login(o: Parameters<Auth["login"]>[0]): Outcome };
const good = (over = {}) => ({
  target: { user_id: "u1", confidence: 0.95, alternatives: [] },
  purpose: "wie lange Angebote dauern",
  questions: [{ ask: "Wie lange hast du an deinem letzten Angebot gesessen?", probe: "Ungefähr reicht.", required: true }],
  lang: "de", mode: "next_inbound", not_before: "", deadline: "", clarifications: [], summary: "Niko wird im nächsten Anruf gefragt, wie lange sein letztes Angebot gedauert hat.",
  ...over,
});

test("TOTP: the RFC 6238 test vector, drift window, and a fresh secret round-trips", () => {
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890"
  assert.equal(base32Decode(secret).toString(), "12345678901234567890");
  assert.equal(hotp(base32Decode(secret), 1), "287082"); // T = 59 s
  assert.equal(verifyTotp(secret, "287082", { now: 59000 }), true);
  assert.equal(verifyTotp(secret, "287082", { now: 59000 + 30000 }), true, "one step of drift");
  assert.equal(verifyTotp(secret, "287082", { now: 59000 + 90000 }), false);
  assert.equal(verifyTotp(secret, "12345"), false);
  const fresh = generateSecret();
  assert.equal(verifyTotp(fresh, hotp(base32Decode(fresh), Math.floor(Date.now() / 30000))), true);
});

test("login: code, then TOTP; a session token; five failures lock the address", () => {
  const secret = generateSecret();
  const auth: TestAuth = createAuth({ ADMIN_CODE: "open-sesame", ADMIN_TOTP_SECRET: secret, SESSION_SECRET: "s" });
  assert.equal(auth.login({ code: "nope", ip: "a" }).status, 401);
  assert.deepEqual(auth.login({ code: "open-sesame", ip: "a" }), { needTotp: true });
  assert.equal(auth.login({ code: "open-sesame", totp: "000000", ip: "a" }).status, 401);
  const { token } = auth.login({ code: "open-sesame", totp: hotp(base32Decode(secret), Math.floor(Date.now() / 30000)), ip: "a" });
  assert.equal(auth.session(token).role, "admin");
  assert.equal(auth.session(`${token}x`), null, "tampered");
  assert.equal(createAuth({ ADMIN_CODE: "open-sesame", SESSION_SECRET: "other" }).session(token), null, "another key");
  for (let i = 0; i < 5; i++) auth.login({ code: "wrong", ip: "b" });
  assert.equal(auth.login({ code: "open-sesame", ip: "b" }).status, 429, "locked even with the right code");
  assert.equal(createAuth({}).enabled, false, "no ADMIN_CODE: no admin login");
});

test("confirm token: bound to the request and exactly this plan", () => {
  const auth = createAuth({ ADMIN_CODE: "x", SESSION_SECRET: "s" });
  const { plan } = checkPlan(good(), { users, skill });
  const h = planHash(plan);
  const t = auth.confirmToken("req_1", h);
  assert.equal(auth.checkConfirm(t, "req_1", h), null);
  assert.match(auth.checkConfirm(t, "req_2", h), /another request/);
  assert.match(auth.checkConfirm(t, "req_1", planHash({ ...plan, mode: "outbound" })), /plan changed/);
  assert.match(auth.checkConfirm(auth.confirmToken("req_1", h, -1), "req_1", h), /expired/);
  assert.match(auth.checkConfirm(auth.session("x") ?? "garbage", "req_1", h), /not a valid/);
  assert.equal(planHash({ a: 1, b: 2 }), planHash({ b: 2, a: 1 }));
});

test("planner: a clear instruction becomes a card that can be approved", () => {
  const { plan, card } = checkPlan(good(), { users, skill });
  assert.equal(plan.target.name, "Niko");
  assert.equal(plan.params.questions[0].id, "q1"); // the template numbers them
  assert.deepEqual(card.blocked, []);
  assert.equal(card.title, "Ask Niko");
  assert.match(card.when, /next call, after his own business/);
  assert.match(plannerPrompt({ instruction: "Frag Niko …", users }), /u1 \| Niko \| \+4915100000000 \| de \| owner/);
});

test("planner: who it is must be clear, the questions valid, the mode possible", () => {
  assert.match(checkPlan(good({ target: { user_id: "", confidence: 0, alternatives: [] } }), { users, skill }).card.blocked[0], /not clear who/);
  assert.match(checkPlan(good({ target: { user_id: "u9", confidence: 1, alternatives: [] } }), { users, skill }).card.blocked[0], /no user u9/);
  assert.match(checkPlan(good({ questions: [] }), { users, skill }).card.blocked[0], /1 to 5/);
  const unsure = checkPlan(good({ target: { user_id: "u1", confidence: 0.5, alternatives: [{ user_id: "u2", why: "also N" }] } }), { users, skill }).card;
  assert.deepEqual(unsure.blocked, []);
  assert.match(unsure.warnings[0], /Is it Niko\? Could also be Nina/);
  const now = checkPlan(good({ mode: "outbound" }), { users, skill });
  assert.equal(now.plan.mode, "next_inbound");
  assert.match(now.card.warnings[0], /aren't set up on this server/);
  const noConsent = checkPlan(good({ mode: "outbound" }), { users, skill, outbound: true });
  assert.equal(noConsent.plan.mode, "next_inbound");
  assert.match(noConsent.card.warnings[0], /Niko can't be called \(he hasn't agreed to be called\)/);
  const agreed = [{ ...users[0], consentOutboundAt: "2026-10-01T00:00:00Z" }, users[1]];
  assert.equal(checkPlan(good({ mode: "outbound" }), { users: agreed, skill, outbound: true }).plan.mode, "outbound");
  assert.match(checkPlan(good({ mode: "either" }), { users: agreed, skill, outbound: true }).card.when, /whichever comes first/);
  const edited = editPlan(now.plan, { questions: [{ ask: "Wann hast du es geschrieben?", probe: "" }] }, { users, skill });
  assert.equal(edited.plan.params.questions[0].ask, "Wann hast du es geschrieben?");
  assert.equal(edited.plan.target.name, "Niko");
});

test("notifier: a webhook gets the result; no channel means nothing to send", async () => {
  const sent = [];
  const n = createNotifier({ env: { NOTIFY_WEBHOOK_URL: "https://hooks.test/x" }, fetchImpl: async (url, init: { body?: string }) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response("ok"); } });
  assert.deepEqual(n.channels, ["webhook"]);
  await n.send({ subject: "s", text: "Niko answered.", payload: { type: "request.done" } });
  assert.equal(sent[0].body.text, "Niko answered.");
  assert.deepEqual(createNotifier({ env: {} }).channels, []);
});

// The whole flow: plan → approve → his next call asks → answered → Max is told (a "notify" job).
let db;
before(async () => { db = await openDb("pglite:memory"); await migrate(db); });
after(async () => { await db?.close(); });
test("the flow: plan, approve, asked in his next call, answered, Max told once", async () => {
  const queue = createQueue({ db });
  const memory = openPgMemory({ db, skill, queue });
  await memory.ensureUser();
  const [u] = await memory.listUsers();
  assert.equal(u.name, "Niko");
  const auth = createAuth({ ADMIN_CODE: "x", SESSION_SECRET: "s" });
  const delivered = [];
  const notifier: Pick<Notifier, "channels" | "send"> = { channels: ["webhook"], send: async m => { delivered.push(m); } };
  const llm = async ({ prompt }) => { assert.match(prompt, /Frag Niko/); return good({ target: { user_id: u.id, confidence: 0.95, alternatives: [] } }); };
  const requests = createRequests({ memory, skill, auth, llm, queue, notifier, publicUrl: "https://deskless.test" });
  const handlers = { notify: p => requests.sendNotification(p), after_call: async () => {} }; // the after-call steps are done by hand below

  const { request, confirmToken } = await requests.plan({ instruction: "Frag Niko, wie lange sein letztes Angebot gedauert hat" });
  assert.equal(request.status, "draft");
  assert.ok(confirmToken);
  await assert.rejects(() => requests.approve(request.id, { confirmToken: auth.confirmToken(request.id, "other-plan") }), /plan changed/);
  const edited = await requests.revise(request.id, { edits: { questions: [{ ask: "Wie lange hast du an deinem letzten Angebot gesessen?", probe: "Ungefähr." }] } });
  await assert.rejects(() => requests.approve(request.id, { confirmToken }), /plan changed/, "the old card's token no longer fits");
  const approved = await requests.approve(request.id, { confirmToken: edited.confirmToken });
  assert.equal(approved.status, "approved");
  await assert.rejects(() => requests.approve(request.id, { confirmToken: edited.confirmToken }), /approved already/);

  const scope = await memory.openCall({ callId: "call-a" });
  assert.deepEqual(scope.objectives.map(o => o.id), [approved.objectiveId], "his next call has the question");
  await scope.endCall({ turns: [{ role: "user", text: "So zwei Stunden." }] });
  const state = await memory.afterCall("call-a");
  const agenda = skill.createAgenda({ objectives: scope.objectives });
  agenda.update({ mode: "capture", agenda: { [approved.objectiveId]: { q1: { asked: true, probed: false, status: "answered", answer: "Zwei Stunden, am Sonntagabend.", quote: "so zwei Stunden" } } } });
  const changed = await state.scope.recordObjectives(agenda.results());
  const [closed] = await requests.objectivesChanged(changed);
  assert.equal(closed.status, "done");
  assert.equal(closed.result.questions[0].quote, "so zwei Stunden");
  assert.deepEqual(closed.result.calls, ["call-a"]);
  assert.deepEqual(await requests.objectivesChanged(changed), [], "closed once");
  assert.equal(delivered.length, 0, "the message is a job, not sent inline");
  assert.deepEqual(await queue.run({ handlers }), { done: 2, failed: 0 }, "the call's after-call job, and the message");
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /Niko answered[\s\S]*Zwei Stunden, am Sonntagabend\. \("so zwei Stunden"\)[\s\S]*https:\/\/deskless\.test\/admin#req_/);
  assert.ok((await requests.get(request.id)).notifiedAt);
  assert.deepEqual(await queue.run({ handlers }), { done: 0, failed: 0 }, "sent once");

  await requests.note(approved.objectiveId, "Couldn't reach Niko by phone.");
  await queue.run({ handlers });
  assert.match(delivered[1].text, /Couldn't reach Niko by phone/);

  const other = await requests.plan({ instruction: "Frag Niko noch was anderes" });
  assert.equal((await requests.cancel(other.request.id)).status, "cancelled");
});

test("a conversation about his day: a card without the planner, approved into an objective", async () => {
  const queue = createQueue({ db });
  const memory = openPgMemory({ db, skill, queue });
  await memory.ensureUser();
  const auth = createAuth({ ADMIN_CODE: "x", SESSION_SECRET: "s" });
  const requests = createRequests({ memory, skill, auth, queue, llm: async () => { throw new Error("no planner for this"); }, outbound: () => false });
  const { request, confirmToken } = await requests.planConversation({ focus: "wie Angebote entstehen", mode: "outbound" });
  assert.equal(request.card.title, "Talk with Niko about his day");
  assert.equal(request.plan.mode, "next_inbound", "no outbound calls on this server: his next call instead");
  assert.match(request.card.warnings[0], /aren't set up on this server yet/);
  await assert.rejects(() => requests.revise(request.id, { answer: "anders" }), /nothing to re-plan/);
  const approved = await requests.approve(request.id, { confirmToken });
  const o = await memory.objectives.get(approved.objectiveId);
  assert.deepEqual([o.template, o.mode, o.params.focus], ["discovery.day", "next_inbound", "wie Angebote entstehen"]);
  assert.equal(o.maxAttempts, 5, "it may take several drives");
});


test("login guard: one account from many addresses is locked too; made-up addresses are forgotten, a lock and the code's count aren't", () => {
  const auth: TestAuth = createAuth({ ADMIN_CODE: "c", SESSION_SECRET: "s" });
  for (let i = 0; i < 20; i++) assert.equal(auth.login({ code: "wrong", ip: `10.0.0.${i}` }).status, 401);
  assert.equal(auth.login({ code: "c", ip: "10.9.9.9" }).status, 429, "the code is locked, whoever tries it");

  const guard = createAuth({ ADMIN_CODE: "c", SESSION_SECRET: "s" }).attempts;
  for (let i = 0; i < 5; i++) guard.fail("locked-one");
  for (let i = 0; i < 4; i++) guard.fail("early");
  for (let i = 0; i < 19; i++) guard.fail("x", "code");
  for (let i = 0; i < 6000; i++) guard.fail(`spoofed-${i}`);
  assert.equal(guard.locked("locked-one"), true, "a lock outlasts the flood");
  guard.fail("early");
  assert.equal(guard.locked("early"), false, "its 4 failures were forgotten: the map didn't grow without end");
  guard.fail("y", "code");
  assert.equal(guard.locked("z", "code"), true, "the code's count survived the flood");
});

test("SESSION_SECRET: Cloud Run won't start without its own; locally it's derived", () => {
  assert.throws(() => createAuth({ K_SERVICE: "deskless", ADMIN_CODE: "c" }), /SESSION_SECRET is required on Cloud Run/);
  assert.ok(createAuth({ K_SERVICE: "deskless", ADMIN_CODE: "c", SESSION_SECRET: "s" }).enabled);
  const { token }: Outcome = createAuth({ ADMIN_CODE: "c" }).login({ code: "c" });
  assert.ok(token);
});

test("requests: two approvals at once make one objective; a cancel during an approval takes its objective along", async () => {
  const queue = createQueue({ db });
  const memory = openPgMemory({ db, skill, queue });
  await memory.ensureUser();
  const [u] = await memory.listUsers();
  const auth = createAuth({ ADMIN_CODE: "x", SESSION_SECRET: "s" });
  const llm = async () => good({ target: { user_id: u.id, confidence: 0.95, alternatives: [] } });
  const requests = createRequests({ memory, skill, auth, llm, queue });
  const made = async id => (await memory.objectives.list()).filter(o => o.createdBy === `request ${id}`);

  const { request, confirmToken } = await requests.plan({ instruction: "Frag Niko nach seinen Wochenenden" });
  const both = await Promise.allSettled([requests.approve(request.id, { confirmToken }), requests.approve(request.id, { confirmToken })]);
  assert.deepEqual(both.map(r => r.status).sort(), ["fulfilled", "rejected"]);
  assert.match(both.find(r => r.status === "rejected").reason.message, /approved already/);
  assert.equal((await made(request.id)).length, 1, "one objective");

  // Max cancels while the approval is still making its objective.
  const second = await requests.plan({ instruction: "Frag Niko nach seinem Werkzeug" });
  let release;
  const gate = new Promise(r => { release = r; });
  const slow = { ...memory, objectives: { ...memory.objectives, create: async o => { await gate; return memory.objectives.create(o); } } };
  const cancelled = [];
  const racing = createRequests({ memory: slow, skill, auth, llm, queue, onCancel: async id => { cancelled.push(id); } });
  const approving = racing.approve(second.request.id, { confirmToken: second.confirmToken });
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await racing.cancel(second.request.id)).status, "cancelled");
  release();
  await assert.rejects(approving, /cancelled already/);
  const [o] = await made(second.request.id);
  assert.equal(o.status, "cancelled", "not left pending for a cancelled request");
  assert.deepEqual(cancelled, [o.id], "its outbound call too");
  assert.equal((await memory.requests.get(second.request.id)).status, "cancelled");
});
