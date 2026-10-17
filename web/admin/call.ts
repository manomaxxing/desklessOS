// #call/<id>: one call's page. What it was for, his wishes, its quotes; the transcript and the
// summary as tabs; copy and download as Markdown; the summary written on demand.
// A live call is polled (web/admin/main.ts); each part of the page is drawn again only when
// its markup changed, so nothing flickers and the keyboard focus stays where it was.

import { $, html, raw, setHtml, patchHtml, delegate, copyText, busy, type SafeHtml } from "../shared/html.ts";
import { getJson, postJson, withDev, seg } from "../shared/api.ts";
import { money, fmtDateTime } from "../shared/format.ts";
import { turnsOf, speaker, isStored } from "../shared/transcript.ts";
import { agentName } from "./auth.ts";
import { callTitle, callMeta } from "./calls.ts";
import { sentence, tabMd, downloadMd } from "./markdown.ts";
import type { CallDetail, QuoteCalc, Recap } from "../shared/types.ts";

type Tab = "transcript" | "summary";
let current: CallDetail | null = null;
let shownId: string | null = null; // the call the page is drawn for (current may still be loading)
let tab: Tab | null = null;

export const liveCallShown = (): boolean => Boolean(current && !current.endedAt);

const ICON_COPY = raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V6.5A2.5 2.5 0 0 0 13.5 4h-7A2.5 2.5 0 0 0 4 6.5v7A2.5 2.5 0 0 0 6.5 16H8"/></svg>');
const ICON_DOWN = raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/></svg>');

const callLink = (id: string): string => withDev(`/monitor?call=${encodeURIComponent(id)}`);
const recapOf = (c: CallDetail): Recap | null => ("recap" in c ? c.recap : null);

// ---------- the parts ----------
const headHtml = (c: CallDetail) => html`<h1>${!c.endedAt && html`<span class="livedot" style="vertical-align:middle;margin-right:8px"></span>`}${callTitle(c)}</h1>
  <div class="muted small" style="margin-top:6px">${callMeta(c).join(" · ")} · <a href="${callLink(c.id)}" target="_blank">timeline</a></div>`;

/** What the call was for: why Toni called, or her own items at the end of his call. */
function goalHtml(c: CallDetail): SafeHtml | null {
  if (!isStored(c) || !c.goal?.length) return null;
  return html`<div class="goal"><div class="lbl">${c.direction === "outbound" ? `Why ${agentName()} called` : `${agentName()}'s own items`}${c.rehearsalOf ? ` · rehearsal, nothing kept in ${c.rehearsalOf}'s memory` : ""}</div>
    ${c.goal.map(g => html`<div style="margin-top:4px"><b>${sentence(g.title)}</b>${g.focus ? `: ${g.focus}` : ""}
      ${g.description && html`<div class="muted small">${g.description}</div>`}
      ${(g.questions?.length ?? 0) > 0 && html`<ul>${(g.questions ?? []).map(q => html`<li>${q}</li>`)}</ul>`}</div>`)}</div>`;
}
/** What he asked for that Toni can't do yet: for Max to build. */
function wishesHtml(c: CallDetail): SafeHtml | null {
  if (!isStored(c) || !c.wishes?.length) return null;
  return html`<div class="goal wish"><div class="lbl">Asked for, ${agentName()} can't do it yet: for you to build</div>
    ${c.wishes.map(w => html`<div style="margin-top:4px"><b>${w.what}</b>${w.why && html` <span class="muted">(for: ${w.why})</span>`}${w.quote && html` <span class="quote">“${w.quote}”</span>`}</div>`)}</div>`;
}
// Quotes made in this call (quote_send): the PDF, made again from its data.
const QUOTE_STATUS: Record<string, string> = { sent: "sent to WhatsApp", saved: "saved", failed: "not sent" };
/** How his list prices were worked out (src/quotes/lists.ts): the quality level and the site's factor. */
const calcText = (c: QuoteCalc | null): string => (c?.fromList
  ? ` · ${[c.quality ? `${c.quality.name} ×${c.quality.factor}` : "", c.site?.factor > 1 ? `site ×${c.site.factor} (${c.site.unfavourable.join(", ")})` : "", `${c.fromList} from his list`].filter(Boolean).join(", ")}`
  : "");
function quotesHtml(c: CallDetail): SafeHtml | null {
  if (!c.quotes?.length) return null;
  return html`<div class="quotes">${c.quotes.map(q => html`<a class="quote" href="${withDev(`/api/quotes/${seg(q.id)}/pdf`)}" target="_blank" title="${q.error || "Open the PDF"}">📄 ${q.draft ? "Draft quote" : "Quote"} ${q.number}${q.customer ? ` · ${q.customer}` : ""}${q.gross != null ? ` · ${money(q.gross, q.currency)}` : ""}${calcText(q.calc)} <span class="st ${q.status}">· ${QUOTE_STATUS[q.status] ?? q.status}</span></a>`)}</div>`;
}

