// Everything that runs outside a call, in one tick:
//   1. calls whose instance died mid-call → ended, after-call job queued
//   2. due jobs: after-call steps, notifications (src/jobs/queue.ts)
//   3. outbound calls: at most one placed per tick (src/jobs/scheduler.ts)
//   4. embeddings for new notes and facts; old done jobs pruned
// Two ways to drive it (BACKGROUND):
//   inline  a timer in this process (local runs, a VM): tick every TICK_MS, and right after a call
//   http    POST /internal/tick (X-Tick-Token: TICK_TOKEN) from Cloud Scheduler every minute,
//           and from the instance that just ended a call. On Cloud Run the CPU only runs while
//           a request is open, so all background work happens inside one; the scheduler's
//           minute tick also keeps an instance warm and the database awake.

import type { Queue, JobHandlers } from "./queue.ts";
import type { Log } from "../types/common.ts";

const KICK_TIMEOUT_MS = 5 * 60 * 1000; // a job slowed by Gemini retries can take minutes; same as the job's lease
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What the scheduler's tick says it did (src/jobs/scheduler.ts). */
interface OutboundStep {
  callId?: string;
  deferred?: string;
  skipped?: string;
  error?: string;
}

export interface TickResult {
  ms: number;
  lost: number;
  jobs: { done: number; failed: number };
  outbound: string | null;
}

export interface Background {
  mode: string;
  tick(): Promise<TickResult>;
  /** Something is due now (a call just ended): run a tick soon, where it gets CPU. */
  kick(): void;
  /** Starts the inline timer; returns how to stop it. */
  start(): () => void;
}

export function createBackground({ queue, handlers, memory, scheduler = () => null, mode = "inline", publicUrl = "", token = "", intervalMs = 30000, budgetMs = 45000, log = () => {} }: {
  queue: Pick<Queue, "run" | "prune">;
  handlers: JobHandlers;
  memory: { sweepLostCalls(): Promise<string[]>; embedPending?(): Promise<unknown> | null };
  /** The scheduler, if outbound calls are on (read on every tick: it's made after this). */
  scheduler?: () => { tick(): Promise<OutboundStep | null> } | null;
  mode?: string;
  publicUrl?: string;
  token?: string;
  intervalMs?: number;
  budgetMs?: number;
  log?: Log;
}): Background {
  let running: Promise<TickResult> | null = null;
  let lastPrune = 0;
  let stopped = false;

  async function work(): Promise<TickResult> {
    const started = Date.now();
    const lost = await memory.sweepLostCalls();
    if (lost.length) log(`calls lost with their instance, ending them: ${lost.join(", ")}`);
    const jobs = await queue.run({ handlers, budgetMs });
    const outbound = await scheduler()?.tick();
    await memory.embedPending?.();
    if (Date.now() - lastPrune > 6 * 3600 * 1000) { lastPrune = Date.now(); await queue.prune(); }
    return { ms: Date.now() - started, lost: lost.length, jobs, outbound: outbound ? (outbound.callId ?? outbound.deferred ?? outbound.skipped ?? outbound.error ?? null) : null };
  }

  /** One tick at a time per instance; a second caller waits for the running one. */
  function tick(): Promise<TickResult> {
    running ??= work().finally(() => { running = null; });
    return running;
  }
  const tickNow = () => { if (!stopped) tick().catch((err: unknown) => log("background error", errText(err))); };

  return {
    mode,
    tick,
    kick() {
      if (mode !== "http") { tickNow(); return; }
      if (!publicUrl) return; // the scheduler's next tick picks it up
      // Held open until the tick is done: on Cloud Run the job only has CPU while this request is open.
      fetch(`${publicUrl}/internal/tick`, { method: "POST", headers: { "x-tick-token": token }, signal: AbortSignal.timeout(KICK_TIMEOUT_MS) })
        .then(res => { if (!res.ok) log(`kick: tick answered ${res.status}`); })
        .catch((err: unknown) => log("kick failed (the scheduler's next tick picks it up):", errText(err)));
    },
    start() {
      if (mode !== "inline") return () => {};
      const timer = setInterval(tickNow, intervalMs);
      timer.unref?.();
      const first = setTimeout(tickNow, 2000);
      first.unref?.();
      // Stopped (SIGTERM): neither timer starts another tick.
      return () => { stopped = true; clearInterval(timer); clearTimeout(first); };
    },
  };
}
