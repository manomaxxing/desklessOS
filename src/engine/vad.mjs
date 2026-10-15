// Energy voice-activity detection with an adaptive noise floor (car noise).
// Feeds on ~20 ms PCM16 frames; reports when speech starts and hands over the
// whole utterance when it ends. How long a pause ends a turn is set by the
// conversation: long while dictating, short for a yes/no.

import { rms, durationMs } from "./audio.mjs";

export function createVad({
  onSpeechStart = () => {},
  onSpeechEnd = () => {},
  startMs = 200, // voiced audio needed to call it speech
  endSilenceMs = 1200, // pause that ends the utterance
  preRollMs = 300, // audio kept from before the start, so first syllables survive
  maxUtteranceMs = 120000,
  minThreshold = 0.012,
  floorFactor = 3,
  interruptMs = 500, // while the agent talks: this much loud speech before it counts (a "mhm" doesn't)
} = {}) {
  let floor = 0.004;
  let speaking = false;
  let voicedMs = 0;
  let silenceMs = 0;
  let strict = false; // while the agent talks: a louder, longer start (barge-in)
  let preRoll = [];
  let preRollLen = 0;
  let utterance = [];
  let utteranceMs = 0;

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
    /** Drops whatever is in progress (after a hang-up or reset). */
    reset() {
      speaking = false; voicedMs = 0; silenceMs = 0; utterance = []; utteranceMs = 0; preRoll = []; preRollLen = 0;
    },
    push(frame) {
      const ms = durationMs(frame);
      const level = rms(frame);
      const voiced = level > threshold();
      if (!speaking) {
        if (!voiced) floor = floor * 0.97 + level * 0.03; // learn the background only from non-speech
        preRoll.push(frame);
        preRollLen += ms;
        while (preRollLen > preRollMs + (strict ? interruptMs : startMs) && preRoll.length > 1) preRollLen -= durationMs(preRoll.shift());
        voicedMs = voiced ? voicedMs + ms : Math.max(0, voicedMs - ms * 0.5);
        if (voicedMs >= (strict ? interruptMs : startMs)) {
          speaking = true;
          silenceMs = 0;
          utterance = preRoll;
          utteranceMs = preRollLen;
          preRoll = [];
          preRollLen = 0;
          onSpeechStart();
        }
        return;
      }
      utterance.push(frame);
      utteranceMs += ms;
      silenceMs = voiced ? 0 : silenceMs + ms;
      if (silenceMs >= endSilenceMs || utteranceMs >= maxUtteranceMs) {
        // Keep ~250 ms of the trailing pause, drop the rest.
        let drop = Math.max(0, silenceMs - 250);
        while (drop > 0 && utterance.length) drop -= durationMs(utterance.pop());
        const pcm = Buffer.concat(utterance);
        speaking = false;
        voicedMs = 0;
        utterance = [];
        utteranceMs = 0;
        onSpeechEnd(pcm);
      }
    },
  };
}
