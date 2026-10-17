// Background work: the job queue, the after-call job (with Gemini stubbed), the tick,
// the bus, the config's checks, and who may call which route.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { openPgMemory } from "../src/memory/pg.ts";
import { createQueue } from "../src/jobs/queue.ts";
import { createBackground } from "../src/jobs/background.ts";
import { createAfterCall } from "../src/calls/after-call.ts";
import { createRequests } from "../src/admin/requests.ts";
import { createAuth } from "../src/admin/auth.ts";
import { createBus, MAX_PAYLOAD } from "../src/bus.ts";
import { createMonitor } from "../src/monitor.ts";
import type { Monitor, CallListing } from "../src/monitor.ts";
import { loadConfig } from "../src/config.ts";
import { createApi } from "../src/http/api.ts";
import type { ApiDeps } from "../src/http/deps.ts";
import type { Db } from "../src/db/client.ts";
import { loadSkillFromTemplates } from "../src/skills/from-templates.ts";

const skill = loadSkillFromTemplates("pilot");
// login's result readable on any side: the assertions check which one came back.
type Outcome = Partial<{ token: string; needTotp: true; error: string; status: number }>;
// The API from what a test uses: the deps it leaves out, or fills in part, stay unset.
type SomeDeps = Partial<Omit<ApiDeps, "cfg" | "memory" | "monitor">> & { cfg: Partial<ApiDeps["cfg"]>; memory: Partial<ApiDeps["memory"]>; monitor: Partial<ApiDeps["monitor"]> };
const apiOf = (deps: SomeDeps) => createApi(deps as ApiDeps);
// The monitor as the assertions read it: a call's record deep; a listed past call has only its id and start.
type TestMonitor = Omit<Monitor, "get" | "list"> & { get(id: string): Promise<any>; list(): Promise<Partial<CallListing>[]> };
let db, queue, memory;
before(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
  queue = createQueue({ db });
  memory = openPgMemory({ db, skill, queue });
  await memory.ensureUser();
});
after(async () => { await db?.close(); });
const jobRow = async key => (await db.query("select * from jobs where key = $1", [key]))[0];

test("queue: one job per key; a failure is retried later; after its last try it's dead", async () => {
  await queue.enqueue("t", { n: 1 }, { key: "t:1", maxAttempts: 2 });
  await queue.enqueue("t", { n: 2 }, { key: "t:1" });
  assert.equal((await db.query("select count(*)::int n from jobs where key = 't:1'"))[0].n, 1);
  const seen = [];
  const handlers = { t: async p => { seen.push(p.n); throw new Error("down"); } };
  assert.deepEqual(await queue.run({ handlers }), { done: 0, failed: 1 });
  let j = await jobRow("t:1");
  assert.equal(j.status, "queued");
  assert.equal(j.attempts, 1);
  assert.ok(new Date(j.run_at) > new Date(Date.now() + 50000), "backs off");
  assert.deepEqual(await queue.run({ handlers }), { done: 0, failed: 0 }, "not due yet");
  await db.query("update jobs set run_at = now() where key = 't:1'");
  await queue.run({ handlers });
  j = await jobRow("t:1");
  assert.equal(j.status, "dead");
  assert.equal(j.last_error, "down");
  assert.deepEqual(seen, [1, 1], "the payload of the first enqueue");
  assert.ok((await queue.list()).some(x => x.key === "t:1" && x.status === "dead"), "the admin page sees it");
});

