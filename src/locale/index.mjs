// Locale packs: everything language-specific lives in locales/<id>.json, so a
// new language is a new file, not a code change. A pack holds the voices, the
// phone country codes, the turn-taking word lists, the persona lines (greeting,
// fillers, …) and the spoken examples the prompts quote.
// Prompts themselves stay in English; the model answers in the caller's language.
//
//   LANGS=de,en       which packs are live (default: every pack with status "enabled")
//   DEFAULT_LANG=de   when nothing else tells us the caller's language
//   FISH_VOICE_<ID>   overrides a pack's Fish voice (e.g. FISH_VOICE_DE); FISH_VOICE overrides the default language's

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LOCALES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "locales");

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = words => [...new Set(words.map(w => w.toLowerCase()))].sort((a, b) => b.length - a.length).map(escape).join("|");

// The word lists, compiled once per pack.
function compileLexicon(lex = {}) {
  const hold = alternation(lex.hold ?? []);
  const tail = alternation([...(lex.hold ?? []), ...(lex.holdTail ?? [])]);
  const never = /(?!)/; // matches nothing: a pack without a list just never triggers it
  return {
    dangling: new Set((lex.dangling ?? []).map(w => w.toLowerCase())),
    // "Moment" as a clause of its own ("…, Moment, ich muss kurz parken") or at the end ("…, warte mal").
    hold: hold || tail ? new RegExp(`${hold ? `(^|[,.!?;:–-]\\s*)(${hold})\\s*([,.!?;…–-]|$)` : "(?!)"}|${tail ? `(^|\\s)(${tail})[\\s.!,…-]*$` : "(?!)"}`, "i") : never,
    // A reply that starts with a filler the agent already played ("Mhm. …").
    fillerPrefix: lex.fillerWords?.length ? new RegExp(`^(${alternation(lex.fillerWords)})[.!,…]*\\s*`, "i") : never,
    // A reply that is only a backchannel ("Mhm." / "Okay, weiter.").
    agentBackchannel: lex.agentBackchannel?.length ? new RegExp(`^\\s*(${alternation(lex.agentBackchannel)})[.!,…]*\\s*((${alternation(lex.goOn ?? []) || "(?!)"})[.!…]*)?\\s*$`, "i") : never,
    stopwords: new Set((lex.stopwords ?? []).map(w => w.toLowerCase())),
    // A yes, and anything that takes it back ("ja, aber…", "nee, warte"): for actions that need his yes.
    affirm: lex.affirm?.length ? new RegExp(`(^|[^\\p{L}])(${alternation(lex.affirm)})(?=$|[^\\p{L}])`, "iu") : never,
    send: lex.send?.length ? new RegExp(`(^|[^\\p{L}])(${alternation(lex.send)})`, "iu") : never, // "schick", "WhatsApp": a yes is about sending something
    negate: lex.negate?.length ? new RegExp(`(^|[^\\p{L}])(${alternation(lex.negate)})(?=$|[^\\p{L}])`, "iu") : never,
    letters: lex.letters ?? "",
    unclear: lex.unclear ?? [],
  };
}

