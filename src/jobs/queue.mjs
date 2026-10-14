// The job queue: all background work, as rows in Postgres (table jobs).
//   enqueue(kind, payload, { key })   idempotent by key: the same key twice is one job
//   run({ handlers, budgetMs })       claims due jobs one by one (FOR UPDATE SKIP LOCKED, so
//                                     any number of instances can run it) until none is due or
//                                     the time budget is spent
// At least once: a handler can run twice (a crash after its work, before "done"), so every
// handler is idempotent. A failure is retried with backoff; after max_attempts the job is
// "dead" and stays for a human (the admin page lists it). A running job holds a lease, so a
// worker that died mid-job doesn't block it for long.

import { randomUUID } from "node:crypto";

const BACKOFF_S = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600]; // after the 1st, 2nd, … failure
const LEASE_S = 5 * 60;
const json = v => JSON.stringify(v ?? null);

export function createQueue({ db, log = () => {} }) {
  async function claim() {
    const [job] = await db.query(`update jobs set status = 'running', attempts = attempts + 1, locked_until = now() + make_interval(secs => $1), updated_at = now()
      where id = (select id from jobs where (status = 'queued' and run_at <= now()) or (status = 'running' and locked_until < now())
        order by run_at limit 1 for update skip locked)
      returning *`, [LEASE_S]);
    return job ?? null;
  }

  async function finish(job, err) {
    if (!err) return db.query("update jobs set status = 'done', locked_until = null, last_error = null, updated_at = now() where id = $1", [job.id]);
    const dead = job.attempts >= job.max_attempts;
    const wait = BACKOFF_S[Math.min(job.attempts, BACKOFF_S.length) - 1];
    await db.query(`update jobs set status = $2, run_at = now() + make_interval(secs => $3), locked_until = null, last_error = $4, updated_at = now() where id = $1`,
      [job.id, dead ? "dead" : "queued", dead ? 0 : wait, String(err?.message ?? err).slice(0, 500)]);
    log(`job ${job.kind} ${job.key} failed (try ${job.attempts}/${job.max_attempts})${dead ? ", given up" : `, again in ${wait} s`}: ${err?.message ?? err}`);
  }

  return {
    /** Adds a job (or nothing, if one with this key exists). `q`: a transaction to enqueue in. */
    async enqueue(kind, payload = {}, { key = `${kind}:${randomUUID()}`, runAt = null, maxAttempts = 5, q = db } = {}) {
      await q.query("insert into jobs (kind, key, payload, run_at, max_attempts) values ($1, $2, $3, coalesce($4::timestamptz, now()), $5) on conflict (key) do nothing",
        [kind, key, json(payload), runAt, maxAttempts]);
    },

    /** Runs due jobs until none is left or `budgetMs` is spent. Returns { done, failed }. */
    async run({ handlers, budgetMs = 45000 }) {
      const until = Date.now() + budgetMs;
      const out = { done: 0, failed: 0 };
      while (Date.now() < until) {
        const job = await claim();
        if (!job) break;
        const handler = handlers[job.kind];
        try {
          if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
          await handler(job.payload, job);
          await finish(job);
          out.done++;
        } catch (err) {
          await finish(job, err);
          out.failed++;
        }
      }
      return out;
    },

    /** The queue as the admin page shows it: what's waiting, running or dead, newest first. */
    async list({ limit = 50 } = {}) {
      return db.query("select id, kind, key, status, attempts, max_attempts, run_at, last_error, created_at, updated_at from jobs where status <> 'done' or updated_at > now() - interval '1 day' order by created_at desc limit $1", [limit]);
    },

    /** Done jobs are history: kept a while, then dropped. */
    async prune({ days = 14 } = {}) {
      await db.query("delete from jobs where status = 'done' and updated_at < now() - make_interval(days => $1)", [days]);
    },
  };
}
