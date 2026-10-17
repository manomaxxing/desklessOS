// The call's audio: the microphone (through mic-worklet.ts) and the agent's voice, played
// paced like Dial (16 kHz PCM16, each piece queued after the last), with a level for the orb.

export interface CallAudio {
  /** The mic's frames (20 ms, PCM16) with their peak: from when the line is open. */
  onFrame: ((frame: Int16Array, peak: number) => void) | null;
  play(pcm: Int16Array): void;
  /** Stops what's playing and what's queued (he interrupted). */
  clear(): void;
  /** Milliseconds until what's queued has played (a mark is echoed then). */
  untilPlayed(): number;
  speaking(): boolean;
  /** How loud the agent is right now, 0…1. */
  outputLevel(): number;
  setMuted(muted: boolean): void;
  close(): void;
}

const abort = () => new DOMException("cancelled", "AbortError");

/** Opens the mic and the speaker; signal: the call was cancelled meanwhile (all of it is closed again). */
export async function openAudio(signal: AbortSignal): Promise<CallAudio> {
  const ctx = new AudioContext();
  let stream: MediaStream | null = null;
  const closeAll = () => {
    stream?.getTracks().forEach(t => t.stop());
    setTimeout(() => void ctx.close().catch(() => {}), 400); // the last words still play out
  };
  try {
    const outGain = ctx.createGain(), analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    outGain.connect(analyser);
    analyser.connect(ctx.destination);
    await ctx.audioWorklet.addModule(new URL("./mic-worklet.ts", import.meta.url).href);
    if (signal.aborted) throw abort();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    if (signal.aborted) throw abort();
    const node = new AudioWorkletNode(ctx, "mic");
    ctx.createMediaStreamSource(stream).connect(node);

    let nextTime = 0;
    let sources: AudioBufferSourceNode[] = [];
    const wave = new Uint8Array(analyser.fftSize);
    const audio: CallAudio = {
      onFrame: null,
      play(pcm) {
        const buf = ctx.createBuffer(1, pcm.length, 16000);
        const data = buf.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) data[i] = (pcm[i] ?? 0) / 32768;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(outGain);
        const at = Math.max(ctx.currentTime + 0.04, nextTime);
        src.start(at);
        nextTime = at + buf.duration;
        sources.push(src);
        src.onended = () => { sources = sources.filter(s => s !== src); };
      },
      clear() {
        for (const s of sources) { try { s.stop(); } catch { /* not started */ } }
        sources = [];
        nextTime = ctx.currentTime;
      },
      untilPlayed: () => Math.max(0, nextTime - ctx.currentTime) * 1000,
      speaking: () => sources.length > 0 && nextTime > ctx.currentTime,
      outputLevel() {
        analyser.getByteTimeDomainData(wave);
        let sum = 0;
        for (const b of wave) { const v = (b - 128) / 128; sum += v * v; }
        return Math.min(1, Math.sqrt(sum / wave.length) * 5);
      },
      setMuted: muted => node.port.postMessage({ muted }),
      close() {
        node.port.onmessage = null;
        audio.clear();
        closeAll();
      },
    };
    node.port.onmessage = (e: MessageEvent<{ frame: Int16Array; peak: number }>) => audio.onFrame?.(e.data.frame, e.data.peak);
    return audio;
  } catch (err) {
    closeAll();
    throw err;
  }
}

export function b64FromInt16(arr: Int16Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function int16FromB64(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1);
}
