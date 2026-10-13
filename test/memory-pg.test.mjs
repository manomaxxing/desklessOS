// Memory on Postgres, against the real migrations in PGlite (no Docker, no network).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db/client.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { openPgMemory } from "../src/memory/pg.mjs";
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
  mem = openPgMemory({ db, skill, embedder: fakeEmbedder });
  await mem.ensureUser();
});
after(async () => { await mem?.close(); });
const turns = [{ role: "user", text: "Ich komm grad vom Huber." }, { role: "model", text: "Notiert." }];
const result = (over = {}) => ({ call_type: "capture", call_summary: "Küche Huber aufgenommen.", customer: { name: "Herr Huber", place: "Allensbach", summary_update: "Küche: Fliesenspiegel neu, 4 m." }, new_actions: [{ text: "Angebot Huber schreiben", due: "2026-10-16" }], completed_action_ids: [], discovery: { asked_question_ids: ["b1"], answered_question_ids: ["b1"], declined_question_ids: [], findings: [{ area: "angebot", hypothesis: "H2", stance: "supports", kind: "number", text: "Angebote schreibt er sonntags, etwa zwei Stunden.", quote: "Sonntagabend halt" }] }, ...over });

test("migrations run once; the first user comes from the persona's profile", async () => {
  assert.deepEqual(await migrate(db), [], "nothing left to apply");
  const users = await db.query("select u.name, u.lang, o.name org from users u join orgs o on o.id = u.org_id");
  assert.deepEqual(users, [{ name: "Niko", lang: "de", org: "Niko" }]);
  await mem.ensureUser();
  assert.equal((await db.query("select count(*)::int n from users"))[0].n, 1, "only on an empty database");
});

test("a call: note, customer, to-do and research findings, once however often it's applied", async () => {
  const scope = await mem.openCall({ callId: "c1", from: "+4915100000000" });
  assert.equal(scope.user.name, "Niko", "the only user takes any caller");
  assert.match(scope.context, /OPEN TO-DOS/);
  assert.ok(scope.discovery, "the research state comes with the call");
  const note = await scope.saveNote({ mode: "capture", customer_name: "Herr Huber", place: "Allensbach", work: [{ area: "Küche", description: "Fliesenspiegel neu", quantity: "4 m" }], summary: "Küche Huber: Fliesenspiegel neu.", lang: "de", call_id: "c1", transcript: turns });
  assert.ok(note.id);
  await scope.endCall({ turns, reason: "caller_hangup", lang: "de", note, noteId: note.id });

  const changed = await scope.apply(result(), { callId: "c1", noteId: note.id, date: "2026-10-12" });
  assert.equal(changed.customer.name, "Herr Huber");
  assert.equal(changed.added[0].text, "Angebot Huber schreiben");
  assert.equal(changed.discovery.findings.length, 1);
  const again = await scope.apply(result(), { callId: "c1", noteId: note.id, date: "2026-10-12" });
  assert.equal(again.skipped, true, "the second run changes nothing");
  assert.equal((await db.query("select count(*)::int n from tasks"))[0].n, 1);
  assert.equal((await db.query("select count(*)::int n from contacts"))[0].n, 1);

  const [n] = await db.query("select contact_id from notes where id = $1", [note.id]);
  assert.equal(n.contact_id, changed.customer.id, "the note is linked to its customer");
  const [fact] = await db.query("select text, tags, source_call_id from facts");
  assert.deepEqual(fact.tags, ["area:angebot", "hyp:H2", "stance:supports"]);
  const [call] = await db.query("select consolidation_status, summary, jsonb_array_length(transcript) turns from calls where id = 'c1'");
  assert.deepEqual(call, { consolidation_status: "done", summary: "Küche Huber aufgenommen.", turns: 2 });

  const next = await mem.openCall({ callId: "c2" });
  assert.match(next.context, /Herr Huber, Allensbach \| last contact 2026-10-12 \| Küche: Fliesenspiegel neu/);
  assert.match(next.context, /note .*Fliesenspiegel neu/);
  assert.match(next.context, /Herr Huber \| Angebot Huber schreiben \| due 2026-10-16/);
  assert.match(next.discovery.context(), /sonntags, etwa zwei Stunden/, "findings come back as research context");
  assert.equal(next.discovery.questions().b1.answered, true);
  const snap = await next.snapshot({ note: { customer_name: "Huber" } });
  assert.equal(snap.customers[0].name, "Herr Huber");
  assert.equal(snap.openActions[0].text, "Angebot Huber schreiben");
  assert.ok(snap.discovery.questions.length > 10);
  // he says it's done
  const done = await next.apply(result({ customer: { existing_id: changed.customer.id, name: "Herr Huber" }, new_actions: [], completed_action_ids: [changed.added[0].id], discovery: null }), { callId: "c2", date: "2026-10-12" });
  assert.equal(done.completed[0].status, "done");
});

