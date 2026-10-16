// Memory on Postgres (Supabase EU; PGlite locally and in tests): per user and org,
// searchable, a budgeted context per call, the call itself saved as it goes, and the
// after-call steps, each of which does its work once however often it's tried.
// Schema: src/db/migrations/.
//
// Who calls: caller ID → users.phone_e164; no caller ID at all (the online test phone,
// scripted calls) → the demo user; else DEFAULT_USER_ID; else the only user there is (the
// pilot). Anyone else gets an empty memory and nothing is saved. The demo user (users.demo)
// has an org of its own, and a phone number like anyone (Max's own, to demo on WhatsApp).

import { buildContext, DEFAULT_BUDGET } from "./context.mjs";
import { noteLine, searchWords } from "./text.mjs";
import { normalizeNote } from "./note-keys.mjs";
import { createDiscovery, memoryStorage } from "./research.mjs";
import { mergeResult, MODES_FOR } from "./objectives.mjs";
import { toVector } from "../engine/embed.mjs";
import { randomUUID } from "node:crypto";
import { FEATURES, allFeatures } from "../features.mjs";
import { listsIn } from "../quotes/lists.mjs";

const QUERY_EMBED_MS = 1200; // search waits this long for the query's vector, then goes on with names only
const EMBED_PAUSE_MS = 5 * 60 * 1000; // after a late one, searches skip vectors for a while
// How well the spoken words ($2) match a contact's name and place: each word that sounds
// like one of them (≥ 0.45) adds its similarity, so "Kowalski Radolfzell" beats "Radolfzell".
const WORD_SCORE = "(select coalesce(sum(x), 0) from (select word_similarity(w, norm(name || ' ' || place)) x from unnest($2::text[]) w) t where x >= 0.45)";
const LOST_AFTER_MIN = 30; // a call still open this long is over (calls end at MAX_CALL_MIN, 15): its instance died
const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s ?? ""));
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));
const day = d => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
export const e164 = s => {
  const d = String(s ?? "").replace(/[^\d+]/g, "");
  return /^\+?\d{6,15}$/.test(d) ? (d.startsWith("+") ? d : `+${d}`) : null;
};
const json = v => JSON.stringify(v ?? null);
const tag = (f, name) => f.tags?.find(t => t.startsWith(`${name}:`))?.slice(name.length + 1) ?? "";

// Rows → the shapes the API, the web pages and the prompts already know.
const customerOut = c => c && ({ id: c.id, name: c.name, company: c.company, email: c.email, phone: c.phone, address: c.address, place: c.place, summary: c.summary, lastContact: c.last_contact ? day(c.last_contact) : "", history: c.history ?? [] });
const taskOut = t => t && ({ id: t.id, text: t.text, due: t.due ? day(t.due) : "", status: t.status, customerId: t.contact_id, customerName: t.contact_name, createdAt: t.created_at, doneAt: t.done_at, sourceCallId: t.source_call_id });
const noteOut = n => ({ ...n.data, id: n.id, lang: n.lang || n.data?.lang || "", call_id: n.call_id, created_at: new Date(n.created_at).toISOString(), customerId: n.contact_id ?? undefined, ...(n.transcript ? { transcript: n.transcript } : {}) });
const userOut = u => u && ({
  id: u.id, orgId: u.org_id, name: u.name, phone: u.phone_e164 ?? "", lang: u.lang, role: u.role, timezone: u.timezone,
  callWindow: u.call_window ?? {}, consentOutboundAt: u.consent_outbound_at ? new Date(u.consent_outbound_at).toISOString() : null, outboundPaused: Boolean(u.outbound_paused),
  demo: Boolean(u.demo), business: u.profile?.business ?? {}, features: u.profile?.features ?? {}, lists: u.profile?.lists ?? {},
});
// His business, for quotes (src/quotes/quote.mjs): only these fields, as text; VAT as a number.
const BUSINESS_FIELDS = ["name", "address", "phone", "email", "taxId", "currency", "vatRate"];
const businessIn = b => Object.fromEntries(BUSINESS_FIELDS.filter(k => b?.[k] !== undefined && b[k] !== null && String(b[k]).trim() !== "").map(k => {
  const v = String(b[k]).trim().slice(0, 200);
  if (k === "vatRate") { const n = Number(v.replace(",", ".")); if (!(n >= 0 && n <= 50)) throw Object.assign(new Error("VAT: a percentage between 0 and 50"), { status: 400 }); return [k, n]; }
  if (k === "currency") { if (!/^[A-Za-z]{3}$/.test(v)) throw Object.assign(new Error("currency: a three-letter code like EUR"), { status: 400 }); return [k, v.toUpperCase()]; }
  return [k, v];
}));
const requestOut = r => r && ({
  id: r.id, userId: r.user_id, instruction: r.instruction, plan: r.plan, planHash: r.plan_hash, card: r.card, turns: r.turns, status: r.status,
  objectiveId: r.objective_id, result: r.result, createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(),
  approvedAt: r.approved_at && new Date(r.approved_at).toISOString(), closedAt: r.closed_at && new Date(r.closed_at).toISOString(),
  notifiedAt: r.notified_at && new Date(r.notified_at).toISOString(), log: r.log ?? [],
  updatedAt: new Date(r.updated_at).toISOString(),
});
// request fields (camelCase) → columns
const REQUEST_COLUMNS = { log: "log", userId: "user_id", instruction: "instruction", plan: "plan", planHash: "plan_hash", card: "card", turns: "turns", status: "status", objectiveId: "objective_id", result: "result", approvedAt: "approved_at", closedAt: "closed_at", notifiedAt: "notified_at" };
const JSON_COLUMNS = new Set(["plan", "card", "turns", "result", "log"]);
const objectiveOut = o => o && ({
  id: o.id, template: o.template, version: o.version, params: o.params, mode: o.mode, status: o.status, priority: o.priority, lang: o.lang,
  createdAt: new Date(o.created_at).toISOString(), createdBy: o.created_by, notBefore: o.not_before, deadline: o.deadline,
  attempts: o.attempts, maxAttempts: o.max_attempts, calls: o.calls, result: o.result, updatedAt: new Date(o.updated_at).toISOString(), userId: o.user_id,
});
// The text a note or fact is found by.
const noteText = d => { const n = normalizeNote(d); return [n.summary, n.customer_name, n.place, n.address, ...(n.work ?? []).map(w => [w.area, w.description, w.quantity, w.material].filter(Boolean).join(" "))].filter(Boolean).join(". "); };

