// One call's memory: read once when it connects (who's calling, the MEMORY block, research,
// the objectives it brings), saved as it goes, ended once (with its after-call job queued in the
// same transaction). And the after-call steps' view of a finished call.

import type { Db, Queryable } from "../db/client.ts";
import type { CallEnd, CallScope, CallSnapshot, Direction, SearchResult } from "../types/call.ts";
import type { Note } from "../types/note.ts";
import type { Objective, ObjectiveResult } from "../types/agenda.ts";
import type { UserRow } from "../types/user.ts";
import type { Framework } from "./research.ts";
import type { Discovery } from "./research.ts";
import type { Users } from "./users.ts";
import type { Objectives } from "./objectives-store.ts";
import { buildContext } from "./context.ts";
import { contextData } from "./context-data.ts";
import { loadResearch } from "./research-store.ts";
import { postCall } from "./post-call.ts";
import { e164, isUuid, json, noteOut, type SavedNote } from "./rows.ts";

/** The after-call job's queue: the end of a call enqueues it in the same transaction. */
export interface CallQueue {
  enqueue(kind: string, payload: Record<string, unknown>, options: { key: string; q?: Queryable }): Promise<unknown>;
}

/** A call that keeps nothing: an unknown caller, Max's own line, or memory that's down. */
export const emptyScope = (): CallScope => ({
  user: null, rehearsal: null, context: "", hidden: 0, stats: null, discovery: null, objectives: [],
  search: async () => [], setAgenda: async () => {}, checkpoint: async () => {}, endCall: async () => false, recordToolRun: async () => {},
});

export interface OpenedCall extends CallScope {
  user: NonNullable<CallScope["user"]>;
  discovery: Discovery | null;
}

export interface OpenCall {
  callId: string;
  from?: string | null;
  to?: string | null;
  userId?: string | null;
  direction?: Direction;
  source?: string;
  at?: Date;
  /** A rehearsal: Max tries out a call to this user (id) on his own phone. */
  rehearsalOf?: string | null;
}

const snapshotParams = ({ turns = [], extraction = null, extractionTurns = 0 }: Partial<CallSnapshot>) =>
  [json(turns), extraction ? json(extraction) : null, extractionTurns] as const;