test("search: a sound-alike name, and a note by its meaning", async () => {
  const scope = await mem.openCall({ callId: "c3" });
  await scope.upsertCustomer({ name: "Familie Kowalski", place: "Radolfzell", summary: "Bad im OG." }, { date: "2026-03-01" });
  const note = await scope.saveNote({ mode: "capture", customer_name: "Familie Kowalski", place: "Radolfzell", work: [{ area: "Bad", description: "Feinsteinzeug anthrazit matt", quantity: "12 m²" }], summary: "Bad Kowalski: Feinsteinzeug anthrazit." });
  const [k] = await db.query("select id from contacts where name = 'Familie Kowalski'");
  await db.query("update notes set contact_id = $1 where id = $2", [k.id, note.id]);
  await mem.embedPending();
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
    from contacts c where c.org_id = $1`, [org]);
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

test("objectives on Postgres: create for the user, pick for a call, record the answer", async () => {
  const o = await mem.objectives.create({ template: "inquiry", params: { questions: [{ ask: "Wie lange hat dein letztes Angebot gedauert?" }] } });
  assert.equal(o.status, "pending");
  await assert.rejects(() => mem.objectives.create({ template: "inquiry", params: { questions: [] } }), /1 to 5/);
  const scope = await mem.openCall({ callId: "c5" });
  assert.deepEqual(scope.objectives.map(x => x.id), [o.id]);
  const [changed] = await scope.recordObjectives([{ id: o.id, done: true, result: { questions: [{ id: "q1", status: "answered", answer: "Zwei Stunden.", quote: "zwei Stunden" }] } }]);
  assert.equal(changed.status, "done");
  assert.deepEqual(await scope.recordObjectives([{ id: o.id, done: true, result: {} }]), [], "once per call");
  assert.equal((await mem.openCall({ callId: "c6" })).objectives.length, 0);
});

test("a failed post-call step is claimed for a retry, then done", async () => {
  const scope = await mem.openCall({ callId: "c7" });
  await scope.endCall({ turns, reason: "caller_hangup", lang: "de", note: { mode: "capture" }, noteId: null });
  await scope.consolidationFailed({}, new Error("gemini down"));
  assert.deepEqual(await mem.pendingConsolidations(), [], "not before the call's own attempts are over");
  await db.query("update calls set ended_at = now() - interval '5 minutes' where id = 'c7'");
  const [job] = await mem.pendingConsolidations();
  assert.equal(job.job.callId, "c7");
  assert.equal(job.job.turns.length, 2);
  await job.scope.apply(result({ customer: {}, new_actions: [], discovery: null }), { callId: "c7" });
  assert.deepEqual(await mem.pendingConsolidations(), []);
});

test("an unknown caller among several users gets nothing and saves nothing", async () => {
  const [{ org_id: org }] = await db.query("select org_id from users limit 1");
  await db.query("insert into users (org_id, name, phone_e164) values ($1, 'Second', '+491700000002')", [org]);
  const guest = await mem.openCall({ callId: "c8", from: "+491709999999" });
  assert.equal(guest.user, null);
  assert.equal(await guest.saveNote({ mode: "capture" }), null);
  const known = await mem.openCall({ callId: "c9", from: "+49 170 0000002" });
  assert.equal(known.user.name, "Second", "matched by caller ID");
  await db.query("delete from users where name = 'Second'");
});

test("the API shapes the pages already read", async () => {
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
});
