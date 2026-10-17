// The microphone, on the audio thread: 16 kHz PCM16 in 20 ms frames (320 samples), each with
// its peak (for the orb). Loaded by audio.ts with audioWorklet.addModule (served as JavaScript).
// Muted: zeros, so the line stays open and the timing doesn't change.

// The AudioWorklet scope's globals (TypeScript's DOM library doesn't have them).
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

const FRAME = 320;

class Mic extends AudioWorkletProcessor {
  ratio = sampleRate / 16000;
  pos = 0;
  buf = new Int16Array(FRAME);
  n = 0;
  muted = false;

  constructor() {
    super();
    this.port.onmessage = (e: MessageEvent<{ muted?: boolean }>) => { this.muted = Boolean(e.data.muted); };
  }

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    let peak = 0;
    for (; this.pos < ch.length; this.pos += this.ratio) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const a = ch[i] ?? 0, b = i + 1 < ch.length ? ch[i + 1] ?? a : a;
      const s = this.muted ? 0 : Math.max(-1, Math.min(1, a + (b - a) * f));
      peak = Math.max(peak, Math.abs(s));
      this.buf[this.n++] = s * 32767;
      if (this.n === FRAME) { this.port.postMessage({ frame: this.buf.slice(0), peak }); this.n = 0; peak = 0; }
    }
    this.pos -= ch.length;
    return true;
  }
}
registerProcessor("mic", Mic);

export {};
