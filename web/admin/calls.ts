// #calls: every call, newest first; a click opens its page (#call/<id>).
// A call still running (or just ended, while this instance remembers it) comes from the
// monitor, without the call log's facts (who, title): it shows its numbers instead.

import { $, html, renderKeyed } from "../shared/html.ts";
import { getJson } from "../shared/api.ts";
import { fmtWhen, fmtDur } from "../shared/format.ts";
import { isStored } from "../shared/transcript.ts";
import { agentName } from "./auth.ts";
import { callHref } from "./router.ts";
import type { CallDetail, CallSummary, CallsOut } from "../shared/types.ts";

const SOURCE: Record<string, string> = { whatsapp: "WhatsApp", dial: "Phone", twilio: "Phone", browser: "Test phone", script: "Script", fake: "Test" };
/** from → to: which one is his depends on who called, which a live call doesn't say yet. */
const numbers = (c: CallSummary | CallDetail): string => [c.from, c.to].filter(Boolean).join(" → ");

export function callTitle(c: CallSummary | CallDetail): string {
  if (!isStored(c)) return numbers(c) || "A call";
  const recapTitle = "recap" in c ? c.recap?.title : null;
  return c.title || recapTitle || (c.rehearsalOf ? `Rehearsal: a call to ${c.rehearsalOf}` : c.userName ? `Call with ${c.userName}` : `Call from ${c.from || "an unknown number"}`);
}
export function callMeta(c: CallSummary | CallDetail): string[] {
  const when = [fmtWhen(c.startedAt), c.endedAt ? fmtDur(c.endedAt - c.startedAt) : "live now", SOURCE[c.source ?? ""] ?? c.source];
  if (!isStored(c)) return when.filter((x): x is string => Boolean(x));
  return [
    c.rehearsalOf ? `rehearsal of a call to ${c.rehearsalOf}` : c.userName,
    c.direction === "outbound" ? `${agentName()} called ${c.to || ""}`.trim() : c.from,
    ...when,
  ].filter((x): x is string => Boolean(x));
}

const wishes = (c: CallSummary) => (isStored(c) ? c.wishes ?? [] : []);
const card = (c: CallSummary) => html`<a class="card item${c.endedAt ? "" : " live"}" href="${callHref(c.id)}" data-call="${c.id}">
    <div class="title">${!c.endedAt && html`<span class="livedot"></span>`}${callTitle(c)}${wishes(c).length > 0 && html` <span class="chip draft" title="${wishes(c).map(w => w.what).join(" · ")}">asked for ${wishes(c).length === 1 ? "something new" : `${wishes(c).length} new things`}</span>`}</div>
    <div class="muted small">${callMeta(c).join(" · ")}</div>
    ${c.summary && html`<p class="sum">${c.summary}</p>`}
  </a>`;

export async function loadCalls(signal: AbortSignal): Promise<void> {
  const { calls } = await getJson<CallsOut>("/api/calls", { signal });
  const shown = calls.filter(c => !c.endedAt || (c.turns ?? 0) > 0);
  renderKeyed($("calls"), shown, {
    key: c => c.id,
    signature: c => `${JSON.stringify(c)}|${agentName()}`,
    render: card,
    empty: html`<div class="empty">No calls yet.</div>`,
  });
  const hidden = calls.length - shown.length;
  $("callsHidden").textContent = hidden ? `${hidden} call${hidden > 1 ? "s" : ""} without a word not shown` : "";
}
