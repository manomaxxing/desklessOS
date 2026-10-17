// #requests: "find something out" (the planner makes a card of questions), "talk with him about
// his day", and the cards: edit the questions, answer the planner, approve, discard, withdraw.
// The list is drawn by request: a card is drawn again only when the request changed, and what's
// typed but not saved (edited questions, an answer for "Plan again") is kept across redraws.

import { $, html, setHtml, renderKeyed, delegate, type SafeHtml } from "../shared/html.ts";
import { getJson, postJson, seg } from "../shared/api.ts";
import { fmtDateTime } from "../shared/format.ts";
import { renderJobs } from "./jobs.ts";
import { fetchUsers } from "./people.ts";
import type { JobsOut, Question, RequestView, User } from "../shared/types.ts";

let views: RequestView[] = [];
const editing = new Map<string, Question[]>(); // request id → its questions as edited, not saved yet
const answers = new Map<string, string>(); // request id → what's typed for "Plan again"
let scrolledTo = "";

const STATUS: Record<string, string> = { draft: "waiting for your OK", approved: "asked in his next call", done: "answered", expired: "expired", cancelled: "cancelled" };

function questionsBlock({ request: r }: RequestView): SafeHtml {
  if (r.status === "draft") {
    const qs = editing.get(r.id) ?? r.card.questions;
    return html`${qs.map((q, i) => html`<div class="q"><label class="lab" for="q-${r.id}-${i}-ask">Question ${i + 1}${q.required === false ? " · only if he has time" : ""}</label>
      <input type="text" id="q-${r.id}-${i}-ask" data-req="${r.id}" data-i="${i}" data-k="ask" value="${q.ask}">
      <label class="lab" for="q-${r.id}-${i}-probe" style="margin-top:6px">If his answer is vague, one follow-up</label>
      <input type="text" id="q-${r.id}-${i}-probe" data-req="${r.id}" data-i="${i}" data-k="probe" value="${q.probe}" placeholder="(none)"></div>`)}`;
  }
  const answered = r.result?.questions ?? r.card.questions.map(q => ({ ask: q.ask, status: "not_asked" as const, answer: undefined, quote: undefined }));
  return html`${answered.map(q => html`<div class="q"><div>${q.ask}</div>
    <div class="answer">${q.status === "answered" || q.status === "vague"
      ? html`<b>${q.answer}</b>${q.quote && html` <span class="quote">“${q.quote}”</span>`}${q.status === "vague" && html` <span class="chip">vague</span>`}`
      : html`<span class="muted">${(q.status || "not asked").replace("_", " ")}</span>`}</div></div>`)}`;
}

