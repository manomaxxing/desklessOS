// Outbound calls. Approved objectives with mode "outbound" or "either" become one
// errand per user (outbound_calls): new ones join his errand that's already waiting. Every
// background tick (src/jobs/background.ts) claims one due errand (FOR UPDATE SKIP LOCKED),
// checks its objectives are still open and the guard against the user's row, and dials
// through the carrier. Outcomes come back from the carrier (no answer, busy, failed:
// nobody picked up) or from the call's after-call step (answered: done, declined, call me
// later, voicemail, hung up early). Retries: 30 min, 2 h, then the next day's window;
// after the fourth try the errand moves to his next inbound call and Max is told.

import { randomUUID } from "node:crypto";
import { nextInWindow, nextDayWindow, usableWindow, zonedTime, localParts, DEFAULT_TZ } from "./windows.ts";
import type { WindowOptions } from "./windows.ts";
import type { Db } from "../db/client.ts";
import type { ErrandRow } from "../types/jobs.ts";
import type { Carrier, CarrierStatus } from "../types/call.ts";
import type { User, UserPatch } from "../types/user.ts";
import type { Log } from "../types/common.ts";

export type { Carrier, CarrierStatus };

const RETRY_MS = [30 * 60000, 2 * 3600000]; // after the 1st and 2nd failed try; the 3rd waits for the next day
const MAX_ATTEMPTS = 4;
const ON_CALL_RETRY_MS = 10 * 60000;
const STUCK_MS = 3 * 60000; // dialing with no word from the carrier: look at what happened
// A call that ended this long ago without its outcome reaching its errand (the after-call job died
// after its retries, ~2.5 h; or it ran where no scheduler was): a failed try, so its questions move on.
const OUTCOME_LOST_MS = 6 * 3600000;
const BAD_WINDOW = "his call times aren't set right (People card)";

/** What the guard needs to know about him. */
export type GuardUser = Pick<User, "consentOutboundAt" | "outboundPaused" | "phone" | "callWindow" | "timezone">;
export type Guard =
  | { ok: true }
  | { ok: false; reason: string; final: true }
  | { ok: false; reason: string; final?: false; retryAt: Date };

/** How an answered call went, from its notes (the agenda's callOutcome). */
export interface CallOutcome {
  consent: string;
  callbackWhen?: string;
}

/** What one tick did: the errand it took, and whom it called or why not. */
export interface OutboundTick {
  job: ErrandRow;
  callId?: string;
  skipped?: string;
  deferred?: string;
  until?: Date;
  error?: string;
}

const windowOf = (user: Pick<User, "callWindow" | "timezone"> | null): WindowOptions => ({ window: user?.callWindow, tz: user?.timezone || DEFAULT_TZ });

/** May we call this user now? { ok } | { ok: false, reason, retryAt } | { ok: false, reason, final } */
export function outboundGuard(user: GuardUser | null, { at = new Date(), onCall = false, answeredToday = 0, perDay = 1 } = {}): Guard {
  if (!user) return { ok: false, reason: "no such user", final: true };
  if (!user.consentOutboundAt) return { ok: false, reason: "he hasn't agreed to be called", final: true };
  if (user.outboundPaused) return { ok: false, reason: "calls to him are paused", final: true };
  if (!user.phone) return { ok: false, reason: "no phone number for him", final: true };
  const w = windowOf(user);
  const opens = nextInWindow(at, w);
  if (!opens) return { ok: false, reason: BAD_WINDOW, final: true };
  if (onCall) return { ok: false, reason: "he's on a call", retryAt: new Date(at.getTime() + ON_CALL_RETRY_MS) };
  if (answeredToday >= perDay) return { ok: false, reason: "he was already called today", retryAt: nextDayWindow(at, w) ?? opens };
  if (opens > at) return { ok: false, reason: "outside his call times", retryAt: opens };
  return { ok: true };
}

/** When to try again after the n-th failed try (n from 1), inside his window; null = give up. */
export function retryAt(n: number, user: Pick<User, "callWindow" | "timezone"> | null, at = new Date()): Date | null {
  const w = windowOf(user);
  if (n >= MAX_ATTEMPTS) return null;
  if (n <= RETRY_MS.length) return nextInWindow(new Date(at.getTime() + RETRY_MS[n - 1]), w);
  return nextDayWindow(at, w);
}

const json = (v: unknown): string => JSON.stringify(v ?? null);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What the scheduler needs from memory (src/memory/pg.ts). */
export interface SchedulerMemory {
  db: Pick<Db, "query">;
  objectives: { toNextInbound(id: string): Promise<unknown> };
  getUser(id: string): Promise<User | null>;
  updateUser(id: string, patch: UserPatch): Promise<unknown>;
  userOnCall(userId: string): Promise<boolean>;
  callExists(callId: string): Promise<boolean>;
}

