// One phone call. Speaks Dial's self-hosted audio protocol on the outside
// (frames in: call_connected, media, mark, call_ended, duration_warning;
// frames out: media, mark, clear, end_call), so the same code serves a real
// Dial call and the browser test page, which pretends to be Dial.
//
// Inside: VAD → fast path (Gemini hears and answers in one stream) → Fish per
// sentence → audio out. The slow path (structured note) runs beside it.
// `config` (from the mode selector): { model, tts: "fish"|"gemini", mask: "typing"|"filler"|"none" }.

import { createVad } from "./vad.mjs";
import { createReplyParser } from "./reply.mjs";
import { streamTurn, extractJsonResilient, warmModel } from "./gemini.mjs";
import { wav, silence, frames, durationMs } from "./audio.mjs";
import { writeFileSync } from "node:fs";
import { createMeter, geminiCost, ttsCost } from "./cost.mjs";
import { createTypist } from "./ambience.mjs";
import { consolidateCall } from "./consolidate.mjs";
import path from "node:path";

// Short end-of-turn waits are safe because the model answers NEXT: wait when he
// paused mid-thought; then we stay silent and keep collecting his audio.
const END_SILENCE = { listen: 800, wait: 800, confirm: 600, hangup: 600 };
const START_MS = { listen: 200, wait: 200, confirm: 120, hangup: 200 }; // a crisp "Passt." is ~160 ms voiced
const WAIT_SILENCE_MS = 2500; // silence after a "wait" that means he's done after all
const MAX_PENDING_MS = 60000;
const FILLER_AFTER_MS = 700;
const HEDGE_MS = Number(process.env.HEDGE_MS || 2200); // no first token by then: race the fallback model
const TURN_DEADLINE_MS = 12000; // give up and say sorry
const IDLE_MS = { listen: 9000, confirm: 7000, wait: 0, hangup: 0 };
const FILLER_WORDS = /^(mhm|okay|ok|alles klar|got it)[.!,…]*\s*/i;
const BACKCHANNEL = /^\s*(mhm|okay|ok)[.!,…]*\s*((weiter|go on)[.!…]*)?\s*$/i;
const BACKCHANNEL_IDLE_MS = 3000;
const INTERRUPT_MS = Number(process.env.INTERRUPT_MIN_MS || 500); // loud speech needed to cut the agent off
const TYPING_AFTER_MS = 250; // typing starts almost at once, like someone writing it down
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = (arr, i) => (Array.isArray(arr) ? arr[i % arr.length] : arr);

