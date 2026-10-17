// Call monitor: every call's timeline (what was heard, what was said, VAD,
// fillers, barge-ins, latency, note updates, errors) for the /monitor page.
// Live calls: kept here while they run, and sent to every instance over the bus, so
// a monitor page sees the calls of all instances. Finished calls: the timeline goes
// into the call's row (the call wiring passes end()'s record to memory.endCall), and
// the list and details come from Postgres (`store`: recentCalls, getCall).
// To the other instances, a call's events go out in batches (one NOTIFY every BATCH_MS, in
// order), not one NOTIFY each. Only ended calls make room for new ones: a live call keeps its
// timeline (capped at MAX_EVENTS, the oldest dropped, with a "trimmed" mark) until it ends.
// RECORD_CALLS=1 also keeps per-turn audio on this instance's disk (local runs).

import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { MAX_PAYLOAD, payloadBytes } from "./bus.ts";
import { isRecord } from "./shared/is-record.ts";
import type { Bus } from "./bus.ts";
import type { CallEvent } from "./types/call.ts";
import type { LangId } from "./types/common.ts";

const BATCH_MS = 300;
const MAX_EVENTS = 4000;
const QUIET_MS = 30 * 60 * 1000; // a "live" call with no event this long is gone (its instance died before it said so)

export type Level = "info" | "warn" | "error";
/** A timeline event, with when it happened (ms). */
export type TimedEvent = CallEvent & { t: number };

/** What a call starts with (and ends with: the same, with endedAt and endedReason). */
export type CallHeader = {
  id: string;
  from: string | null;
  to: string | null;
  lang: LangId | null;
  source: string;
  mode: string | null;
  startedAt: number;
  endedAt: number | null;
  endedReason: string | null;
};
/** A call as the monitor keeps it: its header, its timeline, and what the timeline said last. */
export type LiveCall = CallHeader & {
  events: TimedEvent[];
  note: unknown;
  cost?: { usd?: number; [key: string]: unknown };
  memorySummary?: string;
  savedNoteId?: string;
  turns: number;
  lastAt: number;
};
/** One line of the calls list. */
export type CallListing = CallHeader & { turns: number; savedNoteId: string | null; summary: string; usd: number | null };
export type SystemEntry = { t: number; text: string; level: Level };

/** What the monitor pages get (and the other instances, over the bus). */
export type MonitorMessage =
  | { type: "call"; call: CallHeader | CallListing }
  | { type: "event"; id: string; ev: TimedEvent }
  | { type: "system"; entry: SystemEntry };

/** Where finished calls are (memory: the calls table). */
export interface CallStore {
  recentCalls(): Promise<{ id: string; startedAt: number }[]>;
  getCall(id: string): Promise<object | null>;
}

