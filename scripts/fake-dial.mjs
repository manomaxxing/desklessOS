// A scripted phone call without a phone: plays Dial's side of the protocol.
// Synthesises the caller's lines with Fish (a different voice), streams them
// in real time like a phone line, paces the agent's audio, echoes marks, and
// saves what the agent said.
//
//   npm run fake-dial -- --say "Ich komm grad von der Frau Müller in Haching…" --say "Passt."
//   npm run fake-dial -- --url wss://<host>/dial --signed --say "…"     (deployed, signed like Dial)
//   npm run fake-dial -- --wav caller.wav                                (your own 16 kHz recording)
//   npm run fake-dial -- --say "Ich komm grad von … [pause 3] … und die will ein neues Bad."   (a thinking pause mid-line)

import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import WebSocket from "ws";
import { createFish } from "../src/engine/fish.mjs";
import { wav, wavData, silence, frames, durationMs } from "../src/engine/audio.mjs";

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const lines = args.flatMap((a, i) => (a === "--say" ? [args[i + 1]] : []));
const base = opt("--url", "ws://localhost:8787/dial");
const signed = args.includes("--signed");
const lang = opt("--lang", "en");
// Mode, like the selector: --engine cascade|live  --model <gemini>  --mask typing|filler|none  --live-model <door:model>  --live-voice Kore
const config = Object.fromEntries(Object.entries({ engine: opt("--engine"), model: opt("--model"), mask: opt("--mask"), tts: opt("--tts"), liveModel: opt("--live-model"), liveVoice: opt("--live-voice") }).filter(([, v]) => v));
const callerVoice = opt("--voice", process.env.FISH_CALLER_VOICE || (lang === "en" ? "536d3a5e000945adb7038665781a4aca" /* Ethan */ : "a20517d0d23048319e4ced960899187e" /* Ben */));
const callId = `fake-${Date.now().toString(36)}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Caller audio: Fish lines or a WAV file.
const fish = createFish({ ...process.env, FISH_VOICE: callerVoice, FISH_SPEED: "1" });
const utterances = [];
if (opt("--wav")) utterances.push(wavData(readFileSync(opt("--wav"))).pcm);
// "[pause 3]" inside a line: that many seconds of silence mid-sentence, like a caller thinking.
async function speak(text) {
  const parts = text.split(/\[pause\s+([\d.]+)\]/i);
  const pcm = [];
  for (const [i, part] of parts.entries()) {
    if (i % 2) pcm.push(silence(Number(part) * 1000));
    else if (part.trim()) pcm.push(await fish.synth(part.trim()));
  }
  return Buffer.concat(pcm);
}
for (const text of lines) utterances.push(await speak(text));
if (!utterances.length) utterances.push(await fish.synth("Hallo? Hörst du mich? Ich komm grad von einem Termin bei Herrn Huber in Pullach, Küche, Fliesenspiegel neu."));

const url = `${base.replace(/\/$/, "")}/${callId}${signed ? "" : "?dev=1"}`;
const headers = {};
if (signed) {
  const secret = process.env.DIAL_SIGNING_SECRET;
  if (!secret) throw new Error("--signed needs DIAL_SIGNING_SECRET");
  const t = Math.floor(Date.now() / 1000);
  headers["X-Dial-Signature"] = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${callId}`).digest("hex")}`;
}

const ws = new WebSocket(url, { headers });
const agentAudio = [];
let playhead = 0; // when the agent's queued audio will have finished playing (ms epoch)
let lastAgentAudio = 0;
let markTimers = [];
let lastSayAt = 0; // dev mode: when the agent last produced a real sentence
let ended = false;
const t0 = performance.now();
const stamp = () => `${((performance.now() - t0) / 1000).toFixed(1).padStart(5)}s`;

ws.on("message", data => {
  const f = JSON.parse(data);
  if (f.type === "media") {
    const pcm = Buffer.from(f.payload, "base64");
    agentAudio.push(pcm);
    playhead = Math.max(performance.now(), playhead) + durationMs(pcm);
    lastAgentAudio = performance.now();
  } else if (f.type === "mark") {
    markTimers.push(setTimeout(() => ws.send(JSON.stringify(f)), Math.max(0, playhead - performance.now())));
  } else if (f.type === "clear") {
    markTimers.forEach(clearTimeout); markTimers = []; playhead = performance.now();
    console.log(stamp(), "⟂ clear (barge-in)");
  } else if (f.type === "end_call") {
    console.log(stamp(), "☎ agent hung up");
    ended = true;
  } else if (f.type === "debug") {
    if (f.event === "heard") console.log(stamp(), `🗣  ${f.text}   [${f.lang}, next: ${f.next}]`);
    if (f.event === "say" && f.note?.startsWith("stage")) console.log(stamp(), `🤐 not spoken: ${f.text}`);
    else if (f.event === "say") { lastSayAt = performance.now(); if (f.delta) process.stdout.write(f.text); else console.log(stamp(), `🤖 ${f.text}`); }
    if (f.event === "fallback") console.log(stamp(), `↪ fallback ${f.what}: ${f.from} → ${f.to} (${f.reason})`);
    if (f.event === "retry") console.log(stamp(), `↻ retry → ${f.next}: ${f.reason}`);
    if (f.event === "live") console.log(stamp(), `◉ ${f.text}`);
    if (f.event === "latency") console.log(stamp(), `⏱  first audio ${f.firstAudioMs} ms (gemini first token ${f.firstTokenMs} ms)`);
    if (f.event === "filler") console.log(stamp(), "… filler");
    if (f.event === "note") console.log(stamp(), `📝 note: ${f.note.zusammenfassung || "(…)"}  missing: ${f.missing.join(", ") || "none"}`);
    if (f.event === "mask") console.log(stamp(), "⌨ typing");
    if (f.event === "vad") console.log(stamp(), f.speaking ? "🎙  speech start" : `🎙  speech end (${f.ms} ms)`);
    if (f.event === "barge_in") console.log(stamp(), f.falseStart ? "✋ barge-in: false start, he wasn't done" : "✋ barge-in");
    if (f.event === "dangling") console.log(stamp(), "↩  stopped mid-sentence: keep listening");
    if (f.event === "backchannel") console.log(stamp(), "… mhm (backchannel)");
    if (f.event === "nudge") console.log(stamp(), `⏲  ${f.kind}`);
    if (f.event === "saved") console.log(stamp(), `💾 saved ${f.id}`);
  } else if (f.type === "ping_pong") {
    /* our own pings echoed */
  }
});

await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); ws.once("unexpected-response", (_, res) => reject(new Error(`HTTP ${res.statusCode}`))); });
console.log(stamp(), "connected", url);
ws.send(JSON.stringify({ type: "call_connected", call_id: callId, direction: "inbound", from: lang === "en" ? "+14155550100" : "+4915100000000", to: "+10000000000", instruction: null, language: lang === "en" ? "en-US" : "de-DE", formats: { inbound: "l16_16000", outbound: "l16_16000" }, reconnect: false, ...(Object.keys(config).length ? { config } : {}) }));

// The phone line: one 20 ms frame every 20 ms, caller speech when queued, silence otherwise.
let queue = [];
let seq = 0;
const line = setInterval(() => {
  const frame = queue.length ? queue.shift() : silence(20);
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "media", payload: frame.toString("base64"), seq: ++seq }));
}, 20);
const ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: "ping_pong", timestamp: performance.now() })), 2000);

// Agent is done when it has said something since `since`, its audio has played
// out, and nothing new came for a while.
async function agentDone(since, quietMs = 1800, maxMs = 30000, audioOnly = signed) {
  const start = performance.now();
  while (performance.now() - start < maxMs && !ended) {
    // Dev mode knows real sentences (a filler isn't an answer); signed mode only hears audio.
    const spoke = audioOnly ? lastAgentAudio > since : lastSayAt > since && lastAgentAudio > lastSayAt;
    if (spoke && performance.now() > playhead + quietMs && performance.now() - lastAgentAudio > quietMs) return;
    await sleep(100);
  }
}

await agentDone(0, 1800, 30000, true); // greeting: pre-recorded audio, no "say" event
for (const [i, pcm] of utterances.entries()) {
  console.log(stamp(), `☏ caller speaks line ${i + 1} (${(durationMs(pcm) / 1000).toFixed(1)} s)`);
  queue.push(...frames(pcm, 20));
  while (queue.length) await sleep(50);
  await agentDone(performance.now(), 2500);
  if (ended) break;
}
if (!ended) await agentDone(performance.now(), 3000, 8000);
if (!ended) ws.send(JSON.stringify({ type: "call_ended", reason: "caller_hangup" }));
clearInterval(line); clearInterval(ping);
await sleep(500);
ws.close();
mkdirSync("data", { recursive: true });
writeFileSync("data/fake-dial-agent.wav", wav(Buffer.concat(agentAudio)));
console.log(stamp(), "done. agent audio → data/fake-dial-agent.wav");
process.exit(0);
