// One phone call. Speaks Dial's self-hosted audio protocol on the outside
// (frames in: call_connected, media, mark, call_ended, duration_warning;
// frames out: media, mark, clear, end_call), so the same code serves a real
// Dial call and the browser test page, which pretends to be Dial.
//
// Inside: VAD → fast path (Gemini hears and answers in one stream) → Fish per
// sentence → audio out. The slow path (structured note) runs beside it.
// Tools (Gemini function calling, src/tools/): at most two model calls per turn,
// the answer with the tool call, then the follow-up with its result.
// What the call is about (prompt, note schema, Max's questions) comes from its
// agenda (src/agenda/agenda.mjs), built from the persona and templates; what we
// know about him from `memory`, the call's memory scope (src/memory/), read once
// when the call connected. The call is saved as it goes (memory.checkpoint); when it
// ends, onEnd(reason, final) gets its last state, and everything slow (the final note,
// memory, objectives) happens after the call, in its after-call job (src/calls/after-call.mjs).
// `config` (per call; the browser test phone picks its own): { model, mask: "typing"|"filler"|"none" }.

import { createVad } from "./vad.mjs";
import { createReplyParser } from "./reply.mjs";
import { streamTurn, extractJsonResilient, warmModel, userContent, historyContents, transcribe, FALLBACK_MODEL } from "./gemini.mjs";
import { wav, silence, frames, durationMs } from "./audio.mjs";
import { writeFileSync } from "node:fs";
import { createMeter, geminiCost, ttsCost } from "./cost.mjs";
import { createTypist } from "./ambience.mjs";
import { dangling, holdOn, affirmed } from "./endpointing.mjs";
import { locales, pickLanguage } from "../locale/index.mjs";
import { createToolRunner } from "../tools/registry.mjs";
import { callTools } from "../tools/index.mjs";
import path from "node:path";

// Short end-of-turn waits are safe because the model answers NEXT: wait when he
// paused mid-thought; then we stay silent and keep collecting his audio. Only a
// yes/no question (confirm) skips that check; an open question (ask) keeps it.
const END_SILENCE = { listen: 800, ask: 1000, wait: 800, confirm: 600, hangup: 600 };
const START_MS = { listen: 200, ask: 200, wait: 200, confirm: 120, hangup: 200 }; // a crisp "Passt." is ~160 ms voiced
// After a "wait", if he stays quiet: a soft "mhm" (he keeps the floor), then the
// answer, both counted from his last word. The answer is prepared right away and held,
// so it plays at once when the time is up (not one model round trip later); if he goes
// on, it's dropped unheard. "Moment" / "warte mal" holds the floor much longer, without the "mhm".
const WAIT_MHM_MS = 2500;
const WAIT_DONE_MS = 5000;
const HOLD_MS = 15000;
// He talks again right after the agent started: he wasn't done. Stop on a shorter
// burst of speech, forget the reply, and answer both parts as one thought.
const FALSE_START_MS = 1500;
const FALSE_START_INTERRUPT_MS = 300;
const MAX_PENDING_MS = 60000;
const FILLER_AFTER_MS = 700;
const HEDGE_MS = Number(process.env.HEDGE_MS || 2200); // no first token by then: race the fallback model
const TURN_DEADLINE_MS = 12000; // give up and say sorry
const IDLE_MS = { listen: 9000, ask: 10000, confirm: 7000, wait: 0, hangup: 0 };
const BACKCHANNEL_IDLE_MS = 3000;
const STAGE_DIRECTION = /^\s*[[(][^\])]*[\])]\s*$/; // "[Silence]", "(wartet)": never read out loud
// Two replies that start alike (the same first five words, ignoring case and punctuation).
const words = s => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
const sameStart = (a, b) => { const x = words(a).slice(0, 5), y = words(b).slice(0, x.length); return x.length >= 2 && y.length === x.length && x.every((w, i) => w === y[i]); };
const INTERRUPT_MS = Number(process.env.INTERRUPT_MIN_MS || 500); // loud speech needed to cut the agent off
// While the greeting plays, a "Hallo?" said over it (people do, the moment a call connects) mustn't
// cut it off; only a longer stretch of speech does.
const GREETING_INTERRUPT_MS = Number(process.env.GREETING_INTERRUPT_MS || 1200);
const TYPING_AFTER_MS = 250; // typing starts almost at once, like someone writing it down
// A call the agent made: it greets after his "Hallo?", or after this much silence.
const OUTBOUND_GREET_MS = 1500;
// His first words run this long without a pause: that's a voicemail greeting, not him.
const VOICEMAIL_MS = Number(process.env.VOICEMAIL_MS || 4000);
// Smart Turn's "not done" counts from this much of his speech on (short answers fooled it).
const SMART_TURN_MIN_MS = 1200;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = (arr, i) => (Array.isArray(arr) ? arr[i % arr.length] : arr);

