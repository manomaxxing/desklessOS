// Memory on Postgres, against the real migrations in PGlite (no Docker, no network).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/client.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { openPgMemory } from "../src/memory/pg.mjs";
import { createQueue } from "../src/jobs/queue.mjs";
import { buildContext } from "../src/memory/context.mjs";
import { loadSkillFromTemplates } from "../src/skills/from-templates.mjs";
import { EMBED_DIM } from "../src/engine/embed.mjs";

// A bag-of-words embedder: texts sharing words point the same way.
const fakeEmbedder = {
  model: "fake",
  async embed(texts) {
    return texts.map(t => {
      const v = new Array(EMBED_DIM).fill(0);
      for (const w of String(t).toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 3)) {
        let h = 0;
        for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        v[h % EMBED_DIM] += 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map(x => x / norm);
    });
  },
};

const skill = loadSkillFromTemplates("pilot");
let db, mem;
before(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
  mem = openPgMemory({ db, skill, queue: createQueue({ db }), embedder: fakeEmbedder });
  await mem.ensureUser();
});
after(async () => { await mem?.close(); });
const turns = [{ role: "user", text: "Ich komm grad vom Huber." }, { role: "model", text: "Notiert." }];
const result = (over = {}) => ({ call_type: "capture", call_summary: "Küche Huber aufgenommen.", customer: { name: "Herr Huber", place: "Allensbach", summary_update: "Küche: Fliesenspiegel neu, 4 m." }, new_actions: [{ text: "Angebot Huber schreiben", due: "2026-10-16" }], completed_action_ids: [], discovery: { asked_question_ids: ["b1"], answered_question_ids: ["b1"], declined_question_ids: [], findings: [{ area: "angebot", hypothesis: "H2", stance: "supports", kind: "number", text: "Angebote schreibt er sonntags, etwa zwei Stunden.", quote: "Sonntagabend halt" }] }, ...over });
// A call that ended; what its after-call job works with.
const ended = async (callId, opts = {}) => {
  const scope = await mem.openCall({ callId, ...opts });
  await scope.endCall({ turns, reason: "caller_hangup", lang: "de" });
  return mem.afterCall(callId);
};

test("migrations run once; the first user comes from the persona's profile", async () => {
  assert.deepEqual(await migrate(db), [], "nothing left to apply");
  const users = await db.query("select u.name, u.lang, o.name org from users u join orgs o on o.id = u.org_id");
  assert.deepEqual(users, [{ name: "Niko", lang: "de", org: "Niko" }]);
  await mem.ensureUser();
  assert.equal((await db.query("select count(*)::int n from users"))[0].n, 1, "only on an empty database");
});

test("a call: saved as it goes, ended once with its after-call job", async () => {
  const scope = await mem.openCall({ callId: "c0", from: "+4915100000000", source: "twilio" });
  assert.equal(scope.user.name, "Niko", "the only user takes any caller");
  await scope.checkpoint({ turns: turns.slice(0, 1), extraction: { mode: "capture" }, extractionTurns: 1, lang: "de" });
  const [mid] = await db.query("select jsonb_array_length(transcript) turns, extraction, ended_at from calls where id = 'c0'");
  assert.deepEqual(mid, { turns: 1, extraction: { mode: "capture" }, ended_at: null }, "a dead instance loses nothing");
  assert.equal(await mem.userOnCall(scope.user.id), true, "on a call, whichever instance has it");
  assert.equal(await scope.endCall({ turns, reason: "caller_hangup", lang: "de", timeline: [{ event: "heard" }] }), true);
  assert.equal(await scope.endCall({ turns, reason: "socket_lost" }), false, "a call ends once");
  await scope.checkpoint({ turns: [] });
  assert.equal((await db.query("select jsonb_array_length(transcript) n from calls where id = 'c0'"))[0].n, 2, "a late checkpoint doesn't undo the end");
  assert.equal(await mem.userOnCall(scope.user.id), false);
  const jobs = await db.query("select kind, key, payload from jobs where key = 'after_call:c0'");
  assert.deepEqual(jobs, [{ kind: "after_call", key: "after_call:c0", payload: { callId: "c0" } }], "queued in the same transaction");
  const state = await mem.afterCall("c0");
  assert.equal(state.call.turns.length, 2);
  assert.equal(state.call.extractionTurns, 1);
  await state.done();
  assert.equal(await mem.afterCall("c0"), null, "done: nothing left to do");
});

