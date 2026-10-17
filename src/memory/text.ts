// Text helpers for memory: a note as one prompt line, and the words a search goes by.

import type { Note } from "../types/note.ts";
import { locales } from "../locale/index.ts";

// One note, compact but with the specs a briefing needs.
export function noteLine(n: Note & { created_at?: string }): string {
  const work = (n.work ?? []).map(w => [w.area, w.quantity, w.material, w.supply ? `supply: ${String(w.supply)}` : "", w.description].filter(Boolean).join(" ")).filter(Boolean);
  const parts = [
    n.appointment_date || n.created_at?.slice(0, 10),
    [n.customer_name, n.address, n.place].filter(Boolean).join(", ") || "?",
    n.summary,
    work.length ? `work: ${work.join("; ")}` : "",
    n.substrate ? `substrate: ${String(n.substrate)}` : "",
    n.special_requests?.length ? `wishes: ${n.special_requests.join("; ")}` : "",
    n.timeframe ? `timeframe: ${n.timeframe}` : "",
    n.budget ? `budget: ${n.budget}` : "",
    n.next_steps?.length ? `next: ${n.next_steps.map(s => `${s.what ?? ""}${s.due ? ` (${s.due})` : ""}`).join("; ")}` : "",
    n.open_questions?.length ? `open: ${n.open_questions.join("; ")}` : "",
  ];
  return parts.filter(Boolean).join(" | ");
}

// ---------- search ----------
// Lowercase words without accents ("Müller" → "muller"), 3+ letters, no stopwords of any enabled language.
export function searchWords(text: unknown): string[] {
  const stop = stopwords();
  return String(text ?? "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !stop.has(w));
}
let stopCache: Set<string> | null = null;
const stopwords = (): Set<string> => (stopCache ??= new Set(locales().enabled().flatMap(id => [...locales().lexicon(id).stopwords])));