export function createCallScopes({ db, users, objectives, framework, search, queue = null, budget }: {
  db: Db; users: Users; objectives: Objectives; framework: Framework | null;
  search: (user: Pick<UserRow, "org_id">, query: string) => Promise<SearchResult[]>; queue?: CallQueue | null; budget: number;
}) {
  /** What the after-call steps do with a call that ended: its note, its objectives, its memory. */
  function afterCallScope(user: UserRow, callId: string) {
    return {
      ...postCall(db, framework, user),
      /** His note for this call: one per call, so the after-call step can save it again safely. */
      async saveNote(note: Note & { transcript?: unknown; call_id?: unknown; from?: unknown; ended_reason?: unknown }): Promise<SavedNote> {
        const { transcript: _t, call_id: _c, from: _f, ended_reason: _e, lang = "", ...data } = note;
        const [row] = await db.query<Parameters<typeof noteOut>[0]>(`insert into notes (org_id, user_id, call_id, mode, lang, data, summary) values ($1, $2, $3, $4, $5, $6, $7)
          on conflict (call_id) do update set mode = excluded.mode, lang = excluded.lang, data = excluded.data, summary = excluded.summary returning *`,
          [user.org_id, user.id, callId, data.mode ?? "", lang, json(data), data.summary ?? ""]);
        return noteOut(row!);
      },
      recordObjectives: (results: readonly ObjectiveResult[]): Promise<Objective[]> => objectives.record(callId, results),
    };
  }

  /**
   * A call begins. `rehearsalOf`: a rehearsal (Max tries out a call to someone on his own phone):
   * the call is kept under its own user (the demo), but Toni knows what she knows about that
   * person, and nothing of it goes into his memory: his objectives come along as copies.
   */
  async function openCall({ callId, from = null, to = null, userId = null, direction = "inbound", source = "", at = new Date(), rehearsalOf = null }: OpenCall): Promise<OpenedCall | CallScope> {
    const started = performance.now();
    // An outbound call knows whom it called; an inbound one goes by caller ID.
    const user = isUuid(userId) ? await users.row(userId) : await users.callerUser(from);
    if (!user) return emptyScope();
    const subject = isUuid(rehearsalOf) ? await users.row(rehearsalOf) : user;
    if (!subject) return emptyScope();
    const rehearsal = subject.id !== user.id;
    await db.query("insert into calls (id, org_id, user_id, direction, source, from_e164, to_e164, started_at, meta) values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict (id) do nothing",
      [callId, user.org_id, user.id, direction, source, e164(from), e164(to), at.toISOString(), json(rehearsal ? { rehearsalOf: { id: subject.id, name: subject.name } } : {})]);
    const [data, discovery, found, [talked]] = await Promise.all([
      contextData(db, subject, at),
      loadResearch(db, framework, subject),
      objectives.forCall(subject, { direction, at }),
      db.query<{ talked: boolean }>("select exists (select 1 from calls where user_id = $1 and id <> $2 and jsonb_array_length(transcript) > 2) talked", [subject.id, callId]),
    ]);
    const pending = (await objectives.withLastCall(found)).map(o => (rehearsal ? { ...o, stored: false } : o));
    const ctx = buildContext(data, { budget });
    return {
      user: { id: subject.id, orgId: subject.org_id, name: subject.name, lang: subject.lang, timezone: subject.timezone, profile: subject.profile },
      rehearsal: rehearsal ? { of: subject.name } : null,
      context: ctx.text,
      hidden: ctx.hidden,
      firstCall: !talked?.talked, // he's never really talked with Toni before
      stats: { ...ctx.stats, ms: Math.round(performance.now() - started) },
      discovery,
      objectives: pending,
      search: query => search(subject, query),
      /** The stored objectives this call's agenda took on, and what all its items were for (the dashboard shows it). */
      async setAgenda(objectiveIds, goal = []) {
        await db.query("update calls set objective_ids = $2, meta = meta || $3::jsonb where id = $1", [callId, objectiveIds, json({ goal })]);
      },
      /** The call so far (after every turn and note): if this instance dies, nothing is lost. */
      async checkpoint(s) {
        await db.query("update calls set transcript = $2, extraction = coalesce($3::jsonb, extraction), extraction_turns = case when $3::jsonb is null then extraction_turns else $4 end, lang = coalesce($5, lang), updated_at = now() where id = $1 and ended_at is null",
          [callId, ...snapshotParams(s), s.lang ?? null]);
      },
      /** The call is over: its last state, and its after-call job, in one transaction. Returns whether it was the first end. */
      async endCall({ reason = "", timeline = [], meta = {}, lang = null, ...s }: CallEnd) {
        return db.tx(async q => {
          const [row] = await q.query(`update calls set ended_at = now(), ended_reason = $2, transcript = $3, extraction = coalesce($4::jsonb, extraction), extraction_turns = case when $4::jsonb is null then extraction_turns else $5 end,
            lang = coalesce($6, lang), timeline = $7, meta = meta || $8::jsonb, updated_at = now() where id = $1 and ended_at is null returning id`,
            [callId, reason, ...snapshotParams(s), lang, json(timeline), json(meta)]);
          if (row) await queue?.enqueue("after_call", { callId }, { key: `after_call:${callId}`, q });
          return Boolean(row);
        });
      },
      /** The audit trail of what a tool changed (keyed per call and input: one row; a retry that worked replaces a failure). */
      async recordToolRun(o) {
        if (!o.key) return;
        await db.query(`insert into tool_runs (key, org_id, call_id, name, args, status, result) values ($1, $2, $3, $4, $5, $6, $7)
          on conflict (key) do update set status = excluded.status, result = excluded.result where tool_runs.status <> 'ok'`,
          [o.key, user.org_id, callId, o.name, json(o.args), o.status, json(o.result)]);
      },
    };
  }

  return { openCall, afterCallScope };
}
export type CallScopes = ReturnType<typeof createCallScopes>;
export type AfterCallScope = ReturnType<CallScopes["afterCallScope"]>;