test("after a call: note, customer, to-do and research findings, once however often it's applied", async () => {
  const scope = await mem.openCall({ callId: "c1", from: "+4915100000000" });
  assert.match(scope.context, /OPEN TO-DOS/);
  assert.ok(scope.discovery, "the research state comes with the call");
  assert.equal(await mem.afterCall("c1"), null, "not before the call ended");
  await scope.endCall({ turns, reason: "caller_hangup", lang: "de" });
  const { scope: post } = await mem.afterCall("c1");
  const note = await post.saveNote({ mode: "capture", customer_name: "Herr Huber", place: "Allensbach", work: [{ area: "Küche", description: "Fliesenspiegel neu", quantity: "4 m" }], summary: "Küche Huber: Fliesenspiegel neu.", lang: "de" });
  assert.ok(note.id);
  const again = await post.saveNote({ mode: "capture", customer_name: "Herr Huber", place: "Allensbach", work: [{ area: "Küche", description: "Fliesenspiegel neu", quantity: "4 m" }], summary: "Küche Huber: Fliesenspiegel neu.", lang: "de" });
  assert.equal(again.id, note.id, "one note per call, however often it's saved");

  const changed = await post.apply(result(), { callId: "c1", noteId: note.id, date: "2026-10-12" });
  assert.equal(changed.customer.name, "Herr Huber");
  assert.equal(changed.added[0].text, "Angebot Huber schreiben");
  assert.equal(changed.discovery.findings.length, 1);
  const twice = await post.apply(result(), { callId: "c1", noteId: note.id, date: "2026-10-12" });
  assert.equal(twice.skipped, true, "the second run changes nothing");
  assert.equal((await db.query("select count(*)::int n from tasks"))[0].n, 1);
  assert.equal((await db.query("select count(*)::int n from contacts"))[0].n, 1);

  const [n] = await db.query("select contact_id from notes where id = $1", [note.id]);
  assert.equal(n.contact_id, changed.customer.id, "the note is linked to its customer");
  const [fact] = await db.query("select text, tags, source_call_id from facts");
  assert.deepEqual(fact.tags, ["area:angebot", "hyp:H2", "stance:supports"]);
  const [call] = await db.query("select consolidated_at is not null done, summary, jsonb_array_length(transcript) turns from calls where id = 'c1'");
  assert.deepEqual(call, { done: true, summary: "Küche Huber aufgenommen.", turns: 2 });

  const next = await mem.openCall({ callId: "c2" });
  assert.match(next.context, /Herr Huber, Allensbach \| last contact 2026-10-12 \| Küche: Fliesenspiegel neu/);
  assert.match(next.context, /note .*Fliesenspiegel neu/);
  assert.match(next.context, /Herr Huber \| Angebot Huber schreiben \| due 2026-10-16/);
  assert.match(next.discovery.context(), /sonntags, etwa zwei Stunden/, "findings come back as research context");
  assert.equal(next.discovery.questions().b1.answered, true);
  await next.endCall({ turns, reason: "caller_hangup" });
  const { scope: post2 } = await mem.afterCall("c2");
  const snap = await post2.snapshot({ note: { customer_name: "Huber" } });
  assert.equal(snap.customers[0].name, "Herr Huber");
  assert.equal(snap.openActions[0].text, "Angebot Huber schreiben");
  assert.ok(snap.discovery.questions.length > 10);
  // he says it's done
  const done = await post2.apply(result({ customer: { existing_id: changed.customer.id, name: "Herr Huber" }, new_actions: [], completed_action_ids: [changed.added[0].id], discovery: null }), { callId: "c2", date: "2026-10-12" });
  assert.equal(done.completed[0].status, "done");
});

test("search: a sound-alike name, and a note by its meaning", async () => {
  const [{ org_id: org }] = await db.query("select org_id from users limit 1");
  const [k] = await db.query("insert into contacts (org_id, name, place, summary, last_contact) values ($1, 'Familie Kowalski', 'Radolfzell', 'Bad im OG.', '2026-03-01') returning id", [org]);
  await db.query("insert into notes (org_id, contact_id, mode, data, summary) values ($1, $2, 'capture', $3, 'Bad Kowalski')",
    [org, k.id, JSON.stringify({ mode: "capture", customer_name: "Familie Kowalski", place: "Radolfzell", work: [{ area: "Bad", description: "Feinsteinzeug anthrazit matt", quantity: "12 m²" }], summary: "Bad Kowalski: Feinsteinzeug anthrazit." })]);
  await mem.embedPending();
  const scope = await mem.openCall({ callId: "c3" });
  const byName = await scope.search("Kowalsky in Radolfzell");
  assert.equal(byName[0].name, "Familie Kowalski");
  assert.match(byName[0].notes[0], /anthrazit/);
  const byMeaning = await scope.search("anthrazit Feinsteinzeug");
  assert.equal(byMeaning[0].name, "Familie Kowalski", "found through the note's embedding, not the name");
  assert.deepEqual(await scope.search("und die"), [], "stopwords find nothing");
});