test("queue: a job whose worker died is taken again once its lease runs out; unknown kinds fail", async () => {
  await queue.enqueue("t2", {}, { key: "t2:1" });
  await db.query("update jobs set status = 'running', locked_until = now() + interval '1 minute' where key = 't2:1'");
  const ran = [];
  assert.deepEqual(await queue.run({ handlers: { t2: async () => ran.push(1) } }), { done: 0, failed: 0 }, "someone holds it");
  await db.query("update jobs set locked_until = now() - interval '1 second' where key = 't2:1'");
  assert.deepEqual(await queue.run({ handlers: { t2: async () => ran.push(1) } }), { done: 1, failed: 0 });
  await queue.enqueue("mystery", {}, { key: "m:1" });
  await queue.run({ handlers: {} });
  assert.match((await jobRow("m:1")).last_error, /no handler/);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

test("queue: a slow job keeps its lease, so no other worker runs it beside it", async () => {
  const q = createQueue({ db, leaseS: 1 });
  const other = createQueue({ db, leaseS: 1 });
  await q.enqueue("slow", {}, { key: "slow:1" });
  let runs = 0;
  const running = q.run({ handlers: { slow: async () => { runs++; await sleep(1700); } } });
  await sleep(1300); // past its first lease
  assert.deepEqual(await other.run({ handlers: { slow: async () => { runs++; } } }), { done: 0, failed: 0 }, "still held: the lease was renewed");
  assert.deepEqual(await running, { done: 1, failed: 0 });
  assert.equal(runs, 1);
  assert.equal((await jobRow("slow:1")).status, "done");
});

test("queue: a run that lost its job can't overwrite the newer run's result; a job that takes its worker down dies after max_attempts", async () => {
  await queue.enqueue("fence", {}, { key: "fence:1" });
  let fail;
  const stale = queue.run({ handlers: { fence: () => new Promise((_, reject) => { fail = () => reject(new Error("too late")); }) } });
  await sleep(30);
  await db.query("update jobs set locked_until = now() - interval '1 second' where key = 'fence:1'"); // its worker hangs; the lease runs out
  assert.deepEqual(await queue.run({ handlers: { fence: async () => {} } }), { done: 1, failed: 0 }, "taken again, and done");
  fail();
  await stale;
  const j = await jobRow("fence:1");
  assert.deepEqual([j.status, j.attempts, j.last_error], ["done", 2, null], "the stale failure didn't count");

  await queue.enqueue("crash", {}, { key: "crash:1", maxAttempts: 2 });
  await db.query("update jobs set status = 'running', attempts = 2, locked_until = now() - interval '1 second' where key = 'crash:1'");
  let ran = 0;
  await queue.run({ handlers: { crash: async () => { ran++; } } });
  const c = await jobRow("crash:1");
  assert.equal(ran, 0, "not a third time");
  assert.equal(c.status, "dead");
  assert.match(c.last_error, /worker stopped mid-job/);
});

// Gemini, stubbed: the note extraction and the memory step answer with fixed JSON.
function stubGemini({ note, memoryResult }) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init: { body?: string }) => {
    if (!String(url).startsWith("https://gemini.test/")) return original(url, init);
    const body = JSON.parse(init.body);
    const isMemory = body.systemInstruction.parts[0].text === skill.MEMORY_SYSTEM;
    seen.push(isMemory ? "memory" : "note");
    const out = isMemory ? memoryResult : note;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(out) }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } }));
  };
  return { seen, restore: () => { globalThis.fetch = original; } };
}
const endpoint = { door: "test", url: (model, method) => `https://gemini.test/${model}:${method}`, headers: async () => ({ "content-type": "application/json" }) };

