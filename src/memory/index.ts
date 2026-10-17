// Memory: Postgres at DATABASE_URL (Supabase EU in production; pglite:<dir> for local
// runs, pglite:memory in tests). Migrations run on start; on an empty database the first
// user comes from the persona's profile, and the demo user is made once. One scope per
// call (openCall): who's calling, the MEMORY text for the prompt, search, and the call's
// own row; the after-call steps work from that row (afterCall).

import type { Db } from "../db/client.ts";
import type { Endpoint } from "../types/gemini.ts";
import type { Log } from "../types/common.ts";
import { openPgMemory, type Memory, type MemorySkill } from "./pg.ts";
import type { CallQueue } from "./call-scope.ts";
import { openDb } from "../db/client.ts";
import { migrate } from "../db/migrate.ts";
import { createEmbedder } from "../engine/embed.ts";

/** `db` from openDb(); `queue` (src/jobs/queue.ts) for the after-call jobs. */
export async function openMemory({ db, skill, queue = null, endpoint = null, log = () => {} }: { db: Db; skill: MemorySkill; queue?: CallQueue | null; endpoint?: Endpoint | null; log?: Log }): Promise<Memory> {
  await migrate(db, { log });
  const embedder = endpoint ? createEmbedder({ endpoint, onError: err => log("embedding failed:", err instanceof Error ? err.message : String(err)) }) : null;
  const memory = openPgMemory({ db, skill, queue, embedder, log });
  await memory.ensureUser();
  await memory.ensureDemoUser();
  return memory;
}

export { openDb };
