// Everything that runs outside a call, in one tick:
//   1. calls whose instance died mid-call → ended, after-call job queued
//   2. due jobs: after-call steps, notifications (src/jobs/queue.mjs)
//   3. outbound calls: at most one placed per tick (src/jobs/scheduler.mjs)
//   4. embeddings for new notes and facts; old done jobs pruned
// Two ways to drive it (BACKGROUND):
//   inline  a timer in this process (local runs, a VM): tick every TICK_MS, and right after a call
//   http    POST /internal/tick (X-Tick-Token: TICK_TOKEN) from Cloud Scheduler every minute,
//           and from the instance that just ended a call. On Cloud Run the CPU only runs while
//           a request is open, so all background work happens inside one; the scheduler's
//           minute tick also keeps an instance warm and the database awake.

export function createBackground({ queue, handlers, memory, scheduler = () => null, mode = "inline", publicUrl = "", token = "", intervalMs = 30000, budgetMs = 45000, log = () => {} }) {
  let running = null;
  let lastPrune = 0;
  let stopped = false;

  async function work() {
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
  function tick() {
    running ??= work().finally(() => { running = null; });
    return running;
  }

  return {
    mode,
    tick,
    /** Something is due now (a call just ended): run a tick soon, where it gets CPU. */
    kick() {
      if (mode !== "http") { if (!stopped) tick().catch(err => log("background error", err.message)); return; }
      if (!publicUrl) return; // the scheduler's next tick picks it up
      fetch(`${publicUrl}/internal/tick`, { method: "POST", headers: { "x-tick-token": token }, signal: AbortSignal.timeout(budgetMs + 15000) })
        .then(res => { if (!res.ok) log(`kick: tick answered ${res.status}`); })
        .catch(err => log("kick failed (the scheduler's next tick picks it up):", err.message));
    },
    start() {
      if (mode !== "inline") return () => {};
      const timer = setInterval(() => tick().catch(err => log("background error", err.message)), intervalMs);
      timer.unref?.();
      setTimeout(() => tick().catch(err => log("background error", err.message)), 2000).unref?.();
      return () => { stopped = true; clearInterval(timer); };
    },
  };
}
