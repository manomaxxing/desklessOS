import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVad, type Vad } from "../src/engine/vad.ts";
import { silence, frames, gain, rms, wav, wavData } from "../src/engine/audio.ts";
import { typingLoop } from "../src/engine/ambience.ts";
import { createTurnDetector, lastWindow, DEFAULT_MODEL } from "../src/engine/turn-detector.ts";

// A 200 Hz tone stands in for speech.
function tone(ms: number, amp = 0.2) {
  const n = Math.round(16 * ms);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 200 * i) / 16000) * amp * 32767), i * 2);
  return buf;
}
const feed = (vad: Vad, pcm: Buffer) => { for (const f of frames(pcm, 20)) vad.push(Buffer.from(f)); };

test("silence never starts speech", () => {
  let started = false;
  const vad = createVad({ onSpeechStart: () => { started = true; } });
  feed(vad, silence(3000));
  assert.equal(started, false);
});

test("speech then a pause ends the utterance, keeping the onset", () => {
  const events: string[] = [];
  let ms = 0;
  const vad = createVad({ onSpeechStart: () => events.push("start"), onSpeechEnd: pcm => { events.push("end"); ms = pcm.length / 32; }, endSilenceMs: 800 });
  feed(vad, silence(500));
  feed(vad, tone(1500));
  feed(vad, silence(1000));
  assert.deepEqual(events, ["start", "end"]);
  assert.ok(ms >= 1500 && ms <= 2200, `utterance ${ms} ms`);
});

test("a short pause mid-dictation does not end the turn", () => {
  const ends: number[] = [];
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
  const starts: string[] = [];
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

test("a pause inside the utterance is reported once, with the speech so far; his voice coming back too", () => {
  const events: [string, number?][] = [];
  const vad = createVad({ onPause: pcm => events.push(["pause", Math.round(pcm.length / 32)]), onResume: () => events.push(["resume"]), onSpeechEnd: pcm => events.push(["end", Math.round(pcm.length / 32)]), pauseMs: 350, endSilenceMs: 800 });
  feed(vad, tone(1000));
  feed(vad, silence(500));
  assert.equal(events.length, 1, "one report per pause");
  assert.equal(events[0][0], "pause");
  const sofar = events[0][1] ?? 0;
  assert.ok(sofar >= 1000 && sofar <= 1400, `the speech so far, with a bit of the pause: ${sofar} ms`);
  feed(vad, tone(600));
  assert.deepEqual(events[1], ["resume"], "he goes on");
  feed(vad, silence(1000));
  assert.deepEqual(events.map(e => e[0]), ["pause", "resume", "pause", "end"], "the next pause is reported again, then the end");
  assert.ok((events[3][1] ?? 0) >= 2000, "the end hands over the whole utterance");
  const quiet: number[] = [];
  const off = createVad({ onPause: () => quiet.push(1), endSilenceMs: 800 });
  feed(off, tone(800)); feed(off, silence(1000));
  assert.equal(quiet.length, 0, "pauseMs 0: no reports");
});

// ---------- audio files, the typing mask, Smart Turn's input ----------

test("a WAV's rate comes from its fmt chunk, also when a JUNK chunk comes first", () => {
  const plain = wav(tone(100), 8000);
  assert.equal(wavData(plain).sampleRate, 8000);
  const junk = Buffer.alloc(8 + 28);
  junk.write("JUNK", 0); junk.writeUInt32LE(28, 4);
  const withJunk = Buffer.concat([plain.subarray(0, 12), junk, plain.subarray(12)]);
  const { pcm, sampleRate } = wavData(withJunk);
  assert.equal(sampleRate, 8000, "not 'JUNK' read as a number");
  assert.deepEqual(pcm, tone(100));
});

test("TYPING_LEVEL_DB empty: the default level, not full scale", () => {
  const before = process.env.TYPING_LEVEL_DB;
  const peakDb = (pcm: Buffer) => { let peak = 0; for (let i = 0; i < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i))); return 20 * Math.log10(peak / 32767); };
  try {
    process.env.TYPING_LEVEL_DB = "";
    assert.ok(Math.abs(peakDb(typingLoop({ seconds: 2 })) + 27) < 0.5, "-27 dBFS");
    process.env.TYPING_LEVEL_DB = "-35";
    assert.ok(Math.abs(peakDb(typingLoop({ seconds: 2 })) + 35) < 0.5, "a set level still counts");
  } finally {
    if (before === undefined) delete process.env.TYPING_LEVEL_DB; else process.env.TYPING_LEVEL_DB = before;
  }
});

test("Smart Turn gets the last 8 s of a long turn, not all of it", () => {
  const long = Buffer.alloc(2 * 16000 * 60);
  for (let i = 0; i < long.length / 2; i++) long.writeInt16LE(i % 30000, i * 2);
  const sent = lastWindow(long);
  assert.equal(sent.byteLength, 2 * 16000 * 8, "8 s, not 60 s");
  assert.deepEqual(Buffer.from(sent), long.subarray(long.length - sent.byteLength), "the end of the turn");
  assert.equal(lastWindow(long.subarray(0, 1001)).byteLength, 1000, "whole samples only (a stray byte is dropped, as the features do)");
  const short = tone(500);
  const copy = lastWindow(short);
  assert.deepEqual(Buffer.from(copy), short, "a short turn goes whole");
  assert.notEqual(copy, short.buffer, "as a copy: transferring it leaves his audio alone");
});

let haveOrt = true;
try { await import("onnxruntime-node"); } catch { haveOrt = false; }
const haveModel = existsSync(DEFAULT_MODEL);

test("Smart Turn on a long turn hears the same as on its last 8 s; a bad TURN_THRESHOLD falls back", { skip: haveModel && haveOrt ? false : "no model or onnxruntime-node" }, async () => {
  const before = process.env.TURN_THRESHOLD;
  process.env.TURN_THRESHOLD = "about half";
  const det = await createTurnDetector({ timeoutMs: 10000 });
  if (before === undefined) delete process.env.TURN_THRESHOLD; else process.env.TURN_THRESHOLD = before;
  assert.ok(det);
  try {
    assert.equal(det.threshold, 0.5, "not NaN (every turn 'not done')");
    const turn = Buffer.concat([silence(12000), tone(3000), silence(300)]);
    const [whole, tail] = await Promise.all([det.predict(turn), det.predict(turn.subarray(turn.length - 2 * 16000 * 8))]);
    assert.ok(whole && tail);
    assert.equal(whole.probability, tail.probability);
  } finally { await det.close(); }
});

test("a model file that won't load means no detector, not a crash", { skip: haveOrt ? false : "no onnxruntime-node" }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "smart-turn-"));
  const modelPath = path.join(dir, "broken.onnx");
  writeFileSync(modelPath, "not a model");
  const logs: string[] = [];
  const det = await createTurnDetector({ modelPath, log: (...parts) => logs.push(parts.join(" ")) });
  assert.equal(det, null);
  assert.ok(logs.some(l => l.includes("didn't start")), logs.join("\n"));
});
