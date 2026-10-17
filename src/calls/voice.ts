// The lines a call plays without waiting for the voice: greeting (and the first call's,
// which says Toni is an AI assistant), outbound greeting,
// wrap-up, "mhm", the tool prefaces, oops and fillers, per enabled language and persona.
// Synthesised once and kept in Postgres (voice_clips, by hash of model, voice and text),
// so a new instance loads them in one query: a cold start doesn't wait on the voice
// service, and a changed line or voice is simply a new key.

import { createHash } from "node:crypto";
import { gain } from "../engine/audio.ts";
import { typingLoop } from "../engine/ambience.ts";
import { locales } from "../locale/index.ts";
import type { Fish } from "../engine/fish.ts";
import type { LangClips } from "../types/call.ts";
import type { LangId, Log } from "../types/common.ts";

/** One persona's clips: each enabled language's (assets[lang]), and the typing loop (assets.typing). */
export type VoiceAssets = Record<LangId, LangClips> & { typing: Buffer };

/** Where clips are kept (memory.voiceClips: the voice_clips table). */
export interface ClipStore {
  get(keys: string[]): Promise<Map<string, Buffer>>;
  put(key: string, pcm: Buffer): Promise<unknown>;
}

const keyOf = (fish: Pick<Fish, "model" | "voiceFor">, lang: LangId, text: string) => createHash("sha256").update(`${fish.model}|${fish.voiceFor(lang)}|pcm16k|${text}`).digest("hex");
// A locale pack's line or lines ("oops": one, or several to take turns).
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** { [lang]: { greeting, outboundGreeting, wrapUp, backchannel, working, looking, oops: [], fillers: [] }, typing } for each persona id. */
export async function loadVoiceClips({ fish, store, personas, log = () => {} }: { fish: Pick<Fish, "model" | "voiceFor" | "synth">; store: ClipStore; personas: string[]; log?: Log }): Promise<Record<string, VoiceAssets>> {
  const wanted: { lang: LangId; text: string; key: string }[] = [];
  const linesOf = (lang: LangId, persona: string) => {
    const l = locales().persona(lang, persona) ?? {};
    return { greeting: l.greeting ?? "", firstGreeting: l.firstGreeting ?? "", outboundGreeting: l.outboundGreeting ?? "", wrapUp: l.wrapUp ?? "", backchannel: l.backchannel ?? "", working: l.working ?? "", looking: l.looking ?? "", oops: listOf(l.oops), fillers: listOf(l.fillers) };
  };
  for (const persona of personas) {
    for (const lang of locales().enabled()) {
      const l = linesOf(lang, persona);
      for (const text of [l.greeting, l.firstGreeting, l.outboundGreeting, l.wrapUp, l.backchannel, l.working, l.looking, ...l.oops, ...l.fillers]) if (text) wanted.push({ lang, text, key: keyOf(fish, lang, text) });
    }
  }
  const have = await store.get([...new Set(wanted.map(w => w.key))]);
  const missing = [...new Map(wanted.filter(w => !have.has(w.key)).map(w => [w.key, w])).values()];
  let made = 0;
  await Promise.all(missing.map(async w => {
    try {
      const pcm = await fish.synth(w.text, { lang: w.lang });
      if (!pcm.length) return;
      have.set(w.key, pcm);
      await store.put(w.key, pcm);
      made++;
    } catch (err) { log(`voice clip failed (${w.lang}): "${w.text}": ${errText(err)}`); }
  }));
  // A line without its clip (not synthesised, or no such line) is left out: the call speaks it live.
  const clip = (lang: LangId, text: string): Buffer | undefined => (text ? have.get(keyOf(fish, lang, text)) : undefined);
  const clips = (lang: LangId, texts: string[]): Buffer[] => texts.map(t => clip(lang, t)).filter((b): b is Buffer => b !== undefined);
  const typing = typingLoop();
  const out: Record<string, VoiceAssets> = {};
  for (const persona of personas) {
    const langs: Record<LangId, LangClips> = {};
    for (const lang of locales().enabled()) {
      const l = linesOf(lang, persona);
      const mhm = clip(lang, l.backchannel);
      // The backchannel plays while he's still thinking, so it's quieter than the agent's own turns.
      langs[lang] = {
        greeting: clip(lang, l.greeting), firstGreeting: clip(lang, l.firstGreeting), outboundGreeting: clip(lang, l.outboundGreeting), wrapUp: clip(lang, l.wrapUp), backchannel: mhm && gain(mhm, 0.5),
        working: clip(lang, l.working), looking: clip(lang, l.looking),
        oops: clips(lang, l.oops), fillers: clips(lang, l.fillers),
      };
    }
    out[persona] = Object.assign(langs, { typing });
  }
  log(`voice clips ready: ${have.size} (${made} new)`);
  return out;
}