export interface Monitor {
  record: boolean;
  audioDir(id: string): string;
  audioFile(id: string, name: string): string | null;
  start(c: { id: string; from?: string | null; to?: string | null; lang?: LangId | null; source: string; mode?: string | null }): void;
  event(id: string, ev: CallEvent): void;
  /** The call ended: its record (timeline, cost) for the call's row. */
  end(id: string, reason: string): LiveCall | null;
  system(text: string, level?: Level): void;
  /** Live calls first, then the call log. */
  list(): Promise<({ id: string; startedAt: number } | CallListing)[]>;
  get(id: string): Promise<Record<string, unknown> | null>;
  systemLog(): SystemEntry[];
  subscribe(fn: (msg: MonitorMessage) => void): () => void;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
// A message from another instance: checked before it's applied (it's JSON off the wire).
function monitorMessage(m: unknown): MonitorMessage | null {
  if (!isRecord(m)) return null;
  if (m.type === "call" && isRecord(m.call) && typeof m.call.id === "string") {
    const c = m.call;
    return { type: "call", call: { id: m.call.id, from: str(c.from), to: str(c.to), lang: str(c.lang), source: str(c.source) ?? "", mode: str(c.mode), startedAt: num(c.startedAt) ?? Date.now(), endedAt: num(c.endedAt), endedReason: str(c.endedReason) } };
  }
  if (m.type === "event" && typeof m.id === "string" && isRecord(m.ev) && typeof m.ev.event === "string") return { type: "event", id: m.id, ev: { ...m.ev, event: m.ev.event, t: num(m.ev.t) ?? Date.now() } };
  if (m.type === "system" && isRecord(m.entry)) {
    const level = m.entry.level === "warn" || m.entry.level === "error" ? m.entry.level : "info";
    return { type: "system", entry: { t: num(m.entry.t) ?? Date.now(), text: String(m.entry.text ?? ""), level } };
  }
  return null;
}

export function createMonitor({ bus = null, store = null, record = process.env.RECORD_CALLS === "1", audioRoot = path.join(process.env.DATA_DIR || "data", "calls"), keepLive = 30, batchMs = BATCH_MS, maxEvents = MAX_EVENTS }: {
  bus?: Pick<Bus, "instance" | "publish" | "subscribe"> | null;
  store?: CallStore | null;
  record?: boolean;
  audioRoot?: string;
  /** How many calls are kept here; only ended ones make room. */
  keepLive?: number;
  batchMs?: number;
  maxEvents?: number;
} = {}): Monitor {
  const calls = new Map<string, LiveCall>(); // id → record, live and just ended (this instance's, and others' via the bus)
  const subscribers = new Set<(msg: MonitorMessage) => void>(); // monitor pages on this instance
  const system: SystemEntry[] = []; // connection attempts and server-level events

  const summary = (c: LiveCall): CallListing => ({
    id: c.id, from: c.from, to: c.to, lang: c.lang, source: c.source, startedAt: c.startedAt, endedAt: c.endedAt,
    endedReason: c.endedReason, turns: c.turns, savedNoteId: c.savedNoteId ?? null,
    summary: c.memorySummary ?? (isRecord(c.note) && typeof c.note.summary === "string" ? c.note.summary : ""), usd: c.cost?.usd ?? null, mode: c.mode ?? null,
  });
  const header = (c: CallHeader): CallHeader => ({ id: c.id, from: c.from, to: c.to, lang: c.lang, source: c.source, mode: c.mode, startedAt: c.startedAt, endedAt: c.endedAt, endedReason: c.endedReason });

  // Ended calls make room first, oldest first; a live one only once it has gone quiet.
  function makeRoom(): void {
    if (calls.size <= keepLive) return;
    const now = Date.now();
    for (const [id, c] of calls) { if (calls.size <= keepLive) return; if (c.endedAt) calls.delete(id); }
    for (const [id, c] of calls) { if (calls.size <= keepLive) return; if (now - c.lastAt > QUIET_MS) calls.delete(id); }
  }

  // The timeline keeps its newest events: the oldest go in chunks, and a "trimmed" mark first says how many.
  function push(c: LiveCall, ev: TimedEvent): void {
    c.events.push(ev);
    if (c.events.length <= maxEvents) return;
    const marked = c.events[0]?.event === "trimmed";
    const drop = Math.ceil(maxEvents / 10);
    const dropped = (marked ? Number(c.events[0].dropped) || 0 : 0) + drop;
    c.events.splice(0, drop + (marked ? 1 : 0), { t: c.events[marked ? 1 : 0].t, event: "trimmed", dropped });
  }

  // Every change goes through apply(), for this instance's calls and the others' alike.
  function apply(msg: MonitorMessage): void {
    let out: MonitorMessage = msg;
    if (msg.type === "call") {
      const c = msg.call;
      const existing = calls.get(c.id);
      if (existing) Object.assign(existing, { endedAt: c.endedAt, endedReason: c.endedReason, lastAt: Date.now() });
      else calls.set(c.id, { ...header(c), events: [], note: null, turns: 0, lastAt: Date.now() });
      makeRoom();
      const now = calls.get(c.id);
      if (!now) return;
      out = { type: "call", call: summary(now) };
    } else if (msg.type === "event") {
      const c = calls.get(msg.id);
      if (c) {
        const ev = msg.ev;
        push(c, ev);
        c.lastAt = Date.now();
        if (ev.event === "heard") c.turns += 1;
        if (ev.event === "note") c.note = ev.note;
        if ((ev.event === "connected" || ev.event === "heard") && typeof ev.lang === "string") c.lang = ev.lang;
        if (ev.event === "cost" && isRecord(ev.totals)) c.cost = ev.totals;
        if (ev.event === "memory" && typeof ev.summary === "string") c.memorySummary = ev.summary;
        if (ev.event === "saved" && typeof ev.id === "string") c.savedNoteId = ev.id;
      }
    } else {
      system.push(msg.entry);
      if (system.length > 100) system.shift();
    }
    // A monitor page that fails (a closed socket) mustn't reach the call that emitted this.
    for (const fn of subscribers) { try { fn(out); } catch {} }
  }

  // Too big for NOTIFY (a long note): the other instances get the event without its body.
  function slim(msg: MonitorMessage): { msg: MonitorMessage; bytes: number } {
    const bytes = payloadBytes(JSON.stringify(msg));
    if (msg.type !== "event" || bytes < MAX_PAYLOAD - 200) return { msg, bytes };
    const cut: MonitorMessage = { ...msg, ev: { t: msg.ev.t, event: msg.ev.event, turn: msg.ev.turn, trimmed: true } };
    return { msg: cut, bytes: payloadBytes(JSON.stringify(cut)) };
  }

  // To the other instances: batched, in order, each NOTIFY under the payload limit.
  let outbox: { msg: MonitorMessage; bytes: number }[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  function flush(): void {
    flushTimer = null;
    const pending = outbox;
    outbox = [];
    let batch: MonitorMessage[] = [];
    let bytes = 0;
    const room = MAX_PAYLOAD - 100; // the envelope: { type, msgs, from }
    for (const m of pending) {
      if (batch.length && bytes + m.bytes + 1 > room) { bus?.publish({ type: "monitor", msgs: batch }); batch = []; bytes = 0; }
      batch.push(m.msg);
      bytes += m.bytes + 1;
    }
    if (batch.length) bus?.publish({ type: "monitor", msgs: batch });
  }
  function emit(msg: MonitorMessage): void {
    apply(msg);
    if (!bus) return;
    outbox.push(slim(msg));
    flushTimer ??= setTimeout(flush, batchMs);
    flushTimer.unref?.();
  }
  bus?.subscribe(m => {
    if (m.type !== "monitor" || m.from === bus.instance) return;
    // A batch (or one message, from an instance on the version before batches).
    for (const raw of Array.isArray(m.msgs) ? m.msgs : [m.msg]) {
      const msg = monitorMessage(raw);
      if (msg) apply(msg);
    }
  });

  return {
    record,
    audioDir(id) {
      const d = path.join(audioRoot, safe(id));
      mkdirSync(d, { recursive: true });
      return d;
    },
    audioFile(id, name) {
      const file = path.join(audioRoot, safe(id), path.basename(name));
      return existsSync(file) ? file : null;
    },
    start({ id, from = null, to = null, lang = null, source, mode = null }) {
      emit({ type: "call", call: { id, from, to, lang, source, mode, startedAt: Date.now(), endedAt: null, endedReason: null } });
    },
    event(id, ev) {
      if (calls.has(id)) emit({ type: "event", id, ev: { t: Date.now(), ...ev } });
    },
    end(id, reason) {
      const c = calls.get(id);
      if (!c || c.endedAt) return c ?? null;
      // The header only: the other instances have the timeline already, and a note could be too big for NOTIFY.
      emit({ type: "call", call: { ...header(c), endedAt: Date.now(), endedReason: reason } });
      return c;
    },
    system(text, level = "info") {
      emit({ type: "system", entry: { t: Date.now(), text, level } });
    },
    async list() {
      const live = [...calls.values()].map(summary);
      const ids = new Set(live.map(c => c.id));
      const past = ((await store?.recentCalls()) ?? []).filter(c => !ids.has(c.id));
      return [...live, ...past].sort((a, b) => b.startedAt - a.startedAt).slice(0, 100);
    },
    async get(id) {
      const live = calls.get(id);
      if (live && !live.endedAt) return live;
      const stored = await store?.getCall(id); // ended: the row has what the after-call step added
      return stored ? { ...stored } : live ?? null;
    },
    systemLog: () => system.slice(-50),
    subscribe(fn) { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
  };
}

const safe = (id: string): string => String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
