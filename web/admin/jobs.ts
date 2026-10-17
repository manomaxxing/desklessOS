// Under the requests: the calls Toni makes for them, and background work that keeps failing
// (what after a call or a notification didn't go through: retrying, or given up).

import { $, html, patchHtml } from "../shared/html.ts";
import { fmtDateTime } from "../shared/format.ts";
import type { JobsOut, OutboundCallRow, QueueRow } from "../shared/types.ts";

const jobChip = (j: OutboundCallRow): string => (j.status === "done" ? "done" : j.status === "failed" || j.status === "cancelled" ? "expired" : "approved");

export function renderJobs({ jobs, queue = [] }: JobsOut): void {
  $("jobsTitle").style.display = jobs.length ? "" : "none";
  patchHtml($("jobs"), html`${jobs.map(j => html`<div class="card">
    <div class="title">${j.user_name} <span class="chip ${jobChip(j)}">${j.status}</span>${j.outcome && html`<span class="chip">${j.outcome}</span>`}</div>
    <div class="muted small">try ${j.attempts} of ${j.max_attempts}${j.status === "queued" && ` · next ${fmtDateTime(j.next_attempt_at)}`}${j.call_id && html` · <a href="#call/${encodeURIComponent(j.call_id)}">last call</a>`}</div>
    ${(j.log ?? []).length > 0 && html`<div class="log">${j.log.slice(-4).map((l, i) => html`${i > 0 && html`<br>`}${l.text}`)}</div>`}
  </div>`)}`);

  const trouble = queue.filter((j: QueueRow) => j.status === "dead" || (j.status !== "done" && j.attempts > 1));
  $("queueTitle").style.display = trouble.length ? "" : "none";
  patchHtml($("queue"), html`${trouble.map(j => html`<div class="card">
    <div class="title">${j.kind} <span class="chip ${j.status === "dead" ? "expired" : "approved"}">${j.status === "dead" ? "given up" : "retrying"}</span></div>
    <div class="muted small">${j.key} · try ${j.attempts} of ${j.max_attempts}${j.status !== "dead" && ` · next ${fmtDateTime(j.run_at)}`}</div>
    ${j.last_error && html`<div class="log">${j.last_error}</div>`}
  </div>`)}`);
}
