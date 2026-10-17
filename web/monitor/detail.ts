// The selected call: its head and numbers, the timeline (bubbles for what was said, chips
// for everything else), and on the right its cost, its note and what changed in memory.
// A live call's events are added to the timeline as they come: a new row, or the open agent
// bubble growing; nothing is drawn twice (a long call stays cheap, a playing ▶ keeps playing).

import { $, html, setHtml, patchHtml, fragment, delegate, type SafeHtml } from "../shared/html.ts";
import { withDev, seg } from "../shared/api.ts";
import { fmtTime, fmtDur, usd } from "../shared/format.ts";
import { mergeSay } from "../shared/transcript.ts";
import { chipFor, latClass, type Chip } from "../shared/timeline.ts";
import { costCard } from "../shared/cost.ts";
import { sourceLabel } from "./list.ts";
import { paintPlayer, togglePlay } from "./player.ts";
import type { CallDetail, MonitorEvent, TimelineEvent } from "../shared/types.ts";

interface Bubble { row: HTMLElement; kind: "user" | "agent"; text: string; turn?: number; lang?: string | null; next?: string; audio?: string | null; interrupted?: boolean }

let call: CallDetail | null = null;
let showVad = false;
let follow = (): boolean => false;
// The timeline as drawn so far (for the next event).
let timeline: HTMLElement | null = null;
let lastRow: HTMLElement | null = null;
const agentByTurn = new Map<number | undefined, Bubble>();
const turnCost = new Map<number, number>();
const latencyRows = new Map<number, { el: HTMLElement; ev: Extract<MonitorEvent, { event: "latency" }> }>();
const counts = { heard: 0, bargeIns: 0, retries: 0, errors: 0, latency: 0, firstAudioMs: 0 };

const audioUrl = (file: string): string => withDev(`/api/calls/${seg(call?.id ?? "")}/audio/${encodeURIComponent(file)}`);
const sinceStart = (ev: TimelineEvent): string => (((ev.t ?? 0) - (call?.startedAt ?? 0)) / 1000).toFixed(1);
const chipContext = () => ({ turnCost: (turn: number) => turnCost.get(turn), showVad });

// ---------- rows ----------
const chipRow = (t: string, c: Chip): SafeHtml => html`<div class="row"><div class="t">+${t}</div><div><span class="chip ${c.cls}">${c.text}</span></div></div>`;
function whoHtml(b: Bubble): SafeHtml {
  const who = b.kind === "user" ? `Caller${b.lang ? ` · ${b.lang}` : ""}${b.next ? ` · next ${b.next}` : ""}` : `Agent${b.interrupted ? " · interrupted" : ""}`;
  return html`${who} ${b.audio && html`<button class="play" data-src="${audioUrl(b.audio)}">▶ Play</button>`}`;
}
function bubbleRow(t: string, b: Omit<Bubble, "row">): HTMLElement {
  return fragment(html`<div class="row"><div class="t">+${t}</div><div style="display:grid"><div class="bubble ${b.kind}"><div class="who">${whoHtml(b as Bubble)}</div><span class="text">${b.text}</span></div></div></div>`);
}
const textOf = (b: Bubble): HTMLElement | null => b.row.querySelector<HTMLElement>(".text");
function redrawWho(b: Bubble): void {
  const who = b.row.querySelector(".who");
  if (!who) return;
  setHtml(who, whoHtml(b));
  paintPlayer(who);
}

/** One event onto the timeline (and the numbers). out: where new rows go. */
function add(ev: TimelineEvent, out: ParentNode): void {
  if (ev.event === "heard") counts.heard++;
  if (ev.event === "barge_in") counts.bargeIns++;
  if (ev.event === "retry") counts.retries++;
  if (ev.event === "error") counts.errors++;
  const append = (row: HTMLElement): HTMLElement => { out.append(row); lastRow = row; return row; };
  if (!ev.trimmed) {
    switch (ev.event) {
      case "heard": {
        const b = { kind: "user" as const, text: ev.text || "(nothing transcribed)", turn: ev.turn, lang: ev.lang, next: ev.next, audio: ev.audio };
        append(bubbleRow(sinceStart(ev), b));
        return;
      }
      case "say": {
        let b = agentByTurn.get(ev.turn);
        const piece = [ev.text, ev.note && `(${ev.note})`].filter(Boolean).join(" ");
        if (!b || lastRow !== b.row) {
          const fresh: Omit<Bubble, "row"> = { kind: "agent", text: mergeSay("", piece), turn: ev.turn };
          b = { ...fresh, row: append(bubbleRow(sinceStart(ev), fresh)) };
          agentByTurn.set(ev.turn, b);
        } else {
          b.text = mergeSay(b.text, piece, ev.delta);
          const el = textOf(b);
          if (el) el.textContent = b.text;
        }
        return;
      }
      case "agent_audio": {
        const b = agentByTurn.get(ev.turn);
        if (b) { b.audio = ev.audio; b.interrupted = ev.interrupted; redrawWho(b); }
        return;
      }
      case "cost": {
        if (ev.step === "turn" && ev.turn) {
          turnCost.set(ev.turn, (turnCost.get(ev.turn) ?? 0) + (ev.usd || 0));
          const lat = latencyRows.get(ev.turn); // its chip shows the turn's cost
          const c = lat && chipFor(lat.ev, chipContext());
          if (lat && c) {
            const el = fragment(chipRow(sinceStart(lat.ev), c));
            lat.el.replaceWith(el);
            if (lastRow === lat.el) lastRow = el;
            lat.el = el;
          }
        }
        return;
      }
      case "latency":
        counts.latency++;
        counts.firstAudioMs += ev.firstAudioMs || 0;
        break;
    }
  }
  const c = chipFor(ev, chipContext());
  if (!c) return;
  const row = append(fragment(chipRow(sinceStart(ev), c)));
  if (!ev.trimmed && ev.event === "latency") latencyRows.set(ev.turn, { el: row, ev });
}

