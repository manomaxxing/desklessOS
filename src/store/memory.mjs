// Long-term memory across calls: customers (rolling summary + history) and
// to-dos (due date, open/done). Updated once per call by a consolidation step;
// read at the start of every turn so the agent knows where to look.
//   data/memory/customers.json   { [id]: customer }
//   data/memory/actions.json     [ action ]
// Notes link to their customer via note.customerId (set after consolidation).

import { mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, readJson, writeJson, slug } from "./files.mjs";
import { normalizeNote } from "./note-keys.mjs";
import { locales } from "../locale/index.mjs";

const MAX_CUSTOMERS_IN_PROMPT = 25;
const MAX_UNLINKED_IN_PROMPT = 10;
const NOTES_PER_CUSTOMER = 3;

export function createMemory(dir = dataDir("memory", "MEMORY_DIR")) {
  mkdirSync(dir, { recursive: true });
  const file = name => path.join(dir, name);
  const cache = {};
  const read = (name, fallback) => (cache[name] ??= readJson(file(name), fallback));
  const write = (name, data) => { writeJson(file(name), data); cache[name] = data; };

  const customers = () => read("customers.json", {});
  const actions = () => read("actions.json", []);

  function findCustomer(all, { existing_id, name, place }) {
    if (existing_id && all[existing_id]) return all[existing_id];
    const key = slug(name);
    if (!key) return null;
    return Object.values(all).find(c => slug(c.name) === key && (!place || !c.place || slug(c.place) === slug(place))) ?? null;
  }

  // Which customer a note belongs to: its link if it has one, else by name (notes saved before linking).
  function customerOf(note, all) {
    if (note.customerId && all[note.customerId]) return all[note.customerId];
    const n = normalizeNote(note);
    return n.customer_name ? findCustomer(all, { name: n.customer_name, place: n.place }) : null;
  }
  // Notes per customer id (newest first, as given) and the ones linked to nobody.
  function byCustomer(notes, all) {
    const notesBy = new Map();
    const unlinked = [];
    for (const n of notes) {
      const c = customerOf(n, all);
      if (c) notesBy.set(c.id, [...(notesBy.get(c.id) ?? []), n]);
      else unlinked.push(n);
    }
    return { notesBy, unlinked };
  }
  const byRecency = all => Object.values(all).sort((a, b) => String(b.lastContact).localeCompare(String(a.lastContact)));

  return {
    customers,
    actions,

    /** Applies one call's consolidation result. Returns what changed (for the monitor). */
    apply(result, { callId, noteId, date = new Date().toISOString().slice(0, 10), lang }) {
      const all = structuredClone(customers());
      const list = structuredClone(actions());
      const changed = { customer: null, added: [], completed: [], updated: [] };
      let customer = null;
      const c = result.customer ?? {};
      if (c.name || c.existing_id) {
        customer = findCustomer(all, c);
        if (!customer) {
          customer = { id: slug(`${c.name}-${c.place || ""}`) || randomUUID().slice(0, 8), name: c.name, createdAt: new Date().toISOString(), history: [] };
          if (all[customer.id]) customer.id += `-${randomUUID().slice(0, 4)}`;
          all[customer.id] = customer;
        }
        Object.assign(customer, {
          name: c.name || customer.name,
          place: c.place || customer.place || "",
          address: c.address || customer.address || "",
          phone: c.phone || customer.phone || "",
          summary: c.summary_update || customer.summary || "",
          lastContact: date,
        });
        customer.history = [...(customer.history ?? []), { date, callId, noteId: noteId ?? null, type: result.call_type, summary: result.call_summary, lang }].slice(-30);
        changed.customer = { id: customer.id, name: customer.name };
      }
      for (const a of result.new_actions ?? []) {
        if (!a.text) continue;
        const target = a.customer_name ? findCustomer(all, { name: a.customer_name }) ?? customer : customer;
        const action = { id: randomUUID().slice(0, 8), text: a.text, due: a.due || "", status: "open", customerId: target?.id ?? null, customerName: target?.name ?? a.customer_name ?? "", createdAt: new Date().toISOString(), sourceCallId: callId };
        list.push(action);
        changed.added.push(action);
      }
      for (const id of result.completed_action_ids ?? []) {
        const a = list.find(x => x.id === id && x.status === "open");
        if (a) { a.status = "done"; a.doneAt = new Date().toISOString(); a.doneCallId = callId; changed.completed.push(a); }
      }
      for (const u of result.updated_actions ?? []) {
        const a = list.find(x => x.id === u.id);
        if (a) { if (u.text) a.text = u.text; if (u.due !== undefined) a.due = u.due; changed.updated.push(a); }
      }
      write("customers.json", all);
      write("actions.json", list);
      return changed;
    },

    reset() { for (const k of Object.keys(cache)) delete cache[k]; mkdirSync(dir, { recursive: true }); },

    /** Creates or updates a customer from the order workflow; returns it. */
    upsertCustomer({ name, company = "", email = "", phone = "", address = "", place = "", summary = "" }, { callId = null, date = new Date().toISOString().slice(0, 10), type = "order" } = {}) {
      if (!name) return null;
      const all = structuredClone(customers());
      let c = findCustomer(all, { name, place });
      if (!c) {
        c = { id: slug(`${name}-${place || ""}`) || randomUUID().slice(0, 8), name, createdAt: new Date().toISOString(), history: [] };
        if (all[c.id]) c.id += `-${randomUUID().slice(0, 4)}`;
        all[c.id] = c;
      }
      Object.assign(c, {
        company: company || c.company || "", email: email || c.email || "", phone: phone || c.phone || "",
        address: address || c.address || "", place: place || c.place || "", summary: summary || c.summary || "", lastContact: date,
      });
      if (summary) c.history = [...(c.history ?? []), { date, callId, type, summary }].slice(-30);
      write("customers.json", all);
      return c;
    },

    /** Adds one to-do directly (the order workflow), skipping exact duplicates that are still open. */
    addAction({ text, due = "", customerId = null, customerName = "", sourceCallId = null }) {
      const list = structuredClone(actions());
      const dupe = list.find(a => a.status === "open" && a.text === text && a.customerName === customerName);
      if (dupe) return dupe;
      const action = { id: randomUUID().slice(0, 8), text, due, status: "open", customerId, customerName, createdAt: new Date().toISOString(), sourceCallId };
      write("actions.json", [...list, action]);
      return action;
    },

    setActionStatus(id, status) {
      const list = structuredClone(actions());
      const a = list.find(x => x.id === id);
      if (!a) return null;
      a.status = status === "done" ? "done" : "open";
      a.doneAt = a.status === "done" ? new Date().toISOString() : null;
      write("actions.json", list);
      return a;
    },

    /**
     * Everything the agent knows, for the system prompt: open to-dos first, then
     * customers (most recent first), each with the details of their latest notes,
     * so a briefing can answer "what format did she want?" for any recent customer.
     */
    context({ notes = [], today = new Date() } = {}) {
      const day = today.toISOString().slice(0, 10);
      const all = customers();
      const list = actions();
      const open = list.filter(a => a.status === "open").sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999")).slice(0, 15);
      const recentlyDone = list.filter(a => a.status === "done").sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt))).slice(0, 5);
      const dueLabel = due => {
        if (!due) return "no due date";
        const days = Math.round((Date.parse(due) - Date.parse(day)) / 86400000);
        return `due ${due}${days < 0 ? ` (OVERDUE by ${-days} d)` : days === 0 ? " (today)" : days === 1 ? " (tomorrow)" : ` (in ${days} d)`}`;
      };

      const { notesBy, unlinked } = byCustomer(notes, all);
      const people = byRecency(all);
      const shown = people.slice(0, MAX_CUSTOMERS_IN_PROMPT);
      const customerBlock = c => {
        const own = (notesBy.get(c.id) ?? []).slice(0, NOTES_PER_CUSTOMER);
        return [
          `- [${c.id}] ${c.name}${c.place ? `, ${c.place}` : ""}${c.address ? ` (${c.address})` : ""}${c.phone ? ` tel ${c.phone}` : ""} | last contact ${c.lastContact} | ${c.summary || ""}`,
          ...own.map(n => `    note ${noteLine(n)}`),
        ].join("\n");
      };

      return [
        "OPEN TO-DOS (id | customer | task | due):",
        open.length ? open.map(a => `- [${a.id}] ${a.customerName || "?"} | ${a.text} | ${dueLabel(a.due)}`).join("\n") : "- none",
        recentlyDone.length ? `RECENTLY DONE: ${recentlyDone.map(a => `${a.customerName}: ${a.text}`).join("; ")}` : "",
        "",
        "CUSTOMERS (most recent contact first; under each, their appointment notes, newest first; a newer note overrides an older one):",
        shown.length ? shown.map(customerBlock).join("\n") : "- none yet",
        people.length > shown.length ? `OLDER CUSTOMERS (name only): ${people.slice(shown.length).map(c => `${c.name}${c.place ? ` (${c.place})` : ""}`).join("; ")}` : "",
        unlinked.length ? `\nOTHER NOTES (not linked to a customer yet):\n${unlinked.slice(0, MAX_UNLINKED_IN_PROMPT).map(n => `- ${noteLine(n)}`).join("\n")}` : "",
      ].filter(line => line !== "").join("\n");
    },

    /** How many customers and notes the prompt can't show in full: memory_search is offered when > 0. */
    hidden({ notes = [] } = {}) {
      const all = customers();
      const { unlinked } = byCustomer(notes, all);
      return Math.max(0, Object.keys(all).length - MAX_CUSTOMERS_IN_PROMPT) + Math.max(0, unlinked.length - MAX_UNLINKED_IN_PROMPT);
    },

    /**
     * Customers (and loose notes) matching a spoken query, best first: names and
     * places by similarity (so "Kowalsky" finds Kowalski), other words anywhere
     * in what we know. Each result carries what a briefing needs.
     */
    search(query, { notes = [], limit = 3 } = {}) {
      const all = customers();
      const { notesBy, unlinked } = byCustomer(notes, all);
      const q = searchWords(query);
      if (!q.length) return [];
      const open = actions().filter(a => a.status === "open");
      const found = Object.values(all).map(c => {
        const own = notesBy.get(c.id) ?? [];
        const text = [c.summary, c.address, ...(c.history ?? []).map(h => h.summary), ...own.map(noteLine)].join(" ");
        return { c, own, score: matchScore(q, searchWords(`${c.name} ${c.place ?? ""}`), text) };
      }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || String(b.c.lastContact).localeCompare(String(a.c.lastContact)));
      const loose = unlinked.map(n => ({ n, score: matchScore(q, searchWords(`${normalizeNote(n).customer_name ?? ""} ${normalizeNote(n).place ?? ""}`), noteLine(n)) })).filter(r => r.score > 0);
      const results = [
        ...found.map(({ c, own, score }) => ({
          score,
          name: c.name, place: c.place || "", address: c.address || "", phone: c.phone || "", last_contact: c.lastContact || "",
          summary: c.summary || "",
          history: (c.history ?? []).slice(-3).map(h => `${h.date}: ${h.summary}`),
          notes: own.slice(0, NOTES_PER_CUSTOMER).map(noteLine),
          open_todos: open.filter(a => a.customerId === c.id).map(a => `${a.text}${a.due ? ` (due ${a.due})` : ""}`),
        })),
        ...loose.map(({ n, score }) => ({ score, note: noteLine(n) })),
      ];
      return results.sort((a, b) => b.score - a.score).slice(0, limit).map(({ score, ...r }) => r);
    },

    // Calls whose consolidation failed (API down): kept on disk and retried later.
    savePending(job) {
      mkdirSync(path.join(dir, "pending"), { recursive: true });
      writeJson(path.join(dir, "pending", `${String(job.callId).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`), { ...job, failedAt: new Date().toISOString() });
    },
    listPending() {
      const d = path.join(dir, "pending");
      if (!existsSync(d)) return [];
      return readdirSync(d).filter(f => f.endsWith(".json")).map(f => { try { return { file: path.join(d, f), ...readJson(path.join(d, f), {}) }; } catch { return null; } }).filter(Boolean);
    },
    removePending(job) { rmSync(job.file, { force: true }); },

    /** What the consolidation step needs to match against. */
    snapshot() {
      return {
        customers: Object.values(customers()).map(c => ({ id: c.id, name: c.name, place: c.place, summary: c.summary })),
        openActions: actions().filter(a => a.status === "open").map(a => ({ id: a.id, customer: a.customerName, text: a.text, due: a.due })),
      };
    },
  };
}

