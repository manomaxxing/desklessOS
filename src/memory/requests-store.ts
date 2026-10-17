// Max's requests in Postgres (src/admin/requests.ts has the rules).

import type { Db } from "../db/client.ts";
import type { Request, RequestStatus } from "../types/request.ts";
import { isUuid, json, requestOut, type RequestRow } from "./rows.ts";

// request fields (camelCase) → columns
const COLUMNS = {
  log: "log", userId: "user_id", instruction: "instruction", plan: "plan", planHash: "plan_hash", card: "card", turns: "turns", status: "status",
  objectiveId: "objective_id", result: "result", approvedAt: "approved_at", closedAt: "closed_at", notifiedAt: "notified_at",
} as const satisfies Partial<Record<keyof Request, string>>;
const JSON_COLUMNS = new Set<string>(["plan", "card", "turns", "result", "log"]);
export type RequestPatch = Partial<Pick<Request, keyof typeof COLUMNS>>;

export interface NewRequest extends Pick<Request, "id" | "instruction" | "plan" | "planHash" | "card"> {
  userId: string | null;
  turns?: unknown[];
  status?: RequestStatus;
  createdBy?: string;
}

export function createRequestsStore(db: Db) {
  const out = (rows: RequestRow[]): Request | null => (rows[0] ? requestOut(rows[0]) : null);

  /** `set col = $n` for each known field of the patch, and its values after `first`. */
  function sets(patch: RequestPatch, first: number): { sql: string[]; values: (string | null)[] } {
    const sql: string[] = [];
    const values: (string | null)[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = COLUMNS[k as keyof typeof COLUMNS]; // keys of a RequestPatch
      if (!col) continue;
      values.push(JSON_COLUMNS.has(col) ? json(v) : col === "user_id" && !isUuid(v) ? null : v == null ? null : String(v));
      sql.push(`${col} = $${first + values.length}`);
    }
    return { sql, values };
  }

  const store = {
    async create(r: NewRequest): Promise<Request> {
      const [user] = isUuid(r.userId) ? await db.query<{ org_id: string }>("select org_id from users where id = $1", [r.userId]) : [];
      const rows = await db.query<RequestRow>(`insert into requests (id, org_id, user_id, instruction, plan, plan_hash, card, turns, status, created_by)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [r.id, user?.org_id ?? null, isUuid(r.userId) ? r.userId : null, r.instruction, json(r.plan), r.planHash, json(r.card), json(r.turns ?? []), r.status ?? "draft", r.createdBy ?? "admin"]);
      return out(rows)!;
    },
    get: async (id: string): Promise<Request | null> => out(await db.query<RequestRow>("select * from requests where id = $1", [id])),
    list: async ({ limit = 100 }: { limit?: number } = {}): Promise<Request[]> => (await db.query<RequestRow>("select * from requests order by created_at desc limit $1", [limit])).map(requestOut),
    async update(id: string, patch: RequestPatch): Promise<Request | null> {
      const { sql, values } = sets(patch, 1);
      if (!sql.length) return store.get(id);
      return out(await db.query<RequestRow>(`update requests set ${sql.join(", ")}, updated_at = now() where id = $1 returning *`, [id, ...values]));
    },
    /**
     * A status change that happens only if the request is still in `from` (another instance or a
     * double click may have moved it): the changed request, or null if it wasn't in `from` any more.
     */
    async transition(id: string, from: RequestStatus | readonly RequestStatus[], to: RequestStatus, patch: RequestPatch = {}): Promise<Request | null> {
      const { sql, values } = sets({ ...patch, status: to }, 2);
      const froms = typeof from === "string" ? [from] : [...from];
      return out(await db.query<RequestRow>(`update requests set ${sql.join(", ")}, updated_at = now() where id = $1 and status = any($2::text[]) returning *`, [id, froms, ...values]));
    },
    byObjective: async (objectiveId: string): Promise<Request | null> => out(await db.query<RequestRow>("select * from requests where objective_id = $1", [objectiveId])),
  };
  return store;
}
export type RequestsStore = ReturnType<typeof createRequestsStore>;
