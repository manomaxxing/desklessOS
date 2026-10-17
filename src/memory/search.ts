// memory_search: sound-alike names (pg_trgm), and notes and facts by meaning (pgvector), for
// customers that aren't in the call's MEMORY block. Names first and in parallel: a slow
// embedding service never holds the answer up.

import type { Queryable } from "../db/client.ts";
import type { Log } from "../types/common.ts";
import type { Note } from "../types/note.ts";
import type { UserRow } from "../types/user.ts";
import type { FoundCustomer, SearchResult } from "../types/call.ts";
import { toVector } from "../engine/embed.ts";
import { noteLine, searchWords } from "./text.ts";
import { day, type ContactRow } from "./rows.ts";

const QUERY_EMBED_MS = 1200; // search waits this long for the query's vector, then goes on with names only
const EMBED_PAUSE_MS = 5 * 60 * 1000; // after a late one, searches skip vectors for a while
// How well the spoken words ($2) match a contact's name and place: each word that sounds
// like one of them (≥ 0.45) adds its similarity, so "Kowalski Radolfzell" beats "Radolfzell".
export const WORD_SCORE = "(select coalesce(sum(x), 0) from (select word_similarity(w, norm(name || ' ' || place)) x from unnest($2::text[]) w) t where x >= 0.45)";

export interface Embedder {
  embed(texts: string[], opts?: { task?: string }): Promise<(number[] | null)[]>;
}


const lineOf = (n: { data: Note; created_at: Date | string }): string => noteLine({ ...n.data, created_at: new Date(n.created_at).toISOString() });

export function createSearch({ db, embedder = null, log = () => {} }: { db: Queryable; embedder?: Embedder | null; log?: Log }) {
  let embedPausedUntil = 0;

  /** The query's vector, if the embedding service answers in time; late, vectors pause for a while. */
  async function queryVector(words: string[]): Promise<number[] | null> {
    if (!embedder || Date.now() <= embedPausedUntil) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(resolve => {
      timer = setTimeout(() => { embedPausedUntil = Date.now() + EMBED_PAUSE_MS; log("memory: query embedding late, searching by name for 5 min"); resolve(null); }, QUERY_EMBED_MS);
    });
    const vector = embedder.embed([words.join(" ")], { task: "RETRIEVAL_QUERY" }).then(([v]) => v ?? null).catch(() => null);
    try { return await Promise.race([vector, late]); } finally { clearTimeout(timer); }
  }

  return async function search(user: Pick<UserRow, "org_id">, query: string, { limit = 3 }: { limit?: number } = {}): Promise<SearchResult[]> {
    const words = searchWords(query);
    if (!words.length) return [];
    const org = user.org_id;
    const nameQuery = db.query<{ id: string; s: number }>(`select id, ${WORD_SCORE} s from contacts where org_id = $1 order by s desc limit 5`, [org, words]);
    const vector = await queryVector(words);
    type Scored = { contact_id: string | null; s: number };
    const [byName, byNote, byFact] = await Promise.all([
      nameQuery,
      vector
        ? db.query<Scored & { id: string; data: Note; created_at: Date | string }>("select id, contact_id, data, created_at, 1 - (embedding <=> $2::vector) s from notes where org_id = $1 and embedding is not null order by embedding <=> $2::vector limit 6", [org, toVector(vector)])
        : db.query<Scored & { id: string; data: Note; created_at: Date | string }>(`select id, contact_id, data, created_at, (select max(word_similarity(w, norm(summary || ' ' || data::text))) from unnest($2::text[]) w) * 0.8 s
            from notes where org_id = $1 order by s desc limit 6`, [org, words]),
      vector
        ? db.query<Scored>("select contact_id, text, 1 - (embedding <=> $2::vector) s from facts where org_id = $1 and embedding is not null and superseded_by is null and contact_id is not null order by embedding <=> $2::vector limit 6", [org, toVector(vector)])
        : Promise.resolve<Scored[]>([]),
    ]);
    const score = new Map<string, number>();
    const bump = (id: string | null, s: number) => { if (id) score.set(id, Math.max(score.get(id) ?? 0, 0) + s); };
    for (const r of byName) if (r.s >= 0.45) bump(r.id, 3 * r.s);
    for (const r of [...byNote, ...byFact]) if (r.s >= 0.55) bump(r.contact_id, r.s);
    const ids = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
    const loose = byNote.filter(n => !n.contact_id && n.s >= 0.55).slice(0, 2).map(n => ({ note: lineOf(n) }));
    if (!ids.length) return loose;
    const [contacts, notes, tasks, history] = await Promise.all([
      db.query<ContactRow>("select * from contacts where id = any($1::uuid[])", [ids]),
      db.query<{ contact_id: string; data: Note; created_at: Date | string }>("select contact_id, data, created_at from (select contact_id, data, created_at, row_number() over (partition by contact_id order by created_at desc) rn from notes where contact_id = any($1::uuid[])) x where rn <= 3 order by created_at desc", [ids]),
      db.query<{ contact_id: string; text: string; due: Date | string | null }>("select contact_id, text, due from tasks where contact_id = any($1::uuid[]) and status = 'open' order by due nulls last", [ids]),
      db.query<{ contact_id: string; started_at: Date | string; summary: string }>("select cc.contact_id, c.started_at, c.summary from call_contacts cc join calls c on c.id = cc.call_id where cc.contact_id = any($1::uuid[]) and c.summary <> '' order by c.started_at desc", [ids]),
    ]);
    const found = ids.flatMap(id => contacts.filter(c => c.id === id)).map((c): FoundCustomer => ({
      name: c.name, place: c.place, address: c.address, phone: c.phone, last_contact: c.last_contact ? day(c.last_contact) : "", summary: c.summary,
      history: history.filter(h => h.contact_id === c.id).slice(0, 3).map(h => `${day(h.started_at)}: ${h.summary}`),
      notes: notes.filter(n => n.contact_id === c.id).map(lineOf),
      open_todos: tasks.filter(t => t.contact_id === c.id).map(t => `${t.text}${t.due ? ` (due ${day(t.due)})` : ""}`),
    }));
    return [...found, ...loose];
  };
}
