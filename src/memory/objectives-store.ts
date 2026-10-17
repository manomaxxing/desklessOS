// Objectives in Postgres (src/memory/objectives.ts has the rules): created from a template,
// picked for a call (best first), recorded after it (each call counts an attempt once).

import { randomUUID } from "node:crypto";
import type { Db } from "../db/client.ts";
import type { Objective, ObjectiveMode, ObjectiveResult, Template } from "../types/agenda.ts";
import type { Direction } from "../types/call.ts";
import type { Turn } from "../types/common.ts";
import type { UserRow } from "../types/user.ts";
import { MODES_FOR, mergeResult } from "./objectives.ts";
import { e164, json, objectiveOut, type ObjectiveRow } from "./rows.ts";

/** What objectives need of the templates: which exist, and their params checked. */
export interface ObjectiveTemplates {
  templates: Map<string, Template>;
  objectiveParams(templateId: string, params: unknown): Record<string, unknown>;
}

export interface NewObjective {
  template: string;
  params?: unknown;
  mode?: ObjectiveMode;
  priority?: number;
  lang?: string | null;
  notBefore?: string | null;
  deadline?: string | null;
  createdBy?: string;
  /** A user id, or his phone number; without one, the default user. */
  userId?: string | null;
}

export function createObjectives({ db, skill, defaultUser }: { db: Db; skill: ObjectiveTemplates; defaultUser: () => Promise<UserRow | null> }) {
  const one = async (sql: string, params: string[]): Promise<Objective | null> => {
    const [o] = await db.query<ObjectiveRow>(sql, params);
    return o ? objectiveOut(o) : null;
  };

  return {
    async list(): Promise<Objective[]> { return (await db.query<ObjectiveRow>("select * from objectives order by created_at desc")).map(objectiveOut); },
    get: (id: string) => one("select * from objectives where id = $1", [id]),
    async create({ template, params, mode = "next_inbound", priority, lang = null, notBefore = null, deadline = null, createdBy = "admin", userId = null }: NewObjective): Promise<Objective> {
      const t = skill.templates.get(template);
      if (!t || t.kind !== "objective") throw new Error(`unknown objective template "${template}" (${[...skill.templates.values()].filter(x => x.kind === "objective" && x.params).map(x => x.id).join(", ")})`);
      if (!(t.modes ?? ["next_inbound"]).includes(mode)) throw new Error(`mode "${mode}" isn't possible for ${template} (${(t.modes ?? ["next_inbound"]).join(", ")})`);
      const user = userId ? (await db.query<UserRow>("select * from users where id::text = $1 or phone_e164 = $2", [String(userId), e164(userId)]))[0] : await defaultUser();
      if (!user) throw new Error(userId ? `no user ${userId}` : "several users: say which one (userId)");
      const [o] = await db.query<ObjectiveRow>(`insert into objectives (id, org_id, user_id, template, version, params, mode, priority, lang, not_before, deadline, max_attempts, created_by)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) returning *`,
        [`obj_${randomUUID().slice(0, 8)}`, user.org_id, user.id, template, t.version, json(skill.objectiveParams(template, params)), mode,
          Number.isFinite(priority) ? Number(priority) : t.priority ?? 0, lang, notBefore, deadline, t.limits?.attempts ?? 3, createdBy]);
      return objectiveOut(o!);
    },
    cancel: (id: string) => one("update objectives set status = case when status = 'pending' then 'cancelled' else status end, updated_at = now() where id = $1 returning *", [id]),
    /** Couldn't be done by calling him: ask in his next call instead. */
    toNextInbound: (id: string) => one("update objectives set mode = 'next_inbound', updated_at = now() where id = $1 and status = 'pending' returning *", [id]),
    async byIds(ids: readonly string[] = []): Promise<Objective[]> {
      if (!ids.length) return [];
      const rows = (await db.query<ObjectiveRow>("select * from objectives where id = any($1::text[])", [ids])).map(objectiveOut);
      return ids.flatMap(id => rows.filter(o => o.id === id));
    },
    async forCall(user: Pick<UserRow, "id">, { direction = "inbound", at = new Date() }: { direction?: Direction; at?: Date } = {}): Promise<Objective[]> {
      return (await db.query<ObjectiveRow>("select * from objectives where user_id = $1 and status = 'pending' and mode = any($2::text[]) and (not_before is null or not_before <= $3) and (deadline is null or deadline >= $3) order by priority desc, created_at",
        [user.id, MODES_FOR[direction], at.toISOString()])).map(objectiveOut);
    },
    /** What a call got: each objective counts the call once (a retried after-call job changes nothing). */
    async record(callId: string, results: readonly ObjectiveResult[] = []): Promise<Objective[]> {
      const changed: Objective[] = [];
      for (const r of results) {
        const [o] = await db.tx(async q => {
          const [cur] = await q.query<ObjectiveRow>("select * from objectives where id = $1 for update", [r.id]);
          if (!cur || cur.status !== "pending" || cur.calls.includes(callId)) return [];
          const attempts = cur.attempts + 1;
          const status = r.done ? "done" : attempts >= cur.max_attempts ? "expired" : "pending";
          return q.query<ObjectiveRow>("update objectives set attempts = $2, calls = array_append(calls, $3), result = $4, status = $5, updated_at = now() where id = $1 returning *",
            [r.id, attempts, callId, json(mergeResult(cur.result, r.result)), status]);
        });
        if (o) changed.push(objectiveOut(o));
      }
      return changed;
    },
    /** An objective that was already on a call gets how that call ended: its last turns, so the next one can pick up. */
    async withLastCall(list: Objective[]): Promise<Objective[]> {
      const ids = list.map(o => o.calls?.at(-1)).filter((id): id is string => Boolean(id));
      if (!ids.length) return list;
      const rows = await db.query<{ id: string; ended_reason: string | null; transcript: Turn[] | null }>("select id, ended_reason, transcript from calls where id = any($1::text[])", [ids]);
      return list.map(o => {
        const c = rows.find(r => r.id === o.calls?.at(-1));
        return c ? { ...o, lastCall: { reason: c.ended_reason ?? "", turns: (c.transcript ?? []).slice(-6) } } : o;
      });
    },
  };
}
export type Objectives = ReturnType<typeof createObjectives>;
