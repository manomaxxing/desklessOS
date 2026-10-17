// #people: who Toni talks to. Per person: phone, time zone, call times; Toni calls him on
// WhatsApp now (or a rehearsal on Max's phone); what Toni does for him; his business and his
// lists for quotes; consent and pause.
// A card someone has typed into keeps what's typed until it's saved: loading the people again
// (the view opened again, someone else saved) draws only the cards nobody is editing.
// Whether WhatsApp lets Toni call him is asked once per person and page (and on "Check again").

import { $, html, setHtml, patchHtml, renderKeyed, delegate, busy, type SafeHtml } from "../shared/html.ts";
import { getJson, postJson, seg } from "../shared/api.ts";
import { fmtDate } from "../shared/format.ts";
import { agentName } from "./auth.ts";
import type { FeatureId, User, UserPatch, UsersOut, WaPermission } from "../shared/types.ts";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// What Toni does for someone beyond notes, briefings and to-dos (src/features.ts): one at a time.
const FEATURES: [FeatureId, string, string][] = [
  ["note_whatsapp", "The note on WhatsApp after each call", "only what he confirmed, after WhatsApp calls"],
  ["quotes", "Quotes as a PDF on WhatsApp", "offered after he confirms a job, on WhatsApp calls"],
];
const BUSINESS = ["name", "address", "phone", "email", "taxId", "vatRate", "currency"] as const;

let users: User[] = [];
let outbound = false;
const dirty = new Set<string>(); // people whose card has unsaved edits
const permissions = new Map<string, { phone: string; answer: Promise<WaPermission> }>();
const asked = new Set<string>(); // asked on WhatsApp to allow Toni's calls, this session

export const fetchUsers = (signal: AbortSignal): Promise<UsersOut> => getJson<UsersOut>("/api/users", { signal });

// ---------- a person's card ----------
/** His lists (src/quotes/lists.ts): what Toni goes through after he tells about a job, and how
 *  the quote prices it. Plain text, so what he sends on WhatsApp can be pasted. */
