// Memory v2: one interface, two backends.
//   MEMORY_BACKEND=json (default): the JSON files in DATA_DIR, as before
//   MEMORY_BACKEND=pg: Postgres at DATABASE_URL (Supabase EU, or pglite:<dir> locally);
//                      migrations run on start, the first user comes from the persona's profile
// A backend opens one scope per call (openCall): who's calling, the MEMORY text for the
// prompt, search, saving the note, the office's writes, and the post-call step.

import { openJsonMemory } from "./json.mjs";
import { openPgMemory } from "./pg.mjs";
import { openDb } from "../db/client.mjs";
import { migrate } from "../db/migrate.mjs";
import { createEmbedder } from "../engine/embed.mjs";

export async function openMemory({ skill, backend = process.env.MEMORY_BACKEND || "json", url = process.env.DATABASE_URL, endpoint = null, log = () => {} }) {
  if (backend === "json") return openJsonMemory({ skill });
  if (backend !== "pg") throw new Error(`MEMORY_BACKEND=${backend}: json | pg`);
  const db = await openDb(url);
  await migrate(db, { log });
  const embedder = endpoint ? createEmbedder({ endpoint, onError: err => log("embedding failed:", err.message) }) : null;
  const memory = openPgMemory({ db, skill, embedder, log });
  await memory.ensureUser();
  return memory;
}
