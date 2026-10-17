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
// agenda (src/agenda/agenda.ts), built from the persona and templates; what we
// know about him from `memory`, the call's memory scope (src/memory/), read once
// when the call connected. The call is saved as it goes (src/engine/call-record.ts); when it
// ends, onEnd(reason, final) gets its last state, and everything slow (the final note,
// memory, objectives) happens after the call, in its after-call job (src/calls/after-call.ts).
// `config` (per call; the browser test phone picks its own): { model, mask: "typing"|"filler"|"none" }.
//
// Its parts: timing (src/engine/timing.ts), the hedged model stream (hedged-stream.ts), the
// voice per sentence (clips.ts), the small decisions (turn-rules.ts), what it reports
// (telemetry.ts) and keeps (call-record.ts). This file is the conversation's state machine.

import type { Clock, LangId, Log, Next, TimerHandle, Turn } from "../types/common.ts";
import type { CallEvent, CallScope, CallSnapshot, FrameIn, FrameOut, LangClips } from "../types/call.ts";
import type { Endpoint, StreamEvent } from "../types/gemini.ts";
import type { FunctionDeclaration, Tool, ToolCall, ToolContext, ToolOutcome } from "../types/tool.ts";
import type { Agenda } from "../agenda/agenda.ts";
import type { Mask } from "../config.ts";
import type { SpeakOptions } from "./fish.ts";
import type { TurnDetector, TurnEnd } from "./turn-detector.ts";
import { createVad } from "./vad.ts";
import { createReplyParser, isToolCallText } from "./reply.ts";
import { extractJsonResilient, warmModel, userContent, historyContents, transcribe, FALLBACK_MODEL } from "./gemini.ts";
import { wav, silence, frames, durationMs } from "./audio.ts";
import { createTypist } from "./ambience.ts";
import { holdOn, affirmed, misheard } from "./endpointing.ts";
import { locales, pickLanguage } from "../locale/index.ts";
import { createToolRunner, type CallTool } from "../tools/registry.ts";
import { callTools } from "../tools/index.ts";
import { createTelemetry } from "./telemetry.ts";
import { createCallRecord } from "./call-record.ts";
import { createHedgedStream, type TurnRequest } from "./hedged-stream.ts";
import { drain, readyClip, startClip, type Clip } from "./clips.ts";
import { isStageDirection, judgeNext, onlyReacts, pick, sameStart } from "./turn-rules.ts";
import {
  BACKCHANNEL_IDLE_MS, CUT_OFF_GRACE_MS, FALSE_START_INTERRUPT_MS, FALSE_START_MS, FILLER_AFTER_MS, GREETING_INTERRUPT_MS, HOLD_MS,
  INTERRUPT_MS, MAX_PENDING_MS, OUTBOUND_GREET_MS, PREFACE_WAIT_MS, SPECULATE_MAX, SPECULATE_MS, TYPING_AFTER_MS, VOICEMAIL_MS,
  WAIT_DONE_MS, WAIT_MHM_MS, WRAP_UP_GRACE_MS, endSilenceFor, idleMsFor, realClock, startMsFor,
} from "./timing.ts";

/** What the engine needs of the skill (src/skills/): its persona's id, its default language, its agenda. */
export interface EngineSkill {
  PERSONA: string;
  DEFAULT_LANG: LangId;
  createAgenda(): Agenda;
}
/** The call's memory scope (src/memory/call-scope.ts), or what a test passes for it. */
export type EngineMemory = Pick<CallScope, "context" | "hidden" | "search" | "checkpoint"> & Partial<Pick<CallScope, "recordToolRun">>;
/** One persona's pre-rendered clips: each language's (assets[lang]), and the typing loop. */
export type EngineAssets = Partial<Record<LangId, LangClips>> & { typing?: Buffer };
/** The call's last state, for its end (src/calls/start.ts closes the call's row with it). */
export type CallFinal = CallSnapshot & { usd: number };
export type OnEnd = (reason: string, final: CallFinal) => unknown;

export interface CallSessionOptions {
  send: (frame: FrameOut) => void;
  /** Dev callers (the test phone, scripted calls) get the engine's events inline. */
  dev?: boolean;
  skill: EngineSkill;
  agenda?: Agenda;
  endpoint: Endpoint;
  model: string;
  extractModel?: string | null;
  fish: { model: string; stream: (text: string, opts?: SpeakOptions) => AsyncIterable<Buffer> };
  memory?: EngineMemory | null;
  assets: EngineAssets;
  config?: { model?: string; mask?: Mask; [key: string]: unknown };
  initialTurns?: readonly Turn[];
  initialLang?: LangId | null;
  turnDetector?: Pick<TurnDetector, "predict"> | null;
  log?: Log;
  /** Feeds the monitor (every call). */
  onEvent?: (event: CallEvent) => void;
  onEnd?: OnEnd;
  /** callId → the directory for per-turn audio, or null not to record. */
  recordDir?: ((callId: string) => string | null) | null;
  tools?: readonly CallTool[];
  /** His first call: the greeting says Toni is an AI assistant (EU AI Act, Art. 50) and how it works. */
  firstCall?: boolean;
  clock?: Clock;
}

/** One call's engine, as the host (src/telephony/host.ts) drives it. */
export interface EngineSession {
  readonly ended: boolean;
  handle(msg: FrameIn): void;
  close(reason?: string): Promise<void>;
}

/** The turn being answered. */
interface ActiveTurn {
  id: number;
  abort: AbortController;
  /** Started from a held promise: nothing of it is heard, and no tool changes anything, until it's released. */
  held: boolean;
  released: boolean;
  /** Prepared at a pause inside his utterance (thinking at the pause). */
  speculative: boolean;
  speculationUsed: boolean;
  audioSent: boolean;
  fillerPlayed: boolean;
  /** When his turn ended (a held answer: when it was released): latency counts from here. */
  endpointAt: number;
  marks: string[];
  prevNext: Next;
  toolNotes: string[];
  retryable: boolean;
  wrote: boolean;
  /** Undone: a false start, or a held answer he never heard. */
  falseStart: boolean;
  dropped: boolean;
  /** NEXT: wait (he isn't done) and, with it, "Moment" (hold the floor longer). */
  waiting: boolean;
  hold: boolean;
  /** Misheard (checked in code): why. `misheardHeld`: found while held, decided when it would play. */
  misheard: string;
  misheardHeld: string;
  heardEmpty: boolean;
  toolCallText: boolean;
  /** NEXT of the answer, while the VAD's settings wait for the answer's release. */
  vadNext: Next | null;
  /** His audio and the history's length before it, to undo a false start. */
  userAudio: Buffer[] | null;
  turnsBefore: number | null;
  userEntry: Turn | null;
  turnEnd: TurnEnd | null;
  /** Sentences of a held answer, on the monitor once it plays. */
  unsaid: string[];
  firstTokenAt: number | null;
  firstAudioAt: number | null;
  toolAt: number | null;
  followFrom: number | null;
  followAudioAt: number | null;
  prefaceLength: number;
}

