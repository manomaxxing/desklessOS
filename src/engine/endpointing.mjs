// Text checks on what the caller said, for when a pause ends his turn. The
// model decides first (NEXT: wait); these catch what it misses.

// Words a sentence doesn't end on. If the transcript stops on one with no full
// stop, he paused mid-sentence ("die will", "und", "also ich bin"), whatever the
// model thought. Pronouns and particles that can end a sentence are left out.
const DANGLING = new Set([
  // German
  "und", "oder", "aber", "also", "dann", "weil", "dass", "wenn", "ob", "sondern", "denn", "sowie",
  "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "eines",
  "mein", "meine", "dein", "deine", "sein", "seine", "unser", "unsere",
  "mit", "für", "von", "vom", "zu", "zum", "zur", "im", "ins", "am", "an", "auf", "aus", "bei", "beim",
  "nach", "über", "unter", "vor", "hinter", "neben", "zwischen", "bis", "gegen", "ohne", "um",
  "ich", "du", "wir",
  "will", "wollte", "wollen", "muss", "musste", "müssen", "soll", "sollte", "sollen", "kann", "konnte", "können",
  "hat", "hatte", "habe", "hab", "haben", "ist", "bin", "sind", "war", "waren", "wird", "werden", "würde",
  "äh", "ähm", "öh", "hm", "ehm",
  // English
  "the", "a", "and", "or", "but", "because", "that", "to", "of", "for", "with", "on", "at", "from", "by",
  "i", "we", "my", "his", "her", "their", "our",
  "is", "are", "was", "were", "would", "could", "should", "has", "have", "had", "um", "uh",
]);

/** He stopped mid-sentence: trailing "…" or a word no sentence ends on, with no full stop. */
export function dangling(heard) {
  const t = String(heard ?? "").trim();
  if (!t) return false;
  if (/(\.\.\.|…|[-–—])$/.test(t)) return true;
  if (/[.?!]["“”'»]?$/.test(t)) return false;
  const last = t.replace(/[,;:\s]+$/, "").split(/\s+/).pop().toLowerCase();
  return DANGLING.has(last);
}

// "Moment", "warte mal", "Sekunde": he asked the agent to hold on. As a clause of
// its own ("…, Moment, ich muss kurz parken") or at the end ("…, warte mal"),
// but not inside a sentence ("im Moment hab ich viel zu tun").
const HOLD_WORDS = String.raw`moment(chen)?|warte?( mal)?|(eine |'?ne )?sekunde|augenblick|hold on|hang on|one sec(ond)?|just a sec(ond)?`;
const HOLD = new RegExp(String.raw`(^|[,.!?;:–-]\s*)(${HOLD_WORDS})\s*([,.!?;…–-]|$)|\b(${HOLD_WORDS}|let me think|lass mich (kurz )?(überlegen|nachdenken|schauen))[\s.!,…-]*$`, "i");

export function holdOn(heard) {
  return HOLD.test(String(heard ?? "").trim());
}
