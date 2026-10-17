// Polling that's kind to a server billed per request: one run at a time, nothing while the
// page is hidden (one run as soon as it's shown again), and the latest run wins: now()
// aborts the run in flight, so an older answer can never land on top of a newer one.

import { isAbort } from "./api.ts";

export interface Poller {
  /** Run now (after the user changed something): aborts the run in flight. */
  now(): Promise<void>;
  stop(): void;
}

/**
 * fn gets the run's signal: pass it to getJson, and nothing is drawn from an aborted run
 * (getJson throws). every: ms until the next run after one ended, or null for none (the
 * view has nothing that changes by itself); read after every run, so it can follow state.
 * fn shows its own errors; poll() only keeps going.
 */
export function poll(fn: (signal: AbortSignal) => Promise<void>, every: number | null | (() => number | null), { immediate = true } = {}): Poller {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current: AbortController | null = null;
  let stopped = false;
  const interval = () => (typeof every === "function" ? every() : every);

  function schedule(): void {
    clearTimeout(timer);
    const ms = interval();
    if (!stopped && !document.hidden && ms != null) timer = setTimeout(run, ms);
  }
  async function run(): Promise<void> {
    if (stopped) return;
    clearTimeout(timer);
    current?.abort();
    const ctl = new AbortController();
    current = ctl;
    try { await fn(ctl.signal); } catch (err) {
      if (!isAbort(err)) console.debug("poll:", err); // fn shows what the user needs to see
    } finally {
      if (current === ctl) { current = null; schedule(); }
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(timer);
    else if (!current) void run();
  });
  if (immediate) void run();
  else schedule();
  return {
    now: run,
    stop() { stopped = true; clearTimeout(timer); current?.abort(); current = null; },
  };
}

/** The latest of several overlapping requests: start() aborts the one before. */
export function latest(): { start(): AbortSignal; abort(): void } {
  let ctl: AbortController | null = null;
  return {
    start() { ctl?.abort(); ctl = new AbortController(); return ctl.signal; },
    abort() { ctl?.abort(); ctl = null; },
  };
}
