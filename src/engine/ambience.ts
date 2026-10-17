// Keyboard typing, synthesised: masks the wait while the model thinks, the way
// a person on the phone types while you talk. No samples, so no licensing.
// Each keystroke = a short band-passed noise click plus a soft low "thock";
// keys come in word-sized bursts with human-ish gaps. 16 kHz PCM16 mono.

import { SAMPLE_RATE } from "./audio.ts";

// Deterministic randomness so the loop sounds the same every start.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

// Biquad band-pass (RBJ cookbook), applied in place.
function bandpass(x: Float32Array, f0: number, q: number): Float32Array {
  const w = (2 * Math.PI * f0) / SAMPLE_RATE;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}

function keystroke(rand: () => number, { space = false, velocity = 1 } = {}): Float32Array {
  const len = Math.round(SAMPLE_RATE * (space ? 0.07 : 0.045));
  const click = new Float32Array(len);
  for (let i = 0; i < len; i++) click[i] = rand() * 2 - 1;
  bandpass(click, space ? 1700 : 2600 + rand() * 1400, space ? 0.9 : 1.3);
  const out = new Float32Array(len);
  const thockHz = space ? 140 : 190 + rand() * 80;
  for (let i = 0; i < len; i++) {
    const t = i / SAMPLE_RATE;
    const attack = Math.min(1, t / 0.0015);
    const clickEnv = attack * Math.exp(-t / (space ? 0.012 : 0.007));
    const thock = Math.sin(2 * Math.PI * thockHz * t) * Math.exp(-t / 0.018) * 0.35;
    // a faint release click ~25 ms after the press
    const rel = t > 0.024 ? Math.exp(-(t - 0.024) / 0.004) * 0.25 : 0;
    out[i] = velocity * (click[i] * (clickEnv + rel) * 2.2 + thock * attack);
  }
  return out;
}

// TYPING_LEVEL_DB empty or not a number: the default, not full scale (Number("") is 0) or silence (NaN).
function envLevelDb(): number {
  const db = Number(process.env.TYPING_LEVEL_DB || NaN);
  return Number.isFinite(db) ? db : -27;
}

/** ~`seconds` of typing as PCM16; level in dBFS for the loudest keys (default -27, TYPING_LEVEL_DB). */
export function typingLoop({ seconds = 12, levelDb = envLevelDb(), seed = 7 }: { seconds?: number; levelDb?: number; seed?: number } = {}): Buffer {
  const rand = rng(seed);
  const total = Math.round(SAMPLE_RATE * seconds);
  const mix = new Float32Array(total);
  let t = Math.round(SAMPLE_RATE * 0.05);
  while (t < total) {
    const word = 2 + Math.floor(rand() * 7);
    for (let k = 0; k < word && t < total; k++) {
      const key = keystroke(rand, { velocity: 0.55 + rand() * 0.45 });
      for (let i = 0; i < key.length && t + i < total; i++) mix[t + i] += key[i];
      t += Math.round(SAMPLE_RATE * (0.07 + rand() * 0.09));
    }
    const space = keystroke(rand, { space: true, velocity: 0.7 });
    for (let i = 0; i < space.length && t + i < total; i++) mix[t + i] += space[i];
    t += Math.round(SAMPLE_RATE * (rand() < 0.15 ? 0.5 + rand() * 0.5 : 0.16 + rand() * 0.2));
  }
  let peak = 0;
  for (const v of mix) peak = Math.max(peak, Math.abs(v));
  const gain = (10 ** (levelDb / 20)) / (peak || 1);
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(mix[i] * gain * 32767))), i * 2);
  return pcm;
}

/**
 * Streams typing in real time, a little ahead of playback, so it can stop the
 * instant the reply is ready without a long buffered tail.
 */
export interface Typist {
  readonly running: boolean;
  start(): void;
  stop(): void;
}

export function createTypist(loop: Buffer, send: (chunk: Buffer) => void, { chunkMs = 80, leadMs = 120 } = {}): Typist {
  const bytesPerMs = (SAMPLE_RATE * 2) / 1000;
  let timer: ReturnType<typeof setInterval> | null = null;
  let offset = Math.floor(Math.random() * (loop.length / 2)) & ~1;
  let sentMs = 0;
  let startedAt = 0;
  const tick = () => {
    const due = performance.now() - startedAt + leadMs;
    while (sentMs < due) {
      const size = chunkMs * bytesPerMs;
      if (offset + size > loop.length) offset = 0;
      send(loop.subarray(offset, offset + size));
      offset += size;
      sentMs += chunkMs;
    }
  };
  return {
    get running() { return Boolean(timer); },
    start() {
      if (timer) return;
      startedAt = performance.now();
      sentMs = 0;
      tick();
      timer = setInterval(tick, chunkMs / 2);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
