// The test phone's call: idle → connecting (the mic, then the line) → live → idle.
// It speaks Dial's protocol to /dial/<id>?dev=1 (src/telephony/dial.ts): our mic as media
// frames, the agent's voice back, marks echoed once their audio has played, and the call's
// events inline as debug frames. One call at a time: a second tap while it connects cancels it.

import { wsUrl } from "../shared/api.ts";
import { openAudio, b64FromInt16, int16FromB64, type CallAudio } from "./audio.ts";
import type { Mode, MonitorEvent } from "../shared/types.ts";

export type CallState = "idle" | "connecting" | "live";
/** What the orb shows during a call. */
export type Activity = "listening" | "thinking" | "speaking";
export type DebugFrame = MonitorEvent & { type: "debug" };
type Frame = { type: "media"; payload: string } | { type: "mark"; name: string } | { type: "clear" } | { type: "end_call" } | DebugFrame;

export interface CallHooks {
  onState(state: CallState): void;
  /** A new call: the panels start empty. */
  onStarting(): void;
  onDebug(d: DebugFrame): void;
  onError(message: string): void;
  onEnded(): void;
  /** Once a second-ish: how long the call runs. */
  onTick(seconds: number): void;
}

let state: CallState = "idle";
let attempt = 0; // a stop() cancels the attempt that's still connecting
let ws: WebSocket | null = null;
let audio: CallAudio | null = null;
let starting: AbortController | null = null;
let ping: ReturnType<typeof setInterval> | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
let markTimers: ReturnType<typeof setTimeout>[] = [];
let seq = 0;
let muted = false;
let awaitingSince = 0; // he stopped talking: the agent is thinking (until her voice comes)
let micLevel = 0;
let hooks: CallHooks;

export const callState = (): CallState => state;
export const isMuted = (): boolean => muted;

export function activity(): Activity {
  if (audio?.speaking()) return "speaking";
  if (awaitingSince && performance.now() - awaitingSince < 15000) return "thinking";
  return "listening";
}
/** The orb's level, once per frame: the agent's voice while she speaks, his mic while she listens (it decays). */
export function level(a: Activity): number {
  const v = a === "speaking" ? audio?.outputLevel() ?? 0 : a === "listening" ? Math.min(1, micLevel * 2.2) : 0;
  micLevel *= 0.9;
  return v;
}

const send = (f: object): void => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(f)); };
function setState(s: CallState): void { state = s; hooks.onState(s); }

export function initCall(h: CallHooks): void { hooks = h; }

/** Calls (idle), cancels (connecting), hangs up (live). */
export function toggleCall(opts: { lang: string; mode: Mode }): void {
  if (state === "idle") void start(opts);
  else stop();
}

async function start({ lang, mode }: { lang: string; mode: Mode }): Promise<void> {
  if (state !== "idle") return;
  const mine = ++attempt;
  setState("connecting");
  starting = new AbortController();
  try {
    const a = await openAudio(starting.signal);
    if (mine !== attempt) { a.close(); return; }
    audio = a;
    const callId = `dev-${Math.random().toString(36).slice(2, 10)}`;
    const sock = new WebSocket(wsUrl(`/dial/${callId}?dev=1`));
    ws = sock;
    hooks.onStarting();
    sock.onopen = () => {
      if (ws !== sock) return;
      const pick = lang === "auto" ? (navigator.language || "de").slice(0, 2) : lang;
      const en = pick === "en";
      send({ type: "call_connected", call_id: callId, direction: "inbound", from: en ? "+1-browser" : "+49-browser", to: "+1-dev", instruction: null, language: en ? "en-US" : "de-DE", formats: { inbound: "l16_16000", outbound: "l16_16000" }, reconnect: false, config: mode });
      a.onFrame = (frame, peak) => { send({ type: "media", payload: b64FromInt16(frame), seq: ++seq }); micLevel = Math.max(micLevel, peak); };
      ping = setInterval(() => send({ type: "ping_pong", timestamp: Date.now() }), 2000);
      const startedAt = Date.now();
      clock = setInterval(() => hooks.onTick(Math.floor((Date.now() - startedAt) / 1000)), 500);
      setState("live");
    };
    sock.onmessage = e => {
      if (ws !== sock) return;
      let f: Frame;
      try { f = JSON.parse(String(e.data)) as Frame; } catch { return; }
      onFrame(f);
    };
    sock.onclose = () => { if (ws === sock) stop(false); };
  } catch (err) {
    if (mine !== attempt) return; // cancelled: nothing to say
    hooks.onError((err as Error).message);
    stop(false);
  } finally {
    if (mine === attempt) starting = null;
  }
}

/** Ends it (or the attempt to start it); sendEnd: tell the server (we hung up). Safe to call twice. */
export function stop(sendEnd = true): void {
  if (state === "idle") return;
  attempt++;
  starting?.abort();
  starting = null;
  if (sendEnd) send({ type: "call_ended", reason: "caller_hangup" });
  clearInterval(ping);
  clearInterval(clock);
  markTimers.forEach(clearTimeout);
  markTimers = [];
  const sock = ws;
  ws = null;
  if (sock) { sock.onclose = null; sock.onmessage = null; try { sock.close(); } catch { /* closed */ } }
  audio?.close();
  audio = null;
  awaitingSince = 0;
  muted = false;
  setState("idle");
  hooks.onEnded();
}

export function setMuted(on: boolean): void {
  if (state !== "live") return;
  muted = on;
  audio?.setMuted(on);
}

function onFrame(f: Frame): void {
  switch (f.type) {
    case "media":
      audio?.play(int16FromB64(f.payload));
      awaitingSince = 0;
      break;
    case "mark": {
      if (!audio) break; // the call ended meanwhile
      const name = f.name;
      markTimers.push(setTimeout(() => send({ type: "mark", name }), audio.untilPlayed()));
      break;
    }
    case "clear":
      audio?.clear();
      markTimers.forEach(clearTimeout);
      markTimers = [];
      break;
    case "end_call": {
      const mine = attempt;
      setTimeout(() => { if (mine === attempt) stop(false); }, 300);
      break;
    }
    case "debug":
      // He stopped (a pause long enough to answer), or the turn starts from text: she's thinking.
      if ((f.event === "vad" && !f.speaking && (f.ms ?? 0) > 250) || (f.event === "turn_start" && f.text)) awaitingSince = performance.now();
      hooks.onDebug(f);
      break;
  }
}