test("500 customers: the context stays within its budget, and memory_search is offered", async () => {
  const [{ org_id: org }] = await db.query("select org_id from users limit 1");
  await db.query(`insert into contacts (org_id, name, place, summary, last_contact)
    select $1, 'Kunde ' || i, 'Ort ' || (i % 20), 'Bad ' || i || ', ' || repeat('Fliesen und Fugen, ', 6), date '2026-10-12' - i from generate_series(1, 500) i`, [org]);
  await db.query(`insert into notes (org_id, contact_id, mode, data, summary)
    select $1, c.id, 'capture', jsonb_build_object('mode', 'capture', 'customer_name', c.name, 'summary', 'Lange Notiz ' || repeat('mit Details ', 20)), 'x'
    from contacts c where c.org_id = $1 and c.name like 'Kunde %'`, [org]);
  const t0 = performance.now();
  const scope = await mem.openCall({ callId: "c4", at: new Date("2026-10-12T09:00:00Z") });
  const ms = performance.now() - t0;
  assert.ok(scope.stats.tokens <= 2500, `${scope.stats.tokens} tokens`);
  assert.ok(scope.stats.customers <= 8);
  assert.ok(scope.hidden >= 490, "most customers only through memory_search");
  assert.match(scope.context, /OTHER CUSTOMERS \(name only; memory_search has the details\)/);
  assert.match(scope.context, /and \d+ more/);
  assert.ok(ms < 1500, `opening the call took ${Math.round(ms)} ms in PGlite`);
});

test("buildContext: fewer notes before fewer customers, and never over budget", () => {
  const contacts = Array.from({ length: 30 }, (_, i) => ({ name: `K${i}`, place: "X", summary: "s".repeat(200), lastContact: "2026-10-01", notes: ["n".repeat(400), "n".repeat(400), "n".repeat(400)] }));
  for (const budget of [300, 800, 2500]) {
    const { stats } = buildContext({ today: "2026-10-12", contacts, totalContacts: 30 }, { budget });
    assert.ok(stats.tokens <= budget + 20, `${stats.tokens} > ${budget}`);
  }
});

