// Audio plumbing. Inside the engine everything is 16-bit little-endian mono PCM
// at 16 kHz, which is also Dial's `l16_16000` and what Fish returns for
// `format: "pcm", sample_rate: 16000`. So no codecs on the hot path.

export const SAMPLE_RATE = 16000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000; // 32

/** RMS loudness of a PCM16 frame, 0..1. */
export function rms(pcm: Buffer): number {
  const n = pcm.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

/** Wraps raw PCM16 mono in a WAV header (what Gemini takes as audio/wav). */
export function wav(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** PCM16 payload of a WAV file and its rate, from the fmt and data chunks (whatever comes before them). */
export function wavData(buf: Buffer): { pcm: Buffer; sampleRate: number } {
  let off = 12;
  let sampleRate = SAMPLE_RATE; // a file without a fmt chunk before its data: assume the engine's rate
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    // The rate is read from the fmt chunk itself: a JUNK or LIST chunk may come first.
    if (id === "fmt " && off + 16 <= buf.length) sampleRate = buf.readUInt32LE(off + 12);
    if (id === "data") return { pcm: buf.subarray(off + 8, off + 8 + size), sampleRate };
    off += 8 + size + (size & 1);
  }
  throw new Error("no data chunk in wav");
}

/** The same PCM16, louder or quieter (0.5 ≈ -6 dB), clipped to range. */
export function gain(pcm: Buffer, factor: number): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * factor))), i);
  return out;
}

/** Silence of the given length. */
export function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round(ms * BYTES_PER_MS));
}

/** Splits PCM into frames of `ms` milliseconds (last one may be shorter). */
export function* frames(pcm: Buffer, ms = 20): Generator<Buffer> {
  const size = Math.round(ms * BYTES_PER_MS);
  for (let i = 0; i < pcm.length; i += size) yield pcm.subarray(i, Math.min(i + size, pcm.length));
}

/** Duration in ms of a PCM16 buffer at 16 kHz. */
export function durationMs(pcm: Buffer): number {
  return pcm.length / BYTES_PER_MS;
}

/** Linear resample of PCM16 mono (light smoothing first when downsampling). Good enough for speech. */
export function resample(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcm;
  const n = pcm.length >> 1;
  const src = new Float32Array(n);
  for (let i = 0; i < n; i++) src[i] = pcm.readInt16LE(i * 2);
  if (toRate < fromRate) for (let i = n - 1; i > 0; i--) src[i] = (src[i] + src[i - 1]) / 2;
  const outLen = Math.floor((n * toRate) / fromRate);
  const out = Buffer.alloc(outLen * 2);
  const step = fromRate / toRate;
  for (let j = 0; j < outLen; j++) {
    const x = j * step;
    const i = Math.floor(x);
    const f = x - i;
    const v = src[i] * (1 - f) + (src[Math.min(i + 1, n - 1)] ?? 0) * f;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), j * 2);
  }
  return out;
}

// ---------- phone lines: G.711 μ-law at 8 kHz (Twilio's audio/x-mulaw) ----------
const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const MULAW_EXP = new Uint8Array(256).map((_, i) => (i ? Math.floor(Math.log2(i)) : 0));

/** PCM16 (any rate) → μ-law bytes, one per sample. */
export function mulawEncode(pcm: Buffer): Buffer {
  const n = pcm.length >> 1;
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    let s = pcm.readInt16LE(i * 2);
    const sign = s < 0 ? 0x80 : 0;
    if (sign) s = -s;
    if (s > MULAW_CLIP) s = MULAW_CLIP;
    s += MULAW_BIAS;
    const exponent = MULAW_EXP[(s >> 7) & 0xff];
    const mantissa = (s >> (exponent + 3)) & 0x0f;
    out[i] = ~(sign | (exponent << 4) | mantissa) & 0xff;
  }
  return out;
}

/** μ-law bytes → PCM16 at the same rate. */
export function mulawDecode(bytes: Uint8Array): Buffer {
  const out = Buffer.alloc(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    const u = ~bytes[i] & 0xff;
    const exponent = (u >> 4) & 0x07;
    const sample = (((u & 0x0f) << 3) + MULAW_BIAS << exponent) - MULAW_BIAS;
    out.writeInt16LE(u & 0x80 ? -sample : sample, i * 2);
  }
  return out;
}

/** A phone line's audio (μ-law 8 kHz) → the engine's (PCM16 16 kHz), and back. */
export const fromPhone = (mulaw: Uint8Array): Buffer => resample(mulawDecode(mulaw), 8000, SAMPLE_RATE);
export const toPhone = (pcm: Buffer): Buffer => mulawEncode(resample(pcm, SAMPLE_RATE, 8000));
