// The agent's sentences as audio: a clip starts synthesising the moment its sentence is written
// (Fish, streamed) and is drained later, in order, as its bytes arrive. Cached lines (a tool's
// preface) are clips that are already done.

import type { LangId } from "../types/common.ts";
import type { SpeakOptions } from "./fish.ts";
import { ttsCost, type Meter } from "./cost.ts";

export interface Clip {
  text: string;
  chunks: Buffer[];
  done: boolean;
  error: unknown;
  wake: (() => void) | null;
  /** How long the voice took to its first bytes (this call's own figure: one Fish serves every call). */
  firstByteMs: number | null;
}

/** A clip that's already whole (pre-rendered audio). */
export const readyClip = (text: string, pcm: Buffer): Clip => ({ text, chunks: [pcm], done: true, error: null, wake: null, firstByteMs: 0 });

export function startClip(text: string, { fish, signal, lang, meter, onError }: { fish: { model: string; stream: (text: string, opts?: SpeakOptions) => AsyncIterable<Buffer> }; signal: AbortSignal; lang: LangId; meter: Meter; onError: (err: unknown) => void }): Clip {
  const clip: Clip = { text, chunks: [], done: false, error: null, wake: null, firstByteMs: null };
  const started = performance.now();
  void (async () => {
    try {
      meter.add(ttsCost(fish.model, text));
      for await (const part of fish.stream(text, { signal, lang })) {
        clip.firstByteMs ??= Math.round(performance.now() - started);
        clip.chunks.push(part);
        clip.wake?.();
      }
    } catch (err) {
      if (!signal.aborted) { clip.error = err; onError(err); }
    } finally {
      clip.done = true;
      clip.wake?.();
    }
  })();
  return clip;
}

/** The clip's audio as it arrives; ends when the clip is done (or failed). */
export async function* drain(clip: Clip): AsyncGenerator<Buffer, void, undefined> {
  let i = 0;
  for (;;) {
    while (i < clip.chunks.length) yield clip.chunks[i++]!;
    if (clip.done) return;
    await new Promise<void>(resolve => { clip.wake = resolve; });
    clip.wake = null;
  }
}
