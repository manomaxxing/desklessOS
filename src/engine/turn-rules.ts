// The cascade engine's small decisions about a turn, as pure functions (src/engine/session.ts
// applies them): is he done, is a sentence meant to be spoken, is the agent repeating itself.

import type { Next } from "../types/common.ts";
import type { Lexicon } from "../types/locale.ts";
import type { TurnEnd } from "./turn-detector.ts";
import { dangling } from "./endpointing.ts";
import { SMART_TURN_MIN_MS } from "./timing.ts";

const STAGE_DIRECTION = /^\s*[[(][^\])]*[\])]\s*$/;
/** "[Silence]", "(wartet)": never read out loud. */
export const isStageDirection = (sentence: string): boolean => STAGE_DIRECTION.test(sentence);

const words = (s: string | null | undefined): string[] => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
/** Two replies that start alike (the same first five words, ignoring case and punctuation). */
export function sameStart(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = words(a).slice(0, 5);
  const y = words(b).slice(0, x.length);
  return x.length >= 2 && y.length === x.length && x.every((w, i) => w === y[i]);
}

/** The i-th of a list, round and round (none of an empty one). */
export const pick = <T>(list: readonly T[] | null | undefined, i: number): T | undefined => (list?.length ? list[i % list.length] : undefined);

/**
 * Is he done? The model's NEXT, checked in code. `answerNow`: he's been quiet a while (forced),
 * this is a nudge, or he answered a yes/no question: never wait then. Otherwise he isn't done when
 * Smart Turn says so from his voice, or his words stop on "…die will". Smart Turn only counts on
 * turns of some length the model would answer by listening or asking: on a short "Ja." or a
 * "Tschüss" it said "not done" in testing.
 */
export function judgeNext({ next, answerNow, heard, heardMs, turnEnd, lex }: {
  next: Next; answerNow: boolean; heard: string; heardMs: number; turnEnd: TurnEnd | null | undefined; lex: Lexicon | null | undefined;
}): { next: Next; by: "smart-turn" | "words" | null } {
  if (next === "wait") return { next: answerNow ? "listen" : "wait", by: null };
  if (answerNow) return { next, by: null };
  const by = turnEnd && heardMs >= SMART_TURN_MIN_MS && (next === "listen" || next === "ask")
    ? (turnEnd.complete ? null : "smart-turn")
    : dangling(heard, lex) ? "words" : null;
  return by ? { next: "wait", by } : { next, by: null };
}
