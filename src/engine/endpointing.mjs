// Text checks on what the caller said, for when a pause ends his turn. The
// model decides first (NEXT: wait); these catch what it misses. The word lists
// come from the locale pack of the language he's speaking (locales/<id>.json,
// compiled by src/locale/index.mjs): one language's list, never a union, since
// a word that can't end a sentence in one language can end one in another.

/** He stopped mid-sentence: trailing "…" or a word no sentence ends on, with no full stop. */
export function dangling(heard, lex) {
  const t = String(heard ?? "").trim();
  if (!t) return false;
  if (/(\.\.\.|…|[-–—])$/.test(t)) return true;
  if (/[.?!]["“”'»]?$/.test(t)) return false;
  const last = t.replace(/[,;:\s]+$/, "").split(/\s+/).pop().toLowerCase();
  return Boolean(lex?.dangling.has(last));
}

/**
 * He asked the agent to hold on ("Moment", "warte mal", "hold on"): as a clause
 * of its own or at the end, but not inside a sentence ("im Moment hab ich viel zu tun").
 */
export function holdOn(heard, lex) {
  return Boolean(lex?.hold.test(String(heard ?? "").trim()));
}