/** A call that keeps nothing: an unknown caller, Max's own line, or memory that's down. */
export const emptyScope = () => ({
  user: null, context: "", hidden: 0, stats: null, discovery: null, objectives: [],
  search: async () => [], setAgenda: async () => {}, checkpoint: async () => {}, endCall: async () => false, recordToolRun: async () => {},
});

const USER_TURNS = "(select count(*)::int from jsonb_array_elements(c.transcript) t where t->>'role' = 'user')";
const callOut = c => c && ({
  id: c.id, userId: c.user_id, direction: c.direction, source: c.source, from: c.from_e164, to: c.to_e164, lang: c.lang,
  startedAt: new Date(c.started_at).getTime(), endedAt: c.ended_at ? new Date(c.ended_at).getTime() : null, endedReason: c.ended_reason,
  summary: c.summary, callType: c.call_type, mode: c.meta?.mode ?? null, usd: c.meta?.usd ?? null, turns: c.turns ?? null, savedNoteId: c.note_id ?? null,
  userName: c.user_name ?? null, title: c.recap?.title ?? c.recap_title ?? null, goal: c.meta?.goal ?? [], rehearsalOf: c.meta?.rehearsalOf?.name ?? null,
  ...(c.timeline ? { events: c.timeline, transcript: c.transcript, note: c.note ?? c.extraction ?? null, cost: c.meta?.cost ?? null, recap: c.recap ?? null } : {}),
});

