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
import type { LangId } from "../types/common.ts";
import type { Lexicon, LexiconSource, LoadedPack, LocalePack, PersonaLines } from "../types/locale.ts";
import { isRecord } from "../shared/is-record.ts";

export const LOCALES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "locales");

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alternation = (words: readonly string[]) => [...new Set(words.map(w => w.toLowerCase()))].sort((a, b) => b.length - a.length).map(escape).join("|");

// The word lists, compiled once per pack.
function compileLexicon(lex: LexiconSource = {}): Lexicon {
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

// A pack file as read: its id must name the file; the rest is checked by checkLocales (npm run locale:check).
function readPack(dir: string, file: string): LocalePack {
  const pack: unknown = JSON.parse(readFileSync(path.join(dir, file), "utf8"));
  const id = isRecord(pack) ? String(pack.id) : "";
  if (`${id}.json` !== file) throw new Error(`locales/${file}: id "${id}" doesn't match the file name`);
  return pack as LocalePack; // a pack is data we ship, kept complete by checkLocales and test/locale.test.ts
}

export function loadLocales(dir: string = LOCALES_DIR, { only = process.env.LANGS, fallback = process.env.DEFAULT_LANG }: { only?: string; fallback?: LangId } = {}) {
  const packs = new Map<LangId, LoadedPack>();
  for (const file of readdirSync(dir).filter(f => /^[a-z]{2,3}(-[a-z0-9]+)?\.json$/i.test(f)).sort()) {
    const pack = readPack(dir, file);
    packs.set(pack.id, { ...pack, lex: compileLexicon(pack.lexicon) });
  }
  const wanted = only ? only.split(",").map(s => s.trim()).filter(Boolean) : null;
  const enabledIds = [...packs.values()].filter(p => (wanted ? wanted.includes(p.id) : p.status === "enabled")).map(p => p.id);
  if (!enabledIds.length) throw new Error(`no enabled locale in ${dir}${wanted ? ` (LANGS=${only})` : ""}`);
  const defaultId: LangId = fallback && enabledIds.includes(fallback) ? fallback : enabledIds[0];
  const defaultPack = packs.get(defaultId);
  if (!defaultPack) throw new Error(`no locale pack "${defaultId}" in ${dir}`); // can't happen: enabled ids come from the packs
  /** A language's pack; the default language's for an id that isn't there (or none). */
  const get = (id: LangId | null | undefined): LoadedPack => packs.get(id ?? "") ?? defaultPack;

  // Every pack's markers for "the caller wasn't understood", plus the engine's own.
  const unclear = new RegExp(`^\\((${alternation(["unclear", "silence", "not transcribed", ...[...packs.values()].flatMap(p => p.lex.unclear)])})`, "i");

  return {
    ids: [...packs.keys()],
    enabled: (): LangId[] => [...enabledIds],
    isEnabled: (id: LangId | null | undefined): boolean => enabledIds.includes(id ?? ""),
    defaultId,
    get,
    name: (id: LangId | null | undefined): string => get(id).name,
    bcp47: (id: LangId | null | undefined): string => get(id).bcp47,
    lexicon: (id: LangId | null | undefined): Lexicon => get(id).lex,
    unclear,
    /** A document's texts in this language (documents.<name>: the quote PDF), else the default language's. */
    document(id: LangId | null | undefined, name: string): Record<string, string> | null {
      return get(id).documents?.[name] ?? defaultPack.documents?.[name] ?? null;
    },
    /** Persona lines and examples in this language (the default language's if this one lacks the persona). */
    persona(id: LangId | null | undefined, persona: string): PersonaLines | null {
      return get(id).personas?.[persona] ?? defaultPack.personas?.[persona] ?? null;
    },
    voice(id: LangId | null | undefined, kind: string, env: Record<string, string | undefined> = process.env): string {
      const pack = get(id);
      // FISH_VOICE was the German (default) voice before packs existed: it still overrides the default language's.
      if (kind === "fish") return env[`FISH_VOICE_${pack.id.toUpperCase()}`] || (pack.id === defaultId && env.FISH_VOICE) || pack.voices?.fish || env.FISH_VOICE || "";
      return pack.voices?.[kind] ?? "";
    },
    /** The enabled language for a phone number, by the longest matching country code. */
    forPhone(e164: string | null | undefined): LangId | null {
      const digits = String(e164 ?? "").replace(/^\+/, "");
      if (!/^\d/.test(digits)) return null;
      let best: { id: LangId; cc: string } | null = null;
      for (const id of enabledIds) for (const cc of get(id).countryCodes ?? []) {
        if (digits.startsWith(cc) && (!best || cc.length > best.cc.length)) best = { id, cc };
      }
      return best?.id ?? null;
    },
    /** Which enabled language a piece of text is in, by stopwords and letters; null if unsure. */
    guess(text: string | null | undefined): LangId | null {
      const lower = String(text ?? "").toLowerCase();
      const words = lower.split(/[^\p{L}']+/u).filter(Boolean);
      let best: LangId | null = null;
      let bestScore = 0;
      let tie = false;
      for (const id of enabledIds) {
        const lex = get(id).lex;
        let score = words.filter(w => lex.stopwords.has(w)).length;
        if (lex.letters && [...lex.letters].some(ch => lower.includes(ch))) score += 2;
        if (score > bestScore) { best = id; bestScore = score; tie = false; }
        else if (best && score === bestScore) tie = true;
      }
      return tie ? null : best;
    },
  };
}

/**
 * The language for a new call: what we know about the user, then what the
 * carrier says (e.g. Dial's "de-DE"), then the caller's country code, then the
 * skill's own default, then DEFAULT_LANG.
 */
export function pickLanguage({ locales, userLang, dialTag, from, fallback }: { locales: Pick<Locales, "isEnabled" | "forPhone" | "defaultId">; userLang?: LangId | null; dialTag?: string | null; from?: string | null; fallback?: LangId | null }): LangId {
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
export const promptDate = (d: Date = new Date()): string => d.toLocaleDateString(PROMPT_LOCALE, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
/** "07:40, early morning" in his time zone: what part of his day it is. */
export function promptTime(d: Date = new Date(), timeZone = "Europe/Berlin"): string {
  const hm = d.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });
  const h = Number(hm.slice(0, 2));
  const part = h < 5 ? "night" : h < 9 ? "early morning, his day has barely started" : h < 12 ? "morning" : h < 14 ? "midday" : h < 18 ? "afternoon" : h < 22 ? "evening" : "night";
  return `${hm}, ${part}`;
}
/** "Monday", for a prompt. */
export const promptWeekday = (d: Date = new Date()): string => d.toLocaleDateString(PROMPT_LOCALE, { weekday: "long" });

/** Every pack, compiled, and how to pick one (a language id that isn't there reads as the default language). */
export type Locales = ReturnType<typeof loadLocales>;

let shared: Locales | null = null;
/** The process-wide locales (loaded once from locales/). */
export function locales(): Locales {
  return (shared ??= loadLocales());
}
