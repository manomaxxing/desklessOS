// The left column: the calls (live ones first, with a red dot) and the connection log.

import { $, html, renderKeyed, patchHtml, delegate } from "../shared/html.ts";
import { fmtTime, fmtDur, usd } from "../shared/format.ts";
import type { CallSummary, SystemEntry } from "../shared/types.ts";

export const sourceLabel = (s: string | null | undefined): string => ({ dial: "Dial", browser: "Browser", script: "Script" } as Record<string, string>)[s ?? ""] ?? s ?? "?";

const item = (c: CallSummary, selected: boolean) => html`<button type="button" class="call${selected ? " sel" : ""}" data-id="${c.id}" aria-current="${selected ? "true" : "false"}">
    <span class="top">${!c.endedAt && html`<span class="livedot"></span>`}<span>${c.from || c.id}</span>
      <span class="badge ${c.source === "dial" ? "blue" : ""}">${sourceLabel(c.source)}</span>${c.lang && html`<span class="badge">${c.lang.toUpperCase()}</span>`}${c.savedNoteId && html`<span class="badge green">note</span>`}</span>
    <span class="sub">${fmtTime(c.startedAt)} · ${c.endedAt ? fmtDur(c.endedAt - c.startedAt) : "live"} · ${c.turns ?? 0} turns${c.usd != null ? ` · ${usd(c.usd)}` : ""}</span>
    ${c.mode && html`<span class="sub">${c.mode}</span>`}
    ${c.summary && html`<span class="sum">${c.summary}</span>`}
  </button>`;

export function renderList(calls: readonly CallSummary[], selectedId: string | null): void {
  const total = calls.reduce((s, c) => s + (c.usd || 0), 0);
  $("total").textContent = `${calls.length} calls · ${usd(total)}`;
  renderKeyed($("calls"), calls, {
    key: c => c.id,
    signature: c => `${JSON.stringify(c)}|${c.id === selectedId}`,
    render: c => item(c, c.id === selectedId),
    empty: html`<div class="empty">No calls yet.</div>`,
  });
}

export function renderSystem(entries: readonly SystemEntry[]): void {
  const shown = entries.slice(-25).reverse();
  patchHtml($("system"), shown.length
    ? html`${shown.map(e => html`<div class="sys ${e.level}">${fmtTime(e.t)} · ${e.text}</div>`)}`
    : html`<div class="sys">No connections yet.</div>`);
}

export function initList({ onSelect }: { onSelect: (id: string) => void }): void {
  delegate($("calls"), "click", "button.call[data-id]", (_, b) => onSelect(b.dataset.id ?? ""));
}
