// Text helpers for memory: a note as one prompt line, and the words a search goes by.

import { normalizeNote } from "./note-keys.mjs";
import { locales } from "../locale/index.mjs";

// One note, compact but with the specs a briefing needs (old German-keyed notes too).
export function noteLine(note) {
  const n = normalizeNote(note);
  const work = (n.work ?? []).map(w => [w.area, w.quantity, w.material, w.supply ? `supply: ${w.supply}` : "", w.description].filter(Boolean).join(" ")).filter(Boolean);
  const parts = [
    n.appointment_date || n.created_at?.slice(0, 10),
    [n.customer_name, n.address, n.place].filter(Boolean).join(", ") || "?",
    n.summary,
    work.length ? `work: ${work.join("; ")}` : "",
    n.substrate ? `substrate: ${n.substrate}` : "",
    n.special_requests?.length ? `wishes: ${n.special_requests.join("; ")}` : "",
    n.timeframe ? `timeframe: ${n.timeframe}` : "",
    n.budget ? `budget: ${n.budget}` : "",
    n.next_steps?.length ? `next: ${n.next_steps.map(s => `${s.what}${s.due ? ` (${s.due})` : ""}`).join("; ")}` : "",
    n.open_questions?.length ? `open: ${n.open_questions.join("; ")}` : "",
  ];
  return parts.filter(Boolean).join(" | ");
}

// ---------- search ----------
// Lowercase words without accents ("Müller" → "muller"), 3+ letters, no stopwords of any enabled language.
export function searchWords(text) {
  const stop = stopwords();
  return String(text ?? "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !stop.has(w));
}
let stopCache = null;
const stopwords = () => (stopCache ??= new Set(locales().enabled().flatMap(id => [...locales().lexicon(id).stopwords])));

// pg_trgm-style similarity of two words (0…1).
function trigrams(word) {
  const s = `  ${word} `;
  const out = new Set();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}
export function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return shared / (A.size + B.size - shared);
}
