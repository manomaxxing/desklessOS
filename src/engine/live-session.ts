// One phone call on Gemini Live (native audio): Gemini hears and speaks by itself.
// Same outside as the cascade session (Dial's self-hosted audio protocol), so
// the test phone, the fake caller and real Dial calls all work unchanged.
//
// Gemini's own VAD does turn-taking and barge-in; we forward 16 kHz caller
// audio, resample its 24 kHz speech to 16 kHz, clear playback on `interrupted`,
// and use both transcripts for the note and the monitor. It hangs up through an
// `end_call` tool. If Live fails, `onFatal` lets the call go on with the cascade
// engine (src/calls/start.ts). Tools come from the same registry as the cascade's
// (src/tools/): memory_search, end_call. Like the cascade, it saves the call as it
// goes (src/engine/call-record.ts) and hands its last state to onEnd(reason, final); the note
// and memory are done after the call (src/calls/after-call.ts).

import WebSocket from "ws";
import type { LangId, Turn } from "../types/common.ts";
import type { FrameIn, FrameOut } from "../types/call.ts";
import type { Tool, ToolOutcome } from "../types/tool.ts";
import type { Mask } from "../config.ts";
import type { CallSessionOptions, EngineAssets, EngineSession } from "./session.ts";
import { liveTarget } from "./live-endpoint.ts";
import { extractJsonResilient, FALLBACK_MODEL } from "./gemini.ts";
import { createTypist } from "./ambience.ts";
import { createVad } from "./vad.ts";
import { resample, frames, wav, durationMs } from "./audio.ts";
import { affirmed } from "./endpointing.ts";
import { locales, pickLanguage } from "../locale/index.ts";
import { createToolRunner } from "../tools/registry.ts";
import { callTools } from "../tools/index.ts";
import { createTelemetry, errorMessage } from "./telemetry.ts";
import { createCallRecord } from "./call-record.ts";
import { envMs } from "./timing.ts";
import { isRecord } from "../shared/is-record.ts";

const MARK_EVERY_MS = 800; // playback checkpoints, to know how much the caller actually heard
const EARLY_FRAMES = 100; // caller audio kept until Gemini is ready (~2 s)
// The time limit: Live is asked to say goodbye and hang up; if it hasn't by then, we do.
const TIME_LIMIT_GRACE_MS = 15000;
const LIVE_SILENCE_MS = envMs("LIVE_SILENCE_MS", 800);
const LIVE_TYPING_AFTER_MS = envMs("LIVE_TYPING_AFTER_MS", 900);

/** The WebSocket to Gemini, as far as the session uses it (ws, or a test's fake). */
export interface LiveSocket {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: "open" | "message" | "close" | "error", listener: (...args: never[]) => void): unknown;
}

export interface LiveFatal {
  reason: string;
  turns: Turn[];
  lang: LangId;
  greeted: boolean;
}

export interface LiveSessionOptions extends Omit<CallSessionOptions, "model" | "fish" | "turnDetector" | "initialTurns" | "initialLang" | "clock" | "config" | "assets"> {
  /** Live speaks itself: only the typing loop is used. */
  assets?: Pick<EngineAssets, "typing">;
  config?: { liveModel?: string; liveVoice?: string; mask?: Mask; [key: string]: unknown };
  /** Live failed (setup refused, socket dropped): the caller goes on with the cascade. */
  onFatal?: (fatal: LiveFatal) => void;
  openSocket?: (url: string, options: { headers: Record<string, string> }) => LiveSocket;
}

export interface LiveSession extends EngineSession {
  /** The server swaps engines on a fatal Live error: stop without finalizing. */
  abandon(): void;
}

/** One model turn being spoken. */
interface AgentTurn {
  id: number;
  text: string;
  chunks: Buffer[];
  /** How much of `text` had been said at the last mark that came back. */
  heardText: number;
  sinceMark: number;
}

const OPEN = 1; // WebSocket.OPEN

