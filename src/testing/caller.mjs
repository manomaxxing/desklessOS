// A scripted phone call without a phone: plays Dial's side of the protocol.
// Synthesises the caller's lines with Fish (a different voice), streams them
// in real time like a phone line, paces the agent's audio, echoes marks, and
// collects the server's debug events. Used by scripts/fake-dial.mjs (one call,
// printed) and scripts/regress.mjs (scenarios with assertions).
//
// "[pause 3]" inside a line: that many seconds of silence mid-sentence.

import { createHmac } from "node:crypto";
import WebSocket from "ws";
import { createFish } from "../engine/fish.mjs";
import { silence, frames, durationMs } from "../engine/audio.mjs";
import { locales } from "../locale/index.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Caller audio for one line; "[pause N]" becomes N seconds of silence. */
export async function speakLine(fish, text) {
  const parts = text.split(/\[pause\s+([\d.]+)\]/i);
  const pcm = [];
  for (const [i, part] of parts.entries()) {
    if (i % 2) pcm.push(silence(Number(part) * 1000));
    else if (part.trim()) pcm.push(await fish.synth(part.trim()));
  }
  return Buffer.concat(pcm);
}

/**
 * Runs one call against a server. Returns { callId, events, agentAudio, ended }.
 * `utterances` (PCM buffers) can replace `says`. `onEvent(ev, at)` sees every
 * debug event as it happens (dev mode only; signed calls get no debug frames).
 */
export async function runCall({
  url = "ws://localhost:8787/dial", lang = locales().defaultId, says = [], utterances = null, config = {}, signed = false,
  voice = null, from = null, to = "+10000000000", language = null, onEvent = () => {}, onLine = () => {},
  callId: givenId = null, direction = "inbound", userId = null, speakFirst = false,
}) {
  const callId = givenId ?? `fake-${Date.now().toString(36)}`;
  // The caller's voice and number come from the locale pack's "testing" section.
  const testing = locales().get(lang).testing ?? {};
  const callerVoice = voice || process.env.FISH_CALLER_VOICE || testing.callerVoice;
  const fish = createFish({ ...process.env, FISH_VOICE: callerVoice, FISH_SPEED: "1" });
  const lines = utterances ?? [];
  if (!utterances) for (const text of says) lines.push(await speakLine(fish, text));

  const target = `${url.replace(/\/$/, "")}/${callId}${signed ? "" : "?dev=1"}`;
  const headers = {};
  if (signed) {
    const secret = process.env.DIAL_SIGNING_SECRET;
    if (!secret) throw new Error("signed calls need DIAL_SIGNING_SECRET");
    const t = Math.floor(Date.now() / 1000);
    headers["X-Dial-Signature"] = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${callId}`).digest("hex")}`;
  }

  const ws = new WebSocket(target, { headers });
  const events = [];
  const agentAudio = [];
  let playhead = 0; // when the agent's queued audio will have finished playing
  let lastAgentAudio = 0;
  let markTimers = [];
  let lastSayAt = 0; // dev mode: when the agent last produced a real sentence
  let ended = false;
  const t0 = performance.now();
  const at = () => (performance.now() - t0) / 1000;
  const record = ev => { events.push({ ...ev, at: at() }); onEvent(ev, at()); };

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
      record({ event: "clear" });
    } else if (f.type === "end_call") {
      ended = true;
      record({ event: "end_call" });
    } else if (f.type === "debug") {
      if (f.event === "say" && !f.note?.startsWith("stage")) lastSayAt = performance.now();
      const { type, ...ev } = f;
      record(ev);
    }
  });

  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); ws.once("unexpected-response", (_, res) => reject(new Error(`HTTP ${res.statusCode}`))); });
  record({ event: "open", url: target });
  ws.send(JSON.stringify({
    type: "call_connected", call_id: callId, direction, ...(userId ? { user_id: userId } : {}),
    from: from || testing.from, to, instruction: null,
    language: language ?? null, formats: { inbound: "l16_16000", outbound: "l16_16000" }, reconnect: false,
    ...(Object.keys(config).length ? { config } : {}),
  }));

  // The phone line: one 20 ms frame every 20 ms, caller speech when queued, silence otherwise.
  const queue = [];
  let seq = 0;
  const line = setInterval(() => {
    const frame = queue.length ? queue.shift() : silence(20);
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: "media", payload: frame.toString("base64"), seq: ++seq }));
  }, 20);
  const ping = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: "ping_pong", timestamp: performance.now() })), 2000);

  // The agent is done when it has said something since `since`, its audio has
  // played out, and nothing new came for a while.
  async function agentDone(since, quietMs = 1800, maxMs = 30000, audioOnly = signed) {
    const start = performance.now();
    while (performance.now() - start < maxMs && !ended) {
      // Dev mode knows real sentences (a filler isn't an answer); signed mode only hears audio.
      const spoke = audioOnly ? lastAgentAudio > since : lastSayAt > since && lastAgentAudio > lastSayAt;
      if (spoke && performance.now() > playhead + quietMs && performance.now() - lastAgentAudio > quietMs) return;
      await sleep(100);
    }
  }

  try {
    // He called: the greeting comes first (pre-recorded audio, no "say" event). We were called: we say hello first.
    if (!speakFirst) await agentDone(0, 1800, 30000, true);
    else await sleep(400);
    for (const [i, pcm] of lines.entries()) {
      onLine(i, pcm, at());
      record({ event: "caller_line", line: i + 1, seconds: durationMs(pcm) / 1000 });
      queue.push(...frames(pcm, 20));
      while (queue.length) await sleep(50);
      await agentDone(performance.now(), 2500);
      if (ended) break;
    }
    if (!ended) await agentDone(performance.now(), 3000, 8000);
    if (!ended) ws.send(JSON.stringify({ type: "call_ended", reason: "caller_hangup" }));
  } finally {
    clearInterval(line); clearInterval(ping);
    await sleep(500);
    ws.close();
  }
  return { callId, events, agentAudio: Buffer.concat(agentAudio), ended };
}

