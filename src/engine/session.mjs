// One phone call. Speaks Dial's self-hosted audio protocol on the outside
// (frames in: call_connected, media, mark, call_ended, duration_warning;
// frames out: media, mark, clear, end_call), so the same code serves a real
// Dial call and the browser test page, which pretends to be Dial.
//
// Inside: VAD → fast path (Gemini hears and answers in one stream) → Fish per
// sentence → audio out. The slow path (structured note) runs beside it.

import { createVad } from "./vad.mjs";
import { createReplyParser } from "./reply.mjs";
import { streamTurn, extractJson, warmModel } from "./gemini.mjs";
import { wav, silence, frames, durationMs } from "./audio.mjs";
import { writeFileSync } from "node:fs";
import { createMeter, geminiCost, ttsCost } from "./cost.mjs";
import path from "node:path";

const END_SILENCE = { listen: 1200, confirm: 700, hangup: 700 };
const START_MS = { listen: 200, confirm: 120, hangup: 200 }; // a crisp "Passt." is ~160 ms voiced
const FILLER_AFTER_MS = 700;
const FIRST_TOKEN_TIMEOUT_MS = Number(process.env.FIRST_TOKEN_TIMEOUT_MS || 5000); // then retry once
const IDLE_MS = { listen: 7000, confirm: 6000, hangup: 0 };
const FILLER_WORDS = /^(mhm|okay|ok|alles klar|got it)[.!,…]*\s*/i;
const BACKCHANNEL = /^\s*(mhm|okay|ok)[.!,…]*\s*((weiter|go on)[.!…]*)?\s*$/i;
const BACKCHANNEL_IDLE_MS = 3000;

