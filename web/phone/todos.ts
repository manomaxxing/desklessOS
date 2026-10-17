// The To-dos tab: what the notebook knows (open and recently done to-dos, the customers).
// Loaded while the tab is shown (every 15 s, not during a call, not while the page is hidden),
// and a few times after a call, when the after-call job updates the memory.

import { $, html, patchHtml, delegate, raw, type SafeHtml } from "../shared/html.ts";
import { getJson, postJson, seg } from "../shared/api.ts";
import { poll, type Poller } from "../shared/poll.ts";
import { dueLabel } from "../shared/format.ts";
import type { Action, MemoryOut } from "../shared/types.ts";

const TICK = raw('<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg>');
let poller: Poller | null = null;
let inCall = (): boolean => false;
let after: ReturnType<typeof setTimeout>[] = [];

function duePill(due: string): SafeHtml | null {
  const d = dueLabel(due);
  return d && html`<span class="chip ${d.days < 0 ? "red" : d.days <= 1 ? "orange" : "blue"}">${d.text}</span>`;
}
const todo = (a: Action) => html`<div class="todo ${a.status === "done" ? "done" : ""}"><button class="check" data-id="${a.id}" data-status="${a.status === "done" ? "open" : "done"}" aria-label="${a.status === "done" ? "Mark as open" : "Mark as done"}">${a.status === "done" && TICK}</button>
  <div style="min-width:0"><div class="t1">${a.text}</div><div class="t2">${a.customerName || ""} ${a.status === "open" && duePill(a.due)}</div></div></div>`;

async function load(signal: AbortSignal): Promise<void> {
  let m: MemoryOut;
  try { m = await getJson<MemoryOut>("/api/memory", { signal }); } catch (err) {
    if (!signal.aborted) patchHtml($("memory"), html`<div class="empty">Memory unavailable.</div>`);
    throw err;
  }
  const open = m.actions.filter(a => a.status === "open").sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999"));
  const done = m.actions.filter(a => a.status === "done").sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt))).slice(0, 5);
  const people = [...m.customers].sort((a, b) => String(b.lastContact).localeCompare(String(a.lastContact)));
  const calls = (n: number) => `${n} call${n === 1 ? "" : "s"}`;
  patchHtml($("memory"), html`<h3>To-dos · ${open.length} open</h3><div class="card">${open.length ? open.map(todo) : html`<div class="empty" style="padding:20px">Nothing open.</div>`}</div>
    ${done.length > 0 && html`<h3>Recently done</h3><div class="card">${done.map(todo)}</div>`}
    <h3>Customers · ${people.length}</h3><div class="card">${people.length
      ? people.map(c => html`<div class="rowi cust"><div class="v"><div class="n">${c.name}${c.place && html` <span style="color:var(--muted);font-weight:400">· ${c.place}</span>`}</div><div class="s">${c.summary || ""}</div><div class="t2" style="margin-top:6px"><span class="chip">${c.lastContact || ""}</span><span class="chip">${calls((c.history ?? []).length)}</span></div></div></div>`)
      : html`<div class="empty" style="padding:20px">Customers appear after the first call.</div>`}</div>
    <div class="foot">The notebook reads this at the start of every call.</div>`);
}

/** The tab is shown: load now, then every 15 s (not during a call). */
export function showTodos(): void {
  if (poller) { void poller.now(); return; }
  poller = poll(load, () => (inCall() ? null : 15000));
}
export function hideTodos(): void {
  poller?.stop();
  poller = null;
}
/** A call ended: the after-call job updates the memory in the next half minute. */
export function afterCall(): void {
  after.forEach(clearTimeout);
  after = [4000, 12000, 30000].map(ms => setTimeout(() => void poller?.now(), ms));
}

export function initTodos({ callActive }: { callActive: () => boolean }): void {
  inCall = callActive;
  delegate($("memory"), "click", "button.check[data-id]", async (_, b) => {
    const button = b as HTMLButtonElement;
    if (button.disabled) return;
    $("todoErr").textContent = "";
    button.disabled = true;
    try {
      await postJson(`/api/actions/${seg(button.dataset.id ?? "")}?status=${encodeURIComponent(button.dataset.status ?? "done")}`, {});
      await poller?.now();
    } catch (e) {
      $("todoErr").textContent = `Couldn't change the to-do: ${(e as Error).message}`;
    }
    if (button.isConnected) button.disabled = false;
  });
}
