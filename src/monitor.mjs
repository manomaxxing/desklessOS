// Call monitor: every call's timeline (what was heard, what was said, VAD,
// fillers, barge-ins, latency, note updates, errors) for the /monitor page.
// Live calls: kept here while they run, and sent to every instance over the bus, so
// a monitor page sees the calls of all instances. Finished calls: the timeline goes
// into the call's row (the call wiring passes end()'s record to memory.endCall), and
// the list and details come from Postgres (`store`: recentCalls, getCall).
// RECORD_CALLS=1 also keeps per-turn audio on this instance's disk (local runs).

import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { MAX_PAYLOAD } from "./bus.mjs";

export function createMonitor({ bus = null, store = null, record = process.env.RECORD_CALLS === "1", audioRoot = path.join(process.env.DATA_DIR || "data", "calls"), keepLive = 30 } = {}) {
  const calls = new Map(); // id → record, live and just ended (this instance's, and others' via the bus)
  const subscribers = new Set(); // monitor pages on this instance
  const system = []; // connection attempts and server-level events

  const summary = c => ({
    id: c.id, from: c.from, to: c.to, lang: c.lang, source: c.source, startedAt: c.startedAt, endedAt: c.endedAt,
    endedReason: c.endedReason, turns: c.events.filter(e => e.event === "heard").length, savedNoteId: c.savedNoteId ?? null,
    summary: c.memorySummary ?? c.note?.summary ?? "", usd: c.cost?.usd ?? null, mode: c.mode ?? null,
  });

  // Every change goes through apply(), for this instance's calls and the others' alike.
  function apply(msg) {
    if (msg.type === "call") {
      const c = msg.call;
      const existing = calls.get(c.id);
      if (existing) Object.assign(existing, { endedAt: c.endedAt, endedReason: c.endedReason });
      else {
        calls.set(c.id, { ...c, events: [], note: null });
        while (calls.size > keepLive) calls.delete(calls.keys().next().value);
      }
      msg = { type: "call", call: summary(calls.get(c.id)) };
    } else if (msg.type === "event") {
      const c = calls.get(msg.id);
      if (c) {
        const ev = msg.ev;
        c.events.push(ev);
        if (ev.event === "note") c.note = ev.note;
        if (ev.event === "connected" || ev.event === "heard") c.lang = ev.lang ?? c.lang;
        if (ev.event === "cost") c.cost = ev.totals ?? c.cost;
        if (ev.event === "memory") c.memorySummary = ev.summary;
        if (ev.event === "saved") c.savedNoteId = ev.id;
      }
    } else if (msg.type === "system") {
      system.push(msg.entry);
      if (system.length > 100) system.shift();
    } else return;
    for (const fn of subscribers) fn(msg);
  }
  // Too big for NOTIFY (a long note): the other instances get the event without its body.
  const slim = msg => (JSON.stringify(msg).length < MAX_PAYLOAD - 200 ? msg : { ...msg, ev: { t: msg.ev?.t, event: msg.ev?.event, turn: msg.ev?.turn, trimmed: true } });
  function emit(msg) {
    apply(msg);
    bus?.publish({ type: "monitor", msg: slim(msg) });
  }
  bus?.subscribe(m => { if (m.type === "monitor" && m.from !== bus.instance) apply(m.msg); });

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
    start({ id, from, to, lang, source, mode }) {
      emit({ type: "call", call: { id, from, to, lang, source, mode, startedAt: Date.now(), endedAt: null, endedReason: null } });
    },
    event(id, ev) {
      if (calls.has(id)) emit({ type: "event", id, ev: { t: Date.now(), ...ev } });
    },
    /** The call ended: its record (timeline, cost) for the call's row. */
    end(id, reason) {
      const c = calls.get(id);
      if (!c || c.endedAt) return c ?? null;
      emit({ type: "call", call: { ...c, events: undefined, endedAt: Date.now(), endedReason: reason } });
      return c;
    },
    system(text, level = "info") {
      emit({ type: "system", entry: { t: Date.now(), text, level } });
    },
    /** Live calls first, then the call log. */
    async list() {
      const live = [...calls.values()].map(summary);
      const ids = new Set(live.map(c => c.id));
      const past = ((await store?.recentCalls()) ?? []).filter(c => !ids.has(c.id));
      return [...live, ...past].sort((a, b) => b.startedAt - a.startedAt).slice(0, 100);
    },
    async get(id) {
      const live = calls.get(id);
      if (live && !live.endedAt) return live;
      return (await store?.getCall(id)) ?? live ?? null; // ended: the row has what the after-call step added
    },
    systemLog: () => system.slice(-50),
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
  };
}

const safe = id => String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
