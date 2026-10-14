// The lines a call plays without waiting for the voice: greeting, outbound greeting,
// wrap-up, "mhm", the tool prefaces, oops and fillers, per enabled language and persona.
// Synthesised once and kept in Postgres (voice_clips, by hash of model, voice and text),
// so a new instance loads them in one query: a cold start doesn't wait on the voice
// service, and a changed line or voice is simply a new key.

import { createHash } from "node:crypto";
import { gain } from "../engine/audio.mjs";
import { typingLoop } from "../engine/ambience.mjs";
import { locales } from "../locale/index.mjs";

const keyOf = (fish, lang, text) => createHash("sha256").update(`${fish.model}|${fish.voiceFor(lang)}|pcm16k|${text}`).digest("hex");

/** { [lang]: { greeting, outboundGreeting, wrapUp, backchannel, working, looking, oops: [], fillers: [] }, typing } for each persona id. */
export async function loadVoiceClips({ fish, store, personas, log = () => {} }) {
  const wanted = []; // { lang, text, key }
  const linesOf = (lang, persona) => {
    const l = locales().persona(lang, persona) ?? {};
    return { greeting: l.greeting, outboundGreeting: l.outboundGreeting ?? "", wrapUp: l.wrapUp, backchannel: l.backchannel ?? "", working: l.working ?? "", looking: l.looking ?? "", oops: [].concat(l.oops ?? []), fillers: [].concat(l.fillers ?? []) };
  };
  for (const persona of personas) {
    for (const lang of locales().enabled()) {
      const l = linesOf(lang, persona);
      for (const text of [l.greeting, l.outboundGreeting, l.wrapUp, l.backchannel, l.working, l.looking, ...l.oops, ...l.fillers]) if (text) wanted.push({ lang, text, key: keyOf(fish, lang, text) });
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
    } catch (err) { log(`voice clip failed (${w.lang}): "${w.text}": ${err.message}`); }
  }));
  const clip = (lang, text) => (text ? have.get(keyOf(fish, lang, text)) ?? null : null);
  const typing = typingLoop();
  const out = {};
  for (const persona of personas) {
    const assets = { typing };
    for (const lang of locales().enabled()) {
      const l = linesOf(lang, persona);
      const mhm = clip(lang, l.backchannel);
      // The backchannel plays while he's still thinking, so it's quieter than the agent's own turns.
      assets[lang] = {
        greeting: clip(lang, l.greeting), outboundGreeting: clip(lang, l.outboundGreeting), wrapUp: clip(lang, l.wrapUp), backchannel: mhm && gain(mhm, 0.5),
        working: clip(lang, l.working), looking: clip(lang, l.looking),
        oops: l.oops.map(t => clip(lang, t)).filter(Boolean), fillers: l.fillers.map(t => clip(lang, t)).filter(Boolean),
      };
    }
    out[persona] = assets;
  }
  log(`voice clips ready: ${have.size} (${made} new)`);
  return out;
}
