// What a call reads from memory when it connects (src/memory/context.ts makes the MEMORY block
// of it): facts about him, open and recent to-dos, the customers most likely to come up with
// their latest notes, and notes not linked to a customer yet.

import type { Queryable } from "../db/client.ts";
import type { Note } from "../types/note.ts";
import type { UserRow } from "../types/user.ts";
import type { ContextData } from "./context.ts";
import { noteLine } from "./text.ts";
import { day } from "./rows.ts";

const lineOf = (n: { data: Note; created_at: Date | string }): string => noteLine({ ...n.data, created_at: new Date(n.created_at).toISOString() });

export async function contextData(db: Queryable, user: Pick<UserRow, "org_id">, at: Date): Promise<ContextData> {
  const org = user.org_id;
  const today = day(at);
  // Relevance: recent contact (a date a little ahead of today counts as today, so the division can't reach zero),
  // open to-dos, something due within the week.
  const [facts, tasks, [open], done, contacts, [total], loose] = await Promise.all([
    db.query<{ text: string }>("select text from facts where org_id = $1 and subject = 'user' and superseded_by is null and not exists (select 1 from unnest(tags) t where t like 'area:%') order by created_at desc limit 12", [org]),
    db.query<{ text: string; due: Date | string | null; contact_name: string | null }>("select text, due, contact_name from tasks where org_id = $1 and status = 'open' order by due nulls last, created_at limit 10", [org]),
    db.query<{ n: number }>("select count(*)::int n from tasks where org_id = $1 and status = 'open'", [org]),
    db.query<{ text: string; contact_name: string | null }>("select text, contact_name from tasks where org_id = $1 and status = 'done' order by done_at desc nulls last limit 5", [org]),
    db.query<{ id: string; name: string; place: string | null; address: string | null; phone: string | null; summary: string | null; last_contact: Date | string | null; open_tasks: number; next_due: Date | string | null }>(
      `select c.id, c.name, c.place, c.address, c.phone, c.summary, c.last_contact, coalesce(t.open, 0)::int open_tasks, t.next_due
        from contacts c left join (select contact_id, count(*) open, min(due) next_due from tasks where org_id = $1 and status = 'open' group by contact_id) t on t.contact_id = c.id
        where c.org_id = $1
        order by 10.0 / (1 + greatest(coalesce($2::date - c.last_contact, 365), 0) / 7.0) + 2 * coalesce(t.open, 0) + case when t.next_due <= $2::date + 7 then 3 else 0 end desc, c.name
        limit 48`, [org, today]),
    db.query<{ n: number }>("select count(*)::int n from contacts where org_id = $1", [org]),
    db.query<{ data: Note; created_at: Date | string }>("select data, created_at from notes where org_id = $1 and contact_id is null and mode = 'capture' order by created_at desc limit 5", [org]),
  ]);
  const top = contacts.slice(0, 8).map(c => c.id);
  const notes = top.length
    ? await db.query<{ contact_id: string; data: Note; created_at: Date | string }>("select contact_id, data, created_at from (select contact_id, data, created_at, row_number() over (partition by contact_id order by created_at desc) rn from notes where contact_id = any($1::uuid[])) x where rn <= 3 order by created_at desc", [top])
    : [];
  return {
    today,
    facts,
    tasks: tasks.map(t => ({ text: t.text, due: t.due ? day(t.due) : "", contactName: t.contact_name })),
    openTaskCount: open?.n ?? 0,
    done: done.map(t => ({ text: t.text, contactName: t.contact_name })),
    contacts: contacts.map(c => ({
      name: c.name, place: c.place, address: c.address, phone: c.phone, summary: c.summary,
      lastContact: c.last_contact ? day(c.last_contact) : null, openTasks: c.open_tasks, nextDue: c.next_due ? day(c.next_due) : null,
      notes: notes.filter(n => n.contact_id === c.id).map(lineOf),
    })),
    totalContacts: total?.n ?? 0,
    looseNotes: loose.map(lineOf),
  };
}
