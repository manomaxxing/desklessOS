// Gemini hangs or errors now and then. Hedged requests (Dean & Barroso's "tail at scale"):
// if the main model hasn't produced a token after HEDGE_MS, the same request goes out again
// (a stall is the server's, not the prompt's: a second try usually lands elsewhere); after
// HEDGE_FALLBACK_MS the backup model joins. A failure before the first token tries the backup.
// The first to speak wins and the others are cancelled. Words are never repeated (losers are
// dropped before any of their text is used), and only the winner's tool calls are ever run.

import type { Clock, TimerHandle } from "../types/common.ts";
import type { Endpoint, StreamEvent, Usage } from "../types/gemini.ts";
import { streamTurn, type StreamTurnArgs } from "./gemini.ts";
import { HEDGE_MS, HEDGE_FALLBACK_MS, STREAM_IDLE_MS, TURN_DEADLINE_MS } from "./timing.ts";
import { errorMessage } from "./telemetry.ts";

/** streamTurn's arguments without what the hedge sets itself (model, endpoint, signal, usage). */
export type TurnRequest = Omit<StreamTurnArgs, "endpoint" | "model" | "signal" | "onUsage">;
/** The winning model rides on the final event. */
export type HedgedEvent = StreamEvent | (Extract<StreamEvent, { type: "end" }> & { model: string });

export interface HedgeTiming {
  hedgeMs: number;
  fallbackMs: number;
  idleMs: number;
  deadlineMs: number;
}
const DEFAULT_TIMING: HedgeTiming = { hedgeMs: HEDGE_MS, fallbackMs: HEDGE_FALLBACK_MS, idleMs: STREAM_IDLE_MS, deadlineMs: TURN_DEADLINE_MS };
const MAX_ATTEMPTS = 4;
const POLL_MS = 250;

export interface HedgeOptions {
  endpoint: Endpoint;
  clock: Clock;
  /** A model call's usage, per attempt (losers cost too). */
  onUsage: (usage: Usage, model: string, turnId: number) => void;
  /** retry (an attempt joined) and recovered (a hedge won) events. */
  debug: (event: string, data: Record<string, unknown>) => void;
  timing?: Partial<HedgeTiming>;
  /** The stream itself (tests pass a fake). */
  stream?: (args: StreamTurnArgs) => AsyncIterable<StreamEvent>;
}

interface Attempt {
  model: string;
  ctl: AbortController;
  events: StreamEvent[];
  done: boolean;
  error: unknown;
}

/**
 * `request`: the streamTurn args, or a function model → args (the tool follow-up differs per
 * model). The final "end" event carries the winning model.
 */
export function createHedgedStream({ endpoint, clock, onUsage, debug, timing = {}, stream = streamTurn }: HedgeOptions) {
  const t = { ...DEFAULT_TIMING, ...timing };

  return async function* hedged(request: TurnRequest | ((model: string) => TurnRequest), signal: AbortSignal, turnId: number, { primary, backup }: { primary: string; backup: string | null }): AsyncGenerator<HedgedEvent, void, undefined> {
    const argsFor = typeof request === "function" ? request : () => request;
    const attempts: Attempt[] = [];
    let wake: (() => void) | null = null;
    const notify = () => { const w = wake; wake = null; w?.(); };
    const nap = () => new Promise<void>(resolve => { wake = resolve; clock.setTimeout(resolve, POLL_MS); });
    const spoke = (a: Attempt) => a.events.some(e => e.type !== "end");
    const winner = () => attempts.find(spoke);

    const launch = (model: string, why?: string) => {
      const att: Attempt = { model, ctl: new AbortController(), events: [], done: false, error: null };
      attempts.push(att);
      if (why) debug("retry", { turn: turnId, reason: why, next: model });
      void (async () => {
        try {
          for await (const ev of stream({ ...argsFor(model), endpoint, model, onUsage: u => onUsage(u, model, turnId), signal: AbortSignal.any([signal, att.ctl.signal]) })) {
            att.events.push(ev);
            notify();
          }
        } catch (err) {
          att.error = err;
        } finally {
          att.done = true;
          notify();
        }
      })();
      return att;
    };

    const started = clock.now();
    const timers: TimerHandle[] = [];
    launch(primary);
    timers.push(clock.setTimeout(() => { if (!winner()) launch(primary, `no first token after ${t.hedgeMs} ms`); notify(); }, t.hedgeMs));
    if (backup && backup !== primary) timers.push(clock.setTimeout(() => { if (!winner()) launch(backup, `no first token after ${t.fallbackMs} ms`); notify(); }, t.fallbackMs));
    const clearTimers = () => { for (const h of timers.splice(0)) clock.clearTimeout(h); };

    try {
      let w: Attempt | undefined;
      while (!(w = winner())) {
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        const failed = attempts.filter(a => a.done && !spoke(a));
        if (failed.length === attempts.length) {
          // Everyone failed before a token: one more model, then give up.
          const last = failed.at(-1);
          const tried = new Set(attempts.map(a => a.model));
          const next = backup && !tried.has(backup) ? backup : attempts.length < MAX_ATTEMPTS ? primary : null;
          if (!next || clock.now() - started > t.deadlineMs) throw last?.error ?? new Error("all models failed");
          launch(next, last?.error ? errorMessage(last.error).slice(0, 160) : "empty answer");
          continue;
        }
        if (clock.now() - started > t.deadlineMs) throw new Error(`no answer after ${t.deadlineMs} ms`);
        await nap();
      }
      clearTimers();
      for (const a of attempts) if (a !== w) a.ctl.abort();
      if (w.model !== primary || attempts.length > 1) debug("recovered", { turn: turnId, model: w.model, attempt: attempts.indexOf(w) + 1 });
      let i = 0;
      let lastEventAt = clock.now();
      for (;;) {
        while (i < w.events.length) {
          lastEventAt = clock.now();
          const ev = w.events[i++]!;
          yield ev.type === "end" ? { ...ev, model: w.model } : ev;
        }
        if (w.done) {
          if (w.error && !signal.aborted) throw w.error;
          return;
        }
        if (clock.now() - lastEventAt > t.idleMs) {
          w.ctl.abort();
          throw new Error(`the answer stalled: nothing for ${t.idleMs} ms`);
        }
        await nap();
      }
    } finally {
      clearTimers();
      for (const a of attempts) if (!a.done) a.ctl.abort();
    }
  };
}
export type HedgedStream = ReturnType<typeof createHedgedStream>;
