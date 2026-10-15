// Background work: the job queue, the after-call job (with Gemini stubbed), the tick,
// the bus, the config's checks, and who may call which route.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDb } from "../src/db/client.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { openPgMemory } from "../src/memory/pg.mjs";
import { createQueue } from "../src/jobs/queue.mjs";
import { createBackground } from "../src/jobs/background.mjs";
import { createAfterCall } from "../src/calls/after-call.mjs";
import { createRequests } from "../src/admin/requests.mjs";
import { createAuth } from "../src/admin/auth.mjs";
import { createBus } from "../src/bus.mjs";
import { loadConfig } from "../src/config.mjs";
import { createApi } from "../src/http/api.mjs";
import { loadSkillFromTemplates } from "../src/skills/from-templates.mjs";

const skill = loadSkillFromTemplates("pilot");
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

// Gemini, stubbed: the note extraction and the memory step answer with fixed JSON.
function stubGemini({ note, memoryResult }) {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
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
    const writeRecap = async ({ turns, name, lang }) => { recaps.push({ turns: turns.length, name, lang }); return { title: "Küche Huber", overview: "Neue Küche bei Huber aufgenommen.", topics: [], actions: [{ text: "Angebot Huber schreiben", owner: "Niko", due: "" }], open_questions: [], lang }; };
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
  const admin = auth.login({ code: "x" }).token;
  const api = createApi({
    cfg: { devToken: "dev", tickToken: "tick", model: "m", mask: "typing", dialSecret: "" }, skill, auth, adapters: [], log: () => {},
    memory: { listNotes: async () => [], listUsers: async () => [] }, queue: { list: async () => [] }, notifier: { channels: [] },
    monitor: { list: async () => [], systemLog: () => [], record: false }, background: { tick: async () => ({ ran: true }), mode: "http" }, scheduler: null,
  });
  const server = http.createServer((req, res) => api.handle(req, res));
  await new Promise(r => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const status = async (path, init) => (await fetch(base + path, init)).status;
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
  } finally { server.close(); }
});

test("after a WhatsApp call: the note he confirmed goes into his chat, once; never unconfirmed, never without the feature", async () => {
  const [user] = await memory.listUsers();
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
    assert.equal(sent[0].text, "*Notiert* ✅ Familie Huber, Allensbach\n• Bad: neu fliesen (18 m²)\nAls Nächstes: Angebot schreiben (Freitag)\n\n_Stimmt was nicht? Ruf mich kurz an, dann korrigier ich's._");
    await db.query("update calls set after_call_at = null where id = 'wa-1'");
    await afterCall({ callId: "wa-1" });
    assert.equal(sent.length, 1, "a retried job doesn't send it twice");

    await call("wa-unconfirmed", { extraction: { ...note, confirmed: false } });
    await call("phone-line", { source: "twilio" });
    await afterCall({ callId: "wa-unconfirmed" });
    await afterCall({ callId: "phone-line" });
    assert.equal(sent.length, 1, "not confirmed, or not a WhatsApp call: nothing goes out");

    // WhatsApp refuses: the rest of the after-call work is done all the same.
    await db.query("update users set phone_e164 = null");
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
