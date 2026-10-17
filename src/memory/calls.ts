// Calls after they're placed: the after-call steps' view of one that ended, lost ones swept up,
// who's on a call, and the call log the monitor and the admin page read.

import type { Db, SqlParam } from "../db/client.ts";
import type { Turn } from "../types/common.ts";
import type { CallEvent } from "../types/call.ts";
import type { User, Profile } from "../types/user.ts";
import type { Objective } from "../types/agenda.ts";
import type { Users } from "./users.ts";
import type { Objectives } from "./objectives-store.ts";
import type { Discovery, Framework } from "./research.ts";
import type { AfterCallScope, CallQueue, CallScopes } from "./call-scope.ts";
import { loadResearch } from "./research-store.ts";
import { callDetailOut, callOut, json, userOut, type CallDetail, type CallRow, type CallSummary, type Recap, type Wish } from "./rows.ts";

export const LOST_AFTER_MIN = 30; // a call still open this long is over (calls end at MAX_CALL_MIN, 15): its instance died
const USER_TURNS = "(select count(*)::int from jsonb_array_elements(c.transcript) t where t->>'role' = 'user')";

/** A finished call as the after-call steps see it. */
export interface EndedCall {
  id: string;
  direction: CallRow["direction"];
  source: string;
  from: string | null;
  lang: string | null;
  reason: string | null;
  turns: Turn[];
  extraction: Record<string, unknown> | null;
  extractionTurns: number;
  startedAt: Date | string;
  recap: Recap | null;
  noteSentAt: string | null;
  rehearsalOf: string | null;
  wishes: Wish[] | null;
}
export interface AfterCallState {
  call: EndedCall;
  user: User & { profile: Profile };
  objectives: Objective[];
  discovery: Discovery | null;
  scope: AfterCallScope;
  saveExtraction(extraction: unknown, extractionTurns: number): Promise<unknown>;
  addEvents(events: CallEvent[]): Promise<unknown> | null;
  saveRecap(recap: Recap): Promise<unknown>;
  saveWishes(wishes: Wish[]): Promise<unknown>;
  noteSent(messageId: string): Promise<unknown>;
  addCost(usd: number): Promise<unknown>;
  done(): Promise<unknown>;
}

export function createCalls({ db, users, objectives, framework, scopes, queue = null }: {
  db: Db; users: Users; objectives: Objectives; framework: Framework | null; scopes: CallScopes; queue?: CallQueue | null;
}) {
  return {
    /** A finished call as the after-call steps need it: the row, its user, and the steps bound to them. Null when there's nothing to do. */
    async afterCall(callId: string): Promise<AfterCallState | null> {
      const [c] = await db.query<CallRow>("select * from calls where id = $1", [callId]);
      if (!c || !c.ended_at || c.after_call_at) return null;
      const user = c.user_id ? await users.row(c.user_id) : null;
      if (!user) return null;
      const set = (sql: string, params: SqlParam[]) => db.query(sql, [callId, ...params]);
      return {
        call: {
          id: c.id, direction: c.direction, source: c.source, from: c.from_e164, lang: c.lang, reason: c.ended_reason, turns: c.transcript ?? [],
          extraction: c.extraction ?? null, extractionTurns: c.extraction_turns ?? 0, startedAt: c.started_at, recap: c.recap ?? null,
          noteSentAt: c.meta?.noteSentAt ?? null, rehearsalOf: c.meta?.rehearsalOf?.name ?? null, wishes: c.meta?.wishes ?? null,
        },
        user: { ...userOut(user), profile: user.profile ?? {} },
        objectives: await objectives.byIds(c.objective_ids ?? []),
        discovery: await loadResearch(db, framework, user),
        scope: scopes.afterCallScope(user, callId),
        saveExtraction: (extraction, extractionTurns) => set("update calls set extraction = $2, extraction_turns = $3 where id = $1", [json(extraction), extractionTurns]),
        addEvents: events => (events.length ? set("update calls set timeline = timeline || $2::jsonb where id = $1", [json(events.map(e => ({ t: Date.now(), ...e })))]) : null),
        saveRecap: recap => set("update calls set recap = $2 where id = $1", [json(recap)]),
        saveWishes: wishes => set("update calls set meta = meta || $2::jsonb where id = $1", [json({ wishes })]),
        noteSent: messageId => set("update calls set meta = meta || $2::jsonb where id = $1", [json({ noteSentAt: new Date().toISOString(), noteMessageId: messageId })]),
        addCost: usd => set("update calls set meta = jsonb_set(meta, '{usd}', to_jsonb(coalesce((meta->>'usd')::float8, 0) + $2)) where id = $1", [usd]),
        done: () => set("update calls set after_call_at = now() where id = $1", []),
      };
    },

    /** Calls still open long after any call could last: their instance died. Ended here, and their after-call job queued. */
    async sweepLostCalls({ olderThanMin = LOST_AFTER_MIN }: { olderThanMin?: number } = {}): Promise<string[]> {
      return db.tx(async q => {
        const lost = await q.query<{ id: string }>("update calls set ended_at = now(), ended_reason = 'lost', updated_at = now() where ended_at is null and started_at < now() - make_interval(mins => $1) returning id", [olderThanMin]);
        for (const { id } of lost) await queue?.enqueue("after_call", { callId: id }, { key: `after_call:${id}`, q });
        return lost.map(r => r.id);
      });
    },

    /** Is he on a call right now, on any instance? */
    async userOnCall(userId: string): Promise<boolean> {
      const [r] = await db.query<{ on_call: boolean }>("select exists (select 1 from calls where user_id = $1 and ended_at is null and started_at > now() - make_interval(mins => $2)) on_call", [userId, LOST_AFTER_MIN]);
      return Boolean(r?.on_call);
    },
    callExists: async (callId: string): Promise<boolean> => (await db.query("select 1 from calls where id = $1", [callId])).length > 0,

    // The monitor's call log.
    async recentCalls({ limit = 100 }: { limit?: number } = {}): Promise<CallSummary[]> {
      return (await db.query<CallRow>(`select c.id, c.user_id, c.direction, c.source, c.from_e164, c.to_e164, c.lang, c.started_at, c.ended_at, c.ended_reason, c.summary, c.call_type, c.meta,
          c.recap->>'title' recap_title, u.name user_name, ${USER_TURNS} turns, n.id note_id
          from calls c left join notes n on n.call_id = c.id left join users u on u.id = c.user_id order by c.started_at desc limit $1`, [limit])).map(callOut);
    },
    async getCall(id: string): Promise<CallDetail | null> {
      const [c] = await db.query<CallRow>(`select c.*, ${USER_TURNS} turns, n.id note_id, n.data note, u.name user_name from calls c left join notes n on n.call_id = c.id left join users u on u.id = c.user_id where c.id = $1`, [id]);
      return c ? callDetailOut(c) : null;
    },
    /** A summary written on demand (the admin page), for a call that ended without one. */
    async saveRecap(id: string, recap: Recap): Promise<boolean> {
      const [c] = await db.query("update calls set recap = $2 where id = $1 and ended_at is not null returning id", [id, json(recap)]);
      return Boolean(c);
    },
  };
}
export type Calls = ReturnType<typeof createCalls>;
