// What the admin page and the test phone read of memory as a whole: notes, customers with
// their call history, to-dos, the research state. One operator per server today: these read
// every org; they need an org filter before more than one team shares a server.

import type { Db } from "../db/client.ts";
import type { Users } from "./users.ts";
import type { Framework } from "./research.ts";
import { loadResearch } from "./research-store.ts";
import { customerOut, day, isUuid, noteOut, taskOut, type ContactRow, type Customer, type NoteRow, type SavedNote, type Task, type TaskRow } from "./rows.ts";

export function createOverviews({ db, users, framework }: { db: Db; users: Users; framework: Framework | null }) {
  return {
    async listNotes({ limit = 200 }: { limit?: number } = {}): Promise<SavedNote[]> {
      return (await db.query<NoteRow>("select n.*, c.transcript from notes n left join calls c on c.id = n.call_id order by n.created_at desc limit $1", [limit])).map(noteOut);
    },
    /** Customers (most recent first) with the calls they came up in, and every to-do. */
    async memoryOverview(): Promise<{ customers: Customer[]; actions: Task[] }> {
      const [contacts, tasks] = await Promise.all([
        db.query<ContactRow>("select * from contacts order by last_contact desc nulls last, name limit 500"),
        db.query<TaskRow>("select * from tasks order by status, due nulls last, created_at limit 1000"),
      ]);
      // Only the calls of the customers shown (not every link there ever was), grouped once.
      const history = contacts.length
        ? await db.query<{ contact_id: string; call_id: string; started_at: Date | string; call_type: string | null; summary: string | null }>(
          "select cc.contact_id, c.id call_id, c.started_at, c.call_type, c.summary from call_contacts cc join calls c on c.id = cc.call_id where cc.contact_id = any($1::uuid[]) order by c.started_at",
          [contacts.map(c => c.id)])
        : [];
      const byContact = new Map<string, Customer["history"]>();
      for (const h of history) {
        const list = byContact.get(h.contact_id) ?? [];
        list.push({ date: day(h.started_at), callId: h.call_id, type: h.call_type, summary: h.summary });
        byContact.set(h.contact_id, list);
      }
      return { customers: contacts.map(c => customerOut({ ...c, history: byContact.get(c.id) ?? [] })), actions: tasks.map(taskOut) };
    },
    async setTaskStatus(id: string, status: string): Promise<Task | null> {
      if (!isUuid(id)) return null;
      const [t] = await db.query<TaskRow>("update tasks set status = $2, done_at = case when $2 = 'done' then now() else null end where id = $1 returning *", [id, status === "done" ? "done" : "open"]);
      return t ? taskOut(t) : null;
    },
    async discoveryOverview() {
      const user = await users.defaultUser();
      const d = user ? await loadResearch(db, framework, user) : null;
      if (!d) return null;
      return { framework, findings: d.findings(), questions: d.questions(), calls: d.calls(), next: d.next() };
    },
  };
}

/** Pre-recorded lines (src/calls/voice.ts), kept so a restart doesn't synthesise them again. */
export function createVoiceClips(db: Db) {
  return {
    async get(keys: readonly string[]): Promise<Map<string, Buffer>> {
      const rows = await db.query<{ key: string; pcm: Uint8Array }>("select key, pcm from voice_clips where key = any($1::text[])", [keys]);
      return new Map(rows.map(r => [r.key, Buffer.from(r.pcm)]));
    },
    put: (key: string, pcm: Buffer) => db.query("insert into voice_clips (key, pcm) values ($1, $2) on conflict (key) do nothing", [key, pcm]),
  };
}
