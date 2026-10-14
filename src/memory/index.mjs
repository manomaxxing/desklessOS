// Memory: Postgres at DATABASE_URL (Supabase EU in production; pglite:<dir> for local
// runs, pglite:memory in tests). Migrations run on start; on an empty database the first
// user comes from the persona's profile, and the demo user is made once. One scope per
// call (openCall): who's calling, the MEMORY text for the prompt, search, and the call's
// own row; the after-call steps work from that row (afterCall).

import { openPgMemory } from "./pg.mjs";
import { openDb } from "../db/client.mjs";
import { migrate } from "../db/migrate.mjs";
import { createEmbedder } from "../engine/embed.mjs";

/** `db` from openDb(); `queue` (src/jobs/queue.mjs) for the after-call jobs. */
export async function openMemory({ db, skill, queue = null, endpoint = null, log = () => {} }) {
  await migrate(db, { log });
  const embedder = endpoint ? createEmbedder({ endpoint, onError: err => log("embedding failed:", err.message) }) : null;
  const memory = openPgMemory({ db, skill, queue, embedder, log });
  await memory.ensureUser();
  await memory.ensureDemoUser();
  return memory;
}

export { openDb };
