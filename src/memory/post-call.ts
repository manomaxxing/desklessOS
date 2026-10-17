// The memory step after a call (src/engine/consolidate.ts asks the model, this applies it):
// what the model matches against (likely customers, open to-dos, the research framework),
// and its result as typed changes, in one transaction, once per call.

import type { Db } from "../db/client.ts";
import type { Day } from "../types/common.ts";
import type { Note } from "../types/note.ts";
import type { UserRow } from "../types/user.ts";
import type { Finding, Framework } from "./research.ts";
import type { MemoryResult } from "../types/memory.ts";

export type { MemoryResult };
import { loadResearch, saveResearch } from "./research-store.ts";
import { searchWords } from "./text.ts";
import { WORD_SCORE } from "./search.ts";
import { day, isDay, isUuid, taskOut, type ContactRow, type Task, type TaskRow } from "./rows.ts";

export interface MemoryChanges {
  customer: { id: string; name: string } | null;
  added: Task[];
  completed: Task[];
  updated: Task[];
  discovery?: { asked: string[]; answered: string[]; declined: string[]; findings: Finding[] };
  skipped?: boolean;
}

export interface MemorySnapshot {
  customers: { id: string; name: string; place: string | null; summary: string | null }[];
  openActions: { id: string; customer: string | null; text: string; due: Day | "" }[];
  discovery?: unknown;
}

export function postCall(db: Db, framework: Framework | null, user: Pick<UserRow, "id" | "org_id" | "demo">) {
  return {
    /** What the memory model needs to match against: likely customers, open to-dos, the research framework. */
    async snapshot({ note }: { note?: Note | null } = {}): Promise<MemorySnapshot> {
      const org = user.org_id;
      const n = note ?? {};
      const words = searchWords(`${n.customer_name ?? ""} ${n.place ?? ""}`);
      type Found = Pick<ContactRow, "id" | "name" | "place" | "summary">;
      const [likely, recent, open, research] = await Promise.all([
        words.length ? db.query<Found & { s: number }>(`select id, name, place, summary, ${WORD_SCORE} s from contacts where org_id = $1 order by s desc limit 5`, [org, words]) : Promise.resolve([]),
        db.query<Found>("select id, name, place, summary from contacts where org_id = $1 order by last_contact desc nulls last limit 15", [org]),
        db.query<Pick<TaskRow, "id" | "contact_name" | "text" | "due">>("select id, contact_name, text, due from tasks where org_id = $1 and status = 'open' order by due nulls last limit 40", [org]),
        loadResearch(db, framework, user),
      ]);
      const customers = [...new Map([...likely.filter(c => c.s >= 0.3), ...recent].map(c => [c.id, { id: c.id, name: c.name, place: c.place, summary: c.summary }])).values()];
      return {
        customers,
        openActions: open.map(t => ({ id: t.id, customer: t.contact_name, text: t.text, due: t.due ? day(t.due) : "" })),
        ...(research ? { discovery: research.snapshot() } : {}),
      };
    },

    /** Applies the memory model's result as typed changes, in one transaction, once per call. */
    async apply(result: MemoryResult, { callId, noteId = null, date = day(new Date()) }: { callId: string; noteId?: string | null; date?: Day }): Promise<MemoryChanges> {
      return db.tx(async q => {
        const org = user.org_id;
        const changed: MemoryChanges = { customer: null, added: [], completed: [], updated: [] };
        const claimed = await q.query("update calls set consolidated_at = now(), call_type = $2, summary = $3 where id = $1 and consolidated_at is null returning id", [callId, result.call_type ?? "", result.call_summary ?? ""]);
        if (!claimed.length) return { ...changed, skipped: true }; // already done (or no such call)

        const c = result.customer ?? {};
        let contact: ContactRow | undefined;
        if (c.name || c.existing_id) {
          if (isUuid(c.existing_id)) [contact] = await q.query<ContactRow>("select * from contacts where id = $1 and org_id = $2", [c.existing_id, org]);
          if (!contact && c.name) [contact] = await q.query<ContactRow>("select * from contacts where org_id = $1 and norm(name) = norm($2) and ($3 = '' or place = '' or norm(place) = norm($3)) order by last_contact desc nulls last limit 1", [org, c.name, c.place ?? ""]);
          if (!contact && c.name) [contact] = await q.query<ContactRow>("insert into contacts (org_id, name) values ($1, $2) returning *", [org, c.name]);
        }
        if (contact) {
          [contact] = await q.query<ContactRow>(`update contacts set name = coalesce(nullif($2, ''), name), place = coalesce(nullif($3, ''), place), address = coalesce(nullif($4, ''), address),
            phone = coalesce(nullif($5, ''), phone), summary = coalesce(nullif($6, ''), summary), last_contact = greatest(coalesce(last_contact, $7::date), $7::date), updated_at = now()
            where id = $1 returning *`, [contact.id, c.name ?? "", c.place ?? "", c.address ?? "", c.phone ?? "", c.summary_update ?? "", date]);
        }
        if (contact) {
          await q.query("insert into call_contacts (call_id, contact_id) values ($1, $2) on conflict do nothing", [callId, contact.id]);
          if (isUuid(noteId)) await q.query("update notes set contact_id = $1 where id = $2 and org_id = $3", [contact.id, noteId, org]);
          changed.customer = { id: contact.id, name: contact.name };
        }

        for (const a of result.new_actions ?? []) {
          if (!a.text) continue;
          let target: Pick<ContactRow, "id" | "name"> | undefined = contact;
          if (a.customer_name) [target = contact] = await q.query<Pick<ContactRow, "id" | "name">>("select id, name from contacts where org_id = $1 and norm(name) = norm($2) limit 1", [org, a.customer_name]);
          const [t] = await q.query<TaskRow>("insert into tasks (org_id, user_id, contact_id, contact_name, text, due, source_call_id) values ($1, $2, $3, $4, $5, $6, $7) returning *",
            [org, user.id, target?.id ?? null, target?.name ?? a.customer_name ?? "", a.text, isDay(a.due) ? a.due : null, callId]);
          if (t) changed.added.push(taskOut(t));
        }
        const done = (result.completed_action_ids ?? []).filter(isUuid);
        if (done.length) changed.completed = (await q.query<TaskRow>("update tasks set status = 'done', done_at = now(), done_call_id = $3 where id = any($1::uuid[]) and org_id = $2 and status = 'open' returning *", [done, org, callId])).map(taskOut);
        for (const u of result.updated_actions ?? []) {
          if (!isUuid(u.id)) continue;
          const [t] = await q.query<TaskRow>("update tasks set text = coalesce(nullif($3, ''), text), due = case when $4::text is null then due when $4 = '' then null else $4::date end where id = $1 and org_id = $2 returning *",
            [u.id, org, u.text ?? "", u.due === undefined ? null : isDay(u.due) ? u.due : ""]);
          if (t) changed.updated.push(taskOut(t));
        }

        // The demo has no research (loadResearch gives nothing): its calls' findings aren't kept.
        const research = framework && result.discovery ? await loadResearch(q, framework, user) : null;
        if (research && result.discovery) {
          changed.discovery = research.apply(result.discovery, { callId, date });
          await saveResearch(q, user, research, changed.discovery.findings, callId);
        }
        return changed;
      });
    },
  };
}
export type PostCall = ReturnType<typeof postCall>;
