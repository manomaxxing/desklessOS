// The note he confirmed, as a WhatsApp message (feature note_whatsapp): laid out from the
// note's fields, never written by a model, in the call's language (locale pack:
// documents.note). Null when there's nothing to send.

import { locales as sharedLocales } from "../locale/index.mjs";

const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
const paren = parts => (parts.length ? ` (${parts.join(", ")})` : "");

export function noteMessage(note, lang, L = sharedLocales()) {
  const t = L.document(lang, "note");
  if (!t || !note) return null;
  const who = [note.customer_name, note.address || note.place].map(clean).filter(Boolean);
  const work = (note.work ?? []).map(w => {
    const what = clean(w.description) || clean(w.area);
    if (!what) return "";
    const area = clean(w.area) && clean(w.description) ? `${clean(w.area)}: ` : "";
    return `• ${area}${what}${paren([w.quantity, w.material].map(clean).filter(Boolean))}`;
  }).filter(Boolean);
  const next = (note.next_steps ?? []).map(n => (clean(n.what) ? `${clean(n.what)}${paren([n.due].map(clean).filter(Boolean))}` : "")).filter(Boolean);
  if (!who.length && !work.length) return null;
  return [
    `*${t.title}* ✅${who.length ? ` ${who.join(", ")}` : ""}`,
    ...work,
    ...(next.length ? [`${t.next}: ${next.join("; ")}`] : []),
    "",
    `_${t.footer}_`,
  ].join("\n").slice(0, 3500);
}