test("after-call job: the final note, his note saved, the question answered, Max told, memory updated; again: nothing", async () => {
  const auth = createAuth({ ADMIN_CODE: "x", SESSION_SECRET: "s" });
  const delivered = [];
  const requests = createRequests({ memory, skill, auth, queue, notifier: { channels: ["webhook"], send: async m => { delivered.push(m); } }, llm: async () => { throw new Error("not planned here"); } });
  const objective = await memory.objectives.create({ template: "inquiry", params: { questions: [{ ask: "Wie lange hat dein letztes Angebot gedauert?" }] } });
  await memory.requests.create({ id: "req_t1", userId: (await memory.listUsers())[0].id, instruction: "Frag Niko …", plan: { target: { name: "Niko" } }, planHash: "h", card: { blocked: [] }, status: "approved" });
  await memory.requests.update("req_t1", { objectiveId: objective.id });

  // The call: two turns saved as it went, the extraction one turn behind, then the end.
  const scope = await memory.openCall({ callId: "call-x", source: "twilio" });
  await scope.setAgenda([objective.id]);
  const turns = [
    { role: "user", text: "Ich komm grad vom Herrn Huber in Allensbach, Küche, Fliesenspiegel neu." },
    { role: "model", text: "Notiert. Wie lange hat dein letztes Angebot gedauert?" },
    { role: "user", text: "So zwei Stunden, am Sonntagabend." },
  ];
  await scope.checkpoint({ turns: turns.slice(0, 2), extraction: { mode: "capture", customer_name: "Herr Huber" }, extractionTurns: 1, lang: "de" });
  await scope.endCall({ turns, reason: "caller_hangup", lang: "de", timeline: [{ event: "heard" }], meta: { usd: 0.01 } });

  const gemini = stubGemini({
    note: { mode: "capture", customer_name: "Herr Huber", place: "Allensbach", work: [{ area: "Küche", description: "Fliesenspiegel neu", quantity: "", material: "" }], next_steps: [{ what: "Angebot schreiben", due: "" }], summary: "Küche Huber: Fliesenspiegel neu.",
      agenda: { [objective.id]: { q1: { asked: true, probed: false, status: "answered", answer: "Etwa zwei Stunden, am Sonntagabend.", quote: "So zwei Stunden" } } } },
    memoryResult: { call_type: "capture", call_summary: "Küche Huber aufgenommen.", customer: { name: "Herr Huber", place: "Allensbach", summary_update: "Küche: Fliesenspiegel neu." }, new_actions: [{ text: "Angebot Huber schreiben", due: "" }], completed_action_ids: [] },
  });
  try {
    const recaps = [];
    const writeRecap = async ({ turns, name, lang }) => { recaps.push({ turns: turns.length, name, lang }); return { title: "Küche Huber", overview: "Neue Küche bei Huber aufgenommen.", topics: [], actions: [{ text: "Angebot Huber schreiben", owner: "Niko", due: "" }], open_questions: [], lang, writtenAt: new Date().toISOString() }; };
    const afterCall = createAfterCall({ memory, skill, endpoint, model: "gemini-2.5-flash", writeRecap, requests });
    const handlers = { after_call: afterCall, notify: p => requests.sendNotification(p) };
    assert.deepEqual(await queue.run({ handlers }), { done: 2, failed: 0 }, "the after-call job, then the message it queued");
    assert.deepEqual(gemini.seen, ["note", "memory"], "the extraction again (it lagged a turn), then the memory step");

    const [note] = await db.query("select data->>'customer_name' customer, contact_id is not null linked from notes where call_id = 'call-x'");
    assert.deepEqual(note, { customer: "Herr Huber", linked: true });
    assert.equal((await memory.objectives.get(objective.id)).status, "done");
    const request = await memory.requests.get("req_t1");
    assert.equal(request.status, "done");
    assert.equal(request.result.questions[0].quote, "So zwei Stunden");
    assert.match(delivered[0].text, /Niko answered/);
    assert.ok((await db.query("select 1 from tasks where text = 'Angebot Huber schreiben'")).length);
    const [call] = await db.query("select after_call_at is not null done, consolidated_at is not null consolidated, extraction_turns, timeline, (meta->>'usd')::float8 > 0.01 costed from calls where id = 'call-x'");
    assert.equal(call.done && call.consolidated, true);
    assert.equal(call.extraction_turns, 3);
    assert.deepEqual(call.timeline.map(e => e.event), ["heard", "saved", "memory", "recap"], "the monitor sees what happened after the call");
    assert.equal(call.costed, true, "its Gemini cost is added to the call's");
    assert.deepEqual(recaps, [{ turns: 3, name: "Niko", lang: "de" }], "the summary, from the whole transcript");
    const shown = await memory.getCall("call-x");
    assert.deepEqual([shown.recap.title, shown.title, shown.userName], ["Küche Huber", "Küche Huber", "Niko"], "the dashboard reads it with the call");
    assert.equal((await memory.recentCalls()).find(c => c.id === "call-x").title, "Küche Huber");

    // Twice (a retry after a crash): nothing new.
    assert.deepEqual(await afterCall({ callId: "call-x" }), { skipped: true });
    await db.query("update calls set after_call_at = null where id = 'call-x'");
    await afterCall({ callId: "call-x" });
    assert.deepEqual(gemini.seen, ["note", "memory", "memory"], "the extraction isn't redone; the memory step runs but changes nothing");
    assert.equal(recaps.length, 1, "the summary isn't written again");
    assert.equal((await db.query("select count(*)::int n from notes where call_id = 'call-x'"))[0].n, 1);
    assert.equal((await db.query("select count(*)::int n from tasks where text = 'Angebot Huber schreiben'"))[0].n, 1);
    assert.equal((await memory.objectives.get(objective.id)).attempts, 1, "the call counts once");
    await queue.run({ handlers });
    assert.equal(delivered.length, 1, "Max is told once");
  } finally { gemini.restore(); }
});