// `onEvent` feeds the monitor (every call); dev callers also get the events inline.
// `recordDir(callId)` → directory for per-turn audio, or null to not record.
export function createCallSession({ send, dev = false, skill, agenda = skill.createAgenda(), endpoint, model, extractModel, fish, memory = null, assets, config = {}, initialTurns = [], initialLang = null, turnDetector = null, log = () => {}, onEvent = () => {}, onEnd = () => {}, recordDir = null, tools: extraTools = [], firstCall = false }) {
  const cfg = { model, mask: "typing", ...Object.fromEntries(Object.entries(config).filter(([, v]) => v)) };
  const fastModel = cfg.model;
  const slowModel = extractModel || model; // notes and memory stay on one model so modes compare fairly
  const fallbackModel = fastModel === FALLBACK_MODEL ? "gemini-3.5-flash" : FALLBACK_MODEL;
  // The tools this call's templates may use (src/tools/).
  const runner = createToolRunner({ tools: callTools({ memory, allow: agenda.tools(), extra: extraTools }) });
  let toolDecls = null;
  const declarations = () => (toolDecls ??= runner.declarations());
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
  const turns = [...initialTurns];
  let note = {};
  let missing = agenda.missing(note);
  let pendingUser = []; // caller audio not yet answered
  let lastReply = ""; // what the agent said last turn (to catch it repeating itself)
  let current = null; // the turn being answered
  let turnSeq = 0;
  let markSeq = 0;
  const marks = new Set();
  let hangupMark = null;
  let extracting = null;
  let finalized = null;
  let ended = false;
  let lastNext = "listen";
  let lang = initialLang ?? locales().defaultId; // set from Dial's language / the caller's number, then follows the caller
  const lex = (id = lang) => locales().lexicon(id); // this language's word lists (locales/<id>.json)
  let lastWasBackchannel = false;
  let lastHold = false; // he said "Moment" and got a reply: give him longer before nudging
  let retryable = false; // a write failed last turn: his "yes, try again" may run it again
  let lastSpoken = null; // the latest answer to his audio: { turn, at, userAudio, turnsBefore, prevNext }
  let idleTimer = null;
  let waitTimer = null;
  let falseStartTimer = null;
  let nudges = 0;
  let oopsCount = 0;
  let outbound = null; // a call the agent made: { greeted, timer }
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
    vad.setInterruptMs(INTERRUPT_MS);
  }

  // A clip that starts synthesising now (Fish, streamed) and can be drained later, in order.
  function startClip(text, signal, voiceLang) {
    const clip = { text, chunks: [], done: false, error: null, wake: null };
    (async () => {
      try {
        meter.add(ttsCost(fish.model, text));
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

  // Gemini hangs or errors now and then. Hedged requests (Sierra's trick): if the
  // main model hasn't produced a token after HEDGE_MS, or fails before its first
  // token, the backup model starts in parallel; the first to speak wins and the
  // other is cancelled. Words are never repeated (losers are dropped before any
  // of their text is used), and only the winner's tool calls are ever run.
  // `request`: the streamTurn args, or a function model → args (the tool follow-up
  // differs per model). The final "end" event carries the winning model.
  async function* geminiStream(request, signal, turn, { primary = fastModel, backup = fallbackModel } = {}) {
    const argsFor = typeof request === "function" ? request : () => request;
    const attempts = [];
    let wake = null;
    const notify = () => { const w = wake; wake = null; w?.(); };
    const launch = (m, why) => {
      const ctl = new AbortController();
      const att = { m, ctl, events: [], done: false, error: null };
      attempts.push(att);
      if (why) debug("retry", { turn: turn.id, reason: why, next: m });
      (async () => {
        try {
          for await (const ev of streamTurn({ ...argsFor(m), endpoint, model: m, onUsage: u => record("turn", u, turn.id, m), signal: AbortSignal.any([signal, ctl.signal]) })) {
            att.events.push(ev);
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
    const spoke = a => a.events.some(e => e.type !== "end");
    const started = performance.now();
    launch(primary);
    const hedge = setTimeout(() => { if (!winner()) launch(backup, `no first token after ${HEDGE_MS} ms`); notify(); }, HEDGE_MS);
    const winner = () => attempts.find(spoke);
    try {
      let w = null;
      while (!w) {
        w = winner();
        if (w) break;
        if (signal.aborted) throw signal.reason ?? new Error("aborted");
        const failed = attempts.filter(a => a.done && !spoke(a));
        if (failed.length === attempts.length) {
          // everyone failed before a token: one more model, then give up
          const tried = new Set(attempts.map(a => a.m));
          const next = !tried.has(backup) ? backup : attempts.length < 3 ? primary : null;
          if (!next || performance.now() - started > TURN_DEADLINE_MS) throw failed.at(-1).error ?? new Error("all models failed");
          launch(next, failed.at(-1).error?.message?.slice(0, 160) ?? "empty answer");
          continue;
        }
        if (performance.now() - started > TURN_DEADLINE_MS) throw new Error(`no answer after ${TURN_DEADLINE_MS} ms`);
        await new Promise(r => { wake = r; setTimeout(r, 250); });
      }
      clearTimeout(hedge);
      for (const a of attempts) if (a !== w) a.ctl.abort();
      if (w.m !== primary || attempts.length > 1) debug("recovered", { turn: turn.id, model: w.m, attempt: attempts.indexOf(w) + 1 });
      let i = 0;
      for (;;) {
        while (i < w.events.length) { const ev = w.events[i++]; yield ev.type === "end" ? { ...ev, model: w.m } : ev; }
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
    const ms = lastHold ? HOLD_MS : lastWasBackchannel ? BACKCHANNEL_IDLE_MS : IDLE_MS[lastNext] ?? IDLE_MS.listen;
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

  // After a "wait" (he paused mid-thought): if he stays quiet, a soft "mhm" says
  // we're still listening; if he's still quiet after that, the answer to the whole
  // dictation, prepared meanwhile, plays. After "Moment" he gets HOLD_MS and no "mhm".
  // `lastVoice`: when he stopped talking (performance.now()).
  function armWait({ hold = false, lastVoice = performance.now() } = {}) {
    clearTimeout(waitTimer);
    if (hold) {
      const answer = () => {
        if (ended || current || !pendingUser.length) return;
        if (vad.speaking) return armWait({ hold });
        debug("nudge", { kind: "hold_done" });
        runTurn({ force: true }).catch(err => fail("turn", err));
      };
      waitTimer = setTimeout(answer, HOLD_MS);
      return;
    }
    if (ended || current || !pendingUser.length) return;
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const after = ms => Math.max(0, lastVoice + ms - performance.now());
    runTurn({ force: true, held }).catch(err => fail("turn", err));
    const prepared = current;
    waitTimer = setTimeout(() => {
      if (ended || current !== prepared || vad.speaking) return;
      backchannel();
      const tryRelease = () => {
        if (ended || current !== prepared) return;
        // He's starting again (voice building up, not yet speech): wait; onSpeechStart drops it if it is.
        if (vad.speaking || vad.stirring) { waitTimer = setTimeout(tryRelease, 200); return; }
        debug("nudge", { kind: "dictation_done" });
        release();
      };
      waitTimer = setTimeout(tryRelease, after(WAIT_DONE_MS));
    }, after(WAIT_MHM_MS));
  }

  // A quiet "mhm" that doesn't take the floor: no mark, so his speech isn't a
  // barge-in; strict VAD only while it plays, so its echo doesn't count as him.
  function backchannel() {
    const pcm = assets[lang]?.backchannel;
    if (!pcm?.length) return;
    for (const chunk of frames(pcm, 200)) send({ type: "media", payload: chunk.toString("base64") });
    vad.setStrict(true);
    setTimeout(() => { if (!marks.size) vad.setStrict(false); }, durationMs(pcm) + 300);
    debug("backchannel");
  }

  function onSpeechStart() {
    if (outbound && !outbound.greeted) clearTimeout(outbound.timer); // he's saying hello: wait for him
    clearTimeout(idleTimer);
    clearTimeout(waitTimer);
    debug("vad", { speaking: true });
    // He goes on after a pause: the answer prepared meanwhile was never heard. Drop it, from
    // the history too, and put his audio back, so all of it is answered as one thought.
    if (current?.held && !current.released) {
      const t = current;
      current = null;
      t.dropped = true;
      t.abort.abort();
      if (t.turnsBefore != null) turns.splice(t.turnsBefore);
      if (t.userAudio) pendingUser = [...t.userAudio, ...pendingUser];
      debug("prepared_dropped", { turn: t.id });
      return;
    }
    const agentTalking = marks.size > 0 || (current && current.audioSent);
    if (agentTalking) {
      // Not once a tool changed something in that turn: then it stands, and this is a normal barge-in.
      const falseStart = Boolean(lastSpoken) && performance.now() - lastSpoken.at < FALSE_START_MS && !lastSpoken.turn.wrote;
      debug("barge_in", falseStart ? { falseStart } : {});
      stopSpeaking();
      hangupMark = null; // he's still talking: don't hang up on him
      if (falseStart) resumeAfterFalseStart();
    }
    if (current) { current.abort.abort(); current = null; }
  }

  // The agent started answering and he kept going within FALSE_START_MS: he
  // wasn't done. Forget the reply and the turn it answered, and put his audio
  // back, so what he says next is answered together with it, as one thought.
  function resumeAfterFalseStart() {
    const { turn, userAudio, turnsBefore, prevNext } = lastSpoken;
    lastSpoken = null;
    turn.falseStart = true;
    turns.splice(turnsBefore);
    pendingUser = [...userAudio, ...pendingUser];
    lastNext = prevNext;
    vad.setEndSilence(END_SILENCE[prevNext] ?? END_SILENCE.listen);
    vad.setStartMs(START_MS[prevNext] ?? START_MS.listen);
    debug("false_start", { turn: turn.id });
  }

  function onSpeechEnd(pcm) {
    if (outbound && !outbound.greeted && !ended) {
      // The first thing after picking up: "Hallo?" gets the greeting; a long monologue is a mailbox.
      if (durationMs(pcm) >= VOICEMAIL_MS) return voicemail(`${Math.round(durationMs(pcm) / 100) / 10} s without a pause`);
      return greetOutbound({ heardHello: true });
    }
    debug("vad", { speaking: false, ms: Math.round(durationMs(pcm)) });
    if (ended || durationMs(pcm) < 250) return;
    pendingUser.push(pcm);
    nudges = 0;
    lastHold = false;
    runTurn().catch(err => fail("turn", err));
  }

  // `held`: an answer prepared while he pauses (armWait): nothing of it is heard, and no tool
  // changes anything, until it resolves.
  async function runTurn({ text, force = false, held = null } = {}) {
    clearTimeout(idleTimer);
    if (!held) clearTimeout(waitTimer);
    if (!text && !force && pendingUser.reduce((n, p) => n + durationMs(p), 0) > MAX_PENDING_MS) force = true;
    const turn = { id: ++turnSeq, abort: new AbortController(), audioSent: false, fillerPlayed: false, endpointAt: performance.now(), marks: [], prevNext: lastNext, toolNotes: [], retryable: text ? retryable : (r => (retryable = false, r))(retryable), held: Boolean(held), released: !held };
    current = turn;
    const signal = turn.abort.signal;
    const heardPcm = text ? null : Buffer.concat(pendingUser.flatMap((p, i) => (i ? [silence(300), p] : [p])));
    const audio = heardPcm && wav(heardPcm);
    const heardMs = heardPcm ? durationMs(heardPcm) : 0;
    // Is he done? Smart Turn hears it in the audio, while the model writes its answer
    // (it's back in ~0.1 s, the model's header in ~1.5 s). No detector: the word lists decide.
    if (heardPcm && !force && turnDetector) {
      turnDetector.predict(heardPcm).then(r => {
        turn.turnEnd = r;
        if (r) debug("turn", { turn: turn.id, probability: Math.round(r.probability * 1000) / 1000, complete: r.complete, ms: r.ms });
      });
    }
    const inFile = audio ? saveAudio(`turn-${turn.id}-in.wav`, audio) : null;
    const outAudio = [];
    debug("turn_start", { turn: turn.id, ...(text ? { text } : { utteranceMs: Math.round(durationMs(audio) - 44 / 32), merged: pendingUser.length, force }) });
    let reply = "";
    let next = "listen";
    const clips = [];
    let clipsClosed = false;
    let wakePlayer = null;
    let drained = 0; // clips fully sent

    // Latency mask while Gemini thinks: keyboard typing (default), a spoken filler, or nothing.
    // Not while an answer is held: he's mid-thought, and typing would say the agent is answering.
    let filler = null;
    if (held) {
      held.then(() => {
        if (signal.aborted) return;
        turn.released = true;
        turn.endpointAt = performance.now(); // its latency counts from here: he's done now
        for (const text of turn.unsaid ?? []) debug("say", { turn: turn.id, text });
        turn.unsaid = null;
        if (!turn.firstAudioAt && cfg.mask === "typing" && typist && !typist.running) { typist.start(); debug("mask", { kind: "typing", for: "prepared" }); }
        wakePlayer?.();
      });
    } else if (!text && cfg.mask === "typing" && typist) {
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
        // A prepared answer waits for its release (he's done) before he hears any of it.
        if (!turn.released) {
          await Promise.race([held, new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))]);
          if (signal.aborted) return;
        }
        const index = n++;
        const clip = clips[index];
        for await (const chunk of drain(clip)) {
          if (signal.aborted) return;
          if (!turn.firstAudioAt) {
            turn.firstAudioAt = performance.now();
            stopMask();
            if (turn.userAudio) {
              // For a moment after the agent starts, a shorter burst of his speech cuts it off (a false start).
              lastSpoken = { turn, at: turn.firstAudioAt, userAudio: turn.userAudio, turnsBefore: turn.turnsBefore, prevNext: turn.prevNext };
              vad.setInterruptMs(FALSE_START_INTERRUPT_MS);
              clearTimeout(falseStartTimer);
              falseStartTimer = setTimeout(() => vad.setInterruptMs(INTERRUPT_MS), FALSE_START_MS);
            }
            // firstAudioMs counts from the end of his turn (the silence that ended it already passed);
            // sinceSpeechMs from his last word, which is what he actually waits.
            if (!text) debug("latency", { turn: turn.id, firstAudioMs: Math.round(turn.firstAudioAt - turn.endpointAt), sinceSpeechMs: turn.held ? null : Math.round(turn.firstAudioAt - turn.endpointAt + (END_SILENCE[turn.prevNext] ?? END_SILENCE.listen)), firstTokenMs: Math.round(turn.firstTokenAt - turn.endpointAt), fishFirstByteMs: fish?.stream.lastFirstByteMs ?? null, ...(turn.held ? { prepared: true } : {}) });
          }
          if (turn.followFrom != null && index >= turn.followFrom && !turn.followAudioAt) {
            // The answer after the tool: typing stops, and how long the tool hop took goes to the monitor.
            turn.followAudioAt = performance.now();
            typist?.stop();
            debug("tool_latency", { turn: turn.id, hopMs: Math.round(turn.followAudioAt - turn.toolAt), totalMs: Math.round(turn.followAudioAt - turn.endpointAt) });
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
        drained++;
      }
    })();

    const onSentence = sentence => {
      if (signal.aborted || turn.waiting) return;
      if (STAGE_DIRECTION.test(sentence)) { debug("say", { turn: turn.id, text: sentence, note: "stage direction, not spoken" }); return; }
      // Nothing transcribed, and the reply starts like the last one: it didn't catch him and is
      // repeating itself. Say once that it didn't come through, instead of the same answer again.
      if (!reply && !text && turn.heardEmpty && sameStart(sentence, lastReply)) {
        debug("say", { turn: turn.id, text: sentence, note: "repeat after an empty transcript, not spoken" });
        turn.abort.abort();
        if (current === turn) current = null; // his next words are a new turn; the question he was asked still stands (lastNext)
        speakCached(pick(assets[lang]?.oops, 2), "oops");
        return;
      }
      // A filler already said "Mhm": don't say it twice.
      if (turn.fillerPlayed && !reply && lex().fillerPrefix.test(sentence)) {
        const rest = sentence.replace(lex().fillerPrefix, "");
        reply = sentence;
        if (!rest) { debug("say", { turn: turn.id, text: sentence, note: "already said as filler" }); return; }
        sentence = rest[0].toUpperCase() + rest.slice(1);
        reply = "";
      }
      reply += (reply ? " " : "") + sentence;
      clips.push(startClip(sentence, signal, lang));
      wakePlayer?.();
      // A prepared answer is on the monitor only once it plays (if he goes on, it never does).
      if (turn.released) debug("say", { turn: turn.id, text: sentence });
      else (turn.unsaid ??= []).push(sentence);
    };

    const parser = createReplyParser({
      langs: locales().enabled(),
      onHeader: ({ heard, lang: l, next: n }) => {
        if (n === "wait" && (force || text || lastNext === "confirm")) n = "listen"; // he's been quiet, or answered a yes/no question: answer now
        else if (n !== "wait" && !force && !text && lastNext !== "confirm") {
          // He isn't done: Smart Turn says so from his voice, or his words stop on "…die will".
          // Smart Turn only counts on turns of some length the model would answer by listening or
          // asking: on a short "Ja." or a "Tschüss" it said "not done" in testing.
          const st = turn.turnEnd;
          const by = st && heardMs >= SMART_TURN_MIN_MS && (n === "listen" || n === "ask")
            ? (st.complete ? null : "smart-turn")
            : dangling(heard, lex(l || lang)) ? "words" : null;
          if (by) { n = "wait"; debug("dangling", { turn: turn.id, text: heard, by }); }
        }
        next = n;
        if (l) lang = l;
        turn.heardEmpty = !text && (!String(heard ?? "").trim() || locales().unclear.test(String(heard).trim()));
        turn.hold = !text && holdOn(heard, lex(l || lang));
        if (n === "wait") {
          // Unfinished thought: say nothing, keep his audio, and answer it all once he's done.
          turn.waiting = true;
          vad.setEndSilence(END_SILENCE.wait);
          debug("heard", { turn: turn.id, text: heard, next: n, lang, audio: inFile });
          return;
        }
        vad.setEndSilence(END_SILENCE[n] ?? END_SILENCE.listen);
        vad.setStartMs(START_MS[n] ?? START_MS.listen);
        if (!text) Object.assign(turn, { userAudio: pendingUser, turnsBefore: turns.length }); // to undo a false start
        turns.push({ role: "user", text: text ?? (heard || "(not transcribed)") });
        if (!text) turn.userEntry = turns.at(-1); // a tool follow-up may still say what he said
        if (!text) pendingUser = []; // answered (even if the caller cuts in later)
        debug("heard", { turn: turn.id, text: heard, next: n, lang, audio: inFile });
      },
      onSentence,
    });

    // ---------- tools: run what the model called, then one follow-up call with the results ----------
    // A write waits until he can't take the turn back any more, FALSE_START_MS after
    // the agent started talking ("Yes… no wait, make it Thursday" must not file the request).
    async function writeWindow() {
      // A prepared answer changes nothing until he's done: he might still take it all back.
      if (!turn.released) await Promise.race([held, new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }))]);
      if (signal.aborted) return false;
      const t0 = performance.now();
      while (clips.length && !turn.firstAudioAt && !signal.aborted && performance.now() - t0 < 4000) await sleep(50);
      const until = (turn.firstAudioAt ?? t0) + FALSE_START_MS;
      while (!signal.aborted && performance.now() < until) await sleep(Math.min(100, Math.max(10, until - performance.now())));
      return !signal.aborted;
    }
    const toolContext = () => ({
      callId: call.id,
      get lang() { return lang; },
      signal,
      // He answered a yes/no question, and this answer isn't itself asking one (a recap that
      // calls the tool in the same breath would ride on an earlier yes, e.g. to the email read-back).
      // …or a write failed in the turn before and the agent offered to try again. And his words
      // say yes, plainly: no "ja, aber…", no "nee, warte" (checked in code, not left to the model:
      // a phantom yes must never send anything). Gemini sometimes answers with only the tool call,
      // no transcript: then his audio is written down separately and checked. A reply counts as
      // asking only if it has a question mark (the model sometimes labels "Mach ich." as confirm).
      confirmed: async tool => {
        if (!(turn.prevNext === "confirm" || turn.retryable)) return false;
        if ((next === "confirm" || next === "ask") && reply.includes("?")) return false;
        let words = turn.userEntry?.text ?? "";
        if (audio && (!words.trim() || locales().unclear.test(words.trim()))) {
          words = await transcribe({ endpoint, model: FALLBACK_MODEL, audio, signal });
          debug("heard_check", { turn: turn.id, text: words });
          if (words && turn.userEntry) turn.userEntry.text = words;
        }
        if (!affirmed(words, lex(lang))) return false;
        // Sending something: the yes must be to sending, not to the summary before it.
        if (tool?.confirmAbout === "send") {
          const asked = turns[turns.indexOf(turn.userEntry) - 1];
          const aboutSending = text => lex(lang).send.test(String(text ?? ""));
          if (!(asked?.role === "model" && aboutSending(asked.text)) && !aboutSending(words)) return false;
        }
        return true;
      },
      latestNote: freshNote, // the draft, his latest words included
      memory,
      emit: (event, data) => debug(event, { turn: turn.id, ...data }),
      log,
      mayWrite: writeWindow,
      onWrite: () => { turn.wrote = true; },
    });
    const STATUS_WORDS = { ok: "did", repeated: "already done", error: "failed", rejected: "not run", unknown: "unknown tool" };

    async function answerWithTools(calls, request, first) {
      turn.toolAt = performance.now();
      // He hears something before the tool runs: the model's own words, or a cached line.
      if (!reply && !turn.fillerPlayed) {
        const kind = calls.some(c => runner.get(c.name)?.effect === "write") ? "working" : "looking";
        const line = locales().persona(lang, skill.PERSONA)?.[kind];
        if (assets[lang]?.[kind]?.length && line) {
          clips.push({ text: line, chunks: [assets[lang][kind]], done: true });
          wakePlayer?.();
          reply = line;
          debug("say", { turn: turn.id, text: line, note: "tool preface" });
        }
      }
      turn.prefaceLength = reply.length;
      // Typing while it works, once the preface has played out.
      (async () => {
        while (!signal.aborted && !turn.followAudioAt && (drained < clips.length || turn.marks.some(m => marks.has(m)))) await sleep(50);
        if (!signal.aborted && !turn.followAudioAt && typist && !typist.running) { typist.start(); debug("mask", { kind: "typing", for: "tool" }); }
      })();

      const ctx = toolContext();
      const outcomes = [];
      for (const c of calls) {
        const o = await runner.run(c, ctx);
        outcomes.push(o);
        debug("tool", { turn: turn.id, name: o.name, args: o.args, status: o.status, ms: o.ms, summary: o.summary });
        if (STATUS_WORDS[o.status]) turn.toolNotes.push(`[${STATUS_WORDS[o.status]} ${o.name}${o.summary ? `: ${o.summary}` : ""}]`);
        if (o.status === "error" && runner.get(o.name)?.effect === "write") retryable = true;
        if (signal.aborted) return;
      }

      // The follow-up: the same model sees its own call (thought signature included) and the results.
      // Another model can't read that signature, so a backup gets the exchange as plain text.
      const base = [...historyContents(request.history), userContent(request)];
      const native = { ...request, toolMode: "NONE", contents: [...base, { role: "model", parts: first.parts }, { role: "user", parts: outcomes.map(o => ({ functionResponse: { name: o.name, ...(o.id ? { id: o.id } : {}), response: o.result } })) }] };
      const plain = {
        ...request, tools: undefined,
        contents: [...base, { role: "model", parts: [{ text: `${reply} ${calls.map(c => `[called ${c.name}]`).join(" ")}`.trim() }] }, { role: "user", parts: [{ text: `(System: ${outcomes.map(o => `${o.name} returned ${JSON.stringify(o.result)}`).join("; ")}. Now answer him.)` }] }],
      };
      turn.followFrom = clips.length;
      let followNext = null;
      const follow = createReplyParser({
        langs: locales().enabled(),
        onHeader: ({ heard, lang: l, next: n, present }) => {
          if (!present) return;
          followNext = n === "wait" ? "listen" : n;
          if (l) lang = l;
          if (heard && turn.userEntry?.text === "(not transcribed)") { turn.userEntry.text = heard; debug("heard_late", { turn: turn.id, text: heard }); }
        },
        onSentence,
      });
      const backup = first.model === fastModel ? fallbackModel : fastModel;
      for await (const ev of geminiStream(m => (m === first.model ? native : plain), signal, turn, { primary: first.model, backup })) {
        if (ev.type === "text") follow.push(ev.text);
      }
      follow.end();
      if (followNext) next = followNext;
      vad.setEndSilence(END_SILENCE[next] ?? END_SILENCE.listen);
      vad.setStartMs(START_MS[next] ?? START_MS.listen);
    }

    try {
      const tools = declarations();
      const system = agenda.prompt({ note, missing, memory: memory?.context ?? "", lang, tools: tools.map(t => t.name) });
      const extra = force ? "(The caller is speaking in the audio above. He has now been silent for a few seconds: his thought is complete, so respond. Do not answer wait.)" : undefined;
      const request = { system, history: turns.slice(-16), audio, text, extra, tools };
      const calls = [];
      let first = null;
      for await (const ev of geminiStream(request, signal, turn)) {
        if (!turn.firstTokenAt) turn.firstTokenAt = performance.now();
        if (ev.type === "text") parser.push(ev.text);
        else if (ev.type === "call") { parser.flush(); calls.push(ev.call); }
        else if (ev.type === "end") first = ev;
      }
      parser.end();
      if (calls.length && turn.waiting) debug("tool", { turn: turn.id, ignored: calls.map(c => c.name), reason: "NEXT: wait" });
      else if (calls.length && !signal.aborted) await answerWithTools(calls, request, first);
    } catch (err) {
      stopMask();
      if (signal.aborted) { if (turn.toolNotes.length) finishAborted(); return; } // cut off mid-stream: only what a tool did is kept
      fail("gemini", err);
      if (turn.toolNotes.length) turns.push({ role: "model", text: [reply, ...turn.toolNotes].filter(Boolean).join(" ") });
      const i = oopsCount++;
      speakCached(pick(assets[lang]?.oops, i), "oops");
      debug("say", { turn: turn.id, text: pick(locales().persona(lang, skill.PERSONA)?.oops, i) ?? "(oops)", note: "error fallback" });
      if (current === turn) current = null;
      return;
    } finally {
      clipsClosed = true;
      wakePlayer?.();
    }

    await player;
    stopMask();
    // The voice failed for the whole answer: say the pre-recorded sorry rather than nothing.
    if (!outAudio.length && !signal.aborted && clips.some(c => c.error)) speakCached(pick(assets[lang]?.oops, oopsCount++), "oops");
    if (outAudio.length) {
      const outFile = saveAudio(`turn-${turn.id}-out.wav`, wav(Buffer.concat(outAudio)));
      if (outFile) debug("agent_audio", { turn: turn.id, audio: outFile, interrupted: signal.aborted });
    }
    if (signal.aborted) return finishAborted();
    if (turn.waiting) {
      if (current === turn) current = null;
      lastNext = "wait";
      armWait({ hold: turn.hold, lastVoice: turn.endpointAt - (END_SILENCE[turn.prevNext] ?? END_SILENCE.listen) });
      return;
    }
    // What a tool did stays in the history, between the preface and the answer.
    const said = turn.toolNotes.length ? [reply.slice(0, turn.prefaceLength), ...turn.toolNotes, reply.slice(turn.prefaceLength)].map(s => s.trim()).filter(Boolean).join(" ") : reply;
    if (said) turns.push({ role: "model", text: said });
    if (reply) lastReply = reply;
    checkpoint();
    if (current === turn) current = null;
    lastNext = next;
    lastHold = turn.hold;
    lastWasBackchannel = next === "listen" && lex().agentBackchannel.test(reply);
    if (!text) refreshNote();
    if (next === "hangup") hangupMark = sendMark("bye");
    else if (!marks.size) armIdle();

    // Keep only what the caller actually heard (marks that came back), so the
    // model can pick up where it was cut off instead of assuming it said it all.
    function finishAborted() {
      if (turn.falseStart || turn.dropped) return; // a false start, or a prepared answer he never heard
      const heard = turn.marks.filter(m => m && markText.get(m)?.heard).map(m => markText.get(m).text);
      const unsaid = clips.map(c => c.text).slice(heard.length).join(" ");
      if (reply || turn.toolNotes.length) turns.push({ role: "model", text: [...heard, ...turn.toolNotes, `[interrupted by the caller${unsaid ? `; not heard: "${unsaid.slice(0, 160)}"` : ""}]`].join(" ") });
      checkpoint();
    }
  }

  // ---------- slow path ----------
  // Each extraction reads the transcript as it is when it starts; a result is
  // applied only if no newer one already was, so an older one never overwrites it.
  let noteSeq = 0;
  let noteApplied = 0;
  function extractNote({ hedgeMs, retries429 = 0 }) {
    const seq = ++noteSeq;
    const snapshot = turns.slice();
    return extractJsonResilient({ endpoint, models: [slowModel, fallbackModel], hedgeMs, retries429, system: agenda.extractSystem(lang), prompt: agenda.extractPrompt({ turns: snapshot, lang }), schema: agenda.schema(), onUsage: u => record("note", u) })
      .then(updated => {
        if (seq < noteApplied) return note;
        noteApplied = seq;
        noteCovers = snapshot.length;
        const u = agenda.update(updated); // his note, and which of the agent's own items got done (checked in code)
        lastExtraction = updated;
        note = u.note;
        missing = u.missing;
        debug("note", { note, missing });
        for (const c of u.changes) debug("objective", c);
        checkpoint();
        return note;
      });
  }
  // Background refresh after each turn: chained, so they never pile up in parallel.
  function refreshNote() {
    extracting = (extracting ?? Promise.resolve()).then(() => extractNote({ hedgeMs: 6000, retries429: 1 })).catch(err => fail("extract", err));
    return extracting;
  }
  // A tool needs the draft now, his latest words included: a fresh extraction that
  // doesn't queue behind a slow background one. Fails rather than act on a stale draft.
  // If that extraction fails (Gemini slow), the background draft still serves when it already
  // covers every turn but his last one (the "yes" to the recap it was read from).
  let noteCovers = 0;
  const freshNote = () => extractNote({ hedgeMs: 3500 }).catch(err => {
    if (note?.mode && noteCovers >= turns.length - 1) { debug("note", { note, missing, fallback: "the draft from before his yes" }); return note; }
    throw err;
  });

  // The call so far, saved after every turn and note: one write at a time, the latest state wins.
  let lastExtraction = null;
  let saving = null;
  let saveAgain = false;
  function checkpoint() {
    if (!memory?.checkpoint || ended) return;
    if (saving) { saveAgain = true; return; }
    saving = memory.checkpoint({ turns: turns.slice(), extraction: lastExtraction, extractionTurns: noteCovers, lang })
      .catch(err => fail("checkpoint", err))
      .finally(() => { saving = null; if (saveAgain) { saveAgain = false; checkpoint(); } });
  }

  // The call is over: no more model calls here. Its last state goes to onEnd; the
  // after-call job does the final note and memory (on any instance, retried if need be).
  function finalize(reason) {
    if (finalized) return finalized;
    ended = true;
    typist?.stop();
    clearTimeout(idleTimer);
    clearTimeout(waitTimer);
    clearTimeout(falseStartTimer);
    current?.abort.abort();
    vad.reset();
    meter.phone(Date.now() - call.startedAt);
    debug("cost", { final: true, totals: meter.totals() });
    finalized = (async () => {
      await saving;
      await onEnd(reason, { turns: turns.slice(), extraction: lastExtraction, extractionTurns: noteCovers, lang, usd: meter.totals().usd });
    })().catch(err => fail("finalize", err));
    return finalized;
  }

  // ---------- calls the agent made ----------
  // Greeting from the locale pack at once, then the model says why it's calling and asks
  // for two minutes (the persona's outbound section has the rules).
  function greetOutbound({ heardHello }) {
    if (!outbound || outbound.greeted || ended) return;
    outbound.greeted = true;
    clearTimeout(outbound.timer);
    pendingUser = []; // his "Hallo?" needs no answer of its own
    const line = locales().persona(lang, skill.PERSONA)?.outboundGreeting ?? "";
    speakCached(assets[lang]?.outboundGreeting, "greet");
    debug("say", { text: line, note: "outbound greeting" });
    if (line) turns.push({ role: "model", text: line });
    runTurn({ text: `(You called him. He picked up${heardHello ? " and said hello" : ""}; you've just said: "${line}". Go on: in one sentence why you're calling, then ask whether he has two minutes. NEXT: confirm.)` }).catch(err => fail("turn", err));
  }
  function voicemail(why) {
    if (ended) return;
    clearTimeout(outbound?.timer);
    debug("voicemail", { why });
    log(`voicemail (${why}): hanging up`);
    stopSpeaking();
    send({ type: "end_call" });
    debug("hangup", { by: "agent", reason: "voicemail" });
    finalize("voicemail");
  }

  // ---------- protocol ----------
  return {
    get ended() { return ended; },
    handle(msg) {
      switch (msg.type) {
        case "call_connected":
          Object.assign(call, { id: msg.call_id, from: msg.from, to: msg.to });
          if (!msg.reconnect) call.startedAt = Date.now();
          if (!msg.reconnect && !initialLang) lang = pickLanguage({ locales: locales(), dialTag: msg.language, from: msg.from, fallback: skill.DEFAULT_LANG });
          log(`call ${msg.call_id} from ${msg.from ?? "?"} (${lang})${msg.reconnect ? " (reconnect)" : ""}`);
          if (!msg.reconnect && msg.direction === "outbound") {
            outbound = { greeted: false, timer: setTimeout(() => greetOutbound({ heardHello: false }), OUTBOUND_GREET_MS) };
            debug("outbound", { user: msg.user_id ?? null });
          // His first call: the greeting says Toni is an AI assistant (EU AI Act, Art. 50) and how it works.
          } else if (!msg.reconnect && speakCached((firstCall && assets[lang]?.firstGreeting) || assets[lang]?.greeting, "greet")) vad.setInterruptMs(GREETING_INTERRUPT_MS);
          warmModel({ endpoint, model: fastModel }); // Vertex's first request is slow; take that hit during the greeting
          debug("connected", { formats: msg.formats, lang, config: cfg });
          break;
        case "media":
          if (!ended) vad.push(Buffer.from(msg.payload, "base64"));
          break;
        case "mark":
          marks.delete(msg.name);
          if (msg.name.startsWith("greet-")) vad.setInterruptMs(INTERRUPT_MS); // the greeting is out: the usual barge-in again
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
        case "answered_by":
          // The carrier's answering-machine detection (Twilio AMD): a machine gets no message.
          debug("answered_by", { value: msg.answered_by });
          if (/^(machine|fax)/.test(msg.answered_by ?? "")) voicemail(`answered by ${msg.answered_by}`);
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
