// Whisper's log-mel features, as Smart Turn v3 expects them (transformers'
// WhisperFeatureExtractor(chunk_length=8) with do_normalize, after Smart Turn's
// own step: keep the last 8 s, pad silence at the START, so his last words are
// always at the end of the window).
//   16 kHz → 8 s window → zero mean / unit variance → STFT (n_fft 400, hop 160,
//   periodic Hann, centered with reflect padding) → power → 80 Slaney mel filters
//   (0–8 kHz, Slaney-normalised) → log10 (floor 1e-10) → at most 8 below the max
//   → (x + 4) / 4. Output: Float32Array [80 mel × 800 frames], row-major.

export const SR = 16000;
const N_FFT = 400;
const HOP = 160;
export const N_MELS = 80;
const WINDOW_S = 8;
export const N_SAMPLES = WINDOW_S * SR;
export const N_FRAMES = N_SAMPLES / HOP; // 800 (the STFT's last frame is dropped)
const BINS = N_FFT / 2 + 1; // 201

// ---------- constants, built once ----------
const hzToMel = (f: number) => (f < 1000 ? (3 * f) / 200 : 15 + (Math.log(f / 1000) * 27) / Math.log(6.4));
const melToHz = (m: number) => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp(((m - 15) * Math.log(6.4)) / 27));

/** [mel][bin] weights, Slaney scale and normalisation (transformers' mel_filter_bank). */
export function melFilterBank(): Float32Array {
  const fftFreqs = Array.from({ length: BINS }, (_, k) => (k * (SR / 2)) / (BINS - 1));
  const lo = hzToMel(0), hi = hzToMel(SR / 2);
  const f = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz(lo + ((hi - lo) * i) / (N_MELS + 1)));
  const out = new Float32Array(N_MELS * BINS);
  for (let m = 0; m < N_MELS; m++) {
    const enorm = 2 / (f[m + 2] - f[m]);
    for (let k = 0; k < BINS; k++) {
      const down = (fftFreqs[k] - f[m]) / (f[m + 1] - f[m]);
      const up = (f[m + 2] - fftFreqs[k]) / (f[m + 2] - f[m + 1]);
      out[m * BINS + k] = Math.max(0, Math.min(down, up)) * enorm;
    }
  }
  return out;
}

const MEL = melFilterBank();
const HANN = Float64Array.from({ length: N_FFT }, (_, n) => 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT)); // periodic
const COS = new Float64Array(BINS * N_FFT);
const SIN = new Float64Array(BINS * N_FFT);
for (let k = 0; k < BINS; k++) {
  for (let n = 0; n < N_FFT; n++) {
    const a = (2 * Math.PI * ((k * n) % N_FFT)) / N_FFT;
    COS[k * N_FFT + n] = Math.cos(a);
    SIN[k * N_FFT + n] = Math.sin(a);
  }
}

/** PCM16 LE (any length, 16 kHz) → the model's 8 s window of floats: last 8 s, silence padded in front. */
export function windowOf(pcm: Buffer): { samples: Float32Array; padded: number } {
  const n = pcm.length >> 1;
  const out = new Float32Array(N_SAMPLES);
  const take = Math.min(n, N_SAMPLES);
  for (let i = 0; i < take; i++) out[N_SAMPLES - take + i] = pcm.readInt16LE((n - take + i) * 2) / 32768;
  return { samples: out, padded: N_SAMPLES - take };
}

/** The 8 s window (Float32Array of N_SAMPLES) → features [80 × 800]. `padded`: leading samples that are padding. */
export function logMel(samples: Float32Array, padded = 0): Float32Array {
  // zero mean, unit variance over the whole window (padding included, as in the reference)
  let mean = 0;
  for (let i = 0; i < N_SAMPLES; i++) mean += samples[i];
  mean /= N_SAMPLES;
  let v = 0;
  for (let i = 0; i < N_SAMPLES; i++) v += (samples[i] - mean) ** 2;
  const scale = 1 / Math.sqrt(v / N_SAMPLES + 1e-7);
  const x = new Float64Array(N_SAMPLES + N_FFT); // reflect-padded by n_fft/2 on both sides
  const half = N_FFT / 2;
  for (let i = 0; i < N_SAMPLES; i++) x[i + half] = (samples[i] - mean) * scale;
  for (let i = 0; i < half; i++) {
    x[half - 1 - i] = x[half + 1 + i];
    x[half + N_SAMPLES + i] = x[half + N_SAMPLES - 2 - i];
  }

  const out = new Float32Array(N_MELS * N_FRAMES);
  const power = new Float64Array(BINS);
  const frame = new Float64Array(N_FFT);
  let cached: Float64Array | null = null; // frames wholly inside the leading padding are all the same
  const lastPaddedFrame = Math.floor((padded - N_FFT + half) / HOP); // frame t covers x[t*HOP … t*HOP+N_FFT) → samples t*HOP-half …
  let max = -Infinity;
  for (let t = 0; t < N_FRAMES; t++) {
    let mel: Float64Array;
    if (t >= 1 && t <= lastPaddedFrame && cached) mel = cached;
    else {
      const off = t * HOP;
      for (let n = 0; n < N_FFT; n++) frame[n] = x[off + n] * HANN[n];
      for (let k = 0; k < BINS; k++) {
        let re = 0, im = 0;
        const row = k * N_FFT;
        for (let n = 0; n < N_FFT; n++) { re += frame[n] * COS[row + n]; im -= frame[n] * SIN[row + n]; }
        power[k] = re * re + im * im;
      }
      mel = new Float64Array(N_MELS);
      for (let m = 0; m < N_MELS; m++) {
        let s = 0;
        const row = m * BINS;
        for (let k = 0; k < BINS; k++) s += MEL[row + k] * power[k];
        mel[m] = Math.log10(Math.max(s, 1e-10));
      }
      if (t >= 1 && t <= lastPaddedFrame) cached = mel;
    }
    for (let m = 0; m < N_MELS; m++) {
      out[m * N_FRAMES + t] = mel[m];
      if (mel[m] > max) max = mel[m];
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], max - 8) + 4) / 4;
  return out;
}

/** PCM16 16 kHz (his turn so far) → Smart Turn's input features. */
export const turnFeatures = (pcm: Buffer): Float32Array => { const { samples, padded } = windowOf(pcm); return logMel(samples, padded); };