// ---------- the parts ----------
function headHtml(c: CallDetail): SafeHtml {
  const dur = (c.endedAt ?? Date.now()) - c.startedAt;
  return html`<div class="head"><h2>${c.from || "Call"}</h2><span class="badge ${c.source === "dial" ? "blue" : ""}">${sourceLabel(c.source)}</span>${!c.endedAt && html`<span class="badge" style="color:var(--red)">LIVE</span>`}</div>
    <div class="meta">${c.mode && html`<b>${c.mode}</b> · `}${fmtTime(c.startedAt)} · ${fmtDur(dur)}${c.endedReason ? ` · ${c.endedReason}` : ""} · <span style="font-family:ui-monospace,monospace;font-size:11px">${c.id}</span></div>`;
}
function statsHtml(c: CallDetail): SafeHtml {
  const fa = counts.latency ? counts.firstAudioMs / counts.latency : null;
  const stats: [string | number, string, string][] = [
    [counts.heard, "turns", ""],
    [fa == null ? "—" : `${(fa / 1000).toFixed(2)} s`, "avg first audio", latClass(fa)],
    [usd(c.cost?.usd ?? null), "cost", ""],
    [counts.bargeIns, "barge-ins", ""],
    [counts.retries + counts.errors, "retries / errors", counts.errors ? "bad" : counts.retries ? "warn" : ""],
  ];
  return html`${stats.map(([v, l, cls]) => html`<div class="stat"><b class="${cls}">${v}</b><span>${l}</span></div>`)}`;
}

function noteHtml(c: CallDetail): SafeHtml {
  const n = c.note;
  if (!n) return html`<div class="card"><div class="empty" style="padding:18px">No note yet.</div></div>`;
  const missing = c.events.findLast((e): e is Extract<MonitorEvent, { event: "note" }> => !e.trimmed && e.event === "note")?.missing ?? [];
  const rows = ([
    ["Mode", n.mode], ["Customer", [n.customer_name, n.address, n.place].filter(Boolean).join(", ")],
    ["Work", (n.work ?? []).map(w => [w.area, w.quantity, w.material, w.description].filter(Boolean).join(" ")).join(" · ")],
    ["Next", (n.next_steps ?? []).map(s => s.what + (s.due ? ` (${s.due})` : "")).join(" · ")],
    ["Timeframe", n.timeframe], ["Budget", n.budget], ["Open", (n.open_questions ?? []).join(" · ")], ["Missing", missing.join(", ")],
  ] as [string, string | undefined][]).filter(([, v]) => v);
  return html`<div class="card">${rows.map(([k, v]) => html`<div class="rowi"><div class="k">${k}</div><div class="v">${v}</div></div>`)}${n.summary && html`<div class="rowi"><div class="v">${n.summary}</div></div>`}<details><summary>Raw JSON</summary><pre>${JSON.stringify(n, null, 2)}</pre></details></div>`;
}
function memoryHtml(c: CallDetail): SafeHtml {
  const mem = c.events.findLast((e): e is Extract<MonitorEvent, { event: "memory" }> => !e.trimmed && e.event === "memory");
  if (!mem) return html`<div class="card"><div class="empty" style="padding:18px">${c.endedAt ? "No memory update." : "Written after the call."}</div></div>`;
  const row = (k: SafeHtml | string, v: SafeHtml | string) => html`<div class="rowi">${k}<div class="v">${v}</div></div>`;
  return html`<div class="card">
    ${row(html`<div class="k">Type</div>`, mem.callType)}
    ${row(html`<div class="k">Summary</div>`, mem.summary)}
    ${mem.customer && row(html`<div class="k">Customer</div>`, html`${mem.customer.name} <span style="color:var(--faint)">${mem.customer.id}</span>`)}
    ${(mem.added ?? []).map(a => row(html`<div class="k good">+ to-do</div>`, `${a.text}${a.due ? ` · ${a.due}` : ""}`))}
    ${(mem.completed ?? []).map(a => row(html`<div class="k good">✓ done</div>`, a.text))}
    ${(mem.updated ?? []).map(a => row(html`<div class="k warn">updated</div>`, `${a.text}${a.due ? ` · ${a.due}` : ""}`))}
  </div>`;
}
function drawRight(c: CallDetail): void {
  patchHtml($("rcCost"), costCard(c.cost, { long: false }));
  patchHtml($("rcNote"), noteHtml(c));
  patchHtml($("rcMemory"), memoryHtml(c));
}

