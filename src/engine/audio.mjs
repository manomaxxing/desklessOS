// Audio plumbing. Inside the engine everything is 16-bit little-endian mono PCM
// at 16 kHz, which is also Dial's `l16_16000` and what Fish returns for
// `format: "pcm", sample_rate: 16000`. So no codecs on the hot path.

export const SAMPLE_RATE = 16000;
export const BYTES_PER_MS = (SAMPLE_RATE * 2) / 1000; // 32

/** RMS loudness of a PCM16 frame, 0..1. */
export function rms(pcm) {
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
export function wav(pcm, sampleRate = SAMPLE_RATE) {
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

/** PCM16 payload of a WAV file (assumes the plain 44-byte-style layout; finds the data chunk). */
export function wavData(buf) {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") return { pcm: buf.subarray(off + 8, off + 8 + size), sampleRate: buf.readUInt32LE(24) };
    off += 8 + size + (size & 1);
  }
  throw new Error("no data chunk in wav");
}

/** The same PCM16, louder or quieter (0.5 ≈ -6 dB), clipped to range. */
export function gain(pcm, factor) {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i + 1 < pcm.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * factor))), i);
  return out;
}

/** Silence of the given length. */
export function silence(ms) {
  return Buffer.alloc(Math.round(ms * BYTES_PER_MS));
}

/** Splits PCM into frames of `ms` milliseconds (last one may be shorter). */
export function* frames(pcm, ms = 20) {
  const size = Math.round(ms * BYTES_PER_MS);
  for (let i = 0; i < pcm.length; i += size) yield pcm.subarray(i, Math.min(i + size, pcm.length));
}

/** Duration in ms of a PCM16 buffer at 16 kHz. */
export function durationMs(pcm) {
  return pcm.length / BYTES_PER_MS;
}

/** Linear resample of PCM16 mono (light smoothing first when downsampling). Good enough for speech. */
export function resample(pcm, fromRate, toRate) {
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
