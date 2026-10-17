// The cascade engine's timing (src/engine/session.ts): how long a pause ends his turn, when the
// agent nudges, hedges, gives up. Most are tuned on real calls; the env overrides are for tuning
// runs (scripts/eval.ts), not for production.

import type { Clock, Next } from "../types/common.ts";

/** A number from the environment; the default when unset, empty or not a number. */
export function envMs(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Short end-of-turn waits are safe because the model answers NEXT: wait when he
// paused mid-thought; then we stay silent and keep collecting his audio. Only a
// yes/no question (confirm) skips that check; an open question (ask) keeps it.
export const END_SILENCE: Readonly<Record<Next, number>> = { listen: 800, ask: 1000, wait: 800, confirm: 600, hangup: 600 };
export const START_MS: Readonly<Record<Next, number>> = { listen: 200, ask: 200, wait: 200, confirm: 120, hangup: 200 }; // a crisp "Passt." is ~160 ms voiced
// After a "wait", if he stays quiet: a soft "mhm" (he keeps the floor), then the
// answer, both counted from his last word. The answer is prepared right away and held,
// so it plays at once when the time is up (not one model round trip later); if he goes
// on, it's dropped unheard. "Moment" / "warte mal" holds the floor much longer, without the "mhm".
export const WAIT_MHM_MS = 2500;
export const WAIT_DONE_MS = 5000;
export const HOLD_MS = 15000;
// He talks again right after the agent started: he wasn't done. Stop on a shorter
// burst of speech, forget the reply, and answer both parts as one thought.
export const FALSE_START_MS = 1500;
export const FALSE_START_INTERRUPT_MS = 300;
// Thinking at the pause: SPECULATE_MS of silence inside his utterance starts the answer, held
// unheard; if the silence reaches the end of his turn it plays at once (a model round trip
// sooner), if he goes on it's dropped. At most SPECULATE_MAX per utterance (each costs a call).
export const SPECULATE_MS = envMs("SPECULATE_MS", 350);
export const SPECULATE_MAX = envMs("SPECULATE_MAX", 2);
// More unanswered audio than this: answer now, whatever the model thinks of his pause.
export const MAX_PENDING_MS = 60000;
export const FILLER_AFTER_MS = 700;
export const TYPING_AFTER_MS = 250; // typing starts almost at once, like someone writing it down
// No first token by HEDGE_MS (a healthy turn's p90 is ~1.7 s; Gemini stalls on ~30% of turns,
// independent of the prompt): race the same model again. Still nothing by HEDGE_FALLBACK_MS: the
// fallback model joins (faster, but it mishears more; stalls often hit the same model twice, so
// it isn't kept waiting long).
export const HEDGE_MS = envMs("HEDGE_MS", 1600);
export const HEDGE_FALLBACK_MS = envMs("HEDGE_FALLBACK_MS", 2600);
export const TURN_DEADLINE_MS = 12000; // give up and say sorry
// The answer started, then nothing more for this long: it stalled mid-answer (the fetch alone would
// wait 30 s). What was said stays; he hears a sorry.
export const STREAM_IDLE_MS = envMs("STREAM_IDLE_MS", 4000);
// He says nothing after the agent finished: a nudge after this long (0: none; after a wait or a bye, none).
export const IDLE_MS: Readonly<Record<Next, number>> = { listen: 9000, ask: 10000, confirm: 7000, wait: 0, hangup: 0 };
// After a reply that only reacted ("Mhm.", "Verstehe."): her next words are prepared at once.
// A breath of silence and they play; if he goes on, they're dropped unheard. A question that's
// due isn't this path: it belongs in the same reply as the reaction, so there's no hole at all.
export const REACTION_BEAT_MS = 400;
export const INTERRUPT_MS = envMs("INTERRUPT_MIN_MS", 500); // loud speech needed to cut the agent off
// While the greeting plays, a "Hallo?" said over it (people do, the moment a call connects) mustn't
// cut it off; only a longer stretch of speech does.
export const GREETING_INTERRUPT_MS = envMs("GREETING_INTERRUPT_MS", 1200);
// A call the agent made: it greets after his "Hallo?", or after this much silence.
export const OUTBOUND_GREET_MS = 1500;
// His first words run this long without a pause: that's a voicemail greeting, not him.
export const VOICEMAIL_MS = envMs("VOICEMAIL_MS", 4000);
// Smart Turn's "not done" counts from this much of his speech on (short answers fooled it).
export const SMART_TURN_MIN_MS = 1200;
// The end of a call waits this long at most for an answer the hang-up cut off.
export const CUT_OFF_GRACE_MS = 1500;
// The time limit's wrap-up: the call ends this long after it played, bye mark or not.
export const WRAP_UP_GRACE_MS = 3000;
// A tool's preface waits this long at most for the answer's first audio before a write runs.
export const PREFACE_WAIT_MS = 4000;

/** The pause that ends his next utterance, after an answer with this NEXT. */
export const endSilenceFor = (n: Next | null | undefined): number => END_SILENCE[n ?? "listen"] ?? END_SILENCE.listen;
export const startMsFor = (n: Next | null | undefined): number => START_MS[n ?? "listen"] ?? START_MS.listen;
export const idleMsFor = (n: Next | null | undefined): number => IDLE_MS[n ?? "listen"] ?? IDLE_MS.listen;

/** Real time (the tests run calls on a fake clock: test/session.test.ts). */
export const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id ?? undefined),
};