function scrollToEnd(): void {
  if (!call || call.endedAt || !follow()) return;
  // The timeline scrolls in its column on a wide screen, with the page on a narrow one.
  (lastRow ?? timeline)?.scrollIntoView({ block: "end", inline: "nearest" });
}

// ---------- the call ----------
export function showNothing(text = "Select a call."): void {
  call = null;
  timeline = null;
  setHtml($("main"), html`<div class="empty">${text}</div>`);
  setHtml($("rightcol"), html``);
}

/** Draws the call (the whole timeline). */
export function showCall(c: CallDetail): void {
  call = c;
  agentByTurn.clear();
  turnCost.clear();
  latencyRows.clear();
  Object.assign(counts, { heard: 0, bargeIns: 0, retries: 0, errors: 0, latency: 0, firstAudioMs: 0 });
  lastRow = null;
  for (const e of c.events) if (!e.trimmed && e.event === "cost" && e.step === "turn" && e.turn) turnCost.set(e.turn, (turnCost.get(e.turn) ?? 0) + (e.usd || 0));
  const rows = document.createDocumentFragment();
  for (const e of c.events) if (e.trimmed || e.event !== "cost") add(e, rows); // (the costs are counted above)
  setHtml($("main"), html`<div id="mHead"></div>
    <div class="stats" id="mStats"></div>
    <div class="controls"><label class="toggle"><input type="checkbox" id="vad" ${showVad ? "checked" : ""}><span class="switch"></span>VAD events</label><span>▶ plays exactly what Gemini heard and what Fish said</span></div>
    <div id="timeline"></div>`);
  timeline = $("timeline");
  if (rows.childNodes.length) timeline.append(rows);
  else setHtml(timeline, html`<div class="empty">Waiting for the first turn…</div>`);
  patchHtml($("mHead"), headHtml(c));
  patchHtml($("mStats"), statsHtml(c));
  if (!document.getElementById("rcCost")) setHtml($("rightcol"), html`<h3>Cost</h3><div id="rcCost"></div><h3>Note</h3><div id="rcNote"></div><h3>Memory changes</h3><div id="rcMemory"></div>`);
  drawRight(c);
  paintPlayer();
  scrollToEnd();
}

/** One event of the shown call, as it happens. */
export function addEvent(ev: TimelineEvent): void {
  const c = call;
  if (!c || !timeline) return;
  c.events.push(ev);
  if (!ev.trimmed && ev.event === "note") c.note = ev.note;
  if (!ev.trimmed && ev.event === "cost" && ev.totals) c.cost = ev.totals;
  if (timeline.querySelector(":scope > .empty")) timeline.replaceChildren();
  const before = lastRow;
  add(ev, timeline);
  if (!timeline.childElementCount) setHtml(timeline, html`<div class="empty">Waiting for the first turn…</div>`);
  patchHtml($("mStats"), statsHtml(c));
  if (ev.event === "note" || ev.event === "memory" || ev.event === "cost") drawRight(c);
  if (lastRow !== before || ev.event === "say") scrollToEnd();
}

/** The shown call ended (or its head changed): the head again; every 5 s the running time of a live one. */
export function updateHead(fields: Partial<CallDetail> = {}): void {
  if (!call) return;
  Object.assign(call, fields);
  patchHtml($("mHead"), headHtml(call));
  if (fields.endedAt) drawRight(call);
}
export const shownCallId = (): string | null => call?.id ?? null;

export function initDetail({ following }: { following: () => boolean }): void {
  follow = following;
  delegate($("main"), "click", "button.play[data-src]", (_, b) => togglePlay(b.dataset.src ?? ""));
  delegate($("main"), "change", "#vad", (e) => {
    showVad = (e.target as HTMLInputElement).checked;
    if (call) showCall(call);
    document.getElementById("vad")?.focus();
  });
  setInterval(() => { if (call && !call.endedAt && !document.hidden) updateHead(); }, 5000);
}
