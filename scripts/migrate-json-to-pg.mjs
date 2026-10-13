// Copies the JSON memory (DATA_DIR) into Postgres (DATABASE_URL): customers →
// contacts (their call history → calls), to-dos → tasks, notes → notes, the
// pilot's findings → facts and its question state → research_state, objectives.
// Calendar and quotes stay in JSON. Safe to run again: rows carry their JSON id
// (legacy_id), so a second run updates instead of duplicating.
//   node scripts/migrate-json-to-pg.mjs --dry-run      counts only, no database needed
//   DATABASE_URL=postgres://… node scripts/migrate-json-to-pg.mjs [--embed]
//   (then MEMORY_BACKEND=pg; MEMORY_BACKEND=json is the way back)

import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { readJson } from "../src/store/files.mjs";
import { normalizeNote, normalizeFinding } from "../src/store/note-keys.mjs";
import { loadSkill } from "../src/skills/index.mjs";
import { openDb } from "../src/db/client.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { openPgMemory } from "../src/memory/pg.mjs";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const root = process.env.DATA_DIR || "data";
const file = (...p) => path.join(root, ...p);
const isDate = s => /^\d{4}-\d{2}-\d{2}/.test(String(s ?? ""));
const json = v => JSON.stringify(v ?? null);

const customers = Object.values(readJson(file("memory", "customers.json"), {}));
const actions = readJson(file("memory", "actions.json"), []);
const notes = existsSync(file("notes")) ? readdirSync(file("notes")).filter(f => f.endsWith(".json")).map(f => readJson(file("notes", f), null)).filter(Boolean) : [];
const findings = readJson(file("discovery", "findings.json"), []).map(normalizeFinding);
const questions = readJson(file("discovery", "questions.json"), {});
const researchCalls = readJson(file("discovery", "calls.json"), []);
const objectives = readJson(file("agenda", "objectives.json"), []);
const history = customers.flatMap(c => (c.history ?? []).map((h, i) => ({ ...h, customerId: c.id, id: h.callId || `legacy-${c.id}-${i}` })));
const want = { contacts: customers.length, tasks: actions.length, notes: notes.length, facts: findings.length, objectives: objectives.length, calls: new Set([...history.map(h => h.id), ...notes.map(n => n.call_id).filter(Boolean)]).size };
console.log(`JSON in ${root}: ${Object.entries(want).map(([k, n]) => `${n} ${k}`).join(", ")}${Object.keys(questions).length ? `, research state for ${Object.keys(questions).length} questions` : ""}`);
if (dry) process.exit(0);

const skill = await loadSkill();
const db = await openDb();
await migrate(db, { log: console.log });
const mem = openPgMemory({ db, skill, log: console.log });
await mem.ensureUser();
const users = await db.query("select * from users order by created_at");
const user = users.find(u => u.id === process.env.DEFAULT_USER_ID) ?? users[0];
if (users.length > 1 && !process.env.DEFAULT_USER_ID) throw new Error("several users: set DEFAULT_USER_ID to the one this data belongs to");
const org = user.org_id;