// `onEvent` feeds the monitor (every call); dev callers also get the events inline.
// `recordDir(callId)` → directory for per-turn audio, or null to not record.
export function createCallSession({ send, dev = false, skill, endpoint, model, extractModel, fish, geminiTts, store, memory, office = null, assets, config = {}, initialTurns = [], initialLang = null, log = () => {}, onEvent = () => {}, onEnd = () => {}, recordDir = null }) {
  const cfg = { model, tts: "fish", mask: "typing", ...Object.fromEntries(Object.entries(config).filter(([, v]) => v)) };
  const fastModel = cfg.model;
  const slowModel = extractModel || model; // notes and memory stay on one model so modes compare fairly
  const fallbackModel = process.env.FALLBACK_MODEL || (fastModel === "gemini-2.5-flash" ? "gemini-3.5-flash" : "gemini-2.5-flash");
  const meter = createMeter();
  const record = (step, usage, turnId, m = slowModel) => {
    const entry = geminiCost(m, usage, step);
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
  const turns = [...initialTurns]; // non-empty when taking over a call from the Live engine
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
  let lang = initialLang ?? "de"; // set from Dial's language / the caller's number, then follows the caller
  let lastWasBackchannel = false;
  let idleTimer = null;
  let waitTimer = null;
  let nudges = 0;
  let oopsCount = 0;
  const markText = new Map(); // mark name → { turn, text } for sentences, so we know what was heard

  const vad = createVad({ onSpeechStart, onSpeechEnd, endSilenceMs: END_SILENCE.listen, interruptMs: INTERRUPT_MS });
  // Typing doesn't count as the agent talking: no strict VAD, no marks.
  const typist = assets.typing ? createTypist(assets.typing, chunk => send({ type: "media", payload: chunk.toString("base64") })) : null;

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

  // A clip that starts synthesising now and can be drained later, in order.
  // Fish first (streamed); if Fish fails before any audio, Gemini TTS takes over.
  function startClip(text, signal, voiceLang) {
    const clip = { text, chunks: [], done: false, error: null, wake: null };
    (async () => {
      try {
        if (cfg.tts !== "gemini" && fish) {
          meter.add(ttsCost(fish.model, text));
          try {
            for await (const part of fish.stream(text, { signal, lang: voiceLang })) {
              clip.chunks.push(part);
              clip.wake?.();
            }
            return;
          } catch (err) {
            if (signal.aborted) return;
            if (clip.chunks.length || !geminiTts) { clip.error = err; fail("fish", err); return; }
            debug("fallback", { what: "voice", from: "fish", to: "gemini-tts", reason: err.message });
          }
        }
        if (geminiTts) {
          const { pcm, usage } = await geminiTts.synth(text, { lang: voiceLang, signal });
          if (usage) record("voice", usage, null, geminiTts.model);
          clip.chunks.push(pcm);
        }
      } catch (err) {
        if (!signal.aborted) { clip.error = err; fail("voice", err); }
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

  // Gemini hangs or errors now and then. Hedged requests (Sierra's trick): if the
  // main model hasn't produced a token after HEDGE_MS, or fails before its first
  // token, the fallback model starts in parallel; the first to speak wins and the
  // other is cancelled. Words are never repeated: losers are dropped before any
  // of their text is used.
  async function* geminiStream(args, signal, turn) {
    const attempts = [];
    let wake = null;
    const notify = () => { const w = wake; wake = null; w?.(); };
    const launch = (m, why) => {
      const ctl = new AbortController();
      const att = { m, ctl, pieces: [], done: false, error: null };
      attempts.push(att);
      if (why) debug("retry", { turn: turn.id, reason: why, next: m });
      (async () => {
        try {
          for await (const piece of streamTurn({ ...args, model: m, onUsage: u => record("turn", u, turn.id, m), signal: AbortSignal.any([signal, ctl.signal]) })) {
            att.pieces.push(piece);
            notify();
          }
        } catch (err) {
          att.error = err;
        } finally {
          att.done = true;
          notify();
        }
      })();
      return att;
    };
    const started = performance.now();
    launch(fastModel);
    const hedge = setTimeout(() => { if (!winner()) launch(fallbackModel, `no first token after ${HEDGE_MS} ms`); notify(); }, HEDGE_MS);
    const winner = () => attempts.find(a => a.pieces.length);
    try {
      let w = null;
      while (!w) {
        w = winner();
        if (w) break;
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        const failed = attempts.filter(a => a.done && !a.pieces.length);
        if (failed.length === attempts.length) {
          // everyone failed before a token: one more model, then give up
          const tried = new Set(attempts.map(a => a.m));
          const next = !tried.has(fallbackModel) ? fallbackModel : attempts.length < 3 ? fastModel : null;
          if (!next || performance.now() - started > TURN_DEADLINE_MS) throw failed.at(-1).error ?? new Error("all models failed");
          launch(next, failed.at(-1).error?.message?.slice(0, 160) ?? "failed");
          continue;
        }
        if (performance.now() - started > TURN_DEADLINE_MS) throw new Error(`no answer after ${TURN_DEADLINE_MS} ms`);
        await new Promise(r => { wake = r; setTimeout(r, 250); });
      }
      clearTimeout(hedge);
      for (const a of attempts) if (a !== w) a.ctl.abort();
      if (w.m !== fastModel || attempts.length > 1) debug("recovered", { turn: turn.id, model: w.m, attempt: attempts.indexOf(w) + 1 });
      let i = 0;
      for (;;) {
        while (i < w.pieces.length) yield w.pieces[i++];
        if (w.done) { if (w.error && !signal.aborted) throw w.error; return; }
        await new Promise(r => { wake = r; setTimeout(r, 250); });
      }
    } finally {
      clearTimeout(hedge);
      for (const a of attempts) if (!a.done) a.ctl.abort();
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

  // After a "wait" (he paused mid-thought): if he stays quiet, answer the whole
  // dictation as one turn.
  function armWait() {
    clearTimeout(waitTimer);
    waitTimer = setTimeout(() => {
      if (ended || current || !pendingUser.length) return;
      if (vad.speaking) return armWait();
      debug("nudge", { kind: "dictation_done" });
      runTurn({ force: true }).catch(err => fail("turn", err));
    }, WAIT_SILENCE_MS);
  }

  function onSpeechStart() {
    clearTimeout(idleTimer);
    clearTimeout(waitTimer);
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

  async function runTurn({ text, force = false } = {}) {
    clearTimeout(idleTimer);
    clearTimeout(waitTimer);
    if (!text && !force && pendingUser.reduce((n, p) => n + durationMs(p), 0) > MAX_PENDING_MS) force = true;
    const turn = { id: ++turnSeq, abort: new AbortController(), audioSent: false, fillerPlayed: false, endpointAt: performance.now(), marks: [] };
    current = turn;
    const signal = turn.abort.signal;
    const audio = text ? null : wav(Buffer.concat(pendingUser.flatMap((p, i) => (i ? [silence(300), p] : [p]))));
    const inFile = audio ? saveAudio(`turn-${turn.id}-in.wav`, audio) : null;
    const outAudio = [];
    debug("turn_start", { turn: turn.id, ...(text ? { text } : { utteranceMs: Math.round(durationMs(audio) - 44 / 32), merged: pendingUser.length, force }) });
    let reply = "";
    let next = "listen";
    const clips = [];
    let clipsClosed = false;
    let wakePlayer = null;

    // Latency mask while Gemini thinks: keyboard typing (default), a spoken filler, or nothing.
    let filler = null;
    if (!text && cfg.mask === "typing" && typist) {
      filler = setTimeout(() => { if (!signal.aborted && !turn.firstAudioAt) { typist.start(); debug("mask", { kind: "typing" }); } }, TYPING_AFTER_MS);
    } else if (!text && cfg.mask === "filler") {
      filler = setTimeout(() => {
        const fillers = assets[lang]?.fillers ?? [];
        if (!signal.aborted && !turn.audioSent && fillers.length) {
          turn.audioSent = true;
          turn.fillerPlayed = true;
          turn.marks.push(speakCached(fillers[turnSeq % fillers.length], "filler"));
          debug("filler");
        }
      }, FILLER_AFTER_MS);
    }
    const stopMask = () => { clearTimeout(filler); typist?.stop(); };

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
            stopMask();
            if (!text) debug("latency", { turn: turn.id, firstAudioMs: Math.round(turn.firstAudioAt - turn.endpointAt), firstTokenMs: Math.round(turn.firstTokenAt - turn.endpointAt), fishFirstByteMs: cfg.tts === "fish" ? fish?.stream.lastFirstByteMs : null });
          }
          turn.audioSent = true;
          outAudio.push(chunk);
          sendAudio(chunk);
        }
        if (signal.aborted) return;
        if (clip.chunks.length) {
          const name = sendMark(`t${turn.id}`);
          markText.set(name, { turn: turn.id, text: clip.text });
          turn.marks.push(name);
        }
      }
    })();

    const parser = createReplyParser({
      onHeader: ({ heard, lang: l, next: n, act }) => {
        if (n === "wait" && (force || text || lastNext === "confirm")) n = "listen"; // he's been quiet, or answered a yes/no question: answer now
        if (act === "execute" && office) turn.execute = true;
        next = n;
        if (l) lang = l;
        if (n === "wait") {
          // Unfinished thought: say nothing, keep his audio, and answer it all once he's done.
          turn.waiting = true;
          vad.setEndSilence(END_SILENCE.wait);
          debug("heard", { turn: turn.id, text: heard, next: n, lang, audio: inFile });
          return;
        }
        vad.setEndSilence(END_SILENCE[n] ?? END_SILENCE.listen);
        vad.setStartMs(START_MS[n] ?? START_MS.listen);
        turns.push({ role: "user", text: text ?? (heard || "(not transcribed)") });
        if (!text) pendingUser = []; // answered (even if the caller cuts in later)
        debug("heard", { turn: turn.id, text: heard, next: n, lang, audio: inFile });
      },
      onSentence: sentence => {
        if (signal.aborted || turn.waiting) return;
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
      const system = skill.systemPrompt({ note, missing, memory: memory?.context({ notes: store.list() }) ?? "", office: office?.context(lang) ?? "", lang });
      const extra = force ? "(The caller is speaking in the audio above. He has now been silent for a few seconds: his thought is complete, so respond. Do not answer wait.)" : undefined;
      for await (const piece of geminiStream({ endpoint, system, history: turns.slice(-16), audio, text, extra }, signal, turn)) {
        if (!turn.firstTokenAt) turn.firstTokenAt = performance.now();
        parser.push(piece);
      }
      parser.end();
    } catch (err) {
      stopMask();
      if (signal.aborted) return;
      fail("gemini", err);
      const i = oopsCount++;
      speakCached(pick(assets[lang]?.oops, i), "oops");
      debug("say", { turn: turn.id, text: pick(skill.VOICE_LINES[lang]?.oops, i) ?? "(oops)", note: "error fallback" });
      if (current === turn) current = null;
      return;
    } finally {
      clipsClosed = true;
      wakePlayer?.();
    }

    await player;
    stopMask();
    if (outAudio.length) {
      const outFile = saveAudio(`turn-${turn.id}-out.wav`, wav(Buffer.concat(outAudio)));
      if (outFile) debug("agent_audio", { turn: turn.id, audio: outFile, interrupted: signal.aborted });
    }
    if (signal.aborted) {
      // Keep only what the caller actually heard (marks that came back), so the
      // model can pick up where it was cut off instead of assuming it said it all.
      const heard = turn.marks.filter(m => m && markText.get(m)?.heard).map(m => markText.get(m).text);
      const unsaid = clips.map(c => c.text).slice(heard.length).join(" ");
      if (reply) turns.push({ role: "model", text: `${heard.join(" ")}${heard.length ? " " : ""}[interrupted by the caller${unsaid ? `; not heard: "${unsaid.slice(0, 160)}"` : ""}]` });
      return;
    }
    if (turn.waiting) {
      if (current === turn) current = null;
      lastNext = "wait";
      armWait();
      return;
    }
    if (reply) turns.push({ role: "model", text: reply });
    if (current === turn) current = null;
    if (turn.execute) { runWorkflow().catch(err => fail("workflow", err)); return; }
    lastNext = next;
    lastWasBackchannel = next === "listen" && BACKCHANNEL.test(reply.replace(/\(schon als Füller gesagt\)/, ""));
    if (!text) refreshNote();
    if (next === "hangup") hangupMark = sendMark("bye");
    else if (!marks.size) armIdle();
  }

  // ---------- the office: book, add to-dos, quote and send ----------
  // Runs after he confirmed (DO: execute). Typing plays while it works; the agent
  // then gets "(System: done …)" and tells him what was created.
  async function runWorkflow() {
    typist?.start();
    debug("workflow_start");
    try {
      await extracting;
      await refreshNote(); // the draft from the full transcript, including his "yes"
      const result = office.execute({ draft: note, lang, callId: call.id });
      debug("workflow", { result });
      log(`workflow: ${result.summary}`);
      await runTurn({ text: `(System: done. ${result.summary}. Tell him in one or two sentences what was done, in his language, then ask if there's anything else.)` });
    } catch (err) {
      typist?.stop();
      fail("workflow", err);
      await runTurn({ text: `(System: the office could not complete it: ${err.message}. Apologize in one short sentence and offer to try again.)` });
    }
  }

  // ---------- slow path ----------
  // Chained, so an older extraction can never overwrite a newer one.
  function refreshNote() {
    const snapshot = turns.slice();
    extracting = (extracting ?? Promise.resolve())
      .then(() => extractJsonResilient({ endpoint, models: [slowModel, fallbackModel], system: skill.EXTRACT_SYSTEM, prompt: skill.extractPrompt({ turns: snapshot, note, lang }), schema: skill.NOTE_SCHEMA, onUsage: u => record("note", u) }))
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
    typist?.stop();
    clearTimeout(idleTimer);
    clearTimeout(waitTimer);
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
    const job = { turns, note, callId: call.id, noteId, lang, date: new Date().toISOString().slice(0, 10) };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { result, changed } = await consolidateCall({ endpoint, model: slowModel, skill, memory, store, ...job, onUsage: u => record("memory", u) });
        log(`memory: ${result.call_type}, +${changed.added.length} to-dos, ${changed.completed.length} done`);
        debug("memory", { callType: result.call_type, summary: result.call_summary, customer: changed.customer, added: changed.added, completed: changed.completed, updated: changed.updated });
        return;
      } catch (err) {
        if (attempt === 0) { await sleep(1500); continue; }
        memory.savePending(job); // retried by the server later, so nothing from the call is lost
        fail("memory", new Error(`${err.message} (queued for retry)`));
      }
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
          if (!msg.reconnect && !initialLang) lang = skill.initialLanguage(msg);
          log(`call ${msg.call_id} from ${msg.from ?? "?"} (${lang})${msg.reconnect ? " (reconnect)" : ""}`);
          if (!msg.reconnect) speakCached(assets[lang]?.greeting, "greet");
          warmModel({ endpoint, model: fastModel }); // Vertex's first request is slow; take that hit during the greeting
          debug("connected", { formats: msg.formats, lang, config: cfg });
          break;
        case "media":
          if (!ended) vad.push(Buffer.from(msg.payload, "base64"));
          break;
        case "mark":
          marks.delete(msg.name);
          if (markText.has(msg.name)) markText.get(msg.name).heard = true;
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
