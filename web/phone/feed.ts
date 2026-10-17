// The Call tab while a call runs: the transcript as bubbles (with each answer's latency and
// cost), connection notes, the note card as it grows; and the Cost tab.

import { $, html, patchHtml, setHtml } from "../shared/html.ts";
import { langName, usd, fmtTime } from "../shared/format.ts";
import { mergeSay } from "../shared/transcript.ts";
import { costCard } from "../shared/cost.ts";
import { modeLabel } from "./mode.ts";
import type { DebugFrame } from "./call.ts";
import type { CostTotals, Note } from "../shared/types.ts";

let agentBubble: HTMLElement | null = null;
let lastLang: string | null = null;
const turnMeta = new Map<number | undefined, HTMLElement>(); // the line under each answer
const latency = new Map<number | undefined, string>();
const turnCosts = new Map<number | undefined, number>();
let costTotals: CostTotals | null = null;

function scrollMsgs(): void { const p = $("pane-call"); p.scrollTop = p.scrollHeight; }
/** A line in the transcript (text only). */
export function addLine(cls: string, text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = cls;
  el.textContent = text;
  $("msgs").append(el);
  scrollMsgs();
  return el;
}

export function resetFeed(): void {
  $("msgs").replaceChildren();
  agentBubble = null;
  lastLang = null;
  turnMeta.clear();
  latency.clear();
  turnCosts.clear();
  costTotals = null;
  setHtml($("order"), html``);
  renderCost();
}
/** After the call: no half-shown line left in the caption. */
export const clearCaption = (): void => { $("caption").textContent = ""; };

function paintMeta(turn: number | undefined): void {
  const m = turnMeta.get(turn);
  if (!m) return;
  const cost = turnCosts.get(turn);
  m.textContent = [latency.get(turn), cost != null ? usd(cost) : ""].filter(Boolean).join(" · ");
}

function renderCost(): void {
  patchHtml($("cost"), costCard(costTotals, { long: true, perTurn: [...turnCosts.values()] }));
}

/** The note, as it's drafted during the call. */
function renderNote(n: Note | null, missing: string[] = []): void {
  if (!n || !n.mode || n.mode === "unclear") return;
  const work = (n.work ?? []).map(w => [w.area, w.quantity, w.material, w.description].filter(Boolean).join(" · ")).filter(Boolean);
  const steps = (n.next_steps ?? []).map(s => s.what + (s.due ? ` (${s.due})` : ""));
  const row = (label: string, text: string) => html`<div class="item"><div><small>${label}</small>${text}</div></div>`;
  setHtml($("order"), html`<div class="card order">
    <div class="head"><b>${[n.customer_name, n.place].filter(Boolean).join(", ") || "Note"}</b><span>${n.mode}</span></div>
    ${work.length > 0 && row("Work", work.join("; "))}${steps.length > 0 && row("Next", steps.join("; "))}${n.summary && row("Summary", n.summary)}
    ${missing.length > 0 && html`<div class="acts">${missing.map(m => html`<span class="chip orange">${m}</span>`)}</div>`}
  </div>`);
}

export function onDebug(d: DebugFrame): void {
  if (d.trimmed) return;
  switch (d.event) {
    case "connected":
      lastLang = d.lang ?? null;
      addLine("sys", `${langName(d.lang)} · ${d.config ? modeLabel(d.config) : ""} · ${fmtTime(new Date(), { seconds: false })}`);
      break;
    case "fallback": addLine("sys warn", `${d.from} failed → ${d.to}`); break;
    case "recovered": addLine("sys warn", `Recovered on ${d.model}`); break;
    case "vad": if (d.speaking) clearCaption(); break;
    case "heard":
      if (d.lang && lastLang && d.lang !== lastLang) addLine("sys", `Switched to ${langName(d.lang)}`);
      lastLang = d.lang || lastLang;
      if (d.text) { addLine("msg user", d.text); setHtml($("caption"), html`<b>${d.text}</b>`); }
      agentBubble = null;
      break;
    case "say": {
      if (d.note === "already said as filler" || !d.text) break;
      if (!agentBubble) {
        agentBubble = addLine("msg agent", mergeSay("", d.text));
        turnMeta.set(d.turn, addLine("meta", ""));
      } else {
        agentBubble.textContent = mergeSay(agentBubble.textContent ?? "", d.text, d.delta);
        scrollMsgs();
      }
      $("caption").textContent = d.delta ? (agentBubble.textContent ?? "").slice(-140) : d.text;
      break;
    }
    case "latency":
      if (turnMeta.has(d.turn)) { latency.set(d.turn, `${(d.firstAudioMs / 1000).toFixed(1)} s`); paintMeta(d.turn); }
      break;
    case "cost":
      if (d.totals) costTotals = d.totals;
      if (d.turn && d.step === "turn") { turnCosts.set(d.turn, (turnCosts.get(d.turn) ?? 0) + (d.usd ?? 0)); paintMeta(d.turn); }
      renderCost();
      break;
    case "barge_in": addLine("sys warn", "You interrupted"); agentBubble = null; break;
    case "retry": addLine("sys warn", `Gemini hiccup → retrying${d.next ? ` with ${d.next}` : ""}`); break;
    case "error": addLine("sys bad", `${d.where} error`); break;
    case "note": renderNote(d.note, d.missing); break;
  }
}
