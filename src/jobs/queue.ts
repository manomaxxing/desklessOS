// The job queue: all background work, as rows in Postgres (table jobs).
//   enqueue(kind, payload, { key })   idempotent by key: the same key twice is one job
//   run({ handlers, budgetMs })       claims due jobs one by one (FOR UPDATE SKIP LOCKED, so
//                                     any number of instances can run it) until none is due or
//                                     the time budget is spent
// At least once: a handler can run twice (a crash after its work, before "done"), so every
// handler is idempotent. A failure is retried with backoff; after max_attempts the job is
// "dead" and stays for a human (the admin page lists it). A running job holds a lease, renewed
// while its handler works, so a worker that died mid-job doesn't block it for long, and a slow
// one isn't run a second time beside it. Each claim counts as a try (a job that takes its worker
// down with it dies after max_attempts too), and its try number fences the result: a worker that
// lost its lease can't overwrite what the job's newer run wrote.

import { randomUUID } from "node:crypto";
import type { Db, Queryable } from "../db/client.ts";
import type { JobRow } from "../types/jobs.ts";
import type { Log } from "../types/common.ts";

const BACKOFF_S = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600]; // after the 1st, 2nd, … failure
const LEASE_S = 5 * 60;
const json = (v: unknown): string => JSON.stringify(v ?? null);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A job's payload as stored (jsonb): handlers check the fields they need. */
export type JobPayload = Record<string, unknown>;
export type JobHandler = (payload: JobPayload, job: JobRow) => Promise<unknown>;
export type JobHandlers = Record<string, JobHandler>;

export interface EnqueueOptions {
  key?: string;
  runAt?: string | null;
  maxAttempts?: number;
  /** A transaction to enqueue in. */
  q?: Queryable;
}

/** What the admin page lists. */
export type JobListing = Pick<JobRow, "id" | "kind" | "key" | "status" | "attempts" | "max_attempts" | "run_at" | "last_error" | "created_at" | "updated_at">;

export interface Queue {
  enqueue(kind: string, payload?: JobPayload, options?: EnqueueOptions): Promise<void>;
  run(options: { handlers: JobHandlers; budgetMs?: number }): Promise<{ done: number; failed: number }>;
  list(options?: { limit?: number }): Promise<JobListing[]>;
  prune(options?: { days?: number }): Promise<void>;
}

/** `leaseS`: how long a claim holds a job (renewed every third of it while the handler runs). */
export function createQueue({ db, log = () => {}, leaseS = LEASE_S }: { db: Pick<Db, "query">; log?: Log; leaseS?: number }): Queue {
  // A job whose worker died on its last try is dead, not run again (its lease ran out with no result).
  async function buryLost(): Promise<void> {
    const dead = await db.query<Pick<JobRow, "kind" | "key" | "attempts">>(`update jobs set status = 'dead', locked_until = null, updated_at = now(),
        last_error = left('its worker stopped mid-job on every try (crash or timeout)' || coalesce(': ' || last_error, ''), 500)
      where status = 'running' and locked_until < now() and attempts >= max_attempts returning kind, key, attempts`);
    for (const j of dead) log(`job ${j.kind} ${j.key} given up: its worker stopped mid-job (try ${j.attempts})`);
  }

  async function claim(): Promise<JobRow | null> {
    const [job] = await db.query<JobRow>(`update jobs set status = 'running', attempts = attempts + 1, locked_until = now() + make_interval(secs => $1), updated_at = now()
      where id = (select id from jobs where (status = 'queued' and run_at <= now()) or (status = 'running' and locked_until < now() and attempts < max_attempts)
        order by run_at limit 1 for update skip locked)
      returning *`, [leaseS]);
    return job ?? null;
  }

  // Only while this run still holds the job: its try number is the fence.
  const MINE = "id = $1 and attempts = $2 and status = 'running'";

  /** Keeps the job's lease while its handler works; stops when told, or once the job is no longer ours. */
  function keepLease(job: JobRow): () => void {
    const timer = setInterval(() => {
      db.query(`update jobs set locked_until = now() + make_interval(secs => $3), updated_at = now() where ${MINE} returning id`, [job.id, job.attempts, leaseS])
        .then(rows => { if (!rows.length) { clearInterval(timer); log(`job ${job.kind} ${job.key}: its lease was taken over; this run's result won't count`); } })
        .catch((err: unknown) => log(`job ${job.kind} ${job.key}: lease not renewed: ${errText(err)}`));
    }, (leaseS * 1000) / 3);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async function finish(job: JobRow, err: unknown = null): Promise<void> {
    if (!err) {
      const done = await db.query(`update jobs set status = 'done', locked_until = null, last_error = null, updated_at = now() where ${MINE} returning id`, [job.id, job.attempts]);
      if (!done.length) log(`job ${job.kind} ${job.key}: done, but another run holds it now; left to that one`);
      return;
    }
    const dead = job.attempts >= job.max_attempts;
    const wait = BACKOFF_S[Math.min(job.attempts, BACKOFF_S.length) - 1];
    const failed = await db.query(`update jobs set status = $3, run_at = now() + make_interval(secs => $4), locked_until = null, last_error = $5, updated_at = now() where ${MINE} returning id`,
      [job.id, job.attempts, dead ? "dead" : "queued", dead ? 0 : wait, errText(err).slice(0, 500)]);
    log(`job ${job.kind} ${job.key} failed (try ${job.attempts}/${job.max_attempts})${!failed.length ? "; another run holds it now" : dead ? ", given up" : `, again in ${wait} s`}: ${errText(err)}`);
  }

  return {
    async enqueue(kind, payload = {}, { key = `${kind}:${randomUUID()}`, runAt = null, maxAttempts = 5, q = db } = {}) {
      await q.query("insert into jobs (kind, key, payload, run_at, max_attempts) values ($1, $2, $3, coalesce($4::timestamptz, now()), $5) on conflict (key) do nothing",
        [kind, key, json(payload), runAt, maxAttempts]);
    },

    /** Runs due jobs until none is left or `budgetMs` is spent. Returns { done, failed }. */
    async run({ handlers, budgetMs = 45000 }) {
      const until = Date.now() + budgetMs;
      const out = { done: 0, failed: 0 };
      await buryLost();
      while (Date.now() < until) {
        const job = await claim();
        if (!job) break;
        const handler = handlers[job.kind];
        const stopLease = keepLease(job);
        let error: unknown = null;
        try {
          if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
          await handler(job.payload, job);
        } catch (err) {
          error = err ?? new Error("failed");
        } finally {
          stopLease();
        }
        await finish(job, error);
        if (error) out.failed++;
        else out.done++;
      }
      return out;
    },

    /** The queue as the admin page shows it: what's waiting, running or dead, newest first. */
    async list({ limit = 50 } = {}) {
      return db.query<JobListing>("select id, kind, key, status, attempts, max_attempts, run_at, last_error, created_at, updated_at from jobs where status <> 'done' or updated_at > now() - interval '1 day' order by created_at desc limit $1", [limit]);
    },

    /** Done jobs are history: kept a while, then dropped. */
    async prune({ days = 14 } = {}) {
      await db.query("delete from jobs where status = 'done' and updated_at < now() - make_interval(days => $1)", [days]);
    },
  };
}