function listsHtml(u: User, id: (name: string) => string): SafeHtml {
  const l = u.lists ?? {};
  const kinds = (l.jobs || "").split("\n").filter(x => x.trim().startsWith("#")).map(x => x.replace(/^#+/, "").trim()).filter(Boolean);
  const summary = kinds.length ? `: ${kinds.join(", ")}` : l.site || l.levels ? "" : " (none yet)";
  return html`<details class="biz"><summary>Lists and prices for quotes${summary}</summary>
    <div class="muted small" style="margin-top:6px">After ${u.name} tells about a job of one of these kinds, ${agentName()} goes through what's still open: the job's list, the site, the quality level. He can say "reicht" anytime. A line with a price is priced on the quote: price × quality factor × site factor. A price he says in the call counts as it is.</div>
    <label for="${id("l_jobs")}">Per kind of job: "# Badumbau", then one item per line: <code>Bodenfläche | m² | 65</code> (asked and priced), <code>Format Fliesen Boden</code> (just asked)</label>
    <textarea id="${id("l_jobs")}" name="l_jobs" rows="8" placeholder="${"# Badumbau\nBodenfläche | m² | 65\nWandfläche | m² | 60\nFormat Fliesen Boden"}">${l.jobs || ""}</textarea>
    <label for="${id("l_site")}">The site: <code>Parkplatz | kein Parkplatz am Haus</code> (the question | when it makes the job harder); <code>Adresse</code> is just asked</label>
    <textarea id="${id("l_site")}" name="l_site" rows="5" placeholder="${"Adresse\nHaus oder Wohnung | Wohnung\nStockwerk | ab 2. OG ohne Aufzug\nLaufweg | über 20 m\nParkplatz | kein Parkplatz am Haus"}">${l.site || ""}</textarea>
    <div class="grid2"><div><label for="${id("l_siteMax")}">Factor when all of it makes it harder</label><input type="text" id="${id("l_siteMax")}" name="l_siteMax" value="${l.siteMax ?? ""}" placeholder="1,8"></div></div>
    <label for="${id("l_levels")}">Quality levels: <code>Hochwertig | 1,25</code></label>
    <textarea id="${id("l_levels")}" name="l_levels" rows="4" placeholder="${"Low Budget | 0,85\nStandard | 1\nHochwertig | 1,25\nMeisterstück | 1,5"}">${l.levels || ""}</textarea>
  </details>`;
}

function card(u: User): SafeHtml {
  const w = { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00", ...u.callWindow };
  const id = (name: string): string => `u-${u.id}-${name}`;
  const field = (name: string, label: string, value: unknown, placeholder = "") =>
    html`<div><label for="${id(name)}">${label}</label><input type="text" id="${id(name)}" name="${name}" value="${value == null ? "" : String(value)}"${placeholder && html` placeholder="${placeholder}"`}></div>`;
  const agent = agentName();
  const b = u.business ?? {};
  return html`<div class="card" data-user="${u.id}">
    <div class="title">${u.name} <span class="chip">${u.lang}</span>${u.demo && html`<span class="chip draft">demo</span>`}${u.consentOutboundAt && html`<span class="chip done">may be called</span>`}${u.outboundPaused && html`<span class="chip expired">paused</span>`}</div>
    ${u.demo && html`<div class="muted small" style="margin-top:4px">The online test phone, and calls from the number below. Its own memory; no research questions; nobody else's memory gets these calls.</div>`}
    <div class="grid2">
      ${field("phone", "Phone", u.phone, "+4915112345678")}
      ${field("timezone", "Time zone", u.timezone || "Europe/Berlin")}
      ${field("from", "Calls from", w.from)}
      ${field("to", "until", w.to)}
    </div>
    <div class="days" role="group" aria-label="Days he can be called">${DAYS.map((d, i) => html`<label><input type="checkbox" name="day" value="${i + 1}" ${w.days?.includes(i + 1) ? "checked" : ""}>${d}</label>`)}</div>
    <div class="callbox">
      <div style="font-size:14px;font-weight:600">${agent} calls ${u.name} on WhatsApp</div>
      <div class="muted small" id="wa-${u.id}" aria-live="polite">${u.phone ? "Checking whether WhatsApp lets her call…" : "No phone number yet."}</div>
      <div class="err wa-err" id="waerr-${u.id}" aria-live="polite"></div>
      <div class="row"><input type="text" name="focus" placeholder="What should ${agent} find out? (optional)" aria-label="What should ${agent} find out? (optional)" title="e.g. how his last inquiry went until the quote"></div>
      <div class="row">
        <button class="btn primary" data-call-now="${u.id}" ${u.phone ? "" : "disabled"}>Call now</button>
        ${!u.demo && html`<button class="btn" data-rehearse="${u.id}" title="Rings the demo's number (yours) as if it were a call to ${u.name}: his memory, read only; the call is kept as the demo's">Rehearse on my phone</button>`}
        <span class="muted small" id="callOut-${u.id}" aria-live="polite"></span>
      </div>
    </div>
    <div style="margin-top:12px;font-size:14px;font-weight:600">What Toni does for ${u.name}</div>
    <div class="muted small">Notes, briefings and to-dos always. Switch on the rest one at a time: Toni mentions a new one once, at the end of the next call.</div>
    ${FEATURES.map(([f, label, sub]) => {
      const since = u.features?.[f];
      return html`<label class="check"><input type="checkbox" name="f_${f}" ${since ? "checked" : ""}> ${label} <span class="muted small">(${sub}${since ? `, on since ${fmtDate(since)}` : ""})</span></label>`;
    })}
    <details class="biz"><summary>Business details for quotes${b.name ? `: ${b.name}` : " (without them, quotes are drafts)"}</summary>
      <div class="grid2">
        ${field("b_name", "Business name", b.name, "Fliesen Muster GmbH")}
        ${field("b_address", "Address", b.address, "Hafenstraße 1, 78462 Konstanz")}
        ${field("b_phone", "Phone", b.phone)}
        ${field("b_email", "Email", b.email)}
        ${field("b_taxId", "VAT no.", b.taxId, "DE123456789")}
        <div><label for="${id("b_vatRate")}">VAT % · currency</label><div style="display:flex;gap:6px"><input type="text" id="${id("b_vatRate")}" name="b_vatRate" value="${b.vatRate ?? ""}" placeholder="19"><input type="text" name="b_currency" value="${b.currency ?? ""}" placeholder="EUR" aria-label="Currency"></div></div>
      </div>
    </details>
    ${listsHtml(u, id)}
    <label class="check"><input type="checkbox" name="consent" ${u.consentOutboundAt ? "checked" : ""}> Agreed to be called by the assistant${u.consentOutboundAt ? ` (since ${fmtDate(u.consentOutboundAt)})` : ""}</label>
    <label class="check"><input type="checkbox" name="paused" ${u.outboundPaused ? "checked" : ""}> Pause calls to ${u.name}</label>
    <div class="row"><button class="btn" data-save-user="${u.id}">Save</button>${!outbound && html`<span class="muted small">Planned calls (from requests) are off on this server; Call now works.</span>`}</div>
    <div class="err" id="uerr-${u.id}" aria-live="polite"></div>
  </div>`;
}

const cardOf = (id: string): HTMLElement | null => $("people").querySelector<HTMLElement>(`[data-user="${CSS.escape(id)}"]`);
const signature = (u: User): string => `${JSON.stringify(u)}|${outbound}|${agentName()}`;

function render(): void {
  renderKeyed($("people"), users, {
    key: u => u.id,
    // A card with unsaved edits keeps its signature: it isn't drawn again under the typing.
    signature: u => (dirty.has(u.id) ? cardOf(u.id)?.dataset.sig ?? signature(u) : signature(u)),
    render: card,
    empty: html`<div class="empty">Nobody yet.</div>`,
  });
  for (const u of users) void showPermission(u);
}

// ---------- may Toni call him on WhatsApp ----------
const checkAgain = (u: User) => html` <button class="link" data-wa-check="${u.id}">Check again</button>`;
function permissionHtml(u: User, p: WaPermission): SafeHtml {
  const agent = agentName();
  if (!p.available) return html`${p.why}`;
  if (p.status === "permanent" || p.status === "temporary") return html`✅ ${u.name} allowed ${agent}'s calls${p.until ? ` until ${fmtDate(p.until)}` : ""}.`;
  if (p.status !== "no_permission") return html`Couldn't check with WhatsApp: ${p.error ?? p.status}${checkAgain(u)}`;
  if (asked.has(u.id)) return html`Asked. Once ${u.name} taps Allow, ${agent} can call him.${checkAgain(u)}`;
  return html`Not allowed yet: WhatsApp lets ${agent} call ${u.name} only once he allows it.
    <button class="link" data-ask="${u.id}">Ask him on WhatsApp</button> <span class="muted">(a message with an Allow button; works if he called or wrote to ${agent} in the last 24 hours)</span>${checkAgain(u)}`;
}
async function showPermission(u: User, { fresh = false } = {}): Promise<void> {
  if (!u.phone) return;
  let entry = permissions.get(u.id);
  if (fresh || !entry || entry.phone !== u.phone) {
    entry = { phone: u.phone, answer: getJson<WaPermission>(`/api/users/${seg(u.id)}/whatsapp`) };
    permissions.set(u.id, entry);
  }
  let out: SafeHtml;
  try { out = permissionHtml(u, await entry.answer); } catch (err) {
    if (permissions.get(u.id) === entry) permissions.delete(u.id); // asked again next time
    out = html`${(err as Error).message}${checkAgain(u)}`;
  }
  const el = document.getElementById(`wa-${u.id}`);
  if (el) patchHtml(el, out);
}

// ---------- loading ----------
/** The people change only when someone saves: loaded when the view opens, not polled. */
export async function loadPeople(signal: AbortSignal, { opened }: { opened: boolean }): Promise<void> {
  if (!opened && users.length) return;
  const out = await fetchUsers(signal);
  users = out.users;
  outbound = out.outbound;
  render();
}

// ---------- the buttons ----------
function patchOf(cardEl: HTMLElement, u: User | undefined): UserPatch {
  const v = (name: string): HTMLInputElement => {
    const el = cardEl.querySelector<HTMLInputElement>(`[name="${name}"]`);
    if (!el) throw new Error(`the card has no ${name}`);
    return el;
  };
  const patch: UserPatch = {
    phone: v("phone").value.trim(),
    timezone: v("timezone").value.trim(),
    callWindow: { days: [...cardEl.querySelectorAll<HTMLInputElement>("[name=day]:checked")].map(x => Number(x.value)), from: v("from").value.trim(), to: v("to").value.trim() },
    consentOutbound: v("consent").checked,
    outboundPaused: v("paused").checked,
    business: Object.fromEntries(BUSINESS.map(k => [k, v(`b_${k}`).value.trim()])) as UserPatch["business"],
    features: Object.fromEntries(FEATURES.map(([f]) => [f, v(`f_${f}`).checked])) as UserPatch["features"],
    lists: { jobs: v("l_jobs").value, site: v("l_site").value, siteMax: v("l_siteMax").value.trim(), levels: v("l_levels").value },
  };
  if (u && Boolean(u.consentOutboundAt) === patch.consentOutbound) delete patch.consentOutbound; // keep the original date
  return patch;
}

async function save(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.saveUser ?? "";
  const cardEl = cardOf(id);
  const err = document.getElementById(`uerr-${id}`);
  if (!cardEl || button.disabled) return;
  if (err) err.textContent = "";
  try {
    const before = users.find(u => u.id === id);
    const { user } = await busy(button, null, () => postJson<{ user: User }>(`/api/users/${seg(id)}`, patchOf(cardEl, before)));
    users = users.map(u => (u.id === id ? user : u));
    dirty.delete(id);
    const open = [...cardEl.querySelectorAll("details")].map(d => d.open); // drawn again: the same sections stay open
    render();
    cardOf(id)?.querySelectorAll("details").forEach((d, i) => { d.open = open[i] ?? false; });
  } catch (e) { if (err) err.textContent = (e as Error).message; }
}

async function callNow(button: HTMLButtonElement, rehearse: boolean): Promise<void> {
  const id = button.dataset.callNow ?? button.dataset.rehearse ?? "";
  const out = document.getElementById(`callOut-${id}`);
  if (!out || button.disabled) return;
  const focus = button.closest("[data-user]")?.querySelector<HTMLInputElement>("[name=focus]")?.value.trim() ?? "";
  button.disabled = true;
  out.textContent = "Calling…";
  try {
    await postJson(`/api/users/${seg(id)}/call`, { focus, rehearse });
    out.textContent = rehearse ? "Your phone rings now. The call shows up under Calls." : "It rings now (up to 45 seconds). The call shows up under Calls.";
  } catch (e) { setHtml(out, html`<span class="err" style="display:inline">${(e as Error).message}</span>`); }
  setTimeout(() => { button.disabled = false; }, 8000); // one call at a time
}

async function askOnWhatsApp(button: HTMLButtonElement): Promise<void> {
  const id = button.dataset.ask ?? "";
  const u = users.find(x => x.id === id);
  const err = document.getElementById(`waerr-${id}`);
  if (!u || button.disabled) return;
  if (err) err.textContent = "";
  try {
    await busy(button, null, () => postJson(`/api/users/${seg(id)}/whatsapp/ask`, {}));
    asked.add(id);
    void showPermission(u);
  } catch (e) { if (err) err.textContent = (e as Error).message; }
}

export function initPeople(): void {
  const people = $("people");
  // Typed into: the card keeps it until it's saved.
  people.addEventListener("input", e => {
    const id = (e.target as Element).closest<HTMLElement>("[data-user]")?.dataset.user;
    if (id) dirty.add(id);
  });
  delegate(people, "click", "[data-save-user]", (_, b) => void save(b as HTMLButtonElement));
  delegate(people, "click", "[data-call-now]", (_, b) => void callNow(b as HTMLButtonElement, false));
  delegate(people, "click", "[data-rehearse]", (_, b) => void callNow(b as HTMLButtonElement, true));
  delegate(people, "click", "[data-ask]", (_, b) => void askOnWhatsApp(b as HTMLButtonElement));
  delegate(people, "click", "[data-wa-check]", (_, b) => {
    const u = users.find(x => x.id === b.dataset.waCheck);
    if (!u) return;
    const el = document.getElementById(`wa-${u.id}`);
    if (el) patchHtml(el, html`Checking whether WhatsApp lets her call…`);
    void showPermission(u, { fresh: true });
  });
}
