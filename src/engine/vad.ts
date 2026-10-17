// Energy voice-activity detection with an adaptive noise floor (car noise).
// Feeds on ~20 ms PCM16 frames; reports when speech starts and hands over the
// whole utterance when it ends. How long a pause ends a turn is set by the
// conversation: long while dictating, short for a yes/no.
// A short pause inside an utterance (pauseMs) is reported too, with the speech so far
// (onPause), and so is his voice coming back before the utterance ended (onResume):
// the session starts thinking at the pause and drops it if he goes on.

import { rms, durationMs } from "./audio.ts";

export interface VadOptions {
  onSpeechStart?: () => void;
  onSpeechEnd?: (pcm: Buffer) => void;
  onPause?: (pcm: Buffer) => void;
  onResume?: () => void;
  pauseMs?: number;
  startMs?: number;
  endSilenceMs?: number;
  preRollMs?: number;
  maxUtteranceMs?: number;
  minThreshold?: number;
  floorFactor?: number;
  interruptMs?: number;
}

export interface Vad {
  readonly speaking: boolean;
  readonly stirring: boolean;
  readonly level: { floor: number; threshold: number };
  setEndSilence(ms: number): void;
  setStartMs(ms: number): void;
  setStrict(on: boolean): void;
  setInterruptMs(ms: number): void;
  setPauseMs(ms: number): void;
  reset(): void;
  push(frame: Buffer): void;
}

export function createVad({
  onSpeechStart = () => {},
  onSpeechEnd = () => {},
  onPause = () => {}, // (pcm so far): a pause of pauseMs inside the utterance; at most once per pause
  onResume = () => {}, // he speaks again after a reported pause, before the utterance ended
  pauseMs = 0, // 0: no pause reports
  startMs = 200, // voiced audio needed to call it speech
  endSilenceMs = 1200, // pause that ends the utterance
  preRollMs = 300, // audio kept from before the start, so first syllables survive
  maxUtteranceMs = 120000,
  minThreshold = 0.012,
  floorFactor = 3,
  interruptMs = 500, // while the agent talks: this much loud speech before it counts (a "mhm" doesn't)
}: VadOptions = {}): Vad {
  let floor = 0.004;
  let speaking = false;
  let voicedMs = 0;
  let silenceMs = 0;
  let strict = false; // while the agent talks: a louder, longer start (barge-in)
  let preRoll: Buffer[] = [];
  let preRollLen = 0;
  let utterance: Buffer[] = [];
  let utteranceMs = 0;
  let pauseReported = false;
  // The utterance so far, with ~250 ms of its trailing pause (as onSpeechEnd hands it over).
  const trimmed = () => {
    let end = utterance.length;
    for (let drop = Math.max(0, silenceMs - 250); drop > 0 && end > 0; end--) drop -= durationMs(utterance[end - 1]);
    return Buffer.concat(utterance.slice(0, end));
  };

  const threshold = () => Math.max(minThreshold, floor * floorFactor) * (strict ? 1.8 : 1);

  return {
    get speaking() { return speaking; },
    /** Voice is building up, not yet enough to call it speech (he may be starting again). */
    get stirring() { return !speaking && voicedMs > 0; },
    get level() { return { floor, threshold: threshold() }; },
    setEndSilence(ms) { endSilenceMs = ms; },
    setStartMs(ms) { startMs = ms; }, // shorter while waiting for "ja" / "passt"
    setStrict(on) { strict = on; },
    setInterruptMs(ms) { interruptMs = ms; }, // shorter right after the agent starts: he may not have been done
    setPauseMs(ms) { pauseMs = ms; },
    /** Drops whatever is in progress (after a hang-up or reset). */
    reset() {
      speaking = false; voicedMs = 0; silenceMs = 0; utterance = []; utteranceMs = 0; preRoll = []; preRollLen = 0; pauseReported = false;
    },
    push(frame) {
      const ms = durationMs(frame);
      const level = rms(frame);
      const voiced = level > threshold();
      if (!speaking) {
        if (!voiced) floor = floor * 0.97 + level * 0.03; // learn the background only from non-speech
        preRoll.push(frame);
        preRollLen += ms;
        let old = 0; // the oldest frames beyond what's kept (never the newest)
        while (preRollLen > preRollMs + (strict ? interruptMs : startMs) && old < preRoll.length - 1) preRollLen -= durationMs(preRoll[old++]);
        preRoll.splice(0, old);
        voicedMs = voiced ? voicedMs + ms : Math.max(0, voicedMs - ms * 0.5);
        if (voicedMs >= (strict ? interruptMs : startMs)) {
          speaking = true;
          silenceMs = 0;
          utterance = preRoll;
          utteranceMs = preRollLen;
          preRoll = [];
          preRollLen = 0;
          pauseReported = false;
          onSpeechStart();
        }
        return;
      }
      utterance.push(frame);
      utteranceMs += ms;
      silenceMs = voiced ? 0 : silenceMs + ms;
      if (voiced && pauseReported) { pauseReported = false; onResume(); }
      if (silenceMs >= endSilenceMs || utteranceMs >= maxUtteranceMs) {
        const pcm = trimmed(); // ~250 ms of the trailing pause kept, the rest dropped
        pauseReported = false;
        speaking = false;
        voicedMs = 0;
        utterance = [];
        utteranceMs = 0;
        onSpeechEnd(pcm);
        return;
      }
      if (pauseMs && !pauseReported && silenceMs >= pauseMs && pauseMs < endSilenceMs) {
        pauseReported = true;
        onPause(trimmed());
      }
    },
  };
}
