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
  voice = null, from = null, language = null, onEvent = () => {}, onLine = () => {},
}) {
  const callId = `fake-${Date.now().toString(36)}`;
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
    type: "call_connected", call_id: callId, direction: "inbound",
    from: from || testing.from, to: "+10000000000", instruction: null,
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
    await agentDone(0, 1800, 30000, true); // greeting: pre-recorded audio, no "say" event
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
    case "dangling": return "↩  stopped mid-sentence: keep listening";
    case "backchannel": return "… mhm (backchannel)";
    case "nudge": return `⏲  ${f.kind}`;
    case "tool": return f.ignored ? `🛠  tool call ignored (${f.reason}): ${f.ignored.join(", ")}` : `🛠  ${f.name} ${f.status} (${f.ms} ms)${f.summary ? `: ${f.summary}` : ""}`;
    case "tool_latency": return `⏱  answer after tool: ${f.hopMs} ms after the call, ${f.totalMs} ms after he stopped`;
    case "workflow": return `🏢 office: ${f.result?.summary ?? ""}`;
    case "objective": return `🎯 ${f.template} ${f.done ? "done" : "open again"}: ${f.status}`;
    case "saved": return `💾 saved ${f.id}`;
    case "error": return `⚠ ${f.where}: ${f.message}`;
    default: return null;
  }
}