function summaryHtml(c: CallDetail): SafeHtml {
  const r = recapOf(c);
  if (!r) {
    const spoke = turnsOf(c).some(t => t.role === "user");
    return html`<div class="empty" style="padding:12px">${!c.endedAt ? "The summary is written when the call ends." : !spoke ? "Nothing was said in this call." : html`No summary yet.<div class="row" style="justify-content:center"><button class="btn primary" id="writeRecap">Write the summary</button></div><div class="err" id="recapErr" aria-live="polite"></div>`}</div>`;
  }
  const who = (a: { owner?: string; due?: string }) => [a.owner, a.due].filter(Boolean).join(", ");
  return html`${r.overview && html`<div class="overview">${r.overview}</div>`}
    ${r.topics.map(t => html`<h3>${t.heading}</h3><ul>${t.points.map(p => html`<li>${p}</li>`)}</ul>`)}
    ${r.actions.length > 0 && html`<h3>Action items</h3><ul class="todo">${r.actions.map(a => html`<li><span class="box"></span><span>${a.text}${who(a) && html` <span class="muted">· ${who(a)}</span>`}</span></li>`)}</ul>`}
    ${r.open_questions.length > 0 && html`<h3>Open questions</h3><ul>${r.open_questions.map(q => html`<li>${q}</li>`)}</ul>`}
    <div class="foot">Written by Gemini from the transcript${r.writtenAt ? `, ${fmtDateTime(r.writtenAt)}` : ""} · <button class="link" id="writeRecap">Write it again</button><span class="err" id="recapErr" aria-live="polite"></span></div>`;
}
function transcriptHtml(c: CallDetail): SafeHtml {
  const turns = turnsOf(c);
  if (!turns.length) return html`<div class="empty" style="padding:12px">${c.endedAt ? "Nothing was said in this call." : "Waiting for the first words…"}</div>`;
  return html`${turns.map(t => (t.role === "hint"
    ? html`<div class="turn hint">${t.text}</div>`
    : html`<div class="turn ${t.role}"><div class="who">${speaker(c, t, agentName())}</div><div>${t.text}${t.cut && html` <span class="muted">…</span>`}</div></div>`))}`;
}

// ---------- the page ----------
function skeleton(): SafeHtml {
  return html`<a href="#calls" class="back">‹ Calls</a>
    <div id="callHead"></div>
    <div id="callExtras"></div>
    <div class="tabs" role="tablist" aria-label="Transcript or summary">
      <button class="tab" role="tab" id="tab-transcript" data-tab="transcript" aria-controls="callDoc">Transcript</button>
      <button class="tab" role="tab" id="tab-summary" data-tab="summary" aria-controls="callDoc">✦ Summary</button>
      <span class="tools">
        <button class="icon" id="copyTab" title="Copy this tab as Markdown" aria-label="Copy this tab as Markdown">${ICON_COPY}<span class="lbl">Copy</span></button>
        <button class="icon" id="downloadMd" title="Download summary and transcript as a Markdown file" aria-label="Download summary and transcript as a Markdown file">${ICON_DOWN}<span class="lbl">.md</span></button>
      </span>
    </div>
    <div class="doc" id="callDoc" role="tabpanel"></div>`;
}

function draw(): void {
  const c = current;
  if (!c) return;
  tab ??= c.endedAt ? "summary" : "transcript";
  patchHtml($("callHead"), headHtml(c));
  patchHtml($("callExtras"), html`${goalHtml(c)}${wishesHtml(c)}${quotesHtml(c)}`);
  for (const t of ["transcript", "summary"] as const) {
    const b = $(`tab-${t}`);
    b.classList.toggle("on", t === tab);
    b.setAttribute("aria-selected", String(t === tab));
    b.tabIndex = t === tab ? 0 : -1;
  }
  const doc = $("callDoc");
  doc.setAttribute("aria-labelledby", `tab-${tab}`);
  patchHtml(doc, tab === "summary" ? summaryHtml(c) : transcriptHtml(c));
}

/** The view opens on a call: an empty page until it's loaded (the same call: as it was). */
export function openCall(id: string): void {
  if (shownId === id) return;
  shownId = id;
  current = null;
  tab = null;
  setHtml($("view-call"), html`<div class="empty">…</div>`);
}
export function leaveCall(): void { shownId = null; current = null; }

/** Loads it (again) and draws what changed. Errors: on the page while nothing is shown yet, then thrown. */
export async function loadCall(id: string, signal: AbortSignal): Promise<void> {
  let c: CallDetail;
  try { c = await getJson<CallDetail>(`/api/calls/${seg(id)}`, { signal }); } catch (err) {
    if (!signal.aborted && shownId === id && !current) setHtml($("view-call"), html`<a href="#calls" class="back">‹ Calls</a><div class="err" role="alert">${(err as Error).message}</div>`);
    throw err;
  }
  if (shownId !== id) return;
  if (!current) setHtml($("view-call"), skeleton());
  current = c;
  draw();
}

function selectTab(t: Tab, focus = false): void {
  tab = t;
  draw();
  if (focus) $(`tab-${t}`).focus();
}

export function initCall(): void {
  const view = $("view-call");
  delegate(view, "click", "[data-tab]", (_, b) => selectTab(b.dataset.tab === "summary" ? "summary" : "transcript"));
  // The tabs' keys: ← → between them.
  delegate(view, "keydown", "[role=tab]", (e, b) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    selectTab(b.dataset.tab === "summary" ? "transcript" : "summary", true);
  });
  delegate(view, "click", "#copyTab", (_, b) => { if (current) void copyText(tabMd(current, tab ?? "transcript"), b); });
  delegate(view, "click", "#downloadMd", () => { if (current) downloadMd(current); });
  delegate(view, "click", "#writeRecap", async (_, b) => {
    const c = current;
    if (!c || !(b instanceof HTMLButtonElement) || b.disabled) return;
    const err = document.getElementById("recapErr");
    if (err) err.textContent = "";
    try {
      const { recap } = await busy(b, "Writing… (about 10 seconds)", () => postJson<{ recap: Recap }>(`/api/calls/${seg(c.id)}/recap`, {}));
      if (current?.id !== c.id) return;
      current = { ...current, recap } as CallDetail;
      tab = "summary";
      draw();
    } catch (e) {
      b.textContent = "Try again";
      const errNow = document.getElementById("recapErr");
      if (errNow) errNow.textContent = (e as Error).message;
    }
  });
}