await db.tx(async q => {
  const contactId = new Map();
  for (const c of customers) {
    const [row] = await q.query(`insert into contacts (org_id, name, company, email, phone, address, place, summary, last_contact, legacy_id, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, coalesce($11::timestamptz, now()))
      on conflict (org_id, legacy_id) do update set name = excluded.name, company = excluded.company, email = excluded.email, phone = excluded.phone,
        address = excluded.address, place = excluded.place, summary = excluded.summary, last_contact = excluded.last_contact, updated_at = now()
      returning id`,
      [org, c.name || "?", c.company ?? "", c.email ?? "", c.phone ?? "", c.address ?? "", c.place ?? "", c.summary ?? "", isDate(c.lastContact) ? c.lastContact.slice(0, 10) : null, c.id, c.createdAt ?? null]);
    contactId.set(c.id, row.id);
  }
  // Past calls, already consolidated: they carry the customers' history.
  const transcriptOf = new Map(notes.filter(n => n.call_id).map(n => [n.call_id, n.transcript ?? []]));
  const callRows = new Map(history.map(h => [h.id, { id: h.id, date: h.date, type: h.type ?? "", summary: h.summary ?? "", lang: h.lang ?? null }]));
  for (const n of notes) if (n.call_id && !callRows.has(n.call_id)) callRows.set(n.call_id, { id: n.call_id, date: n.created_at, type: normalizeNote(n).mode ?? "", summary: "", lang: n.lang ?? n.sprache ?? null });
  for (const c of callRows.values()) {
    await q.query(`insert into calls (id, org_id, user_id, started_at, ended_at, call_type, summary, lang, transcript, consolidation_status, consolidated_at)
      values ($1, $2, $3, coalesce($4::timestamptz, now()), coalesce($4::timestamptz, now()), $5, $6, $7, $8, 'done', now())
      on conflict (id) do update set summary = case when calls.summary = '' then excluded.summary else calls.summary end, transcript = case when jsonb_array_length(calls.transcript) = 0 then excluded.transcript else calls.transcript end`,
      [c.id, org, user.id, isDate(c.date) ? c.date : null, c.type, c.summary, c.lang, json(transcriptOf.get(c.id) ?? [])]);
  }
  for (const h of history) if (contactId.has(h.customerId)) await q.query("insert into call_contacts (call_id, contact_id) values ($1, $2) on conflict do nothing", [h.id, contactId.get(h.customerId)]);

  for (const a of actions) {
    await q.query(`insert into tasks (org_id, user_id, contact_id, contact_name, text, due, status, done_at, done_call_id, source_call_id, legacy_id, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, coalesce($12::timestamptz, now()))
      on conflict (org_id, legacy_id) do update set text = excluded.text, due = excluded.due, status = excluded.status, done_at = excluded.done_at, contact_id = excluded.contact_id`,
      [org, user.id, contactId.get(a.customerId) ?? null, a.customerName ?? "", a.text, isDate(a.due) ? a.due.slice(0, 10) : null, a.status === "done" ? "done" : "open", a.doneAt ?? null, a.doneCallId ?? null, a.sourceCallId ?? null, a.id, a.createdAt ?? null]);
  }

  for (const raw of notes) {
    const { transcript, call_id, from, ended_reason, customerId, id, created_at, lang, sprache, ...rest } = raw;
    const n = normalizeNote(rest);
    await q.query(`insert into notes (org_id, user_id, call_id, contact_id, mode, lang, data, summary, legacy_id, created_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, now()))
      on conflict (org_id, legacy_id) do update set data = excluded.data, summary = excluded.summary, contact_id = coalesce(excluded.contact_id, notes.contact_id), mode = excluded.mode`,
      [org, user.id, call_id ?? null, contactId.get(customerId) ?? null, n.mode ?? "", lang ?? sprache ?? n.lang ?? "", json(n), n.summary ?? "", id, created_at ?? null]);
  }

  for (const f of findings) {
    await q.query(`insert into facts (org_id, user_id, subject, kind, text, quote, tags, source_call_id, legacy_id, created_at)
      values ($1, $2, 'user', $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()))
      on conflict (org_id, legacy_id) do update set text = excluded.text, quote = excluded.quote, tags = excluded.tags, kind = excluded.kind`,
      [org, user.id, f.kind || "fact", f.text, f.quote ?? "", [`area:${f.area}`, ...(f.hypothesis ? [`hyp:${f.hypothesis}`] : []), ...(f.stance ? [`stance:${f.stance}`] : [])], f.callId ?? null, f.id, isDate(f.date) ? f.date : null]);
  }
  if (Object.keys(questions).length || researchCalls.length) {
    await q.query(`insert into research_state (user_id, org_id, questions, calls) values ($1, $2, $3, $4)
      on conflict (user_id) do update set questions = excluded.questions, calls = excluded.calls, updated_at = now()`, [user.id, org, json(questions), json(researchCalls)]);
  }

  for (const o of objectives) {
    await q.query(`insert into objectives (id, org_id, user_id, template, version, params, mode, status, priority, lang, result, attempts, max_attempts, calls, not_before, deadline, created_by, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
      on conflict (id) do update set status = excluded.status, result = excluded.result, attempts = excluded.attempts, calls = excluded.calls, updated_at = excluded.updated_at`,
      [o.id, org, user.id, o.template, o.version ?? 1, json(o.params), o.mode, o.status, o.priority ?? 0, o.lang, json(o.result), o.attempts ?? 0, o.maxAttempts ?? 3, o.calls ?? [], o.notBefore, o.deadline, o.createdBy ?? "admin", o.createdAt, o.updatedAt ?? o.createdAt]);
  }
});

const count = async (table, where = "legacy_id is not null") => (await db.query(`select count(*)::int n from ${table} where org_id = $1 and ${where}`, [org]))[0].n;
const have = {
  contacts: await count("contacts"), tasks: await count("tasks"), notes: await count("notes"), facts: await count("facts"),
  objectives: (await db.query("select count(*)::int n from objectives where id = any($1::text[])", [objectives.map(o => o.id)]))[0].n,
  calls: (await db.query("select count(*)::int n from calls where id = any($1::text[])", [[...new Set([...history.map(h => h.id), ...notes.map(n => n.call_id).filter(Boolean)])]]))[0].n,
};
const ok = Object.keys(want).every(k => want[k] === have[k]);
console.log(`Postgres: ${Object.entries(have).map(([k, n]) => `${n} ${k}`).join(", ")} → ${ok ? "counts match" : "COUNTS DIFFER"}`);

if (args.includes("--embed")) {
  const { geminiEndpoint } = await import("../src/engine/gemini-endpoint.mjs");
  const { createEmbedder } = await import("../src/engine/embed.mjs");
  const withEmbeddings = openPgMemory({ db, skill, embedder: createEmbedder({ endpoint: geminiEndpoint(), onError: err => console.log("embedding failed:", err.message) }) });
  for (let i = 0; i < 50; i++) {
    const [{ n }] = await db.query("select (select count(*) from notes where embedding is null) + (select count(*) from facts where embedding is null) n");
    if (!Number(n)) break;
    await withEmbeddings.embedPending();
  }
  console.log("embeddings done");
}
await db.close();
process.exit(ok ? 0 : 1);
