// Call monitor: every call's timeline (what was heard, what was said, VAD,
// fillers, barge-ins, latency, note updates, errors) for the /monitor page.
// Live calls stream over a WebSocket; finished calls are kept in
// data/calls/<id>.json, with per-turn audio when RECORD_CALLS=1.

import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dataDir } from "./store/files.mjs";
import path from "node:path";

export function createMonitor({ dir = dataDir("calls", "CALLS_DIR"), record = process.env.RECORD_CALLS === "1", keepLive = 30 } = {}) {
  mkdirSync(dir, { recursive: true });
  const calls = new Map(); // id → record (live and recent)
  const subscribers = new Set();
  const system = []; // connection attempts and server-level events

  const publish = msg => { for (const fn of subscribers) fn(msg); };
  const summary = c => ({
    id: c.id, from: c.from, to: c.to, lang: c.lang, source: c.source, startedAt: c.startedAt, endedAt: c.endedAt,
    endedReason: c.endedReason, turns: c.events.filter(e => e.event === "heard").length, savedNoteId: c.savedNoteId ?? null,
    summary: c.workflowSummary ?? c.memorySummary ?? c.note?.summary ?? c.note?.zusammenfassung ?? "",
    usd: c.cost?.usd ?? null,
    mode: c.mode ?? null,
  });

  function persist(c) {
    writeFileSync(path.join(dir, `${safe(c.id)}.json`), JSON.stringify(c, null, 1));
  }

  return {
    record,
    audioDir: id => {
      const d = path.join(dir, safe(id));
      mkdirSync(d, { recursive: true });
      return d;
    },
    start({ id, from, to, lang, source, mode }) {
      const existing = calls.get(id);
      if (existing) { existing.endedAt = null; return existing; } // reconnect
      const c = { id, from, to, lang, source, mode, startedAt: Date.now(), endedAt: null, endedReason: null, events: [], note: null };
      calls.set(id, c);
      while (calls.size > keepLive) calls.delete(calls.keys().next().value);
      publish({ type: "call", call: summary(c) });
      return c;
    },
    event(id, ev) {
      const c = calls.get(id);
      if (!c) return;
      const entry = { t: Date.now(), ...ev };
      c.events.push(entry);
      if (ev.event === "note") c.note = ev.note;
      if (ev.event === "connected" || ev.event === "heard") c.lang = ev.lang ?? c.lang;
      if (ev.event === "saved") c.savedNoteId = ev.id;
      if (ev.event === "cost") c.cost = ev.totals;
      if (ev.event === "memory") c.memorySummary = ev.summary;
      if (ev.event === "workflow") c.workflowSummary = ev.result?.summary;
      publish({ type: "event", id, ev: entry });
    },
    end(id, reason) {
      const c = calls.get(id);
      if (!c || c.endedAt) return;
      c.endedAt = Date.now();
      c.endedReason = reason;
      persist(c);
      publish({ type: "call", call: summary(c) });
    },
    system(text, level = "info") {
      const entry = { t: Date.now(), text, level };
      system.push(entry);
      if (system.length > 100) system.shift();
      publish({ type: "system", entry });
    },
    list() {
      const live = [...calls.values()].map(summary);
      const ids = new Set(live.map(c => c.id));
      const past = readdirSync(dir)
        .filter(f => f.endsWith(".json"))
        .map(f => { try { return JSON.parse(readFileSync(path.join(dir, f), "utf8")); } catch { return null; } })
        .filter(c => c && !ids.has(c.id))
        .map(summary);
      return [...live, ...past].sort((a, b) => b.startedAt - a.startedAt).slice(0, 100);
    },
    get(id) {
      if (calls.has(id)) return calls.get(id);
      const file = path.join(dir, `${safe(id)}.json`);
      return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
    },
    audioFile(id, name) {
      const file = path.join(dir, safe(id), path.basename(name));
      return existsSync(file) ? file : null;
    },
    systemLog: () => system.slice(-50),
    reset() { calls.clear(); system.length = 0; mkdirSync(dir, { recursive: true }); },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
  };
}

const safe = id => String(id).replace(/[^a-zA-Z0-9._-]/g, "_");
