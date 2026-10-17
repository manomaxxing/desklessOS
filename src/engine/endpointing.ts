// Text checks on what the caller said, for when a pause ends his turn. The
// model decides first (NEXT: wait); these catch what it misses. The word lists
// come from the locale pack of the language he's speaking (locales/<id>.json,
// compiled by src/locale/index.ts): one language's list, never a union, since
// a word that can't end a sentence in one language can end one in another.

import type { Next } from "../types/common.ts";
import type { Lexicon } from "../types/locale.ts";

/** What he said (the header's HEARD); null or missing reads as nothing. */
type Heard = string | null | undefined;

/** He stopped mid-sentence: trailing "…" or a word no sentence ends on, with no full stop. */
export function dangling(heard: Heard, lex: Lexicon | null | undefined): boolean {
  const t = String(heard ?? "").trim();
  if (!t) return false;
  if (/(\.\.\.|…|[-–—])$/.test(t)) return true;
  if (/[.?!]["“”'»]?$/.test(t)) return false;
  const last = (t.replace(/[,;:\s]+$/, "").split(/\s+/).at(-1) ?? "").toLowerCase();
  return Boolean(lex?.dangling.has(last));
}

/**
 * He said yes, plainly: a yes word, and nothing that takes it back ("ja, aber erst morgen",
 * "nee, warte"). What an action with consequences needs before it runs (a quote sent).
 */
export function affirmed(heard: Heard, lex: Lexicon | null | undefined): boolean {
  const t = String(heard ?? "").trim();
  return Boolean(t) && Boolean(lex?.affirm.test(t)) && !lex?.negate.test(t);
}

/**
 * He asked the agent to hold on ("Moment", "warte mal", "hold on"): as a clause
 * of its own or at the end, but not inside a sentence ("im Moment hab ich viel zu tun").
 */
export function holdOn(heard: Heard, lex: Lexicon | null | undefined): boolean {
  return Boolean(lex?.hold.test(String(heard ?? "").trim()));
}

// What the model wrote down, but nobody said, checked in code before anything is spoken:
//   a goodbye to words without a single word in them ("00:00", "(unclear)", nothing): no hang-up;
//   his previous turn again, word for word (the model copied it instead of hearing him), unless
//   the agent just asked him to say it again. Returns why, or "".
const normalised = (s: Heard) => String(s ?? "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export function misheard(heard: Heard, { next, lastUser = "", askedToRepeat = false }: { next?: Next; lastUser?: string | null; askedToRepeat?: boolean } = {}): string {
  const words = normalised(heard);
  if (next === "hangup" && !/\p{L}{2,}/u.test(words)) return "a goodbye to words nobody understood";
  if (!askedToRepeat && words.length >= 12 && words === normalised(lastUser)) return "the transcript repeats his last turn";
  return "";
}