/**
 * Waits to be called, like a phone: registers `number` with the server's fake carrier
 * (OUTBOUND=fake), runs `beforeRing()` once it's listening (e.g. approve the request that
 * makes the call), answers the ring and plays `says` as the person picking up. `reject`:
 * "no-answer" | "busy" to not pick up.
 */
export async function answerCall({ base = "ws://localhost:8787", number, token = "", beforeRing = async () => {}, timeoutMs = 120000, reject = null, ...call }) {
  const phone = new WebSocket(`${base}/fake/phone?number=${encodeURIComponent(number)}${token ? `&token=${encodeURIComponent(token)}` : ""}`);
  await new Promise((resolve, fail) => { phone.once("open", resolve); phone.once("error", fail); });
  let timer;
  const ring = new Promise((resolve, fail) => {
    timer = setTimeout(() => fail(new Error(`nobody called ${number} within ${timeoutMs / 1000} s`)), timeoutMs);
    phone.on("message", data => { const m = JSON.parse(data); if (m.type === "ring") { clearTimeout(timer); resolve(m); } });
  });
  ring.catch(() => {}); // awaited below; never left dangling if beforeRing fails
  try {
    await beforeRing();
    const r = await ring;
    if (reject) { phone.send(JSON.stringify({ type: "reject", call_id: r.call_id, reason: reject })); return { ring: r, rejected: reject, events: [] }; }
    phone.send(JSON.stringify({ type: "answer", call_id: r.call_id }));
    const result = await runCall({ url: `${base}/dial`, ...call, callId: r.call_id, direction: "outbound", userId: r.user_id, from: r.from, to: number, speakFirst: true });
    return { ring: r, ...result };
  } finally {
    clearTimeout(timer);
    phone.close();
  }
}

/**
 * A call through the Twilio path, without Twilio: posts the signed voice webhook like
 * Twilio would, opens the media stream the TwiML names, and plays `says` as μ-law
 * 8 kHz in 20 ms frames, echoing marks once their audio has "played". The server
 * needs the same TWILIO_AUTH_TOKEN and PUBLIC_URL = `base`. No debug events on this
 * path: the result is checked through the server's API. Returns { callId, events, agentAudio }.
 */
