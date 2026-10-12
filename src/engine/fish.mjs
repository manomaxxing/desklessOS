// Fish Audio text to speech as raw PCM16 at 16 kHz, streamed: bytes are
// forwarded to the caller the moment Fish sends them.
//
// Fish bills API credit separately from platform credit. Without API credit
// every paid model answers 402, and only `s2.1-pro-free` works (the default).

import { locales } from "../locale/index.mjs";

export function createFish(env = process.env) {
  if (!env.FISH_AUDIO_API_KEY) return null;
  const voice = env.FISH_VOICE || env.FISH_NARRATOR_VOICE || (env.FISH_VOICE_IDS ?? "").split(",")[0]?.trim() || "";
  // One voice per language, from the locale pack (FISH_VOICE_<ID> overrides it). Without a
  // language (the scripted caller) the plain FISH_VOICE speaks.
  const voiceFor = lang => (lang ? locales().voice(lang, "fish", env) || voice : voice);
  const model = env.FISH_MODEL || "s2.1-pro-free";
  const latency = env.FISH_LATENCY || "balanced";

  // One retry on a network failure (not on an HTTP error, not after an abort).
  async function request(text, signal, ref, attempt = 0) {
    try {
      return await fetchTts(text, signal, ref);
    } catch (err) {
      if (attempt || signal?.aborted || !(err instanceof TypeError)) throw err;
      return request(text, signal, ref, 1);
    }
  }

  async function* stream(text, { signal, lang } = {}) {
    const started = Date.now();
    const res = await request(text, signal, voiceFor(lang));
    if (!res.ok) throw new Error(`fish ${res.status}: ${(await res.text()).slice(0, 160)}`);
    let carry = Buffer.alloc(0); // keep sample boundaries: PCM16 needs even byte counts
    let first = true;
    for await (const chunk of res.body) {
      if (first) { stream.lastFirstByteMs = Date.now() - started; first = false; }
      const buf = Buffer.concat([carry, Buffer.from(chunk)]);
      const even = buf.length & ~1;
      carry = buf.subarray(even);
      if (even) yield buf.subarray(0, even);
    }
  }

  function fetchTts(text, signal, ref) {
    return fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { authorization: `Bearer ${env.FISH_AUDIO_API_KEY}`, "content-type": "application/json", model },
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
      body: JSON.stringify({
        text,
        ...(ref ? { reference_id: ref } : {}),
        format: "pcm",
        sample_rate: 16000,
        latency,
        prosody: { speed: Number(env.FISH_SPEED ?? 1.05) },
      }),
    });
  }

  async function synth(text, opts) {
    const parts = [];
    for await (const part of stream(text, opts)) parts.push(part);
    return Buffer.concat(parts);
  }

  return { voice, voiceFor, model, stream, synth };
}