export function createLiveSession({
  send, dev = false, skill, agenda = skill.createAgenda(), endpoint, extractModel = null, memory = null, assets = {}, config = {},
  log = () => {}, onEvent = () => {}, onEnd = () => {}, onFatal = () => {}, recordDir = null, tools: extraTools = [], firstCall = false,
  openSocket = (url, options) => new WebSocket(url, options),
}: LiveSessionOptions): LiveSession {
  const cfg = { ...config, liveModel: config.liveModel || "vertex-eu:gemini-3.8-live", liveVoice: config.liveVoice || "Kore", mask: config.mask || "typing" };
  const target = liveTarget(cfg.liveModel);
  const call: { id: string | null; from: string | null; to: string | null; startedAt: number } = { id: null, from: null, to: null, startedAt: Date.now() };
  const tel = createTelemetry({ send, dev, onEvent, log, recordDir, callId: () => call.id });
  const { debug, fail, meter } = tel;
  const audit = (o: ToolOutcome) => {
    if (!o.key || (o.status !== "ok" && o.status !== "error")) return;
    memory?.recordToolRun?.(o).catch(err => fail("tool_runs", err));
  };
  const runner = createToolRunner({ tools: callTools({ engine: "live", memory, allow: agenda.tools(), extra: extraTools }), onRun: audit });
  // Live answers fast, but thinks before longer replies (the wrap-up summary): type meanwhile.
  const typist = assets.typing && cfg.mask === "typing" ? createTypist(assets.typing, chunk => send(media(chunk))) : null;
  let typingTimer: ReturnType<typeof setTimeout> | undefined;
  const stopTyping = () => { clearTimeout(typingTimer); typist?.stop(); };

  const turns: Turn[] = [];
  let lang: LangId = locales().defaultId;
  const lex = () => locales().lexicon(lang);
  const record = createCallRecord({
    agenda, memory, turns, lang: () => lang, debug, fail,
    extract: req => extractJsonResilient<Record<string, unknown>>({ ...req, endpoint, models: [extractModel, FALLBACK_MODEL], onUsage: u => tel.record("note", u, null, extractModel ?? FALLBACK_MODEL) }),
  });

  let gem: LiveSocket | null = null;
  let ready = false;
  let ended = false;
  let finalized: Promise<void> | null = null;
  let fatal = false;
  const early: string[] = []; // caller audio before setupComplete
  const marks = new Set<string>();
  const markInfo = new Map<string, { turn: number; textLength: number }>();
  let markSeq = 0;
  let hangupWanted = false;
  let hangupMark: string | null = null;
  let turnSeq = 0;
  let agent: AgentTurn | null = null;
  let userText = "";
  let userAudio: Buffer[] = [];
  let lastSpeechEnd = 0;
  let timeLimitTimer: ReturnType<typeof setTimeout> | undefined;

  /** To Gemini, if the socket is open (a closed one throws). */
  function toGemini(msg: Record<string, unknown>): boolean {
    if (gem?.readyState !== OPEN) return false;
    try { gem.send(JSON.stringify(msg)); return true; } catch (err) { fail("live", err); return false; }
  }
  const audioIn = (payload: string) => ({ realtimeInput: { audio: { data: payload, mimeType: "audio/pcm;rate=16000" } } });
  const closeGemini = () => { try { gem?.close(); } catch { /* already closed */ } };

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
        typingTimer = setTimeout(() => { if (!agent && !ended) { typist.start(); debug("mask", { kind: "typing" }); } }, LIVE_TYPING_AFTER_MS);
      }
    },
  });

  function sendMark(prefix: string, info?: { turn: number; textLength: number }): string {
    const name = `${prefix}-${++markSeq}`;
    marks.add(name);
    send({ type: "mark", name });
    if (info) markInfo.set(name, info);
    return name;
  }

  // ---------- Gemini Live connection ----------
  async function connect() {
    const headers: Record<string, string> = target.vertex ? { Authorization: (await endpoint.headers()).authorization ?? "" } : {};
    if (ended || fatal) return; // the call ended while the token was fetched: no socket for nobody
    const socket = openSocket(target.url, { headers });
    gem = socket;
    const lines = locales().persona(lang, skill.PERSONA) ?? {};
    const greeting = (firstCall && lines.firstGreeting) || lines.greeting || "";
    socket.on("open", () => {
      toGemini({
        setup: {
          model: target.modelPath,
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.liveVoice } }, ...(target.vertex ? { languageCode: locales().bcp47(lang) } : {}) },
          },
          systemInstruction: { parts: [{ text: agenda.prompt({ engine: "live", note: record.note, missing: record.missing, memory: memory?.context ?? "", lang, tools: runner.declarations().map(d => d.name) }) }] },
          realtimeInputConfig: {
            automaticActivityDetection: { disabled: false, startOfSpeechSensitivity: "START_SENSITIVITY_LOW", endOfSpeechSensitivity: "END_SENSITIVITY_LOW", prefixPaddingMs: 100, silenceDurationMs: LIVE_SILENCE_MS },
            activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          tools: [{ functionDeclarations: runner.declarations() }],
        },
      });
    });
    socket.on("message", (data: { toString(): string }) => {
      let msg: unknown;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!isRecord(msg)) return;
      try { onGemini(msg, greeting); } catch (err) { fail("live", err); }
    });
    socket.on("close", (code: number, reason?: { length: number; toString(): string }) => {
      if (ended) return;
      const why = `Gemini Live closed ${code}${reason?.length ? ": " + reason.toString().slice(0, 160) : ""}`;
      log(why);
      goFatal(why);
    });
    socket.on("error", (err: Error) => { if (!ended) goFatal(`Gemini Live error: ${err.message}`); });
  }

  function goFatal(reason: string) {
    if (fatal || ended) return;
    fatal = true;
    debug("fallback", { what: "engine", from: "gemini-live", to: "cascade", reason });
    closeGemini();
    send({ type: "clear" });
    onFatal({ reason, turns: turns.slice(), lang, greeted: turns.length > 0 || turnSeq > 0 });
  }

  // Gemini's messages, read defensively: a field that isn't what we expect is skipped.
  function onGemini(msg: Record<string, unknown>, greeting: string) {
    if (msg.setupComplete) {
      ready = true;
      debug("live", { text: `connected to ${target.id} · voice ${cfg.liveVoice}` });
      for (const payload of early.splice(0)) toGemini(audioIn(payload));
      toGemini({ realtimeInput: { text: `(The call just connected. Say exactly this, nothing more, then let him speak: "${greeting}")` } });
      return;
    }
    const sc = isRecord(msg.serverContent) ? msg.serverContent : null;
    const textOf = (v: unknown) => (isRecord(v) && typeof v.text === "string" ? v.text : "");
    if (sc) {
      userText += textOf(sc.inputTranscription);
      const parts = isRecord(sc.modelTurn) && Array.isArray(sc.modelTurn.parts) ? sc.modelTurn.parts : [];
      for (const part of parts) {
        const inline = isRecord(part) && isRecord(part.inlineData) ? part.inlineData : null;
        if (inline && typeof inline.data === "string") onAgentAudio(inline.data, typeof inline.mimeType === "string" ? inline.mimeType : "");
      }
      const said = textOf(sc.outputTranscription);
      if (said && agent) {
        agent.text += said;
        debug("say", { turn: agent.id, text: said, delta: true });
      }
      if (sc.interrupted) onInterrupted();
      if (sc.turnComplete) onTurnComplete();
    }
    const fcs = isRecord(msg.toolCall) && Array.isArray(msg.toolCall.functionCalls) ? msg.toolCall.functionCalls : [];
    for (const fc of fcs) {
      if (isRecord(fc) && typeof fc.name === "string") runTool({ id: typeof fc.id === "string" ? fc.id : null, name: fc.name, args: isRecord(fc.args) ? fc.args : {} }).catch(err => fail("tool", err));
    }
    if (isRecord(msg.usageMetadata)) tel.record("live", msg.usageMetadata, agent?.id ?? turnSeq, target.model);
    if (isRecord(msg.goAway)) debug("live", { text: `server goAway, ${String(msg.goAway.timeLeft ?? "?")} left` });
  }

  function commitUser() {
    const text = userText.trim();
    userText = "";
    const pcm = userAudio.length ? Buffer.concat(userAudio) : null;
    userAudio = [];
    if (!text) return;
    turns.push({ role: "user", text });
    record.checkpoint();
    const file = pcm ? tel.saveAudio(`turn-${turnSeq + 1}-in.wav`, () => wav(pcm)) : null;
    lang = locales().guess(text) ?? lang; // Live has no LANG header: guess from his words
    debug("heard", { turn: turnSeq + 1, text, lang, next: "live", audio: file });
  }

  function onAgentAudio(data: string, mimeType: string) {
    const rate = Number(/rate=(\d+)/.exec(mimeType)?.[1] ?? 24000);
    const pcm = resample(Buffer.from(data, "base64"), rate, 16000);
    stopTyping();
    if (!agent) {
      commitUser();
      agent = { id: ++turnSeq, text: "", chunks: [], heardText: 0, sinceMark: 0 };
      const now = performance.now();
      if (lastSpeechEnd && now - lastSpeechEnd < 15000) {
        debug("latency", { turn: agent.id, firstAudioMs: Math.round(now - lastSpeechEnd), firstTokenMs: Math.round(now - lastSpeechEnd), fishFirstByteMs: null });
      }
      lastSpeechEnd = 0;
    }
    if (tel.recording) agent.chunks.push(pcm);
    for (const chunk of frames(pcm, 200)) send(media(chunk));
    agent.sinceMark += durationMs(pcm);
    if (agent.sinceMark >= MARK_EVERY_MS) {
      agent.sinceMark = 0;
      sendMark(`a${agent.id}`, { turn: agent.id, textLength: agent.text.length });
    }
  }

  function closeAgentTurn({ interrupted }: { interrupted: boolean }) {
    if (!agent) return;
    const a = agent;
    agent = null;
    if (a.chunks.length) {
      const file = tel.saveAudio(`turn-${a.id}-out.wav`, () => wav(Buffer.concat(a.chunks)));
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
    record.checkpoint();
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
    if (hadAgent) void record.refresh();
    if (hangupWanted && !hangupMark) hangupMark = sendMark("bye");
  }

  // ---------- tools ----------
  // Live speaks its own preface and decides when to call; we run the tool and answer.
  // No false-start window here: Live has no NEXT header to check against. A tool that needs his
  // yes gets it only from what he said, checked in code (as on the cascade): the agent's words
  // before his were a question, and his are a plain yes (to sending, for a tool that sends).
  function confirmed(tool: Tool): Promise<boolean> {
    commitUser();
    let i = turns.length - 1;
    while (i >= 0 && turns[i]!.role !== "user") i--;
    const words = turns[i]?.text ?? "";
    const asked = turns[i - 1];
    if (!(asked?.role === "model" && asked.text.includes("?"))) return Promise.resolve(false);
    if (!affirmed(words, lex())) return Promise.resolve(false);
    if (tool.confirmAbout === "send" && !lex().send.test(asked.text) && !lex().send.test(words)) return Promise.resolve(false);
    return Promise.resolve(true);
  }

  async function runTool(fc: { id: string | null; name: string; args: Record<string, unknown> }) {
    const tool = runner.get(fc.name);
    if (tool?.effect === "write") typist?.start(); // until Live speaks the result
    const outcome = await runner.run(fc, {
      callId: call.id,
      get lang() { return lang; },
      confirmed,
      latestNote: () => { commitUser(); return record.fresh(); },
      memory,
      emit: (event, data) => debug(event, { turn: turnSeq, ...data }),
      log,
      hangup: () => {
        hangupWanted = true;
        debug("live", { text: "model called end_call" });
        if (!agent && !marks.size && !hangupMark) hangupMark = sendMark("bye");
      },
    });
    debug("tool", { turn: turnSeq, name: outcome.name, args: outcome.args, status: outcome.status, ms: outcome.ms, summary: outcome.summary });
    toGemini({ toolResponse: { functionResponses: [{ id: fc.id, name: fc.name, response: outcome.result }] } });
  }

  // The call is over: its last state goes to onEnd; the after-call job does the note and memory.
  function finalize(reason: string): Promise<void> {
    if (finalized) return finalized;
    commitUser();
    closeAgentTurn({ interrupted: false });
    ended = true;
    stopTyping();
    clearTimeout(timeLimitTimer);
    closeGemini();
    meter.phone(Date.now() - call.startedAt);
    debug("cost", { final: true, totals: meter.totals() });
    finalized = (async () => {
      await record.close();
      await onEnd(reason, { ...record.snapshot(), usd: meter.totals().usd });
    })().catch(err => fail("finalize", err));
    return finalized;
  }
  function hangUp(reason: string) {
    send({ type: "end_call" });
    debug("hangup", { by: "agent", ...(reason === "agent_hangup" ? {} : { reason }) });
    void finalize(reason);
  }

  function connected(msg: Extract<FrameIn, { type: "call_connected" }>) {
    Object.assign(call, { id: msg.call_id ?? null, from: msg.from ?? null, to: msg.to ?? null });
    if (!msg.reconnect) {
      call.startedAt = Date.now();
      lang = pickLanguage({ locales: locales(), dialTag: msg.language, from: msg.from, fallback: skill.DEFAULT_LANG });
      connect().catch(err => goFatal(errorMessage(err)));
    }
    log(`call ${msg.call_id} from ${msg.from ?? "?"} (${lang}) on ${target.id}${msg.reconnect ? " (reconnect)" : ""}`);
    debug("connected", { formats: msg.formats, lang, config: { engine: "live", ...cfg } });
  }

  // ---------- Dial protocol ----------
  return {
    get ended() { return ended; },
    abandon() { ended = true; stopTyping(); clearTimeout(timeLimitTimer); closeGemini(); },
    handle(msg) {
      switch (msg.type) {
        case "call_connected":
          connected(msg);
          break;
        case "media":
          if (ended || fatal || typeof msg.payload !== "string") break;
          vad.push(Buffer.from(msg.payload, "base64"));
          if (ready) toGemini(audioIn(msg.payload));
          else if (early.length < EARLY_FRAMES) early.push(msg.payload);
          break;
        case "mark": {
          const name = msg.name ?? "";
          marks.delete(name);
          const info = markInfo.get(name);
          if (info && agent && info.turn === agent.id) agent.heardText = info.textLength;
          markInfo.delete(name);
          if (name && name === hangupMark && !ended) hangUp("agent_hangup");
          break;
        }
        case "ping_pong":
          send(msg);
          break;
        case "duration_warning":
          if (ended || timeLimitTimer) break;
          debug("duration_warning");
          toGemini({ realtimeInput: { text: "(The call is about to hit its time limit. Say a one-sentence goodbye now, mention that the note is saved, then call end_call.)" } });
          timeLimitTimer = setTimeout(() => { if (!ended) hangUp("time_limit"); }, TIME_LIMIT_GRACE_MS);
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

const media = (chunk: Buffer): FrameOut => ({ type: "media", payload: chunk.toString("base64") });