/** `queue` (src/jobs/queue.mjs): the end of a call enqueues its after-call job in the same transaction. */
export function openPgMemory({ db, skill, queue = null, embedder = null, budget = DEFAULT_BUDGET, log = () => {} }) {
  const framework = skill.framework;

  // ---------- users ----------
  /** First start on an empty database: an org and a user from the persona's profile. */
  async function ensureUser() {
    const [{ n }] = await db.query("select count(*)::int n from users");
    if (n) return;
    const p = skill.profile ?? {};
    const orgName = p.business ? p.name : `${p.name ?? "Pilot"}`;
    const [org] = await db.query("insert into orgs (name) values ($1) returning id", [orgName]);
    const profile = Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v !== "function"));
    await db.query("insert into users (org_id, name, phone_e164, lang, timezone, profile) values ($1, $2, $3, $4, $5, $6)",
      [org.id, p.owner ?? p.name ?? "User", e164(p.phone), p.lang ?? skill.DEFAULT_LANG, p.timezone ?? "Europe/Berlin", json(profile)]);
    log(`memory: created org "${orgName}" and its first user`);
  }
  /** The demo: an org and a user of their own, created once. */
  async function ensureDemoUser() {
    if ((await db.query("select 1 from users where demo")).length) return;
    const lang = skill.profile?.lang ?? skill.DEFAULT_LANG;
    const [org] = await db.query("insert into orgs (name) values ('Demo') returning id");
    await db.query("insert into users (org_id, name, lang, timezone, demo, profile) values ($1, 'Demo', $2, $3, true, $4)",
      [org.id, lang, skill.profile?.timezone ?? "Europe/Berlin", json({ name: "Demo", lang, demo: true, features: allFeatures() })]);
    log("memory: created the demo user");
  }

  async function resolveUser(from) {
    const phone = e164(from);
    if (phone) { const [u] = await db.query("select * from users where phone_e164 = $1", [phone]); if (u) return u; }
    if (isUuid(process.env.DEFAULT_USER_ID)) { const [u] = await db.query("select * from users where id = $1", [process.env.DEFAULT_USER_ID]); if (u) return u; }
    const rows = await db.query("select * from users where not demo order by created_at limit 2");
    return rows.length === 1 ? rows[0] : null;
  }
  const defaultUser = () => resolveUser(null);
  /** Who's calling. No caller ID at all (the browser test phone, scripted calls: both need
   *  DEV_TOKEN) is the demo user; without one, DEFAULT_USER_ID, else the first user. */
  async function callerUser(from) {
    if (!e164(from)) {
      const [demo] = await db.query("select * from users where demo order by created_at limit 1");
      if (demo) return demo;
    }
    if (e164(from) || isUuid(process.env.DEFAULT_USER_ID)) return resolveUser(from);
    const [first] = await db.query("select * from users order by created_at limit 1");
    return first ?? null;
  }

  // ---------- the pilot's research ----------
  async function loadResearch(q, user) {
    if (!framework || user.demo) return null; // the demo gets no research questions
    const [[state], facts] = await Promise.all([
      q.query("select questions, calls from research_state where user_id = $1", [user.id]),
      q.query("select id, kind, text, quote, tags, source_call_id, created_at from facts where user_id = $1 and subject = 'user' and superseded_by is null and exists (select 1 from unnest(tags) t where t like 'area:%') order by created_at", [user.id]),
    ]);
    const findings = facts.map(f => ({ id: f.id, area: tag(f, "area"), hypothesis: tag(f, "hyp"), stance: tag(f, "stance"), kind: f.kind, text: f.text, quote: f.quote, callId: f.source_call_id, date: day(f.created_at) }));
    const storage = memoryStorage({ "findings.json": findings, "questions.json": state?.questions ?? {}, "calls.json": state?.calls ?? [] });
    return { discovery: createDiscovery({ framework, storage }), storage };
  }

  // ---------- the call's context ----------
  async function contextData(user, at) {
    const org = user.org_id;
    const today = day(at);
    const [facts, tasks, [{ n: openTaskCount }], done, contacts, [{ n: totalContacts }], loose] = await Promise.all([
      db.query("select text from facts where org_id = $1 and subject = 'user' and superseded_by is null and not exists (select 1 from unnest(tags) t where t like 'area:%') order by created_at desc limit 12", [org]),
      db.query("select text, due, contact_name from tasks where org_id = $1 and status = 'open' order by due nulls last, created_at limit 10", [org]),
      db.query("select count(*)::int n from tasks where org_id = $1 and status = 'open'", [org]),
      db.query("select text, contact_name from tasks where org_id = $1 and status = 'done' order by done_at desc nulls last limit 5", [org]),
      db.query(`select c.id, c.name, c.place, c.address, c.phone, c.summary, c.last_contact, coalesce(t.open, 0)::int open_tasks, t.next_due
        from contacts c left join (select contact_id, count(*) open, min(due) next_due from tasks where org_id = $1 and status = 'open' group by contact_id) t on t.contact_id = c.id
        where c.org_id = $1
        order by 10.0 / (1 + coalesce($2::date - c.last_contact, 365) / 7.0) + 2 * coalesce(t.open, 0) + case when t.next_due <= $2::date + 7 then 3 else 0 end desc, c.name
        limit 48`, [org, today]),
      db.query("select count(*)::int n from contacts where org_id = $1", [org]),
      db.query("select data, created_at from notes where org_id = $1 and contact_id is null and mode in ('capture', 'order') order by created_at desc limit 5", [org]),
    ]);
    const top = contacts.slice(0, 8).map(c => c.id);
    const notes = top.length
      ? await db.query("select contact_id, data, created_at from (select contact_id, data, created_at, row_number() over (partition by contact_id order by created_at desc) rn from notes where contact_id = any($1::uuid[])) x where rn <= 3 order by created_at desc", [top])
      : [];
    return {
      today,
      facts,
      tasks: tasks.map(t => ({ text: t.text, due: t.due ? day(t.due) : "", contactName: t.contact_name })),
      openTaskCount,
      done: done.map(t => ({ text: t.text, contactName: t.contact_name })),
      contacts: contacts.map(c => ({
        name: c.name, place: c.place, address: c.address, phone: c.phone, summary: c.summary,
        lastContact: c.last_contact ? day(c.last_contact) : null, openTasks: c.open_tasks, nextDue: c.next_due ? day(c.next_due) : null,
        notes: notes.filter(n => n.contact_id === c.id).map(n => noteLine({ ...n.data, created_at: new Date(n.created_at).toISOString() })),
      })),
      totalContacts,
      looseNotes: loose.map(n => noteLine({ ...n.data, created_at: new Date(n.created_at).toISOString() })),
    };
  }

  // ---------- search: sound-alike names, and notes and facts by meaning ----------
  let embedPausedUntil = 0;
  async function search(user, query, { limit = 3 } = {}) {
    const words = searchWords(query);
    if (!words.length) return [];
    const org = user.org_id;
    // Names first and in parallel: a slow embedding service never holds the answer up.
    const nameQuery = db.query(`select id, ${WORD_SCORE} s from contacts where org_id = $1 order by s desc limit 5`, [org, words]);
    let timer;
    const vector = embedder && Date.now() > embedPausedUntil
      ? await Promise.race([
        embedder.embed([words.join(" ")], { task: "RETRIEVAL_QUERY" }).then(([v]) => v).catch(() => null),
        new Promise(resolve => { timer = setTimeout(() => { embedPausedUntil = Date.now() + EMBED_PAUSE_MS; log("memory: query embedding late, searching by name for 5 min"); resolve(null); }, QUERY_EMBED_MS); }),
      ]).finally(() => clearTimeout(timer))
      : null;
    const [byName, byNote, byFact] = await Promise.all([
      nameQuery,
      vector
        ? db.query("select id, contact_id, data, created_at, 1 - (embedding <=> $2::vector) s from notes where org_id = $1 and embedding is not null order by embedding <=> $2::vector limit 6", [org, toVector(vector)])
        : db.query(`select id, contact_id, data, created_at, (select max(word_similarity(w, norm(summary || ' ' || data::text))) from unnest($2::text[]) w) * 0.8 s
            from notes where org_id = $1 order by s desc limit 6`, [org, words]),
      vector
        ? db.query("select contact_id, text, 1 - (embedding <=> $2::vector) s from facts where org_id = $1 and embedding is not null and superseded_by is null and contact_id is not null order by embedding <=> $2::vector limit 6", [org, toVector(vector)])
        : Promise.resolve([]),
    ]);
    const score = new Map();
    const bump = (id, s) => { if (id) score.set(id, Math.max(score.get(id) ?? 0, 0) + s); };
    for (const r of byName) if (r.s >= 0.45) bump(r.id, 3 * r.s);
    for (const r of [...byNote, ...byFact]) if (r.s >= 0.55) bump(r.contact_id, r.s);
    const ids = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
    const loose = byNote.filter(n => !n.contact_id && n.s >= 0.55).slice(0, 2).map(n => ({ note: noteLine({ ...n.data, created_at: new Date(n.created_at).toISOString() }) }));
    if (!ids.length) return loose;
    const [contacts, notes, tasks, history] = await Promise.all([
      db.query("select * from contacts where id = any($1::uuid[])", [ids]),
      db.query("select contact_id, data, created_at from (select contact_id, data, created_at, row_number() over (partition by contact_id order by created_at desc) rn from notes where contact_id = any($1::uuid[])) x where rn <= 3 order by created_at desc", [ids]),
      db.query("select contact_id, text, due from tasks where contact_id = any($1::uuid[]) and status = 'open' order by due nulls last", [ids]),
      db.query("select cc.contact_id, c.started_at, c.summary from call_contacts cc join calls c on c.id = cc.call_id where cc.contact_id = any($1::uuid[]) and c.summary <> '' order by c.started_at desc", [ids]),
    ]);
    return [
      ...ids.map(id => contacts.find(c => c.id === id)).filter(Boolean).map(c => ({
        name: c.name, place: c.place, address: c.address, phone: c.phone, last_contact: c.last_contact ? day(c.last_contact) : "", summary: c.summary,
        history: history.filter(h => h.contact_id === c.id).slice(0, 3).map(h => `${day(h.started_at)}: ${h.summary}`),
        notes: notes.filter(n => n.contact_id === c.id).map(n => noteLine({ ...n.data, created_at: new Date(n.created_at).toISOString() })),
        open_todos: tasks.filter(t => t.contact_id === c.id).map(t => `${t.text}${t.due ? ` (due ${day(t.due)})` : ""}`),
      })),
      ...loose,
    ];
  }

  // ---------- embeddings, filled in the background ----------
  let embedding = null;
  function embedPending() {
    if (!embedder || embedding) return embedding;
    embedding = (async () => {
      for (const [table, textOf] of [["notes", r => noteText(r.data)], ["facts", r => r.text]]) {
        const rows = await db.query(`select id, ${table === "notes" ? "data" : "text"} from ${table} where embedding is null order by created_at desc limit 100`);
        if (!rows.length) continue;
        const vectors = await embedder.embed(rows.map(textOf));
        for (const [i, v] of vectors.entries()) if (v) await db.query(`update ${table} set embedding = $2::vector where id = $1`, [rows[i].id, toVector(v)]);
      }
    })().catch(err => log("memory: embedding failed", err.message)).finally(() => { embedding = null; });
    return embedding;
  }

  // ---------- the memory step after a call ----------
  function postCall(user) {
    return {
      /** What the memory model needs to match against: likely customers, open to-dos, the research framework. */
      async snapshot({ note } = {}) {
        const org = user.org_id;
        const n = normalizeNote(note ?? {});
        const words = searchWords(`${n.customer_name ?? ""} ${n.place ?? ""}`);
        const [likely, recent, open, research] = await Promise.all([
          words.length ? db.query(`select id, name, place, summary, ${WORD_SCORE} s from contacts where org_id = $1 order by s desc limit 5`, [org, words]) : [],
          db.query("select id, name, place, summary from contacts where org_id = $1 order by last_contact desc nulls last limit 15", [org]),
          db.query("select id, contact_name, text, due from tasks where org_id = $1 and status = 'open' order by due nulls last limit 40", [org]),
          loadResearch(db, user),
        ]);
        const customers = [...new Map([...likely.filter(c => c.s >= 0.3), ...recent].map(c => [c.id, { id: c.id, name: c.name, place: c.place, summary: c.summary }])).values()];
        return {
          customers,
          openActions: open.map(t => ({ id: t.id, customer: t.contact_name, text: t.text, due: t.due ? day(t.due) : "" })),
          ...(research ? { discovery: research.discovery.snapshot() } : {}),
        };
      },

      /** Applies the memory model's result as typed changes, in one transaction, once per call. */
      async apply(result, { callId, noteId = null, date = day(new Date()) } = {}) {
        const changed = await db.tx(async q => {
          const org = user.org_id;
          const changed = { customer: null, added: [], completed: [], updated: [] };
          const claimed = await q.query("update calls set consolidated_at = now(), call_type = $2, summary = $3 where id = $1 and consolidated_at is null returning id", [callId, result.call_type ?? "", result.call_summary ?? ""]);
          if (!claimed.length) return { ...changed, skipped: true }; // already done (or no such call)

          const c = result.customer ?? {};
          let contact = null;
          if (c.name || c.existing_id) {
            if (isUuid(c.existing_id)) [contact] = await q.query("select * from contacts where id = $1 and org_id = $2", [c.existing_id, org]);
            if (!contact && c.name) [contact] = await q.query("select * from contacts where org_id = $1 and norm(name) = norm($2) and ($3 = '' or place = '' or norm(place) = norm($3)) order by last_contact desc nulls last limit 1", [org, c.name, c.place ?? ""]);
            if (!contact && c.name) [contact] = await q.query("insert into contacts (org_id, name) values ($1, $2) returning *", [org, c.name]);
          }
          if (contact) {
            [contact] = await q.query(`update contacts set name = coalesce(nullif($2, ''), name), place = coalesce(nullif($3, ''), place), address = coalesce(nullif($4, ''), address),
              phone = coalesce(nullif($5, ''), phone), summary = coalesce(nullif($6, ''), summary), last_contact = greatest(coalesce(last_contact, $7::date), $7::date), updated_at = now()
              where id = $1 returning *`, [contact.id, c.name ?? "", c.place ?? "", c.address ?? "", c.phone ?? "", c.summary_update ?? "", date]);
            await q.query("insert into call_contacts (call_id, contact_id) values ($1, $2) on conflict do nothing", [callId, contact.id]);
            if (isUuid(noteId)) await q.query("update notes set contact_id = $1 where id = $2 and org_id = $3", [contact.id, noteId, org]);
            changed.customer = { id: contact.id, name: contact.name };
          }

          for (const a of result.new_actions ?? []) {
            if (!a.text) continue;
            let target = contact;
            if (a.customer_name) [target = contact] = await q.query("select id, name from contacts where org_id = $1 and norm(name) = norm($2) limit 1", [org, a.customer_name]);
            const [t] = await q.query("insert into tasks (org_id, user_id, contact_id, contact_name, text, due, source_call_id) values ($1, $2, $3, $4, $5, $6, $7) returning *",
              [org, user.id, target?.id ?? null, target?.name ?? a.customer_name ?? "", a.text, isDate(a.due) ? a.due : null, callId]);
            changed.added.push(taskOut(t));
          }
          const done = (result.completed_action_ids ?? []).filter(isUuid);
          if (done.length) changed.completed = (await q.query("update tasks set status = 'done', done_at = now(), done_call_id = $3 where id = any($1::uuid[]) and org_id = $2 and status = 'open' returning *", [done, org, callId])).map(taskOut);
          for (const u of result.updated_actions ?? []) {
            if (!isUuid(u.id)) continue;
            const [t] = await q.query("update tasks set text = coalesce(nullif($3, ''), text), due = case when $4::text is null then due when $4 = '' then null else $4::date end where id = $1 and org_id = $2 returning *",
              [u.id, org, u.text ?? "", u.due === undefined ? null : isDate(u.due) ? u.due : ""]);
            if (t) changed.updated.push(taskOut(t));
          }

          // The demo has no research (loadResearch gives nothing): its calls' findings aren't kept.
          const research = framework && result.discovery ? await loadResearch(q, user) : null;
          if (research) {
            const { discovery, storage } = research;
            changed.discovery = discovery.apply(result.discovery, { callId, date });
            for (const f of changed.discovery.findings) {
              await q.query("insert into facts (org_id, user_id, subject, kind, text, quote, tags, source_call_id) values ($1, $2, 'user', $3, $4, $5, $6, $7)",
                [org, user.id, f.kind || "fact", f.text, f.quote || "", [`area:${f.area}`, ...(f.hypothesis ? [`hyp:${f.hypothesis}`] : []), ...(f.stance ? [`stance:${f.stance}`] : [])], callId]);
            }
            await q.query(`insert into research_state (user_id, org_id, questions, calls, updated_at) values ($1, $2, $3, $4, now())
              on conflict (user_id) do update set questions = excluded.questions, calls = excluded.calls, updated_at = now()`, [user.id, org, json(storage.data["questions.json"] ?? {}), json(storage.data["calls.json"] ?? [])]);
          }
          return changed;
        });
        return changed;
      },
    };
  }

  // ---------- objectives ----------
  const objectives = {
    async list() { return (await db.query("select * from objectives order by created_at desc")).map(objectiveOut); },
    async get(id) { return objectiveOut((await db.query("select * from objectives where id = $1", [id]))[0]) ?? null; },
    async create({ template, params, mode = "next_inbound", priority, lang = null, notBefore = null, deadline = null, createdBy = "admin", userId = null } = {}) {
      const t = skill.templates.get(template);
      if (!t || t.kind !== "objective") throw new Error(`unknown objective template "${template}" (${[...skill.templates.values()].filter(x => x.kind === "objective" && x.params).map(x => x.id).join(", ")})`);
      if (!(t.modes ?? ["next_inbound"]).includes(mode)) throw new Error(`mode "${mode}" isn't possible for ${template} (${(t.modes ?? ["next_inbound"]).join(", ")})`);
      const user = userId ? (await db.query("select * from users where id::text = $1 or phone_e164 = $2", [String(userId), e164(userId)]))[0] : await defaultUser();
      if (!user) throw new Error(userId ? `no user ${userId}` : "several users: say which one (userId)");
      const [o] = await db.query(`insert into objectives (id, org_id, user_id, template, version, params, mode, priority, lang, not_before, deadline, max_attempts, created_by)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
        [`obj_${randomUUID().slice(0, 8)}`, user.org_id, user.id, template, t.version, json(skill.objectiveParams(template, params)), mode,
          Number.isFinite(priority) ? priority : t.priority ?? 0, lang, notBefore, deadline, t.limits?.attempts ?? 3, createdBy]);
      return objectiveOut(o);
    },
    async cancel(id) {
      const [o] = await db.query("update objectives set status = case when status = 'pending' then 'cancelled' else status end, updated_at = now() where id = $1 returning *", [id]);
      return objectiveOut(o) ?? null;
    },
    /** Couldn't be done by calling him: ask in his next call instead. */
    async toNextInbound(id) {
      const [o] = await db.query("update objectives set mode = 'next_inbound', updated_at = now() where id = $1 and status = 'pending' returning *", [id]);
      return objectiveOut(o) ?? null;
    },
    async byIds(ids = []) {
      if (!ids.length) return [];
      const rows = (await db.query("select * from objectives where id = any($1::text[])", [ids])).map(objectiveOut);
      return ids.map(id => rows.find(o => o.id === id)).filter(Boolean);
    },
    async forCall(user, { direction = "inbound", at = new Date() } = {}) {
      return (await db.query("select * from objectives where user_id = $1 and status = 'pending' and mode = any($2::text[]) and (not_before is null or not_before <= $3) and (deadline is null or deadline >= $3) order by priority desc, created_at",
        [user.id, MODES_FOR[direction] ?? [], at.toISOString()])).map(objectiveOut);
    },
    async record(callId, results = []) {
      const changed = [];
      for (const r of results) {
        const [o] = await db.tx(async q => {
          const [cur] = await q.query("select * from objectives where id = $1 for update", [r.id]);
          if (!cur || cur.status !== "pending" || cur.calls.includes(callId)) return [];
          const attempts = cur.attempts + 1;
          const status = r.done ? "done" : attempts >= cur.max_attempts ? "expired" : "pending";
          return q.query("update objectives set attempts = $2, calls = array_append(calls, $3), result = $4, status = $5, updated_at = now() where id = $1 returning *",
            [r.id, attempts, callId, json(mergeResult(cur.result, r.result)), status]);
        });
        if (o) changed.push(objectiveOut(o));
      }
      return changed;
    },
  };

  /** An objective that was already on a call gets how that call ended: its last turns, so the next one can pick up. */
  async function withLastCall(list) {
    const ids = list.map(o => o.calls?.at(-1)).filter(Boolean);
    if (!ids.length) return list;
    const rows = await db.query("select id, ended_reason, transcript from calls where id = any($1::text[])", [ids]);
    return list.map(o => {
      const c = rows.find(r => r.id === o.calls?.at(-1));
      return c ? { ...o, lastCall: { reason: c.ended_reason ?? "", turns: (c.transcript ?? []).slice(-6) } } : o;
    });
  }

  // ---------- one call: what it saves, and what the after-call steps do with it ----------
  const json3 = (turns, extraction, extractionTurns) => [json(turns), extraction ? json(extraction) : null, extractionTurns];
  function callScope(user, callId) {
    return {
      ...postCall(user),
      /** His note for this call: one per call, so the after-call step can save it again safely. */
      async saveNote(note) {
        const { transcript: _t, call_id: _c, from: _f, ended_reason: _e, lang = "", ...data } = note;
        const n = normalizeNote(data);
        const [row] = await db.query(`insert into notes (org_id, user_id, call_id, mode, lang, data, summary) values ($1, $2, $3, $4, $5, $6, $7)
          on conflict (call_id) do update set mode = excluded.mode, lang = excluded.lang, data = excluded.data, summary = excluded.summary returning *`,
          [user.org_id, user.id, callId, n.mode ?? data.mode ?? "", lang, json(data), n.summary ?? ""]);
        return noteOut(row);
      },
      recordObjectives: results => objectives.record(callId, results),
    };
  }

  return {
    kind: "pg",
    db,
    ensureUser,
    ensureDemoUser,

    /** Everything one call needs from memory, read once when it connects; the call's row starts here. */
    /**
     * A call begins. `rehearsalOf`: a rehearsal (Max tries out a call to someone on his own phone):
     * the call is kept under its own user (the demo), but Toni knows what she knows about that
     * person, and nothing of it goes into his memory: his objectives come along as copies.
     */
    async openCall({ callId, from = null, to = null, userId = null, direction = "inbound", source = "", at = new Date(), rehearsalOf = null }) {
      const started = performance.now();
      // An outbound call knows whom it called; an inbound one goes by caller ID.
      const user = isUuid(userId) ? (await db.query("select * from users where id = $1", [userId]))[0] ?? null : await callerUser(from);
      if (!user) return emptyScope();
      const subject = isUuid(rehearsalOf) ? (await db.query("select * from users where id = $1", [rehearsalOf]))[0] ?? null : user;
      if (!subject) return emptyScope();
      const rehearsal = subject.id !== user.id;
      await db.query("insert into calls (id, org_id, user_id, direction, source, from_e164, to_e164, started_at, meta) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (id) do nothing",
        [callId, user.org_id, user.id, direction, source, e164(from), e164(to), at.toISOString(), json(rehearsal ? { rehearsalOf: { id: subject.id, name: subject.name } } : {})]);
      const [data, research, found, [{ talked }]] = await Promise.all([contextData(subject, at), loadResearch(db, subject), objectives.forCall(subject, { direction, at }),
        db.query("select exists (select 1 from calls where user_id = $1 and id <> $2 and jsonb_array_length(transcript) > 2) talked", [subject.id, callId])]);
      const pending = (await withLastCall(found)).map(o => (rehearsal ? { ...o, stored: false } : o));
      const ctx = buildContext(data, { budget });
      return {
        user: { id: subject.id, orgId: subject.org_id, name: subject.name, lang: subject.lang, timezone: subject.timezone, profile: subject.profile },
        rehearsal: rehearsal ? { of: subject.name } : null,
        context: ctx.text,
        hidden: ctx.hidden,
        firstCall: !talked, // he's never really talked with Toni before
        stats: { ...ctx.stats, ms: Math.round(performance.now() - started) },
        discovery: research?.discovery ?? null,
        objectives: pending,
        search: query => search(subject, query),
        /** The stored objectives this call's agenda took on, and what all its items were for (the dashboard shows it). */
        async setAgenda(objectiveIds, goal = []) {
          await db.query("update calls set objective_ids = $2, meta = meta || $3::jsonb where id = $1", [callId, objectiveIds, json({ goal })]);
        },
        /** The call so far (after every turn and note): if this instance dies, nothing is lost. */
        async checkpoint({ turns = [], extraction = null, extractionTurns = 0, lang = null } = {}) {
          await db.query("update calls set transcript = $2, extraction = coalesce($3::jsonb, extraction), extraction_turns = case when $3::jsonb is null then extraction_turns else $4 end, lang = coalesce($5, lang), updated_at = now() where id = $1 and ended_at is null",
            [callId, ...json3(turns, extraction, extractionTurns), lang]);
        },
        /** The call is over: its last state, and its after-call job, in one transaction. Returns whether it was the first end. */
        async endCall({ turns = [], extraction = null, extractionTurns = 0, lang = null, reason = "", timeline = [], meta = {} } = {}) {
          return db.tx(async q => {
            const [row] = await q.query(`update calls set ended_at = now(), ended_reason = $2, transcript = $3, extraction = coalesce($4::jsonb, extraction), extraction_turns = case when $4::jsonb is null then extraction_turns else $5 end,
              lang = coalesce($6, lang), timeline = $7, meta = meta || $8::jsonb, updated_at = now() where id = $1 and ended_at is null returning id`,
              [callId, reason, ...json3(turns, extraction, extractionTurns), lang, json(timeline), json(meta)]);
            if (row) await queue?.enqueue("after_call", { callId }, { key: `after_call:${callId}`, q });
            return Boolean(row);
          });
        },
        async recordToolRun(o) {
          if (!o.key) return;
          await db.query("insert into tool_runs (key, org_id, call_id, name, args, status, result) values ($1, $2, $3, $4, $5, $6, $7) on conflict (key) do nothing",
            [o.key, user.org_id, callId, o.name, json(o.args), o.status, json(o.result)]);
        },
      };
    },

    /** A finished call as the after-call steps need it: the row, its user, and the steps bound to them. Null when there's nothing to do. */
    async afterCall(callId) {
      const [c] = await db.query("select * from calls where id = $1", [callId]);
      if (!c || !c.ended_at || c.after_call_at) return null;
      const [user] = c.user_id ? await db.query("select * from users where id = $1", [c.user_id]) : [];
      if (!user) return null;
      const research = await loadResearch(db, user);
      return {
        call: { id: c.id, direction: c.direction, source: c.source, from: c.from_e164, lang: c.lang, reason: c.ended_reason, turns: c.transcript ?? [], extraction: c.extraction, extractionTurns: c.extraction_turns, startedAt: c.started_at, recap: c.recap ?? null, noteSentAt: c.meta?.noteSentAt ?? null, rehearsalOf: c.meta?.rehearsalOf?.name ?? null },
        user: { ...userOut(user), profile: user.profile ?? {} },
        objectives: await objectives.byIds(c.objective_ids ?? []),
        discovery: research?.discovery ?? null,
        scope: callScope(user, callId),
        saveExtraction: (extraction, extractionTurns) => db.query("update calls set extraction = $2, extraction_turns = $3 where id = $1", [callId, json(extraction), extractionTurns]),
        addEvents: events => (events.length ? db.query("update calls set timeline = timeline || $2::jsonb where id = $1", [callId, json(events.map(e => ({ t: Date.now(), ...e })))]) : null),
        saveRecap: recap => db.query("update calls set recap = $2 where id = $1", [callId, json(recap)]),
        noteSent: messageId => db.query("update calls set meta = meta || $2::jsonb where id = $1", [callId, json({ noteSentAt: new Date().toISOString(), noteMessageId: messageId })]),
        addCost: usd => db.query("update calls set meta = jsonb_set(meta, '{usd}', to_jsonb(coalesce((meta->>'usd')::float8, 0) + $2)) where id = $1", [callId, usd]),
        done: () => db.query("update calls set after_call_at = now() where id = $1", [callId]),
      };
    },

    /** Calls still open long after any call could last: their instance died. Ended here, and their after-call job queued. */
    async sweepLostCalls({ olderThanMin = LOST_AFTER_MIN } = {}) {
      return db.tx(async q => {
        const lost = await q.query("update calls set ended_at = now(), ended_reason = 'lost', updated_at = now() where ended_at is null and started_at < now() - make_interval(mins => $1) returning id", [olderThanMin]);
        for (const { id } of lost) await queue?.enqueue("after_call", { callId: id }, { key: `after_call:${id}`, q });
        return lost.map(r => r.id);
      });
    },

    /** Is he on a call right now, on any instance? */
    async userOnCall(userId) {
      const [r] = await db.query("select exists (select 1 from calls where user_id = $1 and ended_at is null and started_at > now() - make_interval(mins => $2)) on_call", [userId, LOST_AFTER_MIN]);
      return Boolean(r?.on_call);
    },
    async callExists(callId) {
      return (await db.query("select 1 from calls where id = $1", [callId])).length > 0;
    },

    // The monitor's call log.
    async recentCalls({ limit = 100 } = {}) {
      return (await db.query(`select c.id, c.user_id, c.direction, c.source, c.from_e164, c.to_e164, c.lang, c.started_at, c.ended_at, c.ended_reason, c.summary, c.call_type, c.meta,
          c.recap->>'title' recap_title, u.name user_name, ${USER_TURNS} turns, n.id note_id
          from calls c left join notes n on n.call_id = c.id left join users u on u.id = c.user_id order by c.started_at desc limit $1`, [limit])).map(callOut);
    },
    async getCall(id) {
      const [c] = await db.query(`select c.*, ${USER_TURNS} turns, n.id note_id, n.data note, u.name user_name from calls c left join notes n on n.call_id = c.id left join users u on u.id = c.user_id where c.id = $1`, [id]);
      return callOut(c) ?? null;
    },
    /** A summary written on demand (the admin page), for a call that ended without one. */
    async saveRecap(id, recap) {
      const [c] = await db.query("update calls set recap = $2 where id = $1 and ended_at is not null returning id", [id, json(recap)]);
      return Boolean(c);
    },

    // Pre-recorded lines (src/calls/voice.mjs).
    voiceClips: {
      async get(keys) {
        const rows = await db.query("select key, pcm from voice_clips where key = any($1::text[])", [keys]);
        return new Map(rows.map(r => [r.key, Buffer.from(r.pcm)]));
      },
      put: (key, pcm) => db.query("insert into voice_clips (key, pcm) values ($1, $2) on conflict (key) do nothing", [key, pcm]),
    },

    async listNotes({ limit = 200 } = {}) {
      return (await db.query("select n.*, c.transcript from notes n left join calls c on c.id = n.call_id order by n.created_at desc limit $1", [limit])).map(noteOut);
    },
    async memoryOverview() {
      const [contacts, tasks, history] = await Promise.all([
        db.query("select * from contacts order by last_contact desc nulls last, name limit 500"),
        db.query("select * from tasks order by status, due nulls last, created_at limit 1000"),
        db.query("select cc.contact_id, c.id call_id, c.started_at, c.call_type, c.summary from call_contacts cc join calls c on c.id = cc.call_id order by c.started_at"),
      ]);
      return {
        customers: contacts.map(c => customerOut({ ...c, history: history.filter(h => h.contact_id === c.id).map(h => ({ date: day(h.started_at), callId: h.call_id, type: h.call_type, summary: h.summary })) })),
        actions: tasks.map(taskOut),
      };
    },
    async setTaskStatus(id, status) {
      if (!isUuid(id)) return null;
      const [t] = await db.query("update tasks set status = $2, done_at = case when $2 = 'done' then now() else null end where id = $1 returning *", [id, status === "done" ? "done" : "open"]);
      return taskOut(t) ?? null;
    },
    async discoveryOverview() {
      const user = await defaultUser();
      const research = user && (await loadResearch(db, user));
      if (!research) return null;
      const d = research.discovery;
      return { framework, findings: d.findings(), questions: d.questions(), calls: d.calls(), next: d.next() };
    },
    objectives: { list: objectives.list, get: objectives.get, byIds: objectives.byIds, create: objectives.create, cancel: objectives.cancel, toNextInbound: objectives.toNextInbound },

    /** Who can be asked something. */
    async listUsers() {
      return (await db.query("select * from users order by created_at")).map(userOut);
    },
    getUser: async id => (isUuid(id) ? userOut((await db.query("select * from users where id = $1", [id]))[0]) : null),
    /** Admin edits: phone, language, time zone, call window, consent to outbound calls (with its date), pause. */
    async updateUser(id, patch) {
      if (!isUuid(id)) return null;
      const sets = [];
      const values = [id];
      const set = (col, v) => { values.push(v); sets.push(`${col} = $${values.length}`); };
      if ("name" in patch) set("name", String(patch.name || "").trim() || "?");
      if ("phone" in patch) { const p = patch.phone ? e164(patch.phone) : null; if (patch.phone && !p) throw Object.assign(new Error("phone: an international number like +4915112345678"), { status: 400 }); set("phone_e164", p); }
      if ("lang" in patch) set("lang", String(patch.lang));
      if ("timezone" in patch) { try { new Intl.DateTimeFormat(undefined, { timeZone: patch.timezone }); } catch { throw Object.assign(new Error(`unknown time zone ${patch.timezone}`), { status: 400 }); } set("timezone", patch.timezone); }
      if ("callWindow" in patch) set("call_window", json(patch.callWindow ?? {}));
      if ("consentOutbound" in patch) set("consent_outbound_at", patch.consentOutbound ? new Date().toISOString() : null);
      if ("outboundPaused" in patch) set("outbound_paused", Boolean(patch.outboundPaused));
      // In the profile: his business and his lists (for quotes), and the features (src/features.mjs).
      const profile = {};
      if ("business" in patch) profile.business = businessIn(patch.business);
      if ("lists" in patch) profile.lists = listsIn(patch.lists);
      // Features: { id: true | false }; one switched on keeps the date it was first switched on.
      if ("features" in patch) {
        const [cur] = await db.query("select profile->'features' f from users where id = $1", [id]);
        const now = new Date().toISOString();
        profile.features = Object.fromEntries(FEATURES.map(f => [f, f in (patch.features ?? {}) ? (patch.features[f] ? cur?.f?.[f] ?? now : null) : cur?.f?.[f] ?? null]).filter(([, v]) => v));
      }
      if (Object.keys(profile).length) { values.push(json(profile)); sets.push(`profile = profile || $${values.length}::jsonb`); }
      if (!sets.length) return this.getUser(id);
      const [u] = await db.query(`update users set ${sets.join(", ")} where id = $1 returning *`, values);
      return userOut(u);
    },

    // Admin requests (src/admin/requests.mjs).
    requests: {
      async create(r) {
        const [user] = isUuid(r.userId) ? await db.query("select org_id from users where id = $1", [r.userId]) : [];
        const [row] = await db.query(`insert into requests (id, org_id, user_id, instruction, plan, plan_hash, card, turns, status, created_by)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
          [r.id, user?.org_id ?? null, isUuid(r.userId) ? r.userId : null, r.instruction, json(r.plan), r.planHash, json(r.card), json(r.turns ?? []), r.status ?? "draft", r.createdBy ?? "admin"]);
        return requestOut(row);
      },
      get: async id => requestOut((await db.query("select * from requests where id = $1", [id]))[0]) ?? null,
      list: async ({ limit = 100 } = {}) => (await db.query("select * from requests order by created_at desc limit $1", [limit])).map(requestOut),
      async update(id, patch) {
        const sets = [];
        const values = [id];
        for (const [k, v] of Object.entries(patch)) {
          const col = REQUEST_COLUMNS[k];
          if (!col) continue;
          values.push(JSON_COLUMNS.has(col) ? json(v) : col === "user_id" && !isUuid(v) ? null : v);
          sets.push(`${col} = $${values.length}`);
        }
        if (!sets.length) return this.get(id);
        const [row] = await db.query(`update requests set ${sets.join(", ")}, updated_at = now() where id = $1 returning *`, values);
        return requestOut(row) ?? null;
      },
      byObjective: async objectiveId => requestOut((await db.query("select * from requests where objective_id = $1", [objectiveId]))[0]) ?? null,
    },
    embedPending,
    close: () => db.close(),
  };
}