export interface Scheduler {
  /** One step: new errands, stuck ones looked at, and at most one call placed. */
  tick(): Promise<OutboundTick | null>;
  /** Pending outbound objectives without an errand get one per user (or join his waiting one). */
  sync(): Promise<ErrandRow[]>;
  /** The carrier's word on a call: nobody picked up (no-answer, busy, failed, canceled), or it was answered. */
  callStatus(s: CarrierStatus): Promise<void>;
  /** An answered outbound call ended. outcome: { consent: yes|no|later|never|unknown, callbackWhen } from the call's notes. */
  callEnded(o: { callId: string; reason?: string | null; outcome?: CallOutcome | null; objectives?: { id: string; done: boolean }[] }): Promise<void>;
  list(options?: { limit?: number }): Promise<(ErrandRow & { user_name: string })[]>;
  cancelFor(objectiveId: string): Promise<void>;
}

export function createScheduler({ memory, carrier, requests = null, log = () => {}, monitor = null, now = () => new Date(), perDay = Number(process.env.OUTBOUND_PER_DAY || 1) }: {
  memory: SchedulerMemory;
  carrier: Carrier;
  /** Max's requests (src/admin/requests.ts): what happened goes on their card. */
  requests?: { note(objectiveId: string, text: string): Promise<unknown> } | null;
  log?: Log;
  monitor?: { system(text: string, level?: string): void } | null;
  now?: () => Date;
  perDay?: number;
}): Scheduler {
  const db = memory.db;
  const note = (job: ErrandRow, text: string) => db.query("update outbound_calls set log = log || $2::jsonb, updated_at = now() where id = $1", [job.id, json([{ at: now().toISOString(), text }])]);
  const say = (text: string) => { log(`outbound: ${text}`); monitor?.system(`outbound: ${text}`); };

  async function sync(): Promise<ErrandRow[]> {
    const free = await db.query<{ id: string; user_id: string; org_id: string }>(`select o.id, o.user_id, o.org_id from objectives o
      where o.status = 'pending' and o.mode in ('outbound', 'either') and o.user_id is not null
        and (o.not_before is null or o.not_before <= now())
        and not exists (select 1 from outbound_calls j where o.id = any(j.objective_ids) and j.status in ('queued', 'dialing', 'in_call'))`);
    const byUser = new Map<string, typeof free>();
    for (const o of free) byUser.set(o.user_id, [...(byUser.get(o.user_id) ?? []), o]);
    const touched: ErrandRow[] = [];
    for (const [userId, list] of byUser) {
      const ids = list.map(o => o.id);
      // He has a call waiting already: these come along on it, not on a second call.
      const [joined] = await db.query<ErrandRow>(`update outbound_calls set objective_ids = objective_ids || $2::text[], updated_at = now()
        where id = (select id from outbound_calls where user_id = $1 and status = 'queued' order by created_at limit 1 for update skip locked) returning *`, [userId, ids]);
      if (joined) {
        await note(joined, `also: ${ids.join(", ")}`);
        say(`job ${joined.id} also for ${ids.join(", ")}`);
        touched.push(joined);
        continue;
      }
      const [job] = await db.query<ErrandRow>("insert into outbound_calls (id, org_id, user_id, objective_ids, max_attempts, next_attempt_at) values ($1, $2, $3, $4, $5, $6) returning *",
        [`job_${randomUUID().slice(0, 8)}`, list[0].org_id, userId, ids, MAX_ATTEMPTS, now().toISOString()]);
      touched.push(job);
      say(`job ${job.id} for ${ids.join(", ")}`);
    }
    return touched;
  }

  // The errand couldn't be done by calling: his next inbound call asks instead, and Max hears why.
  async function fallBack(job: ErrandRow, why: string): Promise<void> {
    for (const id of job.objective_ids) {
      await memory.objectives.toNextInbound(id);
      await requests?.note(id, `${why} It'll be asked in his next call instead.`);
    }
    say(`job ${job.id}: ${why} → next inbound call`);
  }
  async function finish(job: ErrandRow, status: ErrandRow["status"], outcome: string, why?: string): Promise<void> {
    await db.query("update outbound_calls set status = $2, outcome = $3, updated_at = now() where id = $1", [job.id, status, outcome]);
    await note(job, why ?? outcome);
  }
  async function attemptFailed(job: ErrandRow, outcome: string): Promise<void> {
    const user = await memory.getUser(job.user_id);
    const next = retryAt(job.attempts, user, now());
    if (!next) {
      const usable = usableWindow(windowOf(user));
      await finish(job, "failed", outcome, usable ? `gave up after ${job.attempts} tries (last: ${outcome})` : `gave up: ${BAD_WINDOW} (last: ${outcome})`);
      return fallBack(job, usable ? `Couldn't reach ${user?.name ?? "him"} by phone (${job.attempts} tries, last: ${outcome}).` : `Can't call ${user?.name ?? "him"}: ${BAD_WINDOW}.`);
    }
    await db.query("update outbound_calls set status = 'queued', outcome = $2, next_attempt_at = $3, updated_at = now() where id = $1", [job.id, outcome, next.toISOString()]);
    await note(job, `try ${job.attempts}: ${outcome}; next try ${next.toISOString()}`);
  }

  /** Calls he actually took today, his time (a voicemail doesn't count, nor the call in which he asked to be called back). */
  async function answeredToday(user: User, at: Date, except: string | null): Promise<number> {
    const tz = user.timezone || DEFAULT_TZ;
    const midnight = zonedTime(localParts(at, tz).date, "00:00", tz);
    const [row] = await db.query<{ n: number }>("select count(*)::int n from calls where user_id = $1 and direction = 'outbound' and started_at >= $2 and coalesce(ended_reason, '') <> 'voicemail' and id <> coalesce($3, '')",
      [user.id, midnight.toISOString(), except]);
    return row?.n ?? 0;
  }

  /** The errand's objectives that still want a call (another call may have done them, Max may have cancelled them). */
  async function stillOpen(ids: string[]): Promise<string[]> {
    const rows = await db.query<{ id: string }>("select id from objectives where id = any($1::text[]) and status = 'pending' and mode in ('outbound', 'either')", [ids]);
    const open = new Set(rows.map(r => r.id));
    return ids.filter(id => open.has(id));
  }

  // Errands that stopped moving. Each is claimed by bumping it (one instance acts on it), then:
  //   dialing, no word from the carrier: the call came through → he's on it; else a failed try (backoff, at most four)
  //   in_call, answered but no call ever came through: a failed try (one that did gets its outcome from its after-call step)
  //   in_call, the call ended long ago but its outcome never came: a failed try too
  async function sweep(): Promise<void> {
    for (const j of await db.query<ErrandRow>("update outbound_calls set updated_at = now() where status = 'dialing' and updated_at < now() - make_interval(secs => $1) returning *", [STUCK_MS / 1000])) {
      if (j.call_id && (await memory.callExists(j.call_id))) {
        await db.query("update outbound_calls set status = 'in_call', outcome = 'answered', updated_at = now() where id = $1 and status = 'dialing'", [j.id]);
        await note(j, "no word from the carrier, but the call came through");
      } else await attemptFailed(j, "no word from the carrier");
    }
    for (const j of await db.query<ErrandRow>("update outbound_calls set updated_at = now() where status = 'in_call' and updated_at < now() - interval '20 minutes' returning *")) {
      if (!(j.call_id && (await memory.callExists(j.call_id)))) { await attemptFailed(j, "the call never came through"); continue; }
      const [call] = await db.query<{ lost: boolean }>("select ended_at < now() - make_interval(secs => $2) lost from calls where id = $1", [j.call_id, OUTCOME_LOST_MS / 1000]);
      if (call?.lost) await attemptFailed(j, "the call ended, but its outcome never came");
    }
  }

  async function tick(): Promise<OutboundTick | null> {
    await sync();
    await sweep();
    const [claimed] = await db.query<ErrandRow>(`update outbound_calls set status = 'dialing', attempts = attempts + 1, updated_at = now()
      where id = (select id from outbound_calls where status = 'queued' and next_attempt_at <= $1 order by next_attempt_at limit 1 for update skip locked)
      returning *`, [now().toISOString()]);
    if (!claimed) return null;
    const open = await stillOpen(claimed.objective_ids);
    if (!open.length) {
      await finish(claimed, "done", "nothing left", "nothing left to ask: done, cancelled or moved to his next call meanwhile");
      say(`job ${claimed.id}: nothing left to ask`);
      return { job: claimed, skipped: "nothing left to ask" };
    }
    if (open.length < claimed.objective_ids.length) await db.query("update outbound_calls set objective_ids = $2 where id = $1", [claimed.id, open]);
    const job: ErrandRow = { ...claimed, objective_ids: open };
    const user = await memory.getUser(job.user_id);
    const at = now();
    // "Call me back at 15:00": the call in which he asked doesn't use up today's call.
    const asked = job.outcome === "later" ? job.call_id : null;
    const guard = outboundGuard(user, { at, onCall: Boolean(user && (await memory.userOnCall(user.id))), answeredToday: user ? await answeredToday(user, at, asked) : 0, perDay });
    if (guard.ok === false) { // (=== narrows the union in the tests' looser checking too)
      if (guard.final === true) {
        await finish(job, "failed", "not allowed", guard.reason);
        await fallBack(job, `Can't call ${user?.name ?? "him"}: ${guard.reason}.`);
        return { job, skipped: guard.reason };
      }
      // Not now: back in the queue, and this doesn't count as a try.
      await db.query("update outbound_calls set status = 'queued', attempts = attempts - 1, next_attempt_at = $2, updated_at = now() where id = $1", [job.id, guard.retryAt.toISOString()]);
      await note(job, `not now (${guard.reason}); next ${guard.retryAt.toISOString()}`);
      return { job, deferred: guard.reason, until: guard.retryAt };
    }
    if (!user) return null; // not reached: the guard turns away a missing user
    try {
      const placed = await carrier.dialOut({ to: user.phone, userId: user.id, jobId: job.id });
      await db.query("update outbound_calls set call_id = $2, carrier = $3, updated_at = now() where id = $1", [job.id, placed.callId, placed.carrier]);
      await note(job, `try ${job.attempts}: calling ${user.name} (${placed.carrier} ${placed.callId})`);
      say(`calling ${user.name} for job ${job.id} (try ${job.attempts})`);
      return { job, callId: placed.callId };
    } catch (err) {
      await attemptFailed(job, `the call couldn't be placed: ${errText(err)}`);
      return { job, error: errText(err) };
    }
  }

  const jobOf = async (callId: string | null | undefined): Promise<ErrandRow | null> =>
    (callId ? (await db.query<ErrandRow>("select * from outbound_calls where call_id = $1 order by updated_at desc limit 1", [callId]))[0] ?? null : null);

  return {
    tick,
    sync,

    async callStatus({ callId, status }) {
      const job = await jobOf(callId);
      if (!job || !["dialing", "in_call"].includes(job.status)) return;
      if (["in-progress", "answered"].includes(status)) {
        await db.query("update outbound_calls set status = 'in_call', outcome = 'answered', updated_at = now() where id = $1", [job.id]);
        return;
      }
      if (job.status === "dialing" && ["no-answer", "busy", "failed", "canceled"].includes(status)) await attemptFailed(job, status);
    },

    async callEnded({ callId, reason, outcome, objectives = [] }) {
      const job = await jobOf(callId);
      if (!job || !["dialing", "in_call"].includes(job.status)) return;
      const mine = objectives.filter(o => job.objective_ids.includes(o.id));
      const user = await memory.getUser(job.user_id);
      if (reason === "voicemail") return attemptFailed(job, "voicemail");
      if (mine.length && mine.every(o => o.done)) return finish(job, "done", "completed", "done: all answered");
      if (outcome?.consent === "never") {
        await memory.updateUser(job.user_id, { outboundPaused: true });
        await finish(job, "done", "declined", "he doesn't want these calls: calls to him paused");
        return fallBack(job, `${user?.name ?? "He"} doesn't want to be called for this (calls to him are now paused).`);
      }
      if (outcome?.consent === "no") {
        await finish(job, "done", "declined", "no time, no callback");
        return fallBack(job, `${user?.name ?? "He"} had no time when called.`);
      }
      if (outcome?.consent === "later") {
        const w = windowOf(user);
        const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(outcome.callbackWhen ?? "");
        const asked = m ? zonedTime(m[1], m[2], w.tz ?? DEFAULT_TZ) : null; // his wall clock, not the server's
        const when = nextInWindow(asked && asked > now() ? asked : nextDayWindow(now(), w) ?? now(), w);
        if (!when) {
          await finish(job, "failed", "later", `he asked to be called later, but ${BAD_WINDOW}`);
          return fallBack(job, `${user?.name ?? "He"} asked to be called later, but ${BAD_WINDOW}.`);
        }
        await db.query("update outbound_calls set status = 'queued', outcome = 'later', attempts = greatest(attempts - 1, 0), next_attempt_at = $2, updated_at = now() where id = $1", [job.id, when.toISOString()]);
        await note(job, `he asked to be called later; next try ${when.toISOString()}`);
        return;
      }
      return attemptFailed(job, reason === "caller_hangup" ? "hung up before it was done" : `ended (${reason}) before it was done`);
    },

    async list({ limit = 50 } = {}) {
      return db.query<ErrandRow & { user_name: string }>("select j.*, u.name user_name from outbound_calls j join users u on u.id = j.user_id order by j.created_at desc limit $1", [limit]);
    },
    /** Max cancelled an objective: it leaves its errand; an errand left with nothing to ask is cancelled. */
    async cancelFor(objectiveId) {
      await db.query(`update outbound_calls set objective_ids = array_remove(objective_ids, $1),
          status = case when cardinality(array_remove(objective_ids, $1)) = 0 then 'cancelled' else status end, updated_at = now()
        where $1 = any(objective_ids) and status in ('queued', 'dialing')`, [objectiveId]);
    },
  };
}
