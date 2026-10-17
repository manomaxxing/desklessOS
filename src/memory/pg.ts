// Memory on Postgres (Supabase EU; PGlite locally and in tests): per user and org, searchable,
// a budgeted context per call, the call itself saved as it goes, and the after-call steps, each
// of which does its work once however often it's tried. Schema: src/db/migrations/.
// This puts the stores together (users, calls, objectives, requests, research, search, …);
// each lives in its own module here.

import type { Db } from "../db/client.ts";
import type { Log } from "../types/common.ts";
import type { Profile } from "../types/user.ts";
import type { Framework } from "./research.ts";
import { DEFAULT_BUDGET } from "./context.ts";
import { createUsers } from "./users.ts";
import { createObjectives, type ObjectiveTemplates } from "./objectives-store.ts";
import { createRequestsStore } from "./requests-store.ts";
import { createSearch, type Embedder } from "./search.ts";
import { createEmbeddingFiller } from "./embeddings.ts";
import { createCallScopes, type CallQueue } from "./call-scope.ts";
import { createCalls } from "./calls.ts";
import { createOverviews, createVoiceClips } from "./overviews.ts";

export { emptyScope } from "./call-scope.ts";
export { e164 } from "./rows.ts";

/** What memory needs of the skill: the research framework, the first user's profile, the objective templates. */
export interface MemorySkill extends ObjectiveTemplates {
  framework: Framework | null;
  profile?: Profile & { owner?: string; phone?: string };
  DEFAULT_LANG: string;
}

export interface PgMemoryOptions {
  db: Db;
  skill: MemorySkill;
  /** src/jobs/queue.ts: the end of a call enqueues its after-call job in the same transaction. */
  queue?: CallQueue | null;
  embedder?: Embedder | null;
  budget?: number;
  log?: Log;
}

export function openPgMemory({ db, skill, queue = null, embedder = null, budget = DEFAULT_BUDGET, log = () => {} }: PgMemoryOptions) {
  const framework = skill.framework;
  const users = createUsers({ db, persona: skill, log });
  const objectives = createObjectives({ db, skill, defaultUser: users.defaultUser });
  const search = createSearch({ db, embedder, log });
  const scopes = createCallScopes({ db, users, objectives, framework, search, queue, budget });
  const calls = createCalls({ db, users, objectives, framework, scopes, queue });
  const overviews = createOverviews({ db, users, framework });

  return {
    db,
    ensureUser: users.ensureUser,
    ensureDemoUser: users.ensureDemoUser,
    /** Everything one call needs from memory, read once when it connects; the call's row starts here. */
    openCall: scopes.openCall,
    ...calls,
    voiceClips: createVoiceClips(db),
    ...overviews,
    objectives: { list: objectives.list, get: objectives.get, byIds: objectives.byIds, create: objectives.create, cancel: objectives.cancel, toNextInbound: objectives.toNextInbound },
    listUsers: users.list,
    getUser: users.get,
    updateUser: users.update,
    // Admin requests (src/admin/requests.ts).
    requests: createRequestsStore(db),
    embedPending: createEmbeddingFiller({ db, embedder, log }),
    close: () => db.close(),
  };
}
export type Memory = ReturnType<typeof openPgMemory>;