interface TurnOptions {
  /** A turn without his audio: a nudge, the outbound opening. */
  text?: string;
  /** He's been quiet: answer now, whatever the model thinks of his pause. */
  force?: boolean;
  /** An answer prepared while he pauses: plays when this resolves. */
  held?: Promise<void> | null;
}

/** The latest answer to his audio, for a false start: what to undo. */
interface Spoken {
  turn: ActiveTurn;
  at: number;
  userAudio: Buffer[];
  turnsBefore: number;
  prevNext: Next;
}

const STATUS_WORDS: Partial<Record<ToolOutcome["status"], string>> = { ok: "did", repeated: "already done", error: "failed", rejected: "not run", unknown: "unknown tool" };
const media = (chunk: Buffer): FrameOut => ({ type: "media", payload: chunk.toString("base64") });

export function createCallSession({
  send, dev = false, skill, agenda = skill.createAgenda(), endpoint, model, extractModel = null, fish, memory = null, assets, config = {},
  initialTurns = [], initialLang = null, turnDetector = null, log = () => {}, onEvent = () => {}, onEnd = () => {}, recordDir = null,
  tools: extraTools = [], firstCall = false, clock = realClock,
}: CallSessionOptions): EngineSession {
  const sleep = (ms: number) => new Promise<void>(resolve => { clock.setTimeout(resolve, ms); });
  const whenAborted = (signal: AbortSignal) => new Promise<void>(resolve => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));
  const fastModel = config.model || model;
  const mask: Mask = config.mask || "typing";
  const cfg = { ...config, model: fastModel, mask };
  const slowModel = extractModel || model; // notes and memory stay on one model so modes compare fairly
  const fallbackModel = fastModel === FALLBACK_MODEL ? "gemini-3.5-flash" : FALLBACK_MODEL;

  const call: { id: string | null; from: string | null; to: string | null; startedAt: number } = { id: null, from: null, to: null, startedAt: Date.now() };
  const tel = createTelemetry({ send, dev, onEvent, log, recordDir, callId: () => call.id });
  const { debug, fail, meter } = tel;
  // What a tool changed, kept per call and input (tool_runs): the audit trail.
  const audit = (o: ToolOutcome) => {
    if (!o.key || (o.status !== "ok" && o.status !== "error")) return;
    memory?.recordToolRun?.(o).catch(err => fail("tool_runs", err));
  };
  // The tools this call's templates may use (src/tools/).
  const runner = createToolRunner({ tools: callTools({ memory, allow: agenda.tools(), extra: extraTools }), onRun: audit });
  let toolDecls: FunctionDeclaration[] | null = null;
  const declarations = () => (toolDecls ??= runner.declarations());

  const turns: Turn[] = [...initialTurns];
  let lang: LangId = initialLang ?? locales().defaultId; // set from Dial's language / the caller's number, then follows the caller
  const lex = (id: LangId = lang) => locales().lexicon(id); // this language's word lists (locales/<id>.json)
  const clipsOf = (id: LangId = lang): LangClips => assets[id] ?? {};
  const record = createCallRecord({
    agenda, memory, turns, lang: () => lang, debug, fail,
    extract: req => extractJsonResilient<Record<string, unknown>>({ ...req, endpoint, models: [slowModel, fallbackModel], onUsage: u => tel.record("note", u, null, slowModel) }),
  });
  const geminiStream = createHedgedStream({ endpoint, clock, debug, onUsage: (u, m, turnId) => tel.record("turn", u, turnId, m) });

  let pendingUser: Buffer[] = []; // caller audio not yet answered
  let lastReply = ""; // what the agent said last turn (to catch it repeating itself)
  let current: ActiveTurn | null = null; // the turn being answered
  let turnSeq = 0;
  let markSeq = 0;
  const marks = new Set<string>();
  const markText = new Map<string, { turn: number; text: string; heard: boolean }>(); // sentence marks: what was heard
  let hangupMark: string | null = null;
  let finalized: Promise<void> | null = null;
  let ended = false;
  let lastNext: Next = "listen";
  let lastOnlyReacted = false; // her last reply only reacted ("Mhm.", "Verstehe."): a short silence and she goes on
  let lastHold = false; // he said "Moment" and got a reply: give him longer before nudging
  let retryable = false; // a write failed last turn: his "yes, try again" may run it again
  let lastSpoken: Spoken | null = null;
  let idleTimer: TimerHandle | null = null;
  let waitTimer: TimerHandle | null = null;
  let falseStartTimer: TimerHandle | null = null;
  let nudges = 0;
  let oopsCount = 0;
  let askedToRepeat = false; // the agent's last words asked him to say it again
  let outbound: { greeted: boolean; timer: TimerHandle | null } | null = null; // a call the agent made
  let timeUp = false; // the time limit: the wrap-up is said and the call ends, whatever he says
  let spec: { turn: ActiveTurn; piece: Buffer; release: () => void } | null = null; // the answer being prepared at his pause
  let speculations = 0;
  // The latest turn's work: the end of the call waits (briefly) for an answer the hang-up cut off,
  // so what he heard of it is in the transcript.
  let lastTurnWork: Promise<void> = Promise.resolve();

  const vad = createVad({ onSpeechStart, onSpeechEnd, onPause, onResume, pauseMs: SPECULATE_MS, endSilenceMs: endSilenceFor("listen"), interruptMs: INTERRUPT_MS });
  function vadFor(n: Next) {
    vad.setEndSilence(endSilenceFor(n));
    vad.setStartMs(startMsFor(n));
  }
  // How long a pause ends his next utterance, from the NEXT of the answer. An answer still held
  // while his utterance is open (prepared at a pause) keeps it until it's released.
  function turnVad(turn: ActiveTurn, n: Next) {
    if (!turn.released && (turn.speculative || vad.speaking)) { turn.vadNext = n; return; }
    vadFor(n);
  }
  // Typing doesn't count as the agent talking: no strict VAD, no marks.
  const typist = assets.typing ? createTypist(assets.typing, chunk => send(media(chunk))) : null;

  // ---------- audio out ----------
  function sendAudio(pcm: Buffer) {
    for (const chunk of frames(pcm, 200)) send(media(chunk));
    vad.setStrict(true);
  }
  function sendMark(prefix: string): string {
    const name = `${prefix}-${++markSeq}`;
    marks.add(name);
    send({ type: "mark", name });
    return name;
  }
  function speakCached(pcm: Buffer | null | undefined, prefix: string): string | null {
    if (prefix === "oops") askedToRepeat = true;
    if (!pcm?.length) return null;
    sendAudio(pcm);
    return sendMark(prefix);
  }
  /** The pre-recorded "didn't catch that", the next one in turn (or the i-th). */
  function oops(i = oopsCount++): void {
    speakCached(pick(clipsOf().oops, i), "oops");
  }
  function stopSpeaking() {
    send({ type: "clear" });
    marks.clear();
    vad.setStrict(false);
    vad.setInterruptMs(INTERRUPT_MS);
  }
  /** A turn ends its life as the current one (if it still is). */
  function letGo(turn: ActiveTurn) {
    if (current === turn) current = null;
  }

  // ---------- turns ----------
  // Caller silent after the agent finished: nudge once, then wrap up.
  function armIdle() {
    clock.clearTimeout(idleTimer);
    const ms = lastHold ? HOLD_MS : lastOnlyReacted ? BACKCHANNEL_IDLE_MS : idleMsFor(lastNext);
    if (ended || hangupMark || current || !ms) return;
    idleTimer = clock.setTimeout(() => {
      if (ended || current || marks.size) return;
      if (vad.speaking) { armIdle(); return; }
      if (lastOnlyReacted) {
        lastOnlyReacted = false;
        debug("nudge", { kind: "after_reaction" });
        runTurn({ text: "(Silence: he didn't go on after your short reaction. He's done; continue with the next step.)" });
        return;
      }
      nudges += 1;
      debug("nudge", { kind: nudges === 1 ? "first" : "second" });
      runTurn({ text: nudges === 1 ? "(Silence: the caller has said nothing for a few seconds.)" : "(Silence: the caller has said nothing for a while, the second time.)" });
    }, ms);
  }

  // After a "wait" (he paused mid-thought): if he stays quiet, a soft "mhm" says
  // we're still listening; if he's still quiet after that, the answer to the whole
  // dictation, prepared meanwhile, plays. After "Moment" he gets HOLD_MS and no "mhm".
  // `lastVoice`: when he stopped talking (clock.now()).
  function armWait({ hold = false, lastVoice = clock.now() }: { hold?: boolean; lastVoice?: number } = {}) {
    clock.clearTimeout(waitTimer);
    if (hold) {
      const answer = () => {
        if (ended || current || !pendingUser.length) return;
        if (vad.speaking) { armWait({ hold }); return; }
        debug("nudge", { kind: "hold_done" });
        runTurn({ force: true });
      };
      waitTimer = clock.setTimeout(answer, HOLD_MS);
      return;
    }
    if (ended || current || !pendingUser.length) return;
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const after = (ms: number) => Math.max(0, lastVoice + ms - clock.now());
    const prepared = runTurn({ force: true, held });
    waitTimer = clock.setTimeout(() => {
      if (ended || current !== prepared || vad.speaking) return;
      backchannel();
      const tryRelease = () => {
        if (ended || current !== prepared) return;
        // He's starting again (voice building up, not yet speech): wait; onSpeechStart drops it if it is.
        if (vad.speaking || vad.stirring) { waitTimer = clock.setTimeout(tryRelease, 200); return; }
        debug("nudge", { kind: "dictation_done" });
        if (prepared.misheardHeld) {
          undoHeld(prepared);
          debug("say", { turn: prepared.id, note: `not spoken: ${prepared.misheardHeld}` });
          oops();
          return;
        }
        release();
      };
      waitTimer = clock.setTimeout(tryRelease, after(WAIT_DONE_MS));
    }, after(WAIT_MHM_MS));
  }

  // A quiet "mhm" that doesn't take the floor: no mark, so his speech isn't a
  // barge-in; strict VAD only while it plays, so its echo doesn't count as him.
  function backchannel() {
    const pcm = clipsOf().backchannel;
    if (!pcm?.length) return;
    for (const chunk of frames(pcm, 200)) send(media(chunk));
    vad.setStrict(true);
    clock.setTimeout(() => { if (!marks.size) vad.setStrict(false); }, durationMs(pcm) + 300);
    debug("backchannel");
  }

  function onSpeechStart() {
    if (outbound && !outbound.greeted) clock.clearTimeout(outbound.timer); // he's saying hello: wait for him
    clock.clearTimeout(idleTimer);
    clock.clearTimeout(waitTimer);
    speculations = 0;
    debug("vad", { speaking: true });
    // He goes on after a pause: the answer prepared meanwhile was never heard. Drop it, from
    // the history too, and put his audio back, so all of it is answered as one thought.
    if (current?.held && !current.released) {
      const t = current;
      undoHeld(t);
      debug("prepared_dropped", { turn: t.id });
      return;
    }
    const agentTalking = marks.size > 0 || Boolean(current?.audioSent);
    if (agentTalking) {
      // Not once a tool changed something in that turn: then it stands, and this is a normal barge-in.
      const falseStart = Boolean(lastSpoken) && clock.now() - lastSpoken!.at < FALSE_START_MS && !lastSpoken!.turn.wrote;
      debug("barge_in", falseStart ? { falseStart } : {});
      stopSpeaking();
      if (!timeUp) hangupMark = null; // he's still talking: don't hang up on him (unless the time is up)
      if (falseStart) resumeAfterFalseStart();
    }
    if (current) { current.abort.abort(); current = null; }
  }

  // The agent started answering and he kept going within FALSE_START_MS: he
  // wasn't done. Forget the reply and the turn it answered, and put his audio
  // back, so what he says next is answered together with it, as one thought.
  function resumeAfterFalseStart() {
    if (!lastSpoken) return;
    const { turn, userAudio, turnsBefore, prevNext } = lastSpoken;
    lastSpoken = null;
    turn.falseStart = true;
    turns.splice(turnsBefore);
    pendingUser = [...userAudio, ...pendingUser];
    lastNext = prevNext;
    vadFor(prevNext);
    debug("false_start", { turn: turn.id });
  }

  function onSpeechEnd(pcm: Buffer) {
    const ms = durationMs(pcm);
    if (outbound && !outbound.greeted && !ended) {
      // The first thing after picking up: "Hallo?" gets the greeting; a long monologue is a mailbox.
      if (ms >= VOICEMAIL_MS) { voicemail(`${Math.round(ms / 100) / 10} s without a pause`); return; }
      greetOutbound({ heardHello: true });
      return;
    }
    debug("vad", { speaking: false, ms: Math.round(ms) });
    if (ended || timeUp || ms < 250) { if (spec) dropSpeculation("utterance too short"); return; }
    if (spec) {
      const { turn, piece, release } = spec;
      spec = null;
      nudges = 0;
      lastHold = false;
      // Prepared at the pause, and he stayed quiet: it plays now. His audio is already in it.
      if (current === turn && !turn.released && !turn.misheardHeld) {
        turn.speculationUsed = true;
        debug("speculation_used", { turn: turn.id });
        release();
        return;
      }
      if (current === turn && turn.misheardHeld) undoHeld(turn); // misheard: hear it again, the usual way
      // It said he isn't done: that wait (a soft mhm, then the answer) is already running.
      if (turn.waiting) return;
      // It failed: answer the utterance the usual way.
      pendingUser = pendingUser.filter(p => p !== piece);
    }
    pendingUser.push(pcm);
    nudges = 0;
    lastHold = false;
    runTurn();
  }

  // ---------- thinking at the pause ----------
  // Not while the agent talks or a turn runs, before an outbound greeting, or on a short sound.
  function onPause(pcm: Buffer) {
    if (!SPECULATE_MS || ended || timeUp || spec || current || marks.size || hangupMark || speculations >= SPECULATE_MAX) return;
    if ((outbound && !outbound.greeted) || durationMs(pcm) < 400) return;
    speculations += 1;
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    pendingUser.push(pcm);
    const turn = runTurn({ held, speculative: true });
    spec = { turn, piece: pcm, release };
    debug("speculate", { turn: turn.id, ms: Math.round(durationMs(pcm)) });
  }
  // He goes on: what was prepared is dropped unheard (and its turn out of the history); his
  // utterance isn't over, the VAD hands it over whole when it is.
  function onResume() {
    if (spec) dropSpeculation("he went on");
  }
  // A held answer he never heard: gone, from the history too, and his audio back where it was.
  function undoHeld(t: ActiveTurn) {
    letGo(t);
    t.dropped = true;
    t.abort.abort();
    if (t.turnsBefore !== null) turns.splice(t.turnsBefore);
    if (t.userAudio) pendingUser = [...t.userAudio, ...pendingUser];
  }
  function dropSpeculation(why: string) {
    if (!spec) return;
    const { turn, piece } = spec;
    spec = null;
    clock.clearTimeout(waitTimer);
    if (current?.held && !current.released) undoHeld(current);
    pendingUser = pendingUser.filter(p => p !== piece);
    vadFor(lastNext);
    debug("speculation_dropped", { turn: turn.id, why });
  }

  // A turn starts now (and is the current one from now on); its answer streams in the background.
  function runTurn({ text, force = false, held = null, speculative = false }: TurnOptions & { speculative?: boolean } = {}): ActiveTurn {
    clock.clearTimeout(idleTimer);
    if (!held) clock.clearTimeout(waitTimer);
    if (!text && !force && pendingUser.reduce((n, p) => n + durationMs(p), 0) > MAX_PENDING_MS) force = true;
    const turn: ActiveTurn = {
      id: ++turnSeq, abort: new AbortController(), held: Boolean(held), released: !held, speculative, speculationUsed: false,
      audioSent: false, fillerPlayed: false, endpointAt: clock.now(), marks: [], prevNext: lastNext, toolNotes: [],
      retryable: text ? retryable : retryable && !(retryable = false), // his audio answers it: a retry is offered once
      wrote: false, falseStart: false, dropped: false, waiting: false, hold: false, misheard: "", misheardHeld: "", heardEmpty: false,
      toolCallText: false, vadNext: null, userAudio: null, turnsBefore: null, userEntry: null, turnEnd: null, unsaid: [],
      firstTokenAt: null, firstAudioAt: null, toolAt: null, followFrom: null, followAudioAt: null, prefaceLength: 0,
    };
    current = turn;
    const work = answer(turn, { text, force, held }).catch(err => fail("turn", err));
    lastTurnWork = work;
    return turn;
  }

  async function answer(turn: ActiveTurn, { text, force = false, held = null }: TurnOptions): Promise<void> {
    const signal = turn.abort.signal;
    const heardPcm = text ? null : Buffer.concat(pendingUser.flatMap((p, i) => (i ? [silence(300), p] : [p])));
    const audio = heardPcm ? wav(heardPcm) : null;
    const heardMs = heardPcm ? durationMs(heardPcm) : 0;
    // Is he done? Smart Turn hears it in the audio, while the model writes its answer
    // (it's back in ~0.1 s, the model's header in ~1.5 s). No detector: the word lists decide.
    if (heardPcm && !force && turnDetector) {
      turnDetector.predict(heardPcm).then(r => {
        turn.turnEnd = r;
        if (r) debug("turn", { turn: turn.id, probability: Math.round(r.probability * 1000) / 1000, complete: r.complete, ms: r.ms });
      }, () => {});
    }
    const inFile = audio ? tel.saveAudio(`turn-${turn.id}-in.wav`, audio) : null;
    const outAudio: Buffer[] | null = tel.recording ? [] : null; // what he heard of it, kept only when the call is recorded
    debug("turn_start", { turn: turn.id, ...(text ? { text } : { utteranceMs: Math.round(heardMs), merged: pendingUser.length, force }) });
    let reply = "";
    let next = "listen" as Next; // set by the header callbacks (a plain annotation would narrow it to "listen" here)
    const clips: Clip[] = [];
    let clipsClosed = false;
    let wakePlayer: (() => void) | null = null;
    let drained = 0; // clips fully sent
    const wake = () => wakePlayer?.();

    // Latency mask while Gemini thinks: keyboard typing (default), a spoken filler, or nothing.
    // Not while an answer is held: he's mid-thought, and typing would say the agent is answering.
    let filler: TimerHandle | null = null;
    if (held) {
      void held.then(() => {
        if (signal.aborted) return;
        turn.released = true;
        turn.endpointAt = clock.now(); // its latency counts from here: he's done now
        if (turn.vadNext) turnVad(turn, turn.vadNext);
        for (const s of turn.unsaid) debug("say", { turn: turn.id, text: s });
        turn.unsaid = [];
        if (!turn.firstAudioAt && mask === "typing" && typist && !typist.running) { typist.start(); debug("mask", { kind: "typing", for: "prepared" }); }
        wake();
      });
    } else if (!text && mask === "typing" && typist) {
      filler = clock.setTimeout(() => { if (!signal.aborted && !turn.firstAudioAt) { typist.start(); debug("mask", { kind: "typing" }); } }, TYPING_AFTER_MS);
    } else if (!text && mask === "filler") {
      filler = clock.setTimeout(() => {
        const fillers = clipsOf().fillers ?? [];
        if (!signal.aborted && !turn.audioSent && fillers.length) {
          turn.audioSent = true;
          turn.fillerPlayed = true;
          const m = speakCached(fillers[turnSeq % fillers.length], "filler");
          if (m) turn.marks.push(m);
          debug("filler");
        }
      }, FILLER_AFTER_MS);
    }
    const stopMask = () => { clock.clearTimeout(filler); typist?.stop(); };
    const untilReleased = () => (turn.released ? Promise.resolve() : Promise.race([held ?? Promise.resolve(), whenAborted(signal)]));

    // Player: sends clips in order as their bytes arrive.
    const player = (async () => {
      let n = 0;
      for (;;) {
        if (n >= clips.length) {
          if (clipsClosed) return;
          await new Promise<void>(resolve => { wakePlayer = resolve; });
          wakePlayer = null;
          continue;
        }
        // A prepared answer waits for its release (he's done) before he hears any of it.
        if (!turn.released) {
          await untilReleased();
          if (signal.aborted) return;
        }
        const index = n++;
        const clip = clips[index]!;
        for await (const chunk of drain(clip)) {
          if (signal.aborted) return;
          if (!turn.firstAudioAt) firstAudio(clip);
          if (turn.followFrom !== null && index >= turn.followFrom && !turn.followAudioAt) {
            // The answer after the tool: typing stops, and how long the tool hop took goes to the monitor.
            turn.followAudioAt = clock.now();
            typist?.stop();
            debug("tool_latency", { turn: turn.id, hopMs: Math.round(turn.followAudioAt - (turn.toolAt ?? turn.endpointAt)), totalMs: Math.round(turn.followAudioAt - turn.endpointAt) });
          }
          turn.audioSent = true;
          outAudio?.push(chunk);
          sendAudio(chunk);
        }
        if (signal.aborted) return;
        if (clip.chunks.length) {
          const name = sendMark(`t${turn.id}`);
          markText.set(name, { turn: turn.id, text: clip.text, heard: false });
          turn.marks.push(name);
        }
        drained++;
      }
    })();

    function firstAudio(clip: Clip) {
      const at = clock.now();
      turn.firstAudioAt = at;
      stopMask();
      if (turn.userAudio && turn.turnsBefore !== null) {
        // For a moment after the agent starts, a shorter burst of his speech cuts it off (a false start).
        lastSpoken = { turn, at, userAudio: turn.userAudio, turnsBefore: turn.turnsBefore, prevNext: turn.prevNext };
        vad.setInterruptMs(FALSE_START_INTERRUPT_MS);
        clock.clearTimeout(falseStartTimer);
        falseStartTimer = clock.setTimeout(() => vad.setInterruptMs(INTERRUPT_MS), FALSE_START_MS);
      }
      // firstAudioMs counts from the end of his turn (the silence that ended it already passed);
      // sinceSpeechMs from his last word, which is what he actually waits.
      if (!text) {
        debug("latency", {
          turn: turn.id,
          firstAudioMs: Math.round(at - turn.endpointAt),
          sinceSpeechMs: turn.held && !turn.speculative ? null : Math.round(at - turn.endpointAt + endSilenceFor(turn.prevNext)),
          firstTokenMs: turn.firstTokenAt === null ? null : Math.round(turn.firstTokenAt - turn.endpointAt),
          fishFirstByteMs: clip.firstByteMs,
          ...(turn.speculative ? { speculative: true } : turn.held ? { prepared: true } : {}),
        });
      }
    }

    // A sentence of the answer: spoken, unless it mustn't be.
    const onSentence = (sentence: string) => {
      if (signal.aborted || turn.waiting) return;
      if (isStageDirection(sentence)) { debug("say", { turn: turn.id, text: sentence, note: "stage direction, not spoken" }); return; }
      if (turn.misheard && !reply) {
        debug("say", { turn: turn.id, text: sentence, note: `not spoken: ${turn.misheard}` });
        turn.abort.abort();
        letGo(turn);
        oops();
        return;
      }
      // A tool call written out as text: never read out, and nothing after it in this reply either.
      if (turn.toolCallText || isToolCallText(sentence)) { turn.toolCallText = true; debug("say", { turn: turn.id, text: sentence, note: "a tool call written as text, not spoken" }); return; }
      // Nothing transcribed, and the reply starts like the last one: it didn't catch him and is
      // repeating itself. Say once that it didn't come through, instead of the same answer again.
      if (!reply && !text && turn.heardEmpty && sameStart(sentence, lastReply)) {
        debug("say", { turn: turn.id, text: sentence, note: "repeat after an empty transcript, not spoken" });
        turn.abort.abort();
        letGo(turn); // his next words are a new turn; the question he was asked still stands (lastNext)
        oops(2);
        return;
      }
      // A filler already said "Mhm": don't say it twice.
      if (turn.fillerPlayed && !reply && lex().fillerPrefix.test(sentence)) {
        const rest = sentence.replace(lex().fillerPrefix, "");
        if (!rest) { reply = sentence; debug("say", { turn: turn.id, text: sentence, note: "already said as filler" }); return; }
        sentence = rest[0]!.toUpperCase() + rest.slice(1);
      }
      reply += (reply ? " " : "") + sentence;
      clips.push(startClip(sentence, { fish, signal, lang, meter, onError: err => fail("fish", err) }));
      wake();
      // A prepared answer is on the monitor only once it plays (if he goes on, it never does).
      if (turn.released) debug("say", { turn: turn.id, text: sentence });
      else turn.unsaid.push(sentence);
    };

    const lastUserWords = () => [...turns].reverse().find(t => t.role === "user" && !t.text.startsWith("("))?.text;
    const parser = createReplyParser({
      langs: locales().enabled(),
      onHeader: ({ heard, lang: l, next: said }) => {
        const judged = judgeNext({ next: said, answerNow: force || Boolean(text) || lastNext === "confirm", heard, heardMs, turnEnd: turn.turnEnd, lex: lex(l || lang) });
        let n = judged.next;
        if (judged.by) debug("dangling", { turn: turn.id, text: heard, by: judged.by });
        // Misheard, checked in code: a goodbye to words nobody understood ("00:00"), or a transcript
        // that is just his previous turn again (the model copied it). He hears that it didn't come
        // through, instead of a hang-up or an answer to something he didn't say.
        if (!text && n !== "wait") {
          const why = misheard(heard, { next: n, lastUser: lastUserWords(), askedToRepeat });
          if (why && turn.released) { turn.misheard = why; n = "listen"; }
          else if (why) turn.misheardHeld = why; // decided when it would play (he's mid-pause)
        }
        next = n;
        if (l) lang = l;
        turn.heardEmpty = !text && (!heard.trim() || locales().unclear.test(heard.trim()));
        turn.hold = !text && holdOn(heard, lex(l || lang));
        if (n === "wait") {
          // Unfinished thought: say nothing, keep his audio, and answer it all once he's done.
          turn.waiting = true;
          turnVad(turn, "wait");
          debug("heard", { turn: turn.id, text: heard, next: n, lang, audio: inFile });
          return;
        }
        turnVad(turn, n);
        if (!text) { turn.userAudio = pendingUser; turn.turnsBefore = turns.length; } // to undo a false start
        const entry: Turn = { role: "user", text: text ?? (turn.misheard ? "(unclear)" : heard || "(not transcribed)") };
        turns.push(entry);
        if (!text) {
          turn.userEntry = entry; // a tool follow-up may still say what he said
          pendingUser = []; // answered (even if the caller cuts in later)
        }
        debug("heard", { turn: turn.id, text: heard, next: n, lang, audio: inFile });
      },
      onSentence,
    });

    // ---------- tools: run what the model called, then one follow-up call with the results ----------
    // A write waits until he can't take the turn back any more, FALSE_START_MS after
    // the agent started talking ("Yes… no wait, make it Thursday" must not file the request).
    async function writeWindow(): Promise<boolean> {
      // A prepared answer changes nothing until he's done: he might still take it all back.
      await untilReleased();
      if (signal.aborted) return false;
      const t0 = clock.now();
      while (clips.length && !turn.firstAudioAt && !signal.aborted && clock.now() - t0 < PREFACE_WAIT_MS) await sleep(50);
      const until = (turn.firstAudioAt ?? t0) + FALSE_START_MS;
      while (!signal.aborted && clock.now() < until) await sleep(Math.min(100, Math.max(10, until - clock.now())));
      return !signal.aborted;
    }
    // He answered a yes/no question, and this answer isn't itself asking one (a recap that
    // calls the tool in the same breath would ride on an earlier yes, e.g. to the email read-back).
    // …or a write failed in the turn before and the agent offered to try again. And his words
    // say yes, plainly: no "ja, aber…", no "nee, warte" (checked in code, not left to the model:
    // a phantom yes must never send anything). Gemini sometimes answers with only the tool call,
    // no transcript: then his audio is written down separately and checked. A reply counts as
    // asking only if it has a question mark (the model sometimes labels "Mach ich." as confirm).
    async function confirmed(tool: Tool): Promise<boolean> {
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
      if (tool.confirmAbout === "send") {
        const asked = turn.userEntry ? turns[turns.indexOf(turn.userEntry) - 1] : undefined;
        const aboutSending = (s: string | undefined) => lex(lang).send.test(String(s ?? ""));
        if (!(asked?.role === "model" && aboutSending(asked.text)) && !aboutSending(words)) return false;
      }
      return true;
    }
    const toolContext = (): ToolContext => ({
      callId: call.id,
      get lang() { return lang; },
      signal,
      confirmed,
      latestNote: record.fresh, // the draft, his latest words included
      memory,
      emit: (event, data) => debug(event, { turn: turn.id, ...data }),
      log,
      mayWrite: writeWindow,
      onWrite: () => { turn.wrote = true; },
    });

    async function answerWithTools(calls: ToolCall[], request: TurnRequest, first: Extract<StreamEvent, { type: "end" }>) {
      turn.toolAt = clock.now();
      // He hears something before the tool runs: the model's own words, or a cached line.
      if (!reply && !turn.fillerPlayed) {
        const kind = calls.some(c => runner.get(c.name)?.effect === "write") ? "working" : "looking";
        const line = locales().persona(lang, skill.PERSONA)?.[kind];
        const pcm = clipsOf()[kind];
        if (pcm?.length && line) {
          clips.push(readyClip(line, pcm));
          wake();
          reply = line;
          debug("say", { turn: turn.id, text: line, note: "tool preface" });
        }
      }
      turn.prefaceLength = reply.length;
      // Typing while it works, once the preface has played out.
      void (async () => {
        while (!signal.aborted && !turn.followAudioAt && (drained < clips.length || turn.marks.some(m => marks.has(m)))) await sleep(50);
        if (!signal.aborted && !turn.followAudioAt && typist && !typist.running) { typist.start(); debug("mask", { kind: "typing", for: "tool" }); }
      })();

      const ctx = toolContext();
      const outcomes: ToolOutcome[] = [];
      for (const c of calls) {
        const o = await runner.run(c, ctx);
        outcomes.push(o);
        debug("tool", { turn: turn.id, name: o.name, args: o.args, status: o.status, ms: o.ms, summary: o.summary });
        const word = STATUS_WORDS[o.status];
        if (word) turn.toolNotes.push(`[${word} ${o.name}${o.summary ? `: ${o.summary}` : ""}]`);
        if (o.status === "error" && runner.get(o.name)?.effect === "write") retryable = true;
        if (signal.aborted) return;
      }

      // The follow-up: the same model sees its own call (thought signature included) and the results.
      // Another model can't read that signature, so a backup gets the exchange as plain text.
      const base = [...historyContents(request.history ?? []), userContent(request)];
      const native: TurnRequest = {
        ...request, toolMode: "NONE",
        contents: [...base, { role: "model", parts: first.parts }, { role: "user", parts: outcomes.map(o => ({ functionResponse: { name: o.name, ...(o.id ? { id: o.id } : {}), response: o.result } })) }],
      };
      const plain: TurnRequest = {
        ...request, tools: undefined,
        contents: [...base, { role: "model", parts: [{ text: `${reply} ${calls.map(c => `[called ${c.name}]`).join(" ")}`.trim() }] }, { role: "user", parts: [{ text: `(System: ${outcomes.map(o => `${o.name} returned ${JSON.stringify(o.result)}`).join("; ")}. Now answer him.)` }] }],
      };
      turn.followFrom = clips.length;
      let followNext: Next | null = null;
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
      const firstModel = first.model ?? fastModel;
      const backup = firstModel === fastModel ? fallbackModel : fastModel;
      for await (const ev of geminiStream(m => (m === firstModel ? native : plain), signal, turn.id, { primary: firstModel, backup })) {
        if (ev.type === "text") follow.push(ev.text);
      }
      follow.end();
      if (followNext) next = followNext;
      turnVad(turn, next);
    }

    try {
      const tools = declarations();
      const system = agenda.prompt({ note: record.note, missing: record.missing, memory: memory?.context ?? "", lang, tools: tools.map(t => t.name) });
      const extra = force ? "(The caller is speaking in the audio above. He has now been silent for a few seconds: his thought is complete, so respond. Do not answer wait.)" : undefined;
      const request: TurnRequest = { system, history: turns.slice(-16), audio: audio ?? undefined, text, extra, tools };
      const calls: ToolCall[] = [];
      let first: Extract<StreamEvent, { type: "end" }> | null = null;
      for await (const ev of geminiStream(request, signal, turn.id, { primary: fastModel, backup: fallbackModel })) {
        turn.firstTokenAt ??= clock.now();
        if (ev.type === "text") parser.push(ev.text);
        else if (ev.type === "call") { parser.flush(); calls.push(ev.call); }
        else first = ev;
      }
      parser.end();
      const ignored = calls.map(c => c.name);
      if (calls.length && (turn.misheard || turn.misheardHeld)) {
        debug("tool", { turn: turn.id, ignored, reason: turn.misheard || turn.misheardHeld });
        if (turn.misheard && !reply && !signal.aborted) { turn.abort.abort(); letGo(turn); oops(); }
      } else if (calls.length && turn.waiting) debug("tool", { turn: turn.id, ignored, reason: "NEXT: wait" });
      else if (calls.length && first && !signal.aborted) await answerWithTools(calls, request, first);
    } catch (err) {
      stopMask();
      if (signal.aborted) { if (turn.toolNotes.length) finishAborted(); return; } // cut off mid-stream: only what a tool did is kept
      fail("gemini", err);
      // A held answer that failed while he's still mid-sentence: nothing of it may be heard yet.
      // Prepared at a pause: undone quietly, his turn is heard again the usual way when it ends.
      // Prepared after a "wait": the sorry comes when the answer would have played.
      if (held && !turn.released) {
        if (turn.speculative) { undoHeld(turn); return; }
        await untilReleased();
        if (signal.aborted) return;
      }
      // What he already heard of it plays out and stays in the history; then the sorry.
      clipsClosed = true;
      wake();
      await player;
      if (signal.aborted) return;
      if (reply || turn.toolNotes.length) turns.push({ role: "model", text: [reply, ...turn.toolNotes, reply ? "[the answer broke off here]" : ""].filter(Boolean).join(" ") });
      const i = oopsCount++;
      oops(i);
      debug("say", { turn: turn.id, text: pick(locales().persona(lang, skill.PERSONA)?.oops, i) ?? "(oops)", note: "error fallback" });
      letGo(turn);
      return;
    } finally {
      clipsClosed = true;
      wake();
    }

    await player;
    // A held answer with nothing to play (only a stage direction, a tool call written out) still
    // waits for its release: none of what follows (a sorry, the history, a hang-up) while he talks.
    if (held && !turn.released && !turn.waiting && !signal.aborted) await untilReleased();
    stopMask();
    // The voice failed for the whole answer: say the pre-recorded sorry rather than nothing.
    if (!turn.audioSent && !signal.aborted && clips.some(c => c.error)) oops();
    // Only a tool call written out as text, nothing said: he hears it didn't come through, and says it again.
    else if (turn.toolCallText && !reply && !signal.aborted && !turn.waiting) oops();
    if (outAudio?.length) {
      const outFile = tel.saveAudio(`turn-${turn.id}-out.wav`, () => wav(Buffer.concat(outAudio)));
      if (outFile) debug("agent_audio", { turn: turn.id, audio: outFile, interrupted: signal.aborted });
    }
    if (signal.aborted) { finishAborted(); return; }
    if (turn.waiting) {
      letGo(turn);
      lastNext = "wait";
      armWait({ hold: turn.hold, lastVoice: turn.endpointAt - (turn.speculative && !turn.released ? SPECULATE_MS : endSilenceFor(turn.prevNext)) });
      return;
    }
    // What a tool did stays in the history, between the preface and the answer.
    const said = turn.toolNotes.length ? [reply.slice(0, turn.prefaceLength), ...turn.toolNotes, reply.slice(turn.prefaceLength)].map(s => s.trim()).filter(Boolean).join(" ") : reply;
    if (said) { turns.push({ role: "model", text: said }); askedToRepeat = false; }
    if (reply) lastReply = reply;
    for (const m of turn.marks) markText.delete(m); // all of it is in the history now
    record.checkpoint();
    letGo(turn);
    lastNext = next;
    lastHold = turn.hold;
    lastOnlyReacted = next === "listen" && onlyReacts(reply, lex());
    if (!text) void record.refresh();
    if (next === "hangup") hangupMark = sendMark("bye");
    else if (!marks.size) armIdle();

    // Keep only what the caller actually heard (marks that came back), so the
    // model can pick up where it was cut off instead of assuming it said it all.
    function finishAborted() {
      if (turn.falseStart || turn.dropped) return; // a false start, or a prepared answer he never heard
      const heard = turn.marks.map(m => markText.get(m)).filter(m => m?.heard).map(m => m!.text);
      for (const m of turn.marks) markText.delete(m);
      const unsaid = clips.map(c => c.text).slice(heard.length).join(" ");
      if (reply || turn.toolNotes.length) turns.push({ role: "model", text: [...heard, ...turn.toolNotes, `[interrupted by the caller${unsaid ? `; not heard: "${unsaid.slice(0, 160)}"` : ""}]`].join(" ") });
      record.checkpoint();
    }
  }

  // The call is over: no more model calls here. Its last state goes to onEnd; the
  // after-call job does the final note and memory (on any instance, retried if need be).
  function finalize(reason: string): Promise<void> {
    if (finalized) return finalized;
    ended = true;
    typist?.stop();
    clock.clearTimeout(idleTimer);
    clock.clearTimeout(waitTimer);
    clock.clearTimeout(falseStartTimer);
    clock.clearTimeout(outbound?.timer);
    current?.abort.abort();
    marks.clear(); // nothing more comes back from the phone: no loop may wait for it
    const cutOff = lastTurnWork;
    vad.reset();
    meter.phone(Date.now() - call.startedAt);
    debug("cost", { final: true, totals: meter.totals() });
    finalized = (async () => {
      await Promise.race([cutOff, sleep(CUT_OFF_GRACE_MS)]); // an answer the hang-up cut off records what he heard
      await record.close();
      await onEnd(reason, { ...record.snapshot(), usd: meter.totals().usd });
    })().catch(err => fail("finalize", err));
    return finalized;
  }

  // ---------- calls the agent made ----------
  // Greeting from the locale pack at once, then the model says why it's calling and asks
  // for two minutes (the persona's outbound section has the rules).
  function greetOutbound({ heardHello }: { heardHello: boolean }) {
    if (!outbound || outbound.greeted || ended) return;
    outbound.greeted = true;
    clock.clearTimeout(outbound.timer);
    pendingUser = []; // his "Hallo?" needs no answer of its own
    const line = locales().persona(lang, skill.PERSONA)?.outboundGreeting ?? "";
    speakCached(clipsOf().outboundGreeting, "greet");
    debug("say", { text: line, note: "outbound greeting" });
    if (line) turns.push({ role: "model", text: line });
    runTurn({ text: `(You called him. He picked up${heardHello ? " and said hello" : ""}; you've just said: "${line}". Go on: in one sentence why you're calling, then ask whether he has two minutes. NEXT: confirm.)` });
  }
  function voicemail(why: string) {
    if (ended) return;
    clock.clearTimeout(outbound?.timer);
    debug("voicemail", { why });
    log(`voicemail (${why}): hanging up`);
    hangUp("voicemail");
  }
  /** The agent ends the call. */
  function hangUp(reason: string, extra: Record<string, unknown> = {}) {
    if (reason !== "agent_hangup") stopSpeaking();
    send({ type: "end_call" });
    debug("hangup", { by: "agent", ...(reason === "agent_hangup" ? {} : { reason }), ...extra });
    void finalize(reason);
  }

  function connected(msg: Extract<FrameIn, { type: "call_connected" }>) {
    Object.assign(call, { id: msg.call_id ?? null, from: msg.from ?? null, to: msg.to ?? null });
    if (msg.reconnect) {
      // The old line took its unplayed audio and marks with it: none of them will come back.
      marks.clear();
      vad.setStrict(false);
      vad.setInterruptMs(INTERRUPT_MS);
      if (hangupMark) hangupMark = sendMark("bye");
      else if (!current) armIdle();
    } else {
      call.startedAt = Date.now();
      if (!initialLang) lang = pickLanguage({ locales: locales(), dialTag: msg.language, from: msg.from, fallback: skill.DEFAULT_LANG });
    }
    log(`call ${msg.call_id} from ${msg.from ?? "?"} (${lang})${msg.reconnect ? " (reconnect)" : ""}`);
    if (!msg.reconnect && msg.direction === "outbound") {
      outbound = { greeted: false, timer: clock.setTimeout(() => greetOutbound({ heardHello: false }), OUTBOUND_GREET_MS) };
      debug("outbound", { user: msg.user_id ?? null });
    } else if (!msg.reconnect && speakCached((firstCall && clipsOf().firstGreeting) || clipsOf().greeting, "greet")) {
      vad.setInterruptMs(GREETING_INTERRUPT_MS);
    }
    void warmModel({ endpoint, model: fastModel }); // Vertex's first request is slow; take that hit during the greeting
    debug("connected", { formats: msg.formats, lang, config: cfg });
  }

  // The time limit: the wrap-up, then the call ends even if the bye mark never comes back
  // (he talked over it: marks cleared).
  function timeLimit() {
    if (timeUp || ended) return;
    debug("duration_warning");
    timeUp = true;
    if (current) { current.abort.abort(); current = null; }
    if (spec) dropSpeculation("time limit");
    clock.clearTimeout(idleTimer);
    clock.clearTimeout(waitTimer);
    stopSpeaking();
    const wrap = clipsOf().wrapUp;
    speakCached(wrap, "wrap");
    hangupMark = sendMark("bye");
    clock.setTimeout(() => { if (!ended) hangUp("time_limit"); }, (wrap?.length ? durationMs(wrap) : 0) + WRAP_UP_GRACE_MS);
  }

  // ---------- protocol ----------
  return {
    get ended() { return ended; },
    handle(msg) {
      switch (msg.type) {
        case "call_connected":
          connected(msg);
          break;
        case "media":
          if (!ended && typeof msg.payload === "string") vad.push(Buffer.from(msg.payload, "base64"));
          break;
        case "mark": {
          const name = msg.name ?? "";
          marks.delete(name);
          if (name.startsWith("greet-")) vad.setInterruptMs(INTERRUPT_MS); // the greeting is out: the usual barge-in again
          const sentence = markText.get(name);
          if (sentence) sentence.heard = true;
          if (!marks.size) { vad.setStrict(false); if (!current) armIdle(); }
          if (name && name === hangupMark && !ended) hangUp("agent_hangup");
          break;
        }
        case "ping_pong":
          send(msg);
          break;
        case "duration_warning":
          timeLimit();
          break;
        case "answered_by":
          // The carrier's answering-machine detection (Twilio AMD): a machine gets no message.
          debug("answered_by", { value: msg.answered_by });
          if (/^(machine|fax)/.test(msg.answered_by ?? "")) voicemail(`answered by ${msg.answered_by}`);
          break;
        case "call_ended":
          debug("ended", { reason: msg.reason ?? "ended" });
          void finalize(msg.reason ?? "ended");
          break;
        default:
          break;
      }
    },
    close(reason = "socket_closed") { return finalize(reason); },
  };
}