test("background tick: lost calls, due jobs, outbound; one at a time; kick runs it inline", async () => {
  const ran = [];
  const bg = createBackground({ queue, memory, handlers: { t3: async p => ran.push(p.n) }, scheduler: () => ({ tick: async () => ({ deferred: "outside his call times" }) }) });
  await queue.enqueue("t3", { n: 1 }, { key: "t3:1" });
  const [a, b] = [bg.tick(), bg.tick()];
  assert.equal(a, b, "a second tick waits for the running one");
  const out = await a;
  assert.deepEqual(out.jobs, { done: 1, failed: 0 });
  assert.equal(out.outbound, "outside his call times");
  await queue.enqueue("t3", { n: 2 }, { key: "t3:2" });
  bg.kick();
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(ran, [1, 2]);
});

test("bus without Postgres: every subscriber gets each message once", async () => {
  const bus = await createBus();
  const got = [];
  const off = bus.subscribe(m => got.push(m.n));
  bus.publish({ type: "x", n: 1 });
  off();
  bus.publish({ type: "x", n: 2 });
  assert.deepEqual(got, [1]);
});

test("config: Cloud Run needs Postgres, a tick token and a closed API", () => {
  assert.equal(loadConfig({}).background, "inline");
  assert.match(loadConfig({}).databaseUrl, /^pglite:/);
  assert.throws(() => loadConfig({ K_SERVICE: "deskless" }), /DATABASE_URL.*TICK_TOKEN.*DEV_TOKEN or ADMIN_CODE/);
  const c = loadConfig({ K_SERVICE: "deskless", DATABASE_URL: "postgres://x", TICK_TOKEN: "t", DEV_TOKEN: "d" });
  assert.deepEqual([c.background, c.logFormat], ["http", "json"]);
  assert.throws(() => loadConfig({ OUTBOUND: "pigeon" }), /OUTBOUND=pigeon/);
});