function card(view: RequestView): SafeHtml {
  const r = view.request, c = r.card;
  const calls = r.result?.calls ?? [];
  const draft = r.status === "draft";
  const placeholder = c.clarifications.length ? "Answer, and it plans again" : "Change something? Say it, and it plans again";
  return html`<div class="card${location.hash === `#${r.id}` ? " hl" : ""}" id="${r.id}">
    <div class="title">${c.title} <span class="chip ${r.status}">${STATUS[r.status] ?? r.status}</span></div>
    <div class="muted small" style="margin-top:2px">${r.instruction}</div>
    ${c.summary && html`<p style="margin:10px 0 0">${c.summary}</p>`}
    <dl><dt>Who</dt><dd>${c.who}</dd><dt>When</dt><dd>${c.when}</dd>${c.purpose && html`<dt>Why</dt><dd>${c.purpose}</dd>`}
    ${calls.length > 0 && html`<dt>Calls</dt><dd>${calls.map((id, i) => html`${i > 0 && ", "}<a href="#call/${encodeURIComponent(id)}">call ${i + 1}</a>`)}</dd>`}</dl>
    ${questionsBlock(view)}
    ${r.log.length > 0 && html`<div class="log">${r.log.map((l, i) => html`${i > 0 && html`<br>`}${fmtDateTime(l.at)}: ${l.text}`)}</div>`}
    ${draft && [
      ...c.blocked.map(b => html`<div class="note block">Can't approve: ${b}</div>`),
      ...c.warnings.map(w => html`<div class="note warn">${w}</div>`),
      ...c.clarifications.map(q => html`<div class="note">${q}</div>`),
    ]}
    ${draft ? html`
      <div class="row"><input type="text" data-answer="${r.id}" value="${answers.get(r.id) ?? ""}" placeholder="${placeholder}" aria-label="${placeholder}"></div>
      <div class="row">
        <button class="btn primary" data-act="approve" data-id="${r.id}" ${view.confirmToken && !editing.has(r.id) ? "" : "disabled"}>Approve</button>
        <button class="btn" data-act="save" data-id="${r.id}" ${editing.has(r.id) ? "" : "disabled"}>Save my edits</button>
        <button class="btn" data-act="replan" data-id="${r.id}">Plan again</button>
        <button class="btn danger" data-act="cancel" data-id="${r.id}">Discard</button>
      </div><div class="err" data-err="${r.id}" aria-live="polite"></div>`
    : r.status === "approved" ? html`<div class="row"><button class="btn danger" data-act="cancel" data-id="${r.id}">Withdraw</button></div><div class="err" data-err="${r.id}" aria-live="polite"></div>` : ""}
  </div>`;
}

function render(): void {
  const list = $("list");
  renderKeyed(list, views, {
    key: v => v.request.id,
    // A draft's confirm token is new on every load: what matters is whether it has one.
    signature: v => `${v.request.updatedAt}|${v.request.status}|${v.confirmToken ? 1 : 0}|${location.hash === `#${v.request.id}` ? 1 : 0}`,
    render: card,
    empty: html`<div class="empty">Nothing yet.</div>`,
  });
  if (location.hash.startsWith("#req_") && scrolledTo !== location.hash) {
    scrolledTo = location.hash;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "center" });
  }
}

/** Who the day conversation is with: a choice once there's more than one person. */
function renderPeoplePick(users: User[]): void {
  const pick = $<HTMLSelectElement>("convUser"), was = pick.value;
  setHtml(pick, html`${users.map(p => html`<option value="${p.id}">${p.name}</option>`)}`);
  if (was) pick.value = was;
  pick.style.display = users.length > 1 ? "" : "none";
}

/** opened: the view was just opened (the people for the day conversation too). */
export async function loadRequests(signal: AbortSignal, { opened }: { opened: boolean }): Promise<void> {
  const [list, jobs, people] = await Promise.all([
    getJson<{ requests: RequestView[] }>("/api/requests", { signal }),
    getJson<JobsOut>("/api/jobs", { signal }).catch(() => null), // background work: shown when it loads
    opened ? fetchUsers(signal) : null,
  ]);
  views = list.requests;
  for (const id of editing.keys()) if (!views.some(v => v.request.id === id && v.request.status === "draft")) editing.delete(id);
  for (const id of answers.keys()) if (!views.some(v => v.request.id === id && v.request.status === "draft")) answers.delete(id);
  render();
  if (jobs) renderJobs(jobs);
  if (people) renderPeoplePick(people.users);
}

/** refresh: loads the view again, after something changed (the latest load wins). */
export function initRequests(refresh: () => Promise<void>): void {
  const list = $("list");
  delegate(list, "input", "input[data-req]", (_, el) => {
    const input = el as HTMLInputElement;
    const id = input.dataset.req ?? "";
    const view = views.find(v => v.request.id === id);
    if (!view) return;
    const qs = structuredClone(editing.get(id) ?? view.request.card.questions);
    const q = qs[Number(input.dataset.i)];
    if (q) q[input.dataset.k === "probe" ? "probe" : "ask"] = input.value;
    editing.set(id, qs);
    for (const b of list.querySelectorAll<HTMLButtonElement>(`button[data-id="${CSS.escape(id)}"]`)) {
      if (b.dataset.act === "save") b.disabled = false;
      if (b.dataset.act === "approve") b.disabled = true; // approve exactly what's saved
    }
  });
  delegate(list, "input", "input[data-answer]", (_, el) => { answers.set(el.dataset.answer ?? "", (el as HTMLInputElement).value); });
  delegate(list, "click", "button[data-act]", (_, b) => { void act(b.dataset.act ?? "", b.dataset.id ?? "", b as HTMLButtonElement, refresh); });

  const convBtn = $<HTMLButtonElement>("convBtn");
  convBtn.addEventListener("click", async () => {
    if (convBtn.disabled) return;
    $("convErr").textContent = "";
    convBtn.disabled = true;
    try {
      const view = await postJson<RequestView>("/api/requests/conversation", { userId: $<HTMLSelectElement>("convUser").value || null, focus: $<HTMLInputElement>("convFocus").value.trim(), mode: $<HTMLSelectElement>("convMode").value });
      $<HTMLInputElement>("convFocus").value = "";
      location.hash = view.request.id; // the view loads again, with this card in sight
    } catch (e) { $("convErr").textContent = (e as Error).message; }
    convBtn.disabled = false;
  });

  const planBtn = $<HTMLButtonElement>("planBtn");
  planBtn.addEventListener("click", async () => {
    const instruction = $<HTMLTextAreaElement>("instruction").value.trim();
    if (!instruction || planBtn.disabled) return;
    $("planErr").textContent = "";
    planBtn.disabled = true;
    $("planBusy").textContent = "Planning… (a few seconds)";
    try {
      const view = await postJson<RequestView>("/api/requests", { instruction });
      $<HTMLTextAreaElement>("instruction").value = "";
      location.hash = view.request.id;
    } catch (e) { $("planErr").textContent = (e as Error).message; }
    planBtn.disabled = false;
    $("planBusy").textContent = "";
  });
}

async function act(what: string, id: string, button: HTMLButtonElement, refresh: () => Promise<void>): Promise<void> {
  const view = views.find(v => v.request.id === id);
  const errOf = () => $("list").querySelector<HTMLElement>(`[data-err="${CSS.escape(id)}"]`); // the card may be drawn again meanwhile
  if (!view || button.disabled) return;
  const before = errOf();
  if (before) before.textContent = "";
  const label = button.textContent ?? "";
  button.disabled = true;
  try {
    const path = `/api/requests/${seg(id)}`;
    if (what === "approve") await postJson(`${path}/approve`, { confirmToken: view.confirmToken });
    if (what === "save") {
      await postJson(`${path}/revise`, { edits: { questions: editing.get(id) } });
      editing.delete(id);
    }
    if (what === "replan") {
      const answer = (answers.get(id) ?? "").trim();
      if (!answer) throw new Error("say what should change");
      button.textContent = "Planning…";
      await postJson(`${path}/revise`, { answer });
      answers.delete(id);
      editing.delete(id);
    }
    if (what === "cancel") await postJson(`${path}/cancel`, {});
    await refresh();
  } catch (e) {
    const err = errOf();
    if (err) err.textContent = (e as Error).message;
  }
  // Drawn again by the refresh when it changed; otherwise the button gets its own label back.
  if (!button.isConnected) return;
  button.textContent = label;
  button.disabled = what === "approve" ? !view.confirmToken || editing.has(id) : what === "save" ? !editing.has(id) : false;
}
