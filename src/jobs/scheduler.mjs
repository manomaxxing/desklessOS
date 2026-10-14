// Outbound calls. Approved objectives with mode "outbound" or "either" become one
// errand per user (outbound_calls). Every background tick (src/jobs/background.mjs) claims
// one due errand (FOR UPDATE SKIP LOCKED), checks the guard against the user's row, and
// dials through the carrier. Outcomes come back from the carrier (no answer, busy, failed:
// nobody picked up) or from the call's after-call step (answered: done, declined, call me
// later, voicemail, hung up early). Retries: 30 min, 2 h, then the next day's window;
// after the fourth try the errand moves to his next inbound call and Max is told.

import { randomUUID } from "node:crypto";
import { inWindow, nextInWindow, nextDayWindow, zonedTime, localParts } from "./windows.mjs";

const RETRY_MS = [30 * 60000, 2 * 3600000]; // after the 1st and 2nd failed try; the 3rd waits for the next day
const MAX_ATTEMPTS = 4;
const ON_CALL_RETRY_MS = 10 * 60000;
const STUCK_MS = 3 * 60000; // dialing with no word from the carrier: try again

/** May we call this user now? { ok } | { ok: false, reason, retryAt } | { ok: false, reason, final } */
export function outboundGuard(user, { at = new Date(), onCall = false, answeredToday = 0, perDay = 1 } = {}) {
  if (!user) return { ok: false, reason: "no such user", final: true };
  if (!user.consentOutboundAt) return { ok: false, reason: "he hasn't agreed to be called", final: true };
  if (user.outboundPaused) return { ok: false, reason: "calls to him are paused", final: true };
  if (!user.phone) return { ok: false, reason: "no phone number for him", final: true };
  const w = { window: user.callWindow, tz: user.timezone || "Europe/Berlin" };
  if (onCall) return { ok: false, reason: "he's on a call", retryAt: new Date(at.getTime() + ON_CALL_RETRY_MS) };
  if (answeredToday >= perDay) return { ok: false, reason: "he was already called today", retryAt: nextDayWindow(at, w) };
  if (!inWindow(at, w)) return { ok: false, reason: "outside his call times", retryAt: nextInWindow(at, w) };
  return { ok: true };
}

/** When to try again after the n-th failed try (n from 1), inside his window; null = give up. */
export function retryAt(n, user, at = new Date()) {
  const w = { window: user?.callWindow, tz: user?.timezone || "Europe/Berlin" };
  if (n >= MAX_ATTEMPTS) return null;
  if (n <= RETRY_MS.length) return nextInWindow(new Date(at.getTime() + RETRY_MS[n - 1]), w);
  return nextDayWindow(at, w);
}

const json = v => JSON.stringify(v ?? null);