test("routes: who may call what", async () => {
  const auth = createAuth({ ADMIN_CODE: "x", SESSION_SECRET: "s" });
  const { token: admin }: Outcome = auth.login({ code: "x" });
  const api = apiOf({
    cfg: { devToken: "dev", tickToken: "tick", model: "m", mask: "typing", dialSecret: "" }, skill, auth, adapters: [], log: () => {},
    memory: { listNotes: async () => [], listUsers: async () => [] }, queue: { list: async () => [] }, notifier: { channels: [] },
    monitor: { list: async () => [], systemLog: () => [], record: false }, background: { tick: async () => ({ ran: true }), mode: "http" }, scheduler: null,
  });
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise<void>(r => server.listen(0, r));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const status = async (path: string, init?: RequestInit) => (await fetch(base + path, init)).status;
  try {
    assert.equal(await status("/healthz"), 200);
    assert.equal(await status("/internal/tick", { method: "POST" }), 401);
    assert.equal(await status("/internal/tick", { method: "POST", headers: { "x-tick-token": "nope" } }), 401);
    assert.equal(await status("/internal/tick", { method: "POST", headers: { "x-tick-token": "tick" } }), 200);
    assert.equal(await status("/api/notes"), 401, "customer data needs a token");
    assert.equal(await status("/api/notes?token=dev"), 200);
    assert.equal(await status("/api/notes", { headers: { authorization: `Bearer ${admin}` } }), 200);
    assert.equal(await status("/api/users?token=dev"), 401, "people and requests: the admin only");
    assert.equal(await status("/api/users", { headers: { authorization: `Bearer ${admin}` } }), 200);
    assert.equal(await status("/monitor"), 401);
    assert.equal(await status("/nope"), 404);
    // Objectives by hand: each field checked before anything is stored.
    const post = (path, body) => status(path, { method: "POST", headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(await post("/api/objectives", {}), 400, "which template");
    assert.equal(await post("/api/objectives", { template: "inquiry", mode: "pigeon" }), 400);
    assert.equal(await post("/api/objectives", { template: "inquiry", deadline: "soon" }), 400);
    assert.equal(await post("/api/objectives", { template: "inquiry", priority: "high" }), 400);
  } finally { server.close(); }
});

test("after a WhatsApp call: the note he confirmed goes into his chat, once; never unconfirmed, never without the feature", async () => {
  const [user] = await memory.listUsers();
  await memory.updateUser(user.id, { phone: "+491701234567" });
  const sent = [];
  const whatsapp = { sendText: async m => { if (m.to === "+491709990000") throw new Error("whatsapp messages 400: window closed"); sent.push(m); return { messageId: `wamid.${sent.length}` }; } };
  const turns = [{ role: "user", text: "Familie Huber, Allensbach, Bad neu, achtzehn Quadratmeter. Angebot bis Freitag." }, { role: "model", text: "Passt das?" }, { role: "user", text: "Ja, passt." }];
  const note = { mode: "capture", customer_name: "Familie Huber", place: "Allensbach", work: [{ area: "Bad", description: "neu fliesen", quantity: "18 m²", material: "" }], next_steps: [{ what: "Angebot schreiben", due: "Freitag" }], summary: "Bad Huber.", confirmed: true };
  const call = async (callId, { from = "+491701234567", source = "whatsapp", extraction = note } = {}) => {
    const scope = await memory.openCall({ callId, from, source });
    await scope.endCall({ turns, extraction, extractionTurns: turns.length, reason: "caller_hangup", lang: "de" });
  };
  const gemini = stubGemini({ note, memoryResult: { call_type: "capture", call_summary: "Bad Huber.", customer: { name: "Familie Huber", place: "Allensbach", summary_update: "Bad neu." }, new_actions: [], completed_action_ids: [] } });
  const system = [];
  const afterCall = createAfterCall({ memory, skill, endpoint, model: "gemini-2.5-flash", whatsapp, monitor: { system: (t, l) => system.push([l, t]), event() {} } });
  try {
    await call("wa-off");
    await afterCall({ callId: "wa-off" });
    assert.equal(sent.length, 0, "the feature is off");

    await memory.updateUser(user.id, { features: { note_whatsapp: true } });
    await call("wa-1");
    await afterCall({ callId: "wa-1" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "+491701234567");
    assert.equal(sent[0].text, "*Notiert* ✅ Familie Huber, Allensbach\n• Bad: neu fliesen (18 m²)\n\n*Zu tun*\n☐ Angebot schreiben (Freitag)\n\n_Stimmt was nicht? Ruf mich kurz an, dann korrigier ich's._");
    await db.query("update calls set after_call_at = null where id = 'wa-1'");
    await afterCall({ callId: "wa-1" });
    assert.equal(sent.length, 1, "a retried job doesn't send it twice");

    await call("wa-unconfirmed", { extraction: { ...note, confirmed: false } });
    await call("phone-line", { source: "twilio" });
    await afterCall({ callId: "wa-unconfirmed" });
    await afterCall({ callId: "phone-line" });
    assert.equal(sent.length, 1, "not confirmed, or not a WhatsApp call: nothing goes out");

    // WhatsApp refuses: the rest of the after-call work is done all the same.
    await db.query("update users set phone_e164 = '+491709990000' where id = $1", [user.id]);
    await call("wa-refused", { from: "+491709990000" });
    await afterCall({ callId: "wa-refused" });
    const [row] = await db.query("select after_call_at is not null done, meta->>'noteSentAt' sent from calls where id = 'wa-refused'");
    assert.deepEqual([row.done, row.sent], [true, null]);
    assert.ok(system.some(([level, text]) => level === "warn" && /note to WhatsApp not sent/.test(text)));
  } finally {
    gemini.restore();
    await memory.updateUser(user.id, { features: { note_whatsapp: false } });
  }
});

test("he asked for something Toni can't do yet: kept on the call, once, and Max is told; Toni says so in the call", async () => {
  const sent = [];
  const notifier = { channels: ["webhook"], send: async m => { sent.push(m); } };
  const turns = [{ role: "user", text: "Kannst du dem Huber direkt eine Mail mit dem Termin schreiben?" }, { role: "model", text: "Das kann ich noch nicht. Ich geb's an Max weiter, der baut mir sowas ein." }];
  const scope = await memory.openCall({ callId: "wish-1", source: "twilio" });
  await scope.endCall({ turns, reason: "caller_hangup", lang: "de" });
  const wish = { what: "Mails an Kunden schreiben", why: "Termine bestätigen", quote: "Kannst du dem Huber direkt eine Mail schreiben?" };
  const gemini = stubGemini({ note: { mode: "unclear" }, memoryResult: { call_type: "other", call_summary: "Wollte eine Mail an Huber.", customer: {}, new_actions: [], completed_action_ids: [], wishes: [wish, { what: "  " }] } });
  try {
    const afterCall = createAfterCall({ memory, skill, endpoint, model: "gemini-2.5-flash", notifier });
    await afterCall({ callId: "wish-1" });
    const call = await memory.getCall("wish-1");
    assert.deepEqual(call.wishes, [wish], "an empty one is dropped");
    assert.equal(sent.length, 1);
    assert.match(sent[0].subject, /asked Toni for something she can't do yet: Mails an Kunden schreiben$/);
    assert.match(sent[0].text, /- Mails an Kunden schreiben \(for: Termine bestätigen\): "Kannst du dem Huber/);
    assert.equal(sent[0].payload.type, "wish");
    assert.equal((await memory.recentCalls()).find(c => c.id === "wish-1").wishes.length, 1, "the calls list knows it too");
    await db.query("update calls set after_call_at = null where id = 'wish-1'");
    await afterCall({ callId: "wish-1" });
    assert.equal(sent.length, 1, "a retried job doesn't tell Max twice");
  } finally { gemini.restore(); }
  assert.match(skill.MEMORY_SYSTEM, /- wishes: what he wanted the assistant to do in this call that it can't do \(yet\)/);
  assert.ok(skill.MEMORY_SCHEMA.required.includes("wishes"));
  assert.match(skill.createAgenda().prompt({ lang: "de" }), /that you can't\n  do that yet and that you'll pass it on to Max, who builds what you can do \("Das kann ich noch nicht, ich geb's an Max weiter\."\)/);
});

test("after-call: a run that stopped before the request was closed closes it on the retry, and Max is told", async () => {
  const delivered = [];
  const requests = createRequests({ memory, skill, auth: createAuth({ ADMIN_CODE: "x", SESSION_SECRET: "s" }), queue, notifier: { channels: ["webhook"], send: async m => { delivered.push(m); } }, llm: async () => { throw new Error("not planned here"); } });
  let crash = true;
  const flaky = { objectivesChanged: async objectives => { if (crash) { crash = false; throw new Error("the instance went away"); } return requests.objectivesChanged(objectives); } };
  const objective = await memory.objectives.create({ template: "inquiry", params: { questions: [{ ask: "Wie viele Angebote schreibst du pro Woche?" }] } });
  await memory.requests.create({ id: "req_t2", userId: (await memory.listUsers())[0].id, instruction: "Frag Niko, wie viele Angebote …", plan: { target: { name: "Niko" } }, planHash: "h", card: { blocked: [] }, status: "approved" });
  await memory.requests.update("req_t2", { objectiveId: objective.id });
  const scope = await memory.openCall({ callId: "call-crash", source: "twilio" });
  await scope.setAgenda([objective.id]);
  const turns = [{ role: "model", text: "Wie viele Angebote schreibst du pro Woche?" }, { role: "user", text: "So drei." }];
  const extraction = { mode: "unclear", agenda: { [objective.id]: { q1: { asked: true, probed: false, status: "answered", answer: "Drei pro Woche.", quote: "So drei" } } } };
  await scope.endCall({ turns, extraction, extractionTurns: turns.length, reason: "caller_hangup", lang: "de" });
  const gemini = stubGemini({ note: extraction, memoryResult: { call_type: "other", call_summary: "Drei Angebote pro Woche.", customer: {}, new_actions: [], completed_action_ids: [], wishes: [] } });
  try {
    const afterCall = createAfterCall({ memory, skill, endpoint, model: "gemini-2.5-flash", requests: flaky });
    await assert.rejects(afterCall({ callId: "call-crash" }), /went away/);
    assert.equal((await memory.objectives.get(objective.id)).status, "done", "recorded before it stopped");
    assert.equal((await memory.requests.get("req_t2")).status, "approved", "its request not closed yet");
    await afterCall({ callId: "call-crash" }); // the queue's retry
    assert.equal((await memory.requests.get("req_t2")).status, "done");
    await queue.run({ handlers: { notify: p => requests.sendNotification(p), after_call: async () => {} } });
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].text, /Niko answered[\s\S]*Drei pro Woche/);
  } finally { gemini.restore(); }
});

// Two instances on one Postgres: NOTIFY reaches every listener.
function sharedPostgres() {
  const listeners = [];
  const notifies = [];
  const db = (): Pick<Db, "kind" | "listen" | "query"> => ({ kind: "postgres", listen: async (channel, fn) => { listeners.push(fn); }, query: async (sql, [, payload]) => { notifies.push(payload); for (const fn of listeners) fn(payload); return []; } });
  return { db, notifies };
}

test("monitor over the bus: a call's events reach the other instances in order, many to one NOTIFY, each under the limit", async () => {
  const pg = sharedPostgres();
  const a = createMonitor({ bus: await createBus({ db: pg.db() }), batchMs: 30 });
  const b: TestMonitor = createMonitor({ bus: await createBus({ db: pg.db() }), batchMs: 30 });
  a.start({ id: "c1", from: "+49", source: "dial" });
  for (let i = 0; i < 20; i++) a.event("c1", { event: "heard", turn: i, text: `Satz ${i} über Fliesen` });
  await sleep(80);
  assert.equal(pg.notifies.length, 1, "the start and 20 events: one NOTIFY");
  assert.deepEqual((await b.get("c1")).events.map(e => e.turn), [...Array(20).keys()], "in order, on the other instance");
  for (let i = 0; i < 200; i++) a.event("c1", { event: "say", turn: i, text: "ä".repeat(300) });
  a.end("c1", "caller_hangup");
  await sleep(80);
  assert.ok(pg.notifies.length > 2, "split when a batch would be too big");
  assert.ok(pg.notifies.every(p => Buffer.byteLength(p) <= MAX_PAYLOAD), "each NOTIFY under the limit, counted in bytes");
  const seen = await b.get("c1");
  assert.equal(seen.events.length, 220);
  assert.ok(seen.endedAt, "and that it ended");
});

test("monitor: only ended calls make room (a live call keeps its timeline); a very long timeline keeps its newest, marked trimmed", async () => {
  const m: TestMonitor = createMonitor({ keepLive: 2, maxEvents: 100 });
  for (const id of ["c1", "c2", "c3"]) m.start({ id, source: "dial" });
  for (const id of ["c1", "c2", "c3"]) assert.ok(await m.get(id), `${id} is live: kept beyond keepLive`);
  m.event("c1", { event: "heard", turn: 1 });
  const record = m.end("c1", "caller_hangup");
  assert.equal(record.events.length, 1, "its record goes to the call's row");
  assert.equal(await m.get("c1"), null, "ended: it makes room (its row has it)");
  for (let i = 0; i < 250; i++) m.event("c2", { event: "heard", turn: i });
  const c2 = await m.get("c2");
  assert.ok(c2.events.length <= 101);
  assert.equal(c2.events[0].event, "trimmed");
  assert.equal(c2.events[0].dropped + c2.events.length - 1, 250, "how many were dropped");
  assert.equal(c2.events.at(-1).turn, 249, "the newest are kept");
  assert.equal((await m.list()).find(c => c.id === "c2").turns, 250, "its turns are still all counted");
});
