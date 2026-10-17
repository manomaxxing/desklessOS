// Embeddings for notes and facts, filled in the background (after a call, on the tick):
// at most 100 of each per round, one round at a time.

import type { Queryable } from "../db/client.ts";
import type { Log } from "../types/common.ts";
import type { Note } from "../types/note.ts";
import { toVector } from "../engine/embed.ts";
import type { Embedder } from "./search.ts";
import { noteText } from "./rows.ts";

export function createEmbeddingFiller({ db, embedder = null, log = () => {} }: { db: Queryable; embedder?: Embedder | null; log?: Log }) {
  let running: Promise<void> | null = null;
  return function embedPending(): Promise<void> | null {
    if (!embedder || running) return running;
    running = (async () => {
      const notes = await db.query<{ id: string; data: Note }>("select id, data from notes where embedding is null order by created_at desc limit 100");
      const facts = await db.query<{ id: string; text: string }>("select id, text from facts where embedding is null order by created_at desc limit 100");
      for (const [table, rows] of [["notes", notes.map(r => ({ id: r.id, text: noteText(r.data) }))], ["facts", facts]] as const) {
        if (!rows.length) continue;
        const vectors = await embedder.embed(rows.map(r => r.text));
        for (const [i, v] of vectors.entries()) {
          const row = rows[i];
          if (v && row) await db.query(`update ${table} set embedding = $2::vector where id = $1`, [row.id, toVector(v)]);
        }
      }
    })().catch((err: Error) => log("memory: embedding failed", err.message)).finally(() => { running = null; });
    return running;
  };
}
