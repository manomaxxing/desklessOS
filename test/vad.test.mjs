import { test } from "node:test";
import assert from "node:assert/strict";
import { createVad } from "../src/engine/vad.mjs";
import { silence, frames, gain, rms } from "../src/engine/audio.mjs";

// A 200 Hz tone stands in for speech.
function tone(ms, amp = 0.2) {
  const n = Math.round(16 * ms);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 200 * i) / 16000) * amp * 32767), i * 2);
  return buf;
}
const feed = (vad, pcm) => { for (const f of frames(pcm, 20)) vad.push(Buffer.from(f)); };

test("silence never starts speech", () => {
  let started = false;
  const vad = createVad({ onSpeechStart: () => { started = true; } });
  feed(vad, silence(3000));
  assert.equal(started, false);
});

test("speech then a pause ends the utterance, keeping the onset", () => {
  const events = [];
  const vad = createVad({ onSpeechStart: () => events.push("start"), onSpeechEnd: pcm => events.push(pcm.length / 32), endSilenceMs: 800 });
  feed(vad, silence(500));
  feed(vad, tone(1500));
  feed(vad, silence(1000));
  assert.equal(events[0], "start");
  assert.ok(events[1] >= 1500 && events[1] <= 2200, `utterance ${events[1]} ms`);
});

test("a short pause mid-dictation does not end the turn", () => {
  const ends = [];
  const vad = createVad({ onSpeechEnd: pcm => ends.push(pcm.length), endSilenceMs: 1200 });
  feed(vad, tone(800));
  feed(vad, silence(700));
  feed(vad, tone(800));
  assert.equal(ends.length, 0);
  feed(vad, silence(1400));
  assert.equal(ends.length, 1);
});

test("strict mode (agent talking) needs louder, longer speech", () => {
  let started = false;
  const vad = createVad({ onSpeechStart: () => { started = true; } });
  vad.setStrict(true);
  feed(vad, tone(220, 0.015)); // quiet and short: ignored while the agent talks
  assert.equal(started, false);
  feed(vad, tone(700, 0.3));
  assert.equal(started, true);
});

test("right after the agent starts, a shorter burst cuts it off (false start)", () => {
  const starts = [];
  const vad = createVad({ onSpeechStart: () => starts.push("start"), interruptMs: 500 });
  vad.setStrict(true);
  feed(vad, tone(380, 0.3)); // 380 ms: not enough for a normal barge-in
  assert.equal(starts.length, 0);
  feed(vad, silence(600));
  vad.setInterruptMs(300);
  feed(vad, tone(380, 0.3)); // the same burst in the false-start window
  assert.equal(starts.length, 1);
});

test("gain scales and clips PCM", () => {
  const loud = tone(100, 0.4);
  assert.ok(Math.abs(rms(gain(loud, 0.5)) - rms(loud) / 2) < 0.002, "half as loud");
  assert.equal(gain(Buffer.from([0xff, 0x7f]), 2).readInt16LE(0), 32767, "clipped, not wrapped");
});
