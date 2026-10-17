// A call's timeline as the monitor shows it: what each event becomes. Speech (heard, say,
// agent_audio) becomes bubbles (web/monitor/detail.ts); everything else a chip, or nothing.

import { usd, langName } from "./format.ts";
import type { EventName, MonitorEvent, TimelineEvent } from "./types.ts";

export type Tone = "" | "good" | "warn" | "bad";
export interface Chip { cls: Tone; text: string }
export interface ChipContext {
  /** What the turn's model calls cost so far. */
  turnCost(turn: number): number | undefined;
  showVad: boolean;
}

/** Time to first audio: good up to 2.5 s, then warn, bad past 4 s. */
export const latClass = (ms: number | null | undefined): Tone => (ms == null ? "" : ms <= 2500 ? "good" : ms <= 4000 ? "warn" : "bad");

/** The event K's type (also when its type is shared with others: event: "a" | "b"). */
type Of<K extends EventName> = MonitorEvent extends infer E ? (E extends { event: infer N } ? (K extends N ? E : never) : never) : never;
type ChipEvent = Exclude<EventName, "heard" | "say" | "agent_audio">;
const s2 = (ms: number): string => (ms / 1000).toFixed(2);
const chip = (text: string, cls: Tone = ""): Chip => ({ cls, text });

/** Every event that isn't speech: its chip, or null for one the timeline doesn't show. */
const CHIPS: { [K in ChipEvent]: ((e: Of<K>, ctx: ChipContext) => Chip | null) | null } = {
  turn_start: e => chip(e.text ? `turn ${e.turn} · ${e.text}` : `turn ${e.turn} · ${((e.utteranceMs ?? 0) / 1000).toFixed(1)} s speech${(e.merged ?? 0) > 1 ? ` · ${e.merged} pieces merged` : ""}`),
  latency: (e, ctx) => {
    const cost = ctx.turnCost(e.turn);
    return chip(`${e.prepared ? "prepared answer, played " : ""}first audio ${s2(e.firstAudioMs)} s${e.sinceSpeechMs != null ? ` (${s2(e.sinceSpeechMs)} s after his last word)` : ""} · Gemini ${s2(e.firstTokenMs)} s · Fish ${e.fishFirstByteMs ?? "?"} ms${cost != null ? ` · ${usd(cost)}` : ""}`, latClass(e.sinceSpeechMs ?? e.firstAudioMs));
  },
  heard_check: e => chip(`his words, written down separately for his yes: ${e.text || "(nothing)"}`),
  heard_late: null,
  dangling: null,
  prepared_dropped: () => chip("he went on: the prepared answer was dropped unheard"),
  note_sent: () => chip("note sent to his WhatsApp", "good"),
  recap: e => chip(`summary written · ${e.title ?? ""}`, "good"),
  filler: () => chip("filler"),
  retry: e => chip(`Gemini retry${e.next ? ` → ${e.next}` : ""} · ${e.reason}`, "warn"),
  recovered: e => chip(`recovered on ${e.model} (attempt ${e.attempt})`, "good"),
  fallback: e => chip(`${e.what}: ${e.from} failed → ${e.to} · ${e.reason ?? ""}`, "warn"),
  mask: () => chip("typing sound (masking the wait)"),
  tool: e => (e.ignored
    ? chip(`tool call ignored (${e.reason}) · ${e.ignored.join(", ")}`, "warn")
    : chip(`tool ${e.name} · ${e.status} · ${e.ms} ms${e.summary ? ` · ${e.summary}` : ""}`, e.status === "ok" || e.status === "repeated" ? "good" : "warn")),
  context: e => chip(`memory · ${e.tokens} of ${e.budget} tokens · ${e.customers} customers + ${e.names} names · ${e.tasks} to-dos · ${e.ms} ms`),
  turn: e => chip(`Smart Turn · ${e.complete ? "done" : "not done"} (${e.probability}) · ${e.ms} ms`, e.complete ? "" : "warn"),
  objective: e => chip(`${e.template} ${e.done ? "done" : "open"} · ${e.status}`, e.done ? "good" : ""),
  tool_latency: e => chip(`answer after tool · ${s2(e.hopMs)} s after the call · ${s2(e.totalMs)} s after he stopped`),
  live: e => chip(`live · ${e.text}`, e.level === "error" ? "bad" : ""),
  barge_in: () => chip("barge-in · playback cleared", "warn"),
  nudge: e => chip(`silence nudge · ${e.kind}`, "warn"),
  note: e => chip(`note · ${e.missing?.length ? `missing ${e.missing.join(", ")}` : "complete"}`),
  saved: e => chip(`note saved · ${e.id}`, "good"),
  memory: e => chip(`memory · ${e.callType}${e.added?.length ? ` · +${e.added.length} to-do` : ""}${e.completed?.length ? ` · ${e.completed.length} done` : ""}`, "good"),
  error: e => chip(`${e.where} error · ${e.message}`, "bad"),
  connected: e => chip(`connected · ${langName(e.lang)} · ${e.formats?.inbound ?? "?"}`),
  hangup: () => chip("agent hung up"),
  ended: e => chip(`ended · ${e.reason}`),
  duration_warning: () => chip("Dial duration warning", "warn"),
  vad: (e, ctx) => (ctx.showVad ? chip(e.speaking ? "speech start" : `speech end · ${e.ms} ms`) : null),
  cost: null,
  wish: null,
  voicemail: null,
  outbound: null,
  answered_by: null,
  false_start: null,
  speculate: null,
  speculation_used: null,
  speculation_dropped: null,
  backchannel: null,
};

/** The chip for an event that isn't speech (null: not shown). A trimmed event says so instead of its (missing) details. */
export function chipFor(e: TimelineEvent, ctx: ChipContext): Chip | null {
  if (e.trimmed) return e.event === "vad" && !ctx.showVad ? null : chip(`${e.event} · too big to show here`);
  if (e.event === "heard" || e.event === "say" || e.event === "agent_audio") return null;
  const fn = CHIPS[e.event] as ((e: MonitorEvent, ctx: ChipContext) => Chip | null) | null;
  return fn ? fn(e, ctx) : null;
}
