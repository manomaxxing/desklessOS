// Notes used German keys until v2 (kunde_name, zusammenfassung, …); production has none left
// (checked 2026-10-16), so only the old JSON import (scripts/migrate-json-to-pg.ts) and the
// research report still read old data through these. Each is idempotent: a note that's already
// new comes back unchanged.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (v === undefined || v === null ? "" : String(v));

const NOTE_KEYS: Record<string, string> = {
  modus: "mode", kunde_name: "customer_name", kunde_telefon: "customer_phone", adresse: "address", ort: "place",
  termin_datum: "appointment_date", arbeiten: "work", untergrund: "substrate", sonderwuensche: "special_requests",
  zeitrahmen: "timeframe", naechste_schritte: "next_steps", offene_fragen: "open_questions",
  zusammenfassung: "summary", bestaetigt: "confirmed", sprache: "lang",
};
const MODES: Record<string, string> = { notiz: "capture", briefing: "brief", agenda: "agenda", unklar: "unclear", auftrag: "order" };
const KINDS: Record<string, string> = { fakt: "fact", zahl: "number", geschichte: "story", meinung: "opinion" };

const OLD_WORK_KEYS = ["raum", "bereich", "beschreibung", "menge", "flaeche_m2", "fliese_format", "fliese_material", "fliese_optik", "beschaffung"];
const workItem = (w: unknown): unknown => {
  if (!isObj(w) || !OLD_WORK_KEYS.some(k => k in w)) return w;
  const material = [w.material, w.fliese_material, w.fliese_format, w.fliese_optik].filter(Boolean).map(str).join(" ");
  return {
    area: [w.raum, w.bereich].filter(Boolean).map(str).join(", ") || str(w.area),
    description: str(w.beschreibung ?? w.description),
    quantity: w.menge !== undefined ? str(w.menge) : w.flaeche_m2 ? `${str(w.flaeche_m2)} m²` : str(w.quantity),
    material,
    ...(w.beschaffung ? { supply: str(w.beschaffung) } : {}),
  };
};
const step = (s: unknown): unknown => (isObj(s) && ("was" in s || "bis" in s) ? { what: str(s.was), due: str(s.bis) } : s);

/** A note as stored: English keys, the mode in the new vocabulary. */
export type NormalNote = Obj & { mode?: string; summary?: string; lang?: string };

/** A note with English keys (old German-keyed notes are converted); anything else comes back as it was. */
export function normalizeNote(note: unknown): NormalNote {
  if (!isObj(note)) return {};
  const out: NormalNote = {};
  for (const [k, v] of Object.entries(note)) out[NOTE_KEYS[k] ?? k] = v;
  if (typeof out.mode === "string") out.mode = MODES[out.mode] ?? out.mode;
  if (Array.isArray(out.work)) out.work = out.work.map(workItem);
  if (Array.isArray(out.next_steps)) out.next_steps = out.next_steps.map(step);
  return out;
}

/** A research finding with an English kind ("fakt" → "fact"). */
export function normalizeFinding<F extends { kind?: unknown }>(f: F): F {
  return typeof f?.kind === "string" && f.kind in KINDS ? { ...f, kind: KINDS[f.kind] } : f;
}