export function createScheduler({ memory, carrier, requests = null, log = () => {}, monitor = null, now = () => new Date(), perDay = Number(process.env.OUTBOUND_PER_DAY || 1) }) {
  const db = memory.db;
  const note = (job, text) => db.query("update outbound_calls set log = log || $2::jsonb, updated_at = now() where id = $1", [job.id, json([{ at: now().toISOString(), text }])]);
  const say = text => { log(`outbound: ${text}`); monitor?.system(`outbound: ${text}`); };

  /** Pending outbound objectives without a job get one per user. */
  async function sync() {
    const free = await db.query(`select o.id, o.user_id, o.org_id from objectives o
      where o.status = 'pending' and o.mode in ('outbound', 'either') and o.user_id is not null
        and (o.not_before is null or o.not_before <= now())
        and not exists (select 1 from outbound_calls j where o.id = any(j.objective_ids) and j.status in ('queued', 'dialing', 'in_call'))`);
    const byUser = new Map();
    for (const o of free) byUser.set(o.user_id, [...(byUser.get(o.user_id) ?? []), o]);
    const created = [];
    for (const [userId, list] of byUser) {
      const [job] = await db.query("insert into outbound_calls (id, org_id, user_id, objective_ids, max_attempts, next_attempt_at) values ($1, $2, $3, $4, $5, $6) returning *",
        [`job_${randomUUID().slice(0, 8)}`, list[0].org_id, userId, list.map(o => o.id), MAX_ATTEMPTS, now().toISOString()]);
      created.push(job);
      say(`job ${job.id} for ${list.map(o => o.id).join(", ")}`);
    }
    return created;
  }

  // The errand couldn't be done by calling: his next inbound call asks instead, and Max hears why.
  async function fallBack(job, why) {
    for (const id of job.objective_ids) {
      await memory.objectives.toNextInbound(id);
      await requests?.note(id, `${why} It'll be asked in his next call instead.`);
    }
    say(`job ${job.id}: ${why} → next inbound call`);
  }
  async function finish(job, status, outcome, why) {
    await db.query("update outbound_calls set status = $2, outcome = $3, updated_at = now() where id = $1", [job.id, status, outcome]);
    await note(job, why ?? outcome);
  }
  async function attemptFailed(job, outcome) {
    const user = await memory.getUser(job.user_id);
    const next = retryAt(job.attempts, user, now());
    if (!next) {
      await finish(job, "failed", outcome, `gave up after ${job.attempts} tries (last: ${outcome})`);
      return fallBack(job, `Couldn't reach ${user?.name ?? "him"} by phone (${job.attempts} tries, last: ${outcome}).`);
    }
    await db.query("update outbound_calls set status = 'queued', outcome = $2, next_attempt_at = $3, updated_at = now() where id = $1", [job.id, outcome, next.toISOString()]);
    await note(job, `try ${job.attempts}: ${outcome}; next try ${next.toISOString()}`);
  }

  async function answeredToday(user, at) {
    const midnight = zonedTime(localParts(at, user.timezone || "Europe/Berlin").date, "00:00", user.timezone || "Europe/Berlin");
    // Calls he actually took: a voicemail doesn't count.
    return (await db.query("select count(*)::int n from calls where user_id = $1 and direction = 'outbound' and started_at >= $2 and coalesce(ended_reason, '') <> 'voicemail'", [user.id, midnight.toISOString()]))[0].n;
  }

  /** One step: new jobs, stuck ones back in the queue, and at most one call placed. */
  async function tick() {
    await sync();
    for (const j of await db.query("update outbound_calls set status = 'queued', updated_at = now() where status = 'dialing' and updated_at < now() - make_interval(secs => $1) returning *", [STUCK_MS / 1000])) {
      await note(j, "no word from the carrier; trying again");
    }
    // Answered, but no call ever came through: a failed try. (One that did gets its outcome from its after-call step.)
    for (const j of await db.query("select * from outbound_calls where status = 'in_call' and updated_at < now() - interval '20 minutes'")) {
      if (!(await memory.callExists(j.call_id))) await attemptFailed(j, "the call never came through");
    }
    const [job] = await db.query(`update outbound_calls set status = 'dialing', attempts = attempts + 1, updated_at = now()
      where id = (select id from outbound_calls where status = 'queued' and next_attempt_at <= $1 order by next_attempt_at limit 1 for update skip locked)
      returning *`, [now().toISOString()]);
    if (!job) return null;
    const user = await memory.getUser(job.user_id);
    const guard = outboundGuard(user, { at: now(), onCall: Boolean(user && (await memory.userOnCall(user.id))), answeredToday: user ? await answeredToday(user, now()) : 0, perDay });
    if (!guard.ok) {
      if (guard.final) {
        await finish(job, "failed", "not allowed", guard.reason);
        await fallBack(job, `Can't call ${user?.name ?? "him"}: ${guard.reason}.`);
        return { job, skipped: guard.reason };
      }
      // Not now: back in the queue, and this doesn't count as a try.
      await db.query("update outbound_calls set status = 'queued', attempts = attempts - 1, next_attempt_at = $2, updated_at = now() where id = $1", [job.id, guard.retryAt.toISOString()]);
      await note(job, `not now (${guard.reason}); next ${guard.retryAt.toISOString()}`);
      return { job, deferred: guard.reason, until: guard.retryAt };
    }
    try {
      const placed = await carrier.dialOut({ to: user.phone, userId: user.id, jobId: job.id });
      await db.query("update outbound_calls set call_id = $2, carrier = $3, updated_at = now() where id = $1", [job.id, placed.callId, placed.carrier]);
      await note(job, `try ${job.attempts}: calling ${user.name} (${placed.carrier} ${placed.callId})`);
      say(`calling ${user.name} for job ${job.id} (try ${job.attempts})`);
      return { job, callId: placed.callId };
    } catch (err) {
      await attemptFailed({ ...job }, `the call couldn't be placed: ${err.message}`);
      return { job, error: err.message };
    }
  }

  const jobOf = async callId => (callId ? (await db.query("select * from outbound_calls where call_id = $1 order by updated_at desc limit 1", [callId]))[0] ?? null : null);

  return {
    tick,
    sync,

    /** The carrier's word on a call: nobody picked up (no-answer, busy, failed, canceled), or it was answered. */
    async callStatus({ callId, status }) {
      const job = await jobOf(callId);
      if (!job || !["dialing", "in_call"].includes(job.status)) return;
      if (["in-progress", "answered"].includes(status)) {
        await db.query("update outbound_calls set status = 'in_call', outcome = 'answered', updated_at = now() where id = $1", [job.id]);
        return;
      }
      if (job.status === "dialing" && ["no-answer", "busy", "failed", "canceled"].includes(status)) await attemptFailed(job, status);
    },

    /** An answered outbound call ended. outcome: { consent: yes|no|later|never|unknown, callbackWhen } from the call's notes. */
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
        const w = { window: user?.callWindow, tz: user?.timezone || "Europe/Berlin" };
        const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(outcome.callbackWhen ?? "");
        const asked = m ? zonedTime(m[1], m[2], w.tz) : null; // his wall clock, not the server's
        const when = nextInWindow(asked && asked > now() ? asked : nextDayWindow(now(), w), w);
        await db.query("update outbound_calls set status = 'queued', outcome = 'later', attempts = greatest(attempts - 1, 0), next_attempt_at = $2, updated_at = now() where id = $1", [job.id, when.toISOString()]);
        return note(job, `he asked to be called later; next try ${when.toISOString()}`);
      }
      return attemptFailed(job, reason === "caller_hangup" ? "hung up before it was done" : `ended (${reason}) before it was done`);
    },

    async list({ limit = 50 } = {}) {
      return db.query("select j.*, u.name user_name from outbound_calls j join users u on u.id = j.user_id order by j.created_at desc limit $1", [limit]);
    },
    async cancelFor(objectiveId) {
      await db.query("update outbound_calls set status = 'cancelled', updated_at = now() where $1 = any(objective_ids) and status in ('queued', 'dialing')", [objectiveId]);
    },
  };
}
