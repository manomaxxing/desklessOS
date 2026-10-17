// Fish Audio text to speech as raw PCM16 at 16 kHz, streamed: bytes are
// forwarded to the caller the moment Fish sends them.
//
// Fish bills API credit separately from platform credit. Without API credit
// every paid model answers 402, and only `s2.1-pro-free` works (the default).

import type { LangId } from "../types/common.ts";
import { locales } from "../locale/index.ts";

type Env = Record<string, string | undefined>;

export interface SpeakOptions {
  signal?: AbortSignal;
  /** The language's voice from its locale pack; none: the plain FISH_VOICE (the scripted caller). */
  lang?: LangId | null;
}

/** The streaming synthesiser; `lastFirstByteMs`: how long the latest stream waited for its first bytes. */
export interface FishStream {
  (text: string, opts?: SpeakOptions): AsyncGenerator<Buffer, void, undefined>;
  lastFirstByteMs: number | null;
}

export interface Fish {
  voice: string;
  voiceFor(lang: LangId | null | undefined): string;
  model: string;
  stream: FishStream;
  synth(text: string, opts?: SpeakOptions): Promise<Buffer>;
}

export function createFish(env: Env = process.env): Fish | null {
  if (!env.FISH_AUDIO_API_KEY) return null;
  const voice = env.FISH_VOICE || "";
  // One voice per language, from the locale pack (FISH_VOICE_<ID> overrides it). Without a
  // language (the scripted caller) the plain FISH_VOICE speaks.
  const voiceFor = (lang: LangId | null | undefined) => (lang ? locales().voice(lang, "fish", env) || voice : voice);
  const model = env.FISH_MODEL || "s2.1-pro-free";
  const latency = env.FISH_LATENCY || "balanced";
  // Empty or not a number: the usual speed (Number("") is 0, and NaN went out as null).
  const speed = Number(env.FISH_SPEED || NaN);
  const prosody = { speed: Number.isFinite(speed) ? speed : 1.05 };

  // One retry on a network failure (not on an HTTP error, not after an abort).
  async function request(text: string, signal: AbortSignal | undefined, ref: string, attempt = 0): Promise<Response> {
    try {
      return await fetchTts(text, signal, ref);
    } catch (err) {
      if (attempt || signal?.aborted || !(err instanceof TypeError)) throw err;
      return request(text, signal, ref, 1);
    }
  }

  async function* stream(text: string, { signal, lang }: SpeakOptions = {}): AsyncGenerator<Buffer, void, undefined> {
    const started = Date.now();
    const res = await request(text, signal, voiceFor(lang));
    if (!res.ok) throw new Error(`fish ${res.status}: ${(await res.text()).slice(0, 160)}`);
    if (!res.body) throw new Error("fish: an answer without audio");
    const body: AsyncIterable<Uint8Array> = res.body;
    let carry = Buffer.alloc(0); // keep sample boundaries: PCM16 needs even byte counts
    let first = true;
    for await (const chunk of body) {
      if (first) { fishStream.lastFirstByteMs = Date.now() - started; first = false; }
      const buf = Buffer.concat([carry, Buffer.from(chunk)]);
      const even = buf.length & ~1;
      carry = buf.subarray(even);
      if (even) yield buf.subarray(0, even);
    }
  }
  // A debug figure: the latest stream's wait, whichever call it was for (one Fish serves them all).
  const timing: Pick<FishStream, "lastFirstByteMs"> = { lastFirstByteMs: null };
  const fishStream: FishStream = Object.assign(stream, timing);

  function fetchTts(text: string, signal: AbortSignal | undefined, ref: string): Promise<Response> {
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
        prosody,
      }),
    });
  }

  async function synth(text: string, opts?: SpeakOptions): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const part of stream(text, opts)) parts.push(part);
    return Buffer.concat(parts);
  }

  return { voice, voiceFor, model, stream: fishStream, synth };
}
