import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAuth, verifyTotp, hotp, base32Decode, generateSecret, planHash } from "../src/admin/auth.mjs";
import { checkPlan, editPlan, plannerPrompt } from "../src/admin/planner.mjs";
import { createRequests } from "../src/admin/requests.mjs";
import { createNotifier } from "../src/notify.mjs";
import { loadSkillFromTemplates } from "../src/skills/from-templates.mjs";
import { openJsonMemory } from "../src/memory/json.mjs";
import { openDb } from "../src/db/client.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { openPgMemory } from "../src/memory/pg.mjs";

const skill = loadSkillFromTemplates("pilot");
const users = [{ id: "u1", name: "Niko", phone: "+4915100000000", lang: "de", role: "owner" }, { id: "u2", name: "Nina", phone: "", lang: "de", role: "staff" }];
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
  const auth = createAuth({ ADMIN_CODE: "open-sesame", ADMIN_TOTP_SECRET: secret, SESSION_SECRET: "s" });
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
  assert.equal(plan.params.questions[0].id, "q1");
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
  assert.match(now.card.warnings[0], /isn't available yet/);
  const edited = editPlan(now.plan, { questions: [{ ask: "Wann hast du es geschrieben?", probe: "" }] }, { users, skill });
  assert.equal(edited.plan.params.questions[0].ask, "Wann hast du es geschrieben?");
  assert.equal(edited.plan.target.name, "Niko");
});

test("notifier: a webhook gets the result; no channel means nothing to send", async () => {
  const sent = [];
  const n = createNotifier({ env: { NOTIFY_WEBHOOK_URL: "https://hooks.test/x" }, fetchImpl: async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response("ok"); } });
  assert.deepEqual(n.channels, ["webhook"]);
  await n.send({ subject: "s", text: "Niko answered.", payload: { type: "request.done" } });
  assert.equal(sent[0].body.text, "Niko answered.");
  assert.deepEqual(createNotifier({ env: {} }).channels, []);
});

// The whole flow on both backends: plan → approve → his next call asks → answered → Max is told.
async function flow(memory, userId) {
  const auth = createAuth({ ADMIN_CODE: "x", SESSION_SECRET: "s" });
  const delivered = [];
  const notifier = { channels: ["webhook"], send: async m => { delivered.push(m); } };
  const llm = async ({ prompt }) => { assert.match(prompt, /Frag Niko/); return good({ target: { user_id: userId, confidence: 0.95, alternatives: [] } }); };
  const requests = createRequests({ memory, skill, auth, llm, notifier, publicUrl: "https://deskless.test" });

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
  const agenda = skill.createAgenda({ objectives: scope.objectives });
  agenda.update({ mode: "capture", agenda: { [approved.objectiveId]: { q1: { asked: true, probed: false, status: "answered", answer: "Zwei Stunden, am Sonntagabend.", quote: "so zwei Stunden" } } } });
  const changed = await scope.recordObjectives(agenda.results());
  const [closed] = await requests.objectivesChanged(changed);
  assert.equal(closed.status, "done");
  assert.equal(closed.result.questions[0].quote, "so zwei Stunden");
  assert.deepEqual(closed.result.calls, ["call-a"]);
  assert.equal(closed.notifyStatus, "pending");
  await requests.flushNotifications();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /Niko answered[\s\S]*Zwei Stunden, am Sonntagabend\. \("so zwei Stunden"\)[\s\S]*https:\/\/deskless\.test\/admin#req_/);
  assert.equal((await requests.get(request.id)).notifyStatus, "sent");
  assert.deepEqual(await requests.flushNotifications(), [], "sent once");

  const other = await requests.plan({ instruction: "Frag Niko noch was anderes" });
  assert.equal((await requests.cancel(other.request.id)).status, "cancelled");
}

test("the flow on JSON memory", async () => {
  process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "deskless-admin-"));
  try { await flow(openJsonMemory({ skill }), "default"); } finally { delete process.env.DATA_DIR; }
});

let db;
before(async () => { db = await openDb("pglite:memory"); await migrate(db); });
after(async () => { await db?.close(); });
test("the flow on Postgres memory", async () => {
  const memory = openPgMemory({ db, skill });
  await memory.ensureUser();
  const [u] = await memory.listUsers();
  assert.equal(u.name, "Niko");
  await flow(memory, u.id);
});
