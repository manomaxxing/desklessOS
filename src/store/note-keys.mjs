// Notes used German keys until v2 (kunde_name, zusammenfassung, …). New notes
// are written with English keys, values in the language of the call plus `lang`.
// These map an old note, finding or history entry to the new shape: readers use
// them while old data is still around, scripts/migrate-keys.mjs rewrites the files.
// Every function is idempotent: a note that's already new comes back unchanged.

const NOTE_KEYS = {
  modus: "mode", kunde_name: "customer_name", kunde_telefon: "customer_phone", adresse: "address", ort: "place",
  termin_datum: "appointment_date", arbeiten: "work", untergrund: "substrate", sonderwuensche: "special_requests",
  zeitrahmen: "timeframe", naechste_schritte: "next_steps", offene_fragen: "open_questions",
  zusammenfassung: "summary", bestaetigt: "confirmed", sprache: "lang",
};
const MODES = { notiz: "capture", briefing: "brief", agenda: "agenda", unklar: "unclear", auftrag: "order" };
const KINDS = { fakt: "fact", zahl: "number", geschichte: "story", meinung: "opinion" };

const workItem = w => {
  if (!w || typeof w !== "object") return w;
  if (!["raum", "bereich", "beschreibung", "menge", "flaeche_m2", "fliese_format", "fliese_material", "fliese_optik", "beschaffung"].some(k => k in w)) return w;
  const material = [w.material, w.fliese_material, w.fliese_format, w.fliese_optik].filter(Boolean).join(" ");
  return {
    area: [w.raum, w.bereich].filter(Boolean).join(", ") || w.area || "",
    description: w.beschreibung ?? w.description ?? "",
    quantity: w.menge ?? (w.flaeche_m2 ? `${w.flaeche_m2} m²` : w.quantity ?? ""),
    material,
    ...(w.beschaffung ? { supply: w.beschaffung } : {}),
  };
};
const step = s => (s && typeof s === "object" && ("was" in s || "bis" in s) ? { what: s.was ?? "", due: s.bis ?? "" } : s);

/** A note with English keys (old German-keyed notes are converted). */
export function normalizeNote(note) {
  if (!note || typeof note !== "object") return note;
  const out = {};
  for (const [k, v] of Object.entries(note)) out[NOTE_KEYS[k] ?? k] = v;
  if (out.mode in MODES) out.mode = MODES[out.mode];
  if (Array.isArray(out.work)) out.work = out.work.map(workItem);
  if (Array.isArray(out.next_steps)) out.next_steps = out.next_steps.map(step);
  return out;
}

/** A call type or note mode in the new vocabulary ("notiz" → "capture"). */
export const normalizeMode = mode => MODES[mode] ?? mode;

/** A research finding with an English kind ("fakt" → "fact"). */
export function normalizeFinding(f) {
  return f && f.kind in KINDS ? { ...f, kind: KINDS[f.kind] } : f;
}