// One note, compact but with the specs a briefing needs (old German-keyed notes too).
export function noteLine(note) {
  const n = normalizeNote(note);
  const work = (n.work ?? []).map(w => [w.area, w.quantity, w.material, w.supply ? `supply: ${w.supply}` : "", w.description].filter(Boolean).join(" ")).filter(Boolean);
  const parts = [
    n.appointment_date || n.created_at?.slice(0, 10),
    [n.customer_name, n.address, n.place].filter(Boolean).join(", ") || "?",
    n.summary,
    work.length ? `work: ${work.join("; ")}` : "",
    n.substrate ? `substrate: ${n.substrate}` : "",
    n.special_requests?.length ? `wishes: ${n.special_requests.join("; ")}` : "",
    n.timeframe ? `timeframe: ${n.timeframe}` : "",
    n.budget ? `budget: ${n.budget}` : "",
    n.next_steps?.length ? `next: ${n.next_steps.map(s => `${s.what}${s.due ? ` (${s.due})` : ""}`).join("; ")}` : "",
    n.open_questions?.length ? `open: ${n.open_questions.join("; ")}` : "",
  ];
  return parts.filter(Boolean).join(" | ");
}

// ---------- search ----------
// Lowercase words without accents ("Müller" → "muller"), 3+ letters, no stopwords of any enabled language.
function searchWords(text) {
  const stop = stopwords();
  return String(text ?? "").toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3 && !stop.has(w));
}
let stopCache = null;
const stopwords = () => (stopCache ??= new Set(locales().enabled().flatMap(id => [...locales().lexicon(id).stopwords])));

// pg_trgm-style similarity of two words (0…1).
function trigrams(word) {
  const s = `  ${word} `;
  const out = new Set();
  for (let i = 0; i < s.length - 2; i++) out.add(s.slice(i, i + 3));
  return out;
}
export function similarity(a, b) {
  const A = trigrams(a), B = trigrams(b);
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return shared / (A.size + B.size - shared);
}

// A name or place word that sounds alike counts 3; any other word found in the text counts 1.
function matchScore(queryWords, nameWords, text) {
  const hay = searchWords(text).join(" ");
  let score = 0;
  for (const w of queryWords) {
    const best = Math.max(0, ...nameWords.map(n => similarity(w, n)));
    if (best >= 0.45) score += 3 * best;
    else if (w.length >= 4 && hay.includes(w)) score += 1;
  }
  return score;
}
