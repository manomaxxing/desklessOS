// One phone call on Gemini Live (native audio): Gemini hears and speaks by itself.
// Same outside as the cascade session (Dial's self-hosted audio protocol), so
// the test phone, the fake caller and real Dial calls all work unchanged.
//
// Gemini's own VAD does turn-taking and barge-in; we forward 16 kHz caller
// audio, resample its 24 kHz speech to 16 kHz, clear playback on `interrupted`,
// and use both transcripts for the note, memory and the monitor. It hangs up
// through an `end_call` tool. If Live fails, `onFatal` lets the server carry
// the call on with the cascade engine.

import WebSocket from "ws";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { liveTarget } from "./live-endpoint.mjs";
import { extractJsonResilient } from "./gemini.mjs";
import { createTypist } from "./ambience.mjs";
import { consolidateCall } from "./consolidate.mjs";
import { createMeter, geminiCost } from "./cost.mjs";
import { createVad } from "./vad.mjs";
import { resample, frames, wav, durationMs } from "./audio.mjs";

const MARK_EVERY_MS = 800; // playback checkpoints, to know how much the caller actually heard

export function createLiveSession({ send, dev = false, skill, endpoint, extractModel, store, memory, assets = {}, config = {}, log = () => {}, onEvent = () => {}, onEnd = () => {}, onFatal = () => {}, recordDir = null }) {
  const cfg = { liveModel: "vertex-eu:gemini-3.8-live", liveVoice: "Kore", mask: "typing", ...config };
  // Live answers fast, but thinks before longer replies (the wrap-up summary): type meanwhile.
  const typist = assets.typing && cfg.mask === "typing" ? createTypist(assets.typing, chunk => send({ type: "media", payload: chunk.toString("base64") })) : null;
  let typingTimer = null;
  const stopTyping = () => { clearTimeout(typingTimer); typist?.stop(); };
  const target = liveTarget(cfg.liveModel);
  const meter = createMeter();
  const debug = (event, data = {}) => { onEvent({ event, ...data }); if (dev) send({ type: "debug", event, ...data, t: Date.now() }); };
  const fail = (where, err) => { log(`${where} error`, err.message); debug("error", { where, message: err.message }); };
  const record = (step, usage, turnId, m) => {
    const entry = geminiCost(m, usage, step);
    meter.add(entry);
    debug("cost", { turn: turnId ?? null, step, usd: entry.usd, inputTokens: entry.inputTokens, audioTokens: entry.audioTokens, outputTokens: entry.outputTokens, totals: meter.totals() });
  };
  const saveAudio = (name, data) => {
    const dir = recordDir?.(call.id);
    if (!dir) return null;
    try { writeFileSync(path.join(dir, name), data); return name; } catch { return null; }
  };

  const call = { id: null, from: null, to: null, startedAt: Date.now() };
  const turns = [];
  let note = {};
  let missing = skill.missingFields(note);
  let lang = "de";
  let gem = null; // WebSocket to Gemini
  let ready = false;
  let ended = false;
  let finalized = null;
  let extracting = null;
  let fatal = false;
  const early = []; // caller audio before setupComplete
  const marks = new Set();
  let markSeq = 0;
  let hangupWanted = false;
  let hangupMark = null;
  let turnSeq = 0;
  let agent = null; // the model turn being spoken: { id, text, chunks, heardText, sinceMark, startedAt }
  let userText = "";
  let userAudio = [];
  let lastSpeechEnd = 0;

  // Our own VAD only measures (end of speech → first audio) and cuts caller recordings.
  const vad = createVad({
    endSilenceMs: 300,
    onSpeechStart: () => { stopTyping(); debug("vad", { speaking: true }); },
    onSpeechEnd: pcm => {
      lastSpeechEnd = performance.now();
      userAudio.push(pcm);
      debug("vad", { speaking: false, ms: Math.round(durationMs(pcm)) });
      if (typist && !agent && durationMs(pcm) > 400) {
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => { if (!agent && !ended) { typist.start(); debug("mask", { kind: "typing" }); } }, Number(process.env.LIVE_TYPING_AFTER_MS || 900));
      }
    },
  });

  function sendMark(prefix, info) {
    const name = `${prefix}-${++markSeq}`;
    marks.add(name);
    send({ type: "mark", name });
    if (info) markInfo.set(name, info);
    return name;
  }
  const markInfo = new Map();

  // ---------- Gemini Live connection ----------
  async function connect() {
    const headers = target.vertex ? { Authorization: (await endpoint.headers()).authorization } : {};
    gem = new WebSocket(target.url, { headers });
    const greeting = [].concat(skill.VOICE_LINES[lang]?.greeting ?? "")[0];
    gem.on("open", () => {
      gem.send(JSON.stringify({
        setup: {
          model: target.modelPath,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.liveVoice } }, ...(target.vertex ? { languageCode: lang === "en" ? "en-US" : "de-DE" } : {}) },
          },
          systemInstruction: { parts: [{ text: skill.livePrompt({ note, missing, notes: store.list(), memory: memory?.context() ?? "", lang }) }] },
          realtimeInputConfig: {
            automaticActivityDetection: { disabled: false, startOfSpeechSensitivity: "START_SENSITIVITY_LOW", endOfSpeechSensitivity: "END_SENSITIVITY_LOW", prefixPaddingMs: 100, silenceDurationMs: Number(process.env.LIVE_SILENCE_MS || 800) },
            activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: [{ name: "end_call", description: "Hang up the phone. Call this only right after you have said goodbye and the conversation is finished.", parameters: { type: "OBJECT", properties: {} } }] }],
        },
      }));
    });
    gem.on("message", data => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      try { onGemini(msg, greeting); } catch (err) { fail("live", err); }
    });
    gem.on("close", (code, reason) => {
      const why = `Gemini Live closed ${code}${reason?.length ? ": " + reason.toString().slice(0, 160) : ""}`;
      if (ended) return;
      log(why);
      goFatal(why);
    });
    gem.on("error", err => { if (!ended) goFatal(`Gemini Live error: ${err.message}`); });
  }

  function goFatal(reason) {
    if (fatal || ended) return;
    fatal = true;
    debug("fallback", { what: "engine", from: "gemini-live", to: "cascade", reason });
    try { gem?.close(); } catch {}
    send({ type: "clear" });
    onFatal({ reason, turns: turns.slice(), lang, greeted: turns.length > 0 || turnSeq > 0 });
  }

  function onGemini(msg, greeting) {
    if (msg.setupComplete) {
      ready = true;
      debug("live", { text: `connected to ${target.id} · voice ${cfg.liveVoice}` });
      for (const payload of early.splice(0)) gem.send(JSON.stringify({ realtimeInput: { audio: { data: payload, mimeType: "audio/pcm;rate=16000" } } }));
      gem.send(JSON.stringify({ realtimeInput: { text: `(The call just connected. Greet him in one short sentence, in the spirit of: "${greeting}")` } }));
      return;
    }
    const sc = msg.serverContent;
    if (sc?.inputTranscription?.text) userText += sc.inputTranscription.text;
    if (sc?.modelTurn?.parts) for (const part of sc.modelTurn.parts) if (part.inlineData?.data) onAgentAudio(part.inlineData);
    if (sc?.outputTranscription?.text && agent) {
      agent.text += sc.outputTranscription.text;
      debug("say", { turn: agent.id, text: sc.outputTranscription.text, delta: true });
    }
    if (sc?.interrupted) onInterrupted();
    if (sc?.turnComplete) onTurnComplete();
    if (msg.toolCall?.functionCalls) {
      for (const fc of msg.toolCall.functionCalls) {
        if (fc.name === "end_call") {
          hangupWanted = true;
          debug("live", { text: "model called end_call" });
          gem.send(JSON.stringify({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: { result: { ok: true } } }] } }));
          if (!agent && !marks.size) { hangupMark = sendMark("bye"); }
        }
      }
    }
    if (msg.usageMetadata) record("live", msg.usageMetadata, agent?.id ?? turnSeq, target.model);
    if (msg.goAway) debug("live", { text: `server goAway, ${msg.goAway.timeLeft ?? "?"} left` });
  }

  function commitUser() {
    const text = userText.trim();
    userText = "";
    const pcm = userAudio.length ? Buffer.concat(userAudio) : null;
    userAudio = [];
    if (!text) return;
    turns.push({ role: "user", text });
    const file = pcm ? saveAudio(`turn-${turnSeq + 1}-in.wav`, wav(pcm)) : null;
    if (/^[\x00-\x7F\s]*$/.test(text) && /\b(the|and|i|is|you|that|it)\b/i.test(text)) lang = "en";
    else if (/[äöüß]|\b(und|ich|ist|das|die|der|nicht)\b/i.test(text)) lang = "de";
    debug("heard", { turn: turnSeq + 1, text, lang, next: "live", audio: file });
  }

  function onAgentAudio(inline) {
    const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? "")?.[1] ?? 24000);
    const pcm = resample(Buffer.from(inline.data, "base64"), rate, 16000);
    stopTyping();
    if (!agent) {
      commitUser();
      agent = { id: ++turnSeq, text: "", chunks: [], heardText: 0, sinceMark: 0, startedAt: performance.now() };
      if (lastSpeechEnd && performance.now() - lastSpeechEnd < 15000) {
        debug("latency", { turn: agent.id, firstAudioMs: Math.round(performance.now() - lastSpeechEnd), firstTokenMs: Math.round(performance.now() - lastSpeechEnd), fishFirstByteMs: null });
      }
      lastSpeechEnd = 0;
    }
    agent.chunks.push(pcm);
    for (const chunk of frames(pcm, 200)) send({ type: "media", payload: chunk.toString("base64") });
    agent.sinceMark += durationMs(pcm);
    if (agent.sinceMark >= MARK_EVERY_MS) {
      agent.sinceMark = 0;
      sendMark(`a${agent.id}`, { turn: agent.id, textLength: agent.text.length });
    }
  }

  function closeAgentTurn({ interrupted }) {
    if (!agent) return;
    const a = agent;
    agent = null;
    if (a.chunks.length) {
      const file = saveAudio(`turn-${a.id}-out.wav`, wav(Buffer.concat(a.chunks)));
      if (file) debug("agent_audio", { turn: a.id, audio: file, interrupted });
    }
    const text = a.text.trim();
    if (!text) return;
    if (interrupted) {
      const heard = a.text.slice(0, a.heardText).trim();
      turns.push({ role: "model", text: `${heard}${heard ? " " : ""}[interrupted by the caller; not heard: "${a.text.slice(a.heardText).trim().slice(0, 160)}"]` });
    } else {
      turns.push({ role: "model", text });
    }
  }

  function onInterrupted() {
    send({ type: "clear" });
    marks.clear();
    debug("barge_in");
    closeAgentTurn({ interrupted: true });
  }

  function onTurnComplete() {
    const hadAgent = Boolean(agent);
    if (!agent) commitUser();
    closeAgentTurn({ interrupted: false });
    if (hadAgent) refreshNote();
    if (hangupWanted && !hangupMark) hangupMark = sendMark("bye");
  }

  // ---------- slow path (same as the cascade engine) ----------
  function refreshNote() {
    const snapshot = turns.slice();
    extracting = (extracting ?? Promise.resolve())
      .then(() => extractJsonResilient({ endpoint, models: [extractModel, process.env.FALLBACK_MODEL || "gemini-2.5-flash"], system: skill.EXTRACT_SYSTEM, prompt: skill.extractPrompt({ turns: snapshot, note }), schema: skill.NOTE_SCHEMA, onUsage: u => record("note", u, null, extractModel) }))
      .then(updated => { note = updated; missing = skill.missingFields(note); debug("note", { note, missing }); })
      .catch(err => fail("extract", err));
    return extracting;
  }

  async function consolidate(noteId) {
    const job = { turns, note, callId: call.id, noteId, lang, date: new Date().toISOString().slice(0, 10) };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { result, changed } = await consolidateCall({ endpoint, model: extractModel, skill, memory, ...job, onUsage: u => record("memory", u, null, extractModel) });
        debug("memory", { callType: result.call_type, summary: result.call_summary, customer: changed.customer, added: changed.added, completed: changed.completed, updated: changed.updated });
        return;
      } catch (err) {
        if (attempt === 0) { await new Promise(r => setTimeout(r, 1500)); continue; }
        memory.savePending(job);
        fail("memory", new Error(`${err.message} (queued for retry)`));
      }
    }
  }

  function finalize(reason) {
    if (finalized) return finalized;
    ended = true;
    stopTyping();
    try { gem?.close(); } catch {}
    commitUser();
    closeAgentTurn({ interrupted: false });
    finalized = (async () => {
      await extracting;
      const spoke = turns.some(t => t.role === "user");
      if (spoke) await refreshNote();
      let saved = null;
      if (skill.worthSaving(note)) {
        saved = store.save({ ...note, sprache: lang, call_id: call.id, from: call.from, ended_reason: reason, engine: "live", transcript: turns });
        debug("saved", { id: saved.id });
      }
      if (spoke && memory) await consolidate(saved?.id);
    })()
      .catch(err => fail("finalize", err))
      .finally(() => { meter.phone(Date.now() - call.startedAt); debug("cost", { final: true, totals: meter.totals() }); onEnd(reason); });
    return finalized;
  }

  // ---------- Dial protocol ----------
  return {
    get ended() { return ended; },
    /** The server swaps engines on a fatal Live error: stop without finalizing. */
    abandon() { ended = true; stopTyping(); try { gem?.close(); } catch {} },
    handle(msg) {
      switch (msg.type) {
        case "call_connected":
          Object.assign(call, { id: msg.call_id, from: msg.from, to: msg.to });
          if (!msg.reconnect) {
            call.startedAt = Date.now();
            lang = skill.initialLanguage(msg);
            connect().catch(err => goFatal(err.message));
          }
          log(`call ${msg.call_id} from ${msg.from ?? "?"} (${lang}) on ${target.id}${msg.reconnect ? " (reconnect)" : ""}`);
          debug("connected", { formats: msg.formats, lang, config: { engine: "live", ...cfg } });
          break;
        case "media":
          if (ended || fatal) break;
          vad.push(Buffer.from(msg.payload, "base64"));
          if (ready) gem.send(JSON.stringify({ realtimeInput: { audio: { data: msg.payload, mimeType: "audio/pcm;rate=16000" } } }));
          else if (early.length < 100) early.push(msg.payload);
          break;
        case "mark":
          marks.delete(msg.name);
          if (markInfo.has(msg.name) && agent && markInfo.get(msg.name).turn === agent.id) agent.heardText = markInfo.get(msg.name).textLength;
          markInfo.delete(msg.name);
          if (msg.name === hangupMark) {
            send({ type: "end_call" });
            debug("hangup", { by: "agent" });
            finalize("agent_hangup");
          }
          break;
        case "ping_pong":
          send(msg);
          break;
        case "duration_warning":
          debug("duration_warning");
          if (ready) gem.send(JSON.stringify({ realtimeInput: { text: "(The call is about to hit its time limit. Say a one-sentence goodbye now, mention that the note is saved, then call end_call.)" } }));
          break;
        case "call_ended":
          debug("ended", { reason: msg.reason ?? "ended" });
          finalize(msg.reason ?? "ended");
          break;
      }
    },
    close(reason = "socket_closed") { return finalize(reason); },
  };
}