export function loadLocales(dir = LOCALES_DIR, { only = process.env.LANGS, fallback = process.env.DEFAULT_LANG } = {}) {
  const packs = new Map();
  for (const file of readdirSync(dir).filter(f => /^[a-z]{2,3}(-[a-z0-9]+)?\.json$/i.test(f)).sort()) {
    const pack = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
    if (`${pack.id}.json` !== file) throw new Error(`locales/${file}: id "${pack.id}" doesn't match the file name`);
    packs.set(pack.id, { ...pack, lex: compileLexicon(pack.lexicon) });
  }
  const wanted = only ? only.split(",").map(s => s.trim()).filter(Boolean) : null;
  const enabledIds = [...packs.values()].filter(p => (wanted ? wanted.includes(p.id) : p.status === "enabled")).map(p => p.id);
  if (!enabledIds.length) throw new Error(`no enabled locale in ${dir}${wanted ? ` (LANGS=${only})` : ""}`);
  const defaultId = fallback && enabledIds.includes(fallback) ? fallback : enabledIds[0];
  const get = id => packs.get(id) ?? packs.get(defaultId);

  // Every pack's markers for "the caller wasn't understood", plus the engine's own.
  const unclear = new RegExp(`^\\((${alternation(["unclear", "silence", "not transcribed", ...[...packs.values()].flatMap(p => p.lex.unclear)])})`, "i");

  return {
    ids: [...packs.keys()],
    enabled: () => [...enabledIds],
    isEnabled: id => enabledIds.includes(id),
    defaultId,
    get,
    name: id => get(id).name,
    bcp47: id => get(id).bcp47,
    lexicon: id => get(id).lex,
    unclear,
    /** A document's texts in this language (documents.<name>: the quote PDF), else the default language's. */
    document(id, name) {
      return get(id).documents?.[name] ?? packs.get(defaultId).documents?.[name] ?? null;
    },
    /** Persona lines and examples in this language (the default language's if this one lacks the persona). */
    persona(id, persona) {
      return get(id).personas?.[persona] ?? packs.get(defaultId).personas?.[persona] ?? null;
    },
    voice(id, kind, env = process.env) {
      const pack = get(id);
      // FISH_VOICE was the German (default) voice before packs existed: it still overrides the default language's.
      if (kind === "fish") return env[`FISH_VOICE_${pack.id.toUpperCase()}`] || (pack.id === defaultId && env.FISH_VOICE) || pack.voices?.fish || env.FISH_VOICE || "";
      return pack.voices?.[kind] ?? "";
    },
    /** The enabled language for a phone number, by the longest matching country code. */
    forPhone(e164) {
      const digits = String(e164 ?? "").replace(/^\+/, "");
      if (!/^\d/.test(digits)) return null;
      let best = null;
      for (const id of enabledIds) for (const cc of get(id).countryCodes ?? []) {
        if (digits.startsWith(cc) && (!best || cc.length > best.cc.length)) best = { id, cc };
      }
      return best?.id ?? null;
    },
    /** Which enabled language a piece of text is in, by stopwords and letters; null if unsure. */
    guess(text) {
      const words = String(text ?? "").toLowerCase().split(/[^\p{L}']+/u).filter(Boolean);
      let best = null;
      for (const id of enabledIds) {
        const lex = get(id).lex;
        let score = words.filter(w => lex.stopwords.has(w)).length;
        if (lex.letters && [...lex.letters].some(ch => text.toLowerCase().includes(ch))) score += 2;
        if (score > (best?.score ?? 0)) best = { id, score };
        else if (best && score === best.score) best = { ...best, tie: true };
      }
      return best && !best.tie ? best.id : null;
    },
  };
}

/**
 * The language for a new call: what we know about the user, then what the
 * carrier says (e.g. Dial's "de-DE"), then the caller's country code, then the
 * skill's own default, then DEFAULT_LANG.
 */
export function pickLanguage({ locales, userLang, dialTag, from, fallback }) {
  if (userLang && locales.isEnabled(userLang)) return userLang;
  const tag = String(dialTag ?? "").toLowerCase().split(/[-_]/)[0];
  if (tag && locales.isEnabled(tag)) return tag;
  return locales.forPhone(from) ?? (fallback && locales.isEnabled(fallback) ? fallback : locales.defaultId);
}

// Prompts are written in English whatever the call's language, so their dates are too.
const PROMPT_LOCALE = "en-GB";
/** For parsing dates into parts (digits, 24 h), not for anything spoken. */
export const FORMAT_LOCALE = "en-GB";
/** "Monday, 12 October 2026", for a prompt. */
export const promptDate = (d = new Date()) => d.toLocaleDateString(PROMPT_LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
/** "07:40, early morning" in his time zone: what part of his day it is. */
export function promptTime(d = new Date(), timeZone = "Europe/Berlin") {
  const hm = d.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
  const h = Number(hm.slice(0, 2));
  const part = h < 5 ? "night" : h < 9 ? "early morning, his day has barely started" : h < 12 ? "morning" : h < 14 ? "midday" : h < 18 ? "afternoon" : h < 22 ? "evening" : "night";
  return `${hm}, ${part}`;
}
/** "Monday", for a prompt. */
export const promptWeekday = (d = new Date()) => d.toLocaleDateString(PROMPT_LOCALE, { weekday: "long" });

let shared = null;
/** The process-wide locales (loaded once from locales/). */
export function locales() {
  return (shared ??= loadLocales());
}
