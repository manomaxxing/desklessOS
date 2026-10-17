// What a call cost (src/engine/cost.ts totals): the test phone's Cost tab (long: with what
// each line is, the bars per turn and the price date) and the monitor's column (short).

import { html, type SafeHtml } from "./html.ts";
import { usd, ktok } from "./format.ts";
import type { CostTotals } from "./types.ts";

const crow = (name: string, sub: string, value: string): SafeHtml =>
  html`<div class="crow"><div>${name}<small>${sub}</small></div><div class="usd">${value}</div></div>`;

export function costCard(t: CostTotals | null | undefined, { long, perTurn = [] }: { long: boolean; perTurn?: number[] }): SafeHtml {
  if (!t) return long ? html`<div class="empty">Costs appear once the call starts.</div>` : html`<div class="card"><div class="empty" style="padding:18px">No cost yet.</div></div>`;
  const s = t.byStep ?? {};
  const kb = (t.ttsBytes / 1000).toFixed(1);
  const phone = t.phoneUsd == null ? "—" : usd(t.phoneUsd);
  if (!long) {
    return html`<div class="card"><div class="big">${usd(t.usd)}</div><div class="bigsub">${t.llmCalls} model calls · ${ktok(t.inputTokens)} in (${ktok(t.audioTokens)} audio) · ${ktok(t.outputTokens)} out</div>
      ${crow("Conversation", `${s.turn?.calls ?? 0} turns`, usd(s.turn?.usd ?? 0))}${crow("Note", `${s.note?.calls ?? 0} extractions`, usd(s.note?.usd ?? 0))}${crow("Memory", "after the call", usd(s.memory?.usd ?? 0))}
      ${crow("Voice", `Fish · ${kb} kB · paid tier ${usd(t.ttsPaidUsd)}`, usd(t.ttsUsd))}${crow("Phone", t.phoneMinutes ? `${t.phoneMinutes.toFixed(1)} min` : "—", phone)}</div>`;
  }
  const max = Math.max(...perTurn, 1e-9);
  return html`<div class="card"><div class="big">${usd(t.usd)}</div><div class="bigsub">this call · ${t.llmCalls} model calls · ${ktok(t.inputTokens)} tokens in (${ktok(t.audioTokens)} audio) · ${ktok(t.outputTokens)} out</div>
      ${perTurn.length > 0 && html`<div class="bars">${perTurn.map(v => html`<i style="height:${Math.max(8, (v / max) * 100)}%" title="${usd(v)}"></i>`)}</div><div class="foot">cost per turn</div>`}</div>
    <div class="card">
      ${crow("Conversation", `Gemini · ${s.turn?.calls ?? 0} turns · ${ktok(s.turn?.inputTokens ?? 0)} in · ${ktok(s.turn?.outputTokens ?? 0)} out`, usd(s.turn?.usd ?? 0))}
      ${crow("Note extraction", `Gemini · ${s.note?.calls ?? 0} calls`, usd(s.note?.usd ?? 0))}
      ${crow("Memory", "Gemini · after the call", usd(s.memory?.usd ?? 0))}
      ${crow("Voice", `Fish · ${kb} kB text · paid tier: ${usd(t.ttsPaidUsd)}`, usd(t.ttsUsd))}
      ${crow("Phone", `${t.phoneMinutes ? `${t.phoneMinutes.toFixed(1)} min` : "after the call"} · rate via DIAL_USD_PER_MIN`, phone)}
    </div>
    <div class="foot">Estimates at list prices as of ${t.pricesAsOf ?? ""}${t.unpriced ? ` · ${t.unpriced} unpriced calls` : ""}</div>`;
}