test("objectives: create for the user, pick for a call (best first), record answers, done or expired", async () => {
  const question = { template: "inquiry", params: { questions: [{ ask: "Wie lange hat dein letztes Angebot gedauert?" }] } };
  await assert.rejects(() => mem.objectives.create({ template: "nope", params: {} }), /unknown objective template/);
  await assert.rejects(() => mem.objectives.create({ ...question, mode: "smoke-signal" }), /mode "smoke-signal" isn't possible/);
  await assert.rejects(() => mem.objectives.create({ template: "inquiry", params: { questions: [] } }), /1 to 5/);
  const a = await mem.objectives.create(question);
  const b = await mem.objectives.create({ ...question, priority: 5 });
  assert.equal(a.status, "pending");
  const scope = await mem.openCall({ callId: "c5" });
  assert.deepEqual(scope.objectives.map(x => x.id), [b.id, a.id], "higher priority first");
  assert.deepEqual((await mem.openCall({ callId: "c5o", direction: "outbound" })).objectives, [], "next_inbound ones aren't for a call we make");
  const notAsked = { questions: [{ id: "q1", status: "not_asked", answer: "", quote: "" }] };
  const { scope: post } = await ended("c5a");
  await post.recordObjectives([{ id: a.id, done: false, result: { questions: [{ id: "q1", status: "answered", answer: "Zwei Stunden.", quote: "zwei Stunden" }] } }]);
  const { scope: post2 } = await ended("c5b");
  const [kept] = await post2.recordObjectives([{ id: a.id, done: false, result: notAsked }]);
  assert.equal(kept.result.questions[0].answer, "Zwei Stunden.", "a call that didn't get to it keeps the answer from before");
  assert.equal(kept.attempts, 2);
  const [changed] = await post2.recordObjectives([{ id: b.id, done: true, result: { questions: [{ id: "q1", status: "answered", answer: "Drei Stunden.", quote: "" }] } }]);
  assert.equal(changed.status, "done");
  assert.deepEqual(await post2.recordObjectives([{ id: b.id, done: true, result: {} }]), [], "once per call");
  const { scope: post3 } = await ended("c5c");
  const [expired] = await post3.recordObjectives([{ id: a.id, done: false, result: notAsked }]);
  assert.equal(expired.status, "expired", "three calls without getting it done");
  const c = await mem.objectives.create(question);
  assert.equal((await mem.objectives.cancel(c.id)).status, "cancelled");
  assert.equal((await mem.openCall({ callId: "c6" })).objectives.length, 0);
  assert.deepEqual((await mem.objectives.byIds([b.id, "nope", a.id])).map(o => o.id), [b.id, a.id]);
});

test("a call whose instance died is ended by the sweep, and its after-call job queued", async () => {
  const scope = await mem.openCall({ callId: "c7", at: new Date(Date.now() - 45 * 60000) });
  await scope.checkpoint({ turns, lang: "de" });
  assert.ok((await mem.sweepLostCalls()).includes("c7"));
  assert.deepEqual(await mem.sweepLostCalls(), [], "once");
  const [row] = await db.query("select ended_reason, (select count(*)::int from jobs where key = 'after_call:c7') jobs from calls where id = 'c7'");
  assert.deepEqual(row, { ended_reason: "lost", jobs: 1 });
  assert.equal((await mem.afterCall("c7")).call.turns.length, 2, "what it had saved is all there");
});

test("voice clips: stored once by key, read back as bytes", async () => {
  await mem.voiceClips.put("k1", Buffer.from([1, 2, 3, 4]));
  await mem.voiceClips.put("k1", Buffer.from([9, 9]));
  const got = await mem.voiceClips.get(["k1", "k2"]);
  assert.deepEqual([...got.keys()], ["k1"]);
  assert.ok(Buffer.isBuffer(got.get("k1")));
  assert.deepEqual([...got.get("k1")], [1, 2, 3, 4], "the first one stays");
});

test("an unknown caller among several users gets nothing and saves nothing", async () => {
  const [{ org_id: org }] = await db.query("select org_id from users limit 1");
  await db.query("insert into users (org_id, name, phone_e164) values ($1, 'Second', '+491700000002')", [org]);
  const guest = await mem.openCall({ callId: "c8", from: "+491709999999" });
  assert.equal(guest.user, null);
  assert.equal(await guest.endCall({ turns }), false);
  assert.deepEqual(await db.query("select id from calls where id = 'c8'"), [], "no row, no transcript");
  const known = await mem.openCall({ callId: "c9", from: "+49 170 0000002" });
  assert.equal(known.user.name, "Second", "matched by caller ID");
  await db.query("delete from calls where id = 'c9'");
  await db.query("delete from users where name = 'Second'");
});

test("the API shapes the pages read: memory, notes, research, the call log", async () => {
  const overview = await mem.memoryOverview();
  const huber = overview.customers.find(c => c.name === "Herr Huber");
  assert.equal(huber.lastContact, "2026-10-12");
  assert.ok(huber.history.length >= 1);
  assert.ok(overview.actions.every(a => "customerName" in a && "status" in a));
  const notes = await mem.listNotes({ limit: 1000 });
  assert.ok(notes.some(n => n.call_id === "c1" && n.customer_name === "Herr Huber" && n.transcript.length === 2));
  const d = await mem.discoveryOverview();
  assert.equal(d.findings[0].area, "angebot");
  const task = overview.actions.find(a => a.status === "done");
  assert.equal((await mem.setTaskStatus(task.id, "open")).status, "open");
  const calls = await mem.recentCalls();
  const c0 = calls.find(c => c.id === "c0");
  assert.equal(c0.source, "twilio");
  assert.equal(c0.turns, 1, "his turns");
  assert.equal(calls.find(c => c.id === "c1").savedNoteId, notes.find(n => n.call_id === "c1").id);
  const detail = await mem.getCall("c0");
  assert.deepEqual(detail.events, [{ event: "heard" }]);
  assert.equal(await mem.getCall("nope"), null);
});