export async function runTwilioCall({ base = "http://localhost:8787", authToken, says = [], lang = locales().defaultId, from = null, to = "+4930000000", voice = null }) {
  const { twilioSignature } = await import("../telephony/twilio.mjs");
  const { toPhone, fromPhone } = await import("../engine/audio.mjs");
  const testing = locales().get(lang).testing ?? {};
  const fish = createFish({ ...process.env, FISH_VOICE: voice || process.env.FISH_CALLER_VOICE || testing.callerVoice, FISH_SPEED: "1" });
  const lines = [];
  for (const text of says) lines.push(await speakLine(fish, text));
  const callSid = `CA${Date.now().toString(16)}sim`;
  const params = { AccountSid: "ACsim", CallSid: callSid, From: from || testing.from, To: to, CallStatus: "ringing", Direction: "inbound" };
  const res = await fetch(`${base}/twilio/voice`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": twilioSignature(`${base}/twilio/voice`, params, authToken) }, body: new URLSearchParams(params) });
  if (!res.ok) throw new Error(`voice webhook ${res.status}`);
  const twiml = await res.text();
  const streamUrl = /<Stream url="([^"]+)"/.exec(twiml)?.[1];
  const custom = Object.fromEntries([...twiml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)].map(m => [m[1], m[2].replace(/&amp;/g, "&")]));
  const ws = new WebSocket(streamUrl);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const events = [];
  const agentAudio = [];
  let playhead = 0;
  let lastAudio = 0;
  let closed = false;
  const t0 = performance.now();
  ws.on("message", data => {
    const m = JSON.parse(data);
    if (m.event === "media") {
      const pcm = fromPhone(Buffer.from(m.media.payload, "base64"));
      agentAudio.push(pcm);
      playhead = Math.max(performance.now(), playhead) + durationMs(pcm);
      lastAudio = performance.now();
    } else if (m.event === "mark") {
      setTimeout(() => ws.readyState === 1 && ws.send(JSON.stringify({ event: "mark", streamSid: "MZsim", mark: m.mark })), Math.max(0, playhead - performance.now()));
    } else if (m.event === "clear") {
      playhead = performance.now();
      events.push({ event: "clear", at: (performance.now() - t0) / 1000 });
    }
  });
  ws.on("close", () => { closed = true; events.push({ event: "end_call", at: (performance.now() - t0) / 1000 }); });
  ws.send(JSON.stringify({ event: "connected", protocol: "Call", version: "1.0.0" }));
  ws.send(JSON.stringify({ event: "start", streamSid: "MZsim", start: { accountSid: "ACsim", callSid, streamSid: "MZsim", tracks: ["inbound"], customParameters: custom, mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 } } }));
  const quietFor = async (ms, max = 30000) => {
    const start = performance.now();
    while (!closed && performance.now() - start < max) {
      if (lastAudio && performance.now() > playhead + ms && performance.now() - lastAudio > ms) return;
      await sleep(100);
    }
  };
  // The line: one 20 ms μ-law frame every 20 ms, speech when queued, silence otherwise.
  const queue = [];
  const silent = toPhone(silence(20));
  const line = setInterval(() => { if (ws.readyState === 1) ws.send(JSON.stringify({ event: "media", streamSid: "MZsim", media: { track: "inbound", payload: (queue.shift() ?? silent).toString("base64") } })); }, 20);
  try {
    await quietFor(1800); // the greeting
    for (const pcm of lines) {
      for (const f of frames(pcm, 20)) queue.push(toPhone(f));
      while (queue.length) await sleep(50);
      lastAudio = 0;
      await quietFor(2500);
      if (closed) break;
    }
    if (!closed) { await quietFor(3000, 8000); ws.send(JSON.stringify({ event: "stop", streamSid: "MZsim", stop: { accountSid: "ACsim", callSid } })); }
  } finally {
    clearInterval(line);
    await sleep(300);
    ws.close();
  }
  return { callId: callSid, events, agentAudio: Buffer.concat(agentAudio) };
}

/** One line per debug event, for the console. Returns null for events not worth printing. */
export function describeEvent(f) {
  switch (f.event) {
    case "open": return `connected ${f.url}`;
    case "caller_line": return `☏ caller speaks line ${f.line} (${f.seconds.toFixed(1)} s)`;
    case "clear": return "⟂ clear (barge-in)";
    case "end_call": return "☎ agent hung up";
    case "heard": return `🗣  ${f.text}   [${f.lang}, next: ${f.next}]`;
    case "say": return f.note?.startsWith("stage") ? `🤐 not spoken: ${f.text}` : `🤖 ${f.text}`;
    case "fallback": return `↪ fallback ${f.what}: ${f.from} → ${f.to} (${f.reason})`;
    case "retry": return `↻ retry → ${f.next}: ${f.reason}`;
    case "live": return `◉ ${f.text}`;
    case "latency": return `⏱  first audio ${f.firstAudioMs} ms (gemini first token ${f.firstTokenMs} ms)`;
    case "filler": return "… filler";
    case "note": return `📝 note: ${f.note?.summary || f.note?.zusammenfassung || "(…)"}  missing: ${f.missing?.join(", ") || "none"}`;
    case "mask": return "⌨ typing";
    case "vad": return f.speaking ? "🎙  speech start" : `🎙  speech end (${f.ms} ms)`;
    case "barge_in": return f.falseStart ? "✋ barge-in: false start, he wasn't done" : "✋ barge-in";
    case "dangling": return `↩  stopped mid-sentence: keep listening${f.by ? ` (${f.by})` : ""}`;
    case "turn": return `🎚  Smart Turn: ${f.complete ? "done" : "not done"} (${f.probability}, ${f.ms} ms)`;
    case "backchannel": return "… mhm (backchannel)";
    case "nudge": return `⏲  ${f.kind}`;
    case "tool": return f.ignored ? `🛠  tool call ignored (${f.reason}): ${f.ignored.join(", ")}` : `🛠  ${f.name} ${f.status} (${f.ms} ms)${f.summary ? `: ${f.summary}` : ""}`;
    case "tool_latency": return `⏱  answer after tool: ${f.hopMs} ms after the call, ${f.totalMs} ms after he stopped`;
    case "objective": return `🎯 ${f.template} ${f.done ? "done" : "open again"}: ${f.status}`;
    case "saved": return `💾 saved ${f.id}`;
    case "outbound": return "📞 we called him";
    case "voicemail": return `📼 voicemail (${f.why}): hanging up`;
    case "answered_by": return `☎ answered by ${f.value}`;
    case "error": return `⚠ ${f.where}: ${f.message}`;
    default: return null;
  }
}