// `onEvent` feeds the monitor (every call); dev callers also get the events inline.
// `recordDir(callId)` → directory for per-turn audio, or null to not record.
export function createCallSession({ send, dev = false, skill, endpoint, model, fish, store, memory, assets, log = () => {}, onEvent = () => {}, onEnd = () => {}, recordDir = null }) {
  const meter = createMeter();
  const record = (step, usage, turnId) => {
    const entry = geminiCost(model, usage, step);
    meter.add(entry);
    debug("cost", { turn: turnId ?? null, step, usd: entry.usd, inputTokens: entry.inputTokens, audioTokens: entry.audioTokens, outputTokens: entry.outputTokens, totals: meter.totals() });
  };
  const debug = (event, data = {}) => {
    onEvent({ event, ...data });
    if (dev) send({ type: "debug", event, ...data, t: Date.now() });
  };
  const fail = (where, err) => { log(`${where} error`, err.message); debug("error", { where, message: err.message }); };
  const saveAudio = (name, pcmOrWav) => {
    const dir = recordDir?.(call.id);
    if (!dir) return null;
    try { writeFileSync(path.join(dir, name), pcmOrWav); return name; } catch { return null; }
  };
  const call = { id: null, from: null, to: null, startedAt: Date.now() };
  const turns = [];
  let note = {};
  let missing = skill.missingFields(note);
  let pendingUser = []; // caller audio not yet answered
  let current = null; // the turn being answered
  let turnSeq = 0;
  let markSeq = 0;
  const marks = new Set();
  let hangupMark = null;
  let extracting = null;
  let finalized = null;
  let ended = false;
  let lastNext = "listen";
  let lang = "de"; // set from Dial's language / the caller's number, then follows the caller
  let lastWasBackchannel = false;
  let idleTimer = null;
  let nudges = 0;

  const vad = createVad({ onSpeechStart, onSpeechEnd, endSilenceMs: END_SILENCE.listen });

  // ---------- audio out ----------
  function sendAudio(pcm) {
    for (const chunk of frames(pcm, 200)) send({ type: "media", payload: chunk.toString("base64") });
    vad.setStrict(true);
  }
  function sendMark(prefix) {
    const name = `${prefix}-${++markSeq}`;
    marks.add(name);
    send({ type: "mark", name });
    return name;
  }
  function speakCached(pcm, prefix) {
    if (!pcm?.length) return null;
    sendAudio(pcm);
    return sendMark(prefix);
  }
  function stopSpeaking() {
    send({ type: "clear" });
    marks.clear();
    vad.setStrict(false);
  }

  // A Fish clip that starts synthesising now and can be drained later, in order.
  function startClip(text, signal, voiceLang) {
    const clip = { text, chunks: [], done: false, error: null, wake: null };
    meter.add(ttsCost(fish.model, text));
    (async () => {
      try {
        for await (const part of fish.stream(text, { signal, lang: voiceLang })) {
          clip.chunks.push(part);
          clip.wake?.();
        }
      } catch (err) {
        if (!signal.aborted) { clip.error = err; fail("fish", err); }
      } finally {
        clip.done = true;
        clip.wake?.();
      }
    })();
    return clip;
  }
  async function* drain(clip) {
    let i = 0;
    for (;;) {
      while (i < clip.chunks.length) yield clip.chunks[i++];
      if (clip.done) return;
      await new Promise(resolve => { clip.wake = resolve; });
      clip.wake = null;
    }
  }

  // Gemini sometimes hangs without a byte. If nothing arrives in time, cancel and
  // retry once, but only before any text came back (never repeat words).
  async function* geminiStream(args, signal, turn) {
    for (let attempt = 0; ; attempt++) {
      const attemptCtl = new AbortController();
      const watchdog = setTimeout(() => attemptCtl.abort(new Error(`no first token after ${FIRST_TOKEN_TIMEOUT_MS} ms`)), FIRST_TOKEN_TIMEOUT_MS);
      let got = false;
      try {
        for await (const piece of streamTurn({ ...args, signal: AbortSignal.any([signal, attemptCtl.signal]) })) {
          if (!got) { got = true; clearTimeout(watchdog); }
          yield piece;
        }
        return;
      } catch (err) {
        if (signal.aborted || got || attempt >= 1) throw attemptCtl.signal.aborted && !got ? attemptCtl.signal.reason : err;
        debug("retry", { turn: turn.id, reason: attemptCtl.signal.aborted ? attemptCtl.signal.reason.message : err.message });
      } finally {
        clearTimeout(watchdog);
      }
    }
  }

  // ---------- turns ----------
  // Caller silent after the agent finished: nudge once, then wrap up.
  function armIdle() {
    clearTimeout(idleTimer);
    const ms = lastWasBackchannel ? BACKCHANNEL_IDLE_MS : IDLE_MS[lastNext] ?? IDLE_MS.listen;
    if (ended || hangupMark || current || !ms) return;
    idleTimer = setTimeout(() => {
      if (ended || current || marks.size) return;
      if (vad.speaking) return armIdle();
      if (lastWasBackchannel) {
        lastWasBackchannel = false;
        debug("nudge", { kind: "after_mhm" });
        return runTurn({ text: "(Silence: he didn't continue after your Mhm. He's done; continue with the next step.)" }).catch(err => fail("turn", err));
      }
      nudges += 1;
      const text = nudges === 1 ? "(Silence: the caller has said nothing for a few seconds.)" : "(Silence: the caller has said nothing for a while, the second time.)";
      debug("nudge", { kind: nudges === 1 ? "first" : "second" });
      runTurn({ text }).catch(err => fail("turn", err));
    }, ms);
  }

  function onSpeechStart() {
    clearTimeout(idleTimer);
    debug("vad", { speaking: true });
    const agentTalking = marks.size > 0 || (current && current.audioSent);
    if (agentTalking) {
      debug("barge_in");
      stopSpeaking();
    }
    if (current) { current.abort.abort(); current = null; }
  }

  function onSpeechEnd(pcm) {
    debug("vad", { speaking: false, ms: Math.round(durationMs(pcm)) });
    if (ended || durationMs(pcm) < 250) return;
    pendingUser.push(pcm);
    nudges = 0;
    runTurn().catch(err => fail("turn", err));
  }

  async function runTurn({ text } = {}) {
    clearTimeout(idleTimer);
    const turn = { id: ++turnSeq, abort: new AbortController(), audioSent: false, fillerPlayed: false, endpointAt: performance.now(), marks: [] };
    current = turn;
    const signal = turn.abort.signal;
    const audio = text ? null : wav(Buffer.concat(pendingUser.flatMap((p, i) => (i ? [silence(300), p] : [p]))));
    const inFile = audio ? saveAudio(`turn-${turn.id}-in.wav`, audio) : null;
    const outAudio = [];
    debug("turn_start", { turn: turn.id, ...(text ? { text } : { utteranceMs: Math.round(durationMs(audio) - 44 / 32), merged: pendingUser.length }) });
    let reply = "";
    let next = "listen";
    const clips = [];
    let clipsClosed = false;
    let wakePlayer = null;

    const filler = setTimeout(() => {
      const fillers = assets[lang]?.fillers ?? [];
      if (!signal.aborted && !turn.audioSent && !text && fillers.length) {
        turn.audioSent = true;
        turn.fillerPlayed = true;
        turn.marks.push(speakCached(fillers[turnSeq % fillers.length], "filler"));
        debug("filler");
      }
    }, FILLER_AFTER_MS);

    // Player: sends clips in order as their bytes arrive.
    const player = (async () => {
      let n = 0;
      for (;;) {
        if (n >= clips.length) {
          if (clipsClosed) return;
          await new Promise(resolve => { wakePlayer = resolve; });
          wakePlayer = null;
          continue;
        }
        const clip = clips[n++];
        for await (const chunk of drain(clip)) {
          if (signal.aborted) return;
          if (!turn.firstAudioAt) {
            turn.firstAudioAt = performance.now();
            clearTimeout(filler);
            if (!text) debug("latency", { turn: turn.id, firstAudioMs: Math.round(turn.firstAudioAt - turn.endpointAt), firstTokenMs: Math.round(turn.firstTokenAt - turn.endpointAt), fishFirstByteMs: fish.stream.lastFirstByteMs });
          }
          turn.audioSent = true;
          outAudio.push(chunk);
          sendAudio(chunk);
        }
        if (signal.aborted) return;
        if (clip.chunks.length) turn.marks.push(sendMark(`t${turn.id}`));
      }
    })();

    const parser = createReplyParser({
      onHeader: ({ heard, lang: l, next: n }) => {
        next = n;
        if (l) lang = l;
        vad.setEndSilence(END_SILENCE[n] ?? END_SILENCE.listen);
        vad.setStartMs(START_MS[n] ?? START_MS.listen);
        turns.push({ role: "user", text: text ?? (heard || "(not transcribed)") });
        if (!text) pendingUser = []; // answered (even if the caller cuts in later)
        debug("heard", { turn: turn.id, text: heard, next: n, lang, audio: inFile });
      },
      onSentence: sentence => {
        if (signal.aborted) return;
        // A filler already said "Mhm": don't say it twice.
        if (turn.fillerPlayed && !reply && FILLER_WORDS.test(sentence)) {
          const rest = sentence.replace(FILLER_WORDS, "");
          reply = sentence;
          if (!rest) { debug("say", { turn: turn.id, text: sentence, note: "already said as filler" }); return; }
          sentence = rest[0].toUpperCase() + rest.slice(1);
          reply = "";
        }
        reply += (reply ? " " : "") + sentence;
        clips.push(startClip(sentence, signal, lang));
        wakePlayer?.();
        debug("say", { turn: turn.id, text: sentence });
      },
    });

    try {
      const system = skill.systemPrompt({ note, missing, notes: store.list(), memory: memory?.context() ?? "", lang });
      for await (const piece of geminiStream({ endpoint, model, system, history: turns.slice(-16), audio, text, onUsage: u => record("turn", u, turn.id) }, signal, turn)) {
        if (!turn.firstTokenAt) turn.firstTokenAt = performance.now();
        parser.push(piece);
      }
      parser.end();
    } catch (err) {
      if (signal.aborted) return;
      fail("gemini", err);
      clearTimeout(filler);
      speakCached(assets[lang]?.oops, "oops");
      debug("say", { turn: turn.id, text: skill.VOICE_LINES[lang]?.oops ?? "(oops)", note: "error fallback" });
      return;
    } finally {
      clipsClosed = true;
      wakePlayer?.();
    }

    await player;
    clearTimeout(filler);
    if (outAudio.length) {
      const outFile = saveAudio(`turn-${turn.id}-out.wav`, wav(Buffer.concat(outAudio)));
      if (outFile) debug("agent_audio", { turn: turn.id, audio: outFile, interrupted: signal.aborted });
    }
    if (signal.aborted) {
      if (reply) turns.push({ role: "model", text: `${reply} (unterbrochen)` });
      return;
    }
    if (reply) turns.push({ role: "model", text: reply });
    if (current === turn) current = null;
    lastNext = next;
    lastWasBackchannel = next === "listen" && BACKCHANNEL.test(reply.replace(/\(schon als Füller gesagt\)/, ""));
    if (!text) refreshNote();
    if (next === "hangup") hangupMark = sendMark("bye");
    else if (!marks.size) armIdle();
  }

  // ---------- slow path ----------
  // Chained, so an older extraction can never overwrite a newer one.
  function refreshNote() {
    const snapshot = turns.slice();
    extracting = (extracting ?? Promise.resolve())
      .then(() => extractJson({ endpoint, model, system: skill.EXTRACT_SYSTEM, prompt: skill.extractPrompt({ turns: snapshot, note }), schema: skill.NOTE_SCHEMA, onUsage: u => record("note", u) }))
      .then(updated => {
        note = updated;
        missing = skill.missingFields(note);
        debug("note", { note, missing });
      })
      .catch(err => fail("extract", err));
    return extracting;
  }

  function finalize(reason) {
    if (finalized) return finalized;
    ended = true;
    clearTimeout(idleTimer);
    current?.abort.abort();
    vad.reset();
    finalized = (async () => {
      await extracting;
      const spoke = turns.some(t => t.role === "user" && !/^\((unclear|unklar|silence|not transcribed)/i.test(t.text));
      if (spoke) await refreshNote();
      let saved = null;
      if (skill.worthSaving(note)) {
        saved = store.save({ ...note, sprache: lang, call_id: call.id, from: call.from, ended_reason: reason, transcript: turns });
        log("saved note", saved.id);
        debug("saved", { id: saved.id });
      }
      if (spoke && memory) await consolidate(saved?.id);
    })()
      .catch(err => fail("finalize", err))
      .finally(() => {
        meter.phone(Date.now() - call.startedAt);
        debug("cost", { final: true, totals: meter.totals() });
        onEnd(reason);
      });
    return finalized;
  }

  // After the call: fold it into long-term memory (customers, to-dos, summaries).
  async function consolidate(noteId) {
    try {
      const result = await extractJson({
        endpoint, model, system: skill.MEMORY_SYSTEM, schema: skill.MEMORY_SCHEMA,
        prompt: skill.memoryPrompt({ turns, note, snapshot: memory.snapshot() }),
        onUsage: u => record("memory", u),
      });
      const changed = memory.apply(result, { callId: call.id, noteId, lang });
      log(`memory: ${result.call_type}, +${changed.added.length} to-dos, ${changed.completed.length} done`);
      debug("memory", { callType: result.call_type, summary: result.call_summary, customer: changed.customer, added: changed.added, completed: changed.completed, updated: changed.updated });
    } catch (err) {
      fail("memory", err);
    }
  }

  // ---------- protocol ----------
  return {
    get ended() { return ended; },
    handle(msg) {
      switch (msg.type) {
        case "call_connected":
          Object.assign(call, { id: msg.call_id, from: msg.from, to: msg.to });
          if (!msg.reconnect) call.startedAt = Date.now();
          if (!msg.reconnect) lang = skill.initialLanguage(msg);
          log(`call ${msg.call_id} from ${msg.from ?? "?"} (${lang})${msg.reconnect ? " (reconnect)" : ""}`);
          if (!msg.reconnect) speakCached(assets[lang]?.greeting, "greet");
          warmModel({ endpoint, model }); // Vertex's first request is slow; take that hit during the greeting
          debug("connected", { formats: msg.formats, lang });
          break;
        case "media":
          if (!ended) vad.push(Buffer.from(msg.payload, "base64"));
          break;
        case "mark":
          marks.delete(msg.name);
          if (!marks.size) { vad.setStrict(false); if (!current) armIdle(); }
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
          stopSpeaking();
          speakCached(assets[lang]?.wrapUp, "wrap");
          hangupMark = sendMark("bye");
          break;
        case "call_ended":
          debug("ended", { reason: msg.reason ?? "ended" });
          finalize(msg.reason ?? "ended");
          break;
        default:
          break;
      }
    },
    close(reason = "socket_closed") { return finalize(reason); },
  };
}
