// Long-term memory across calls: customers (rolling summary + history) and
// to-dos (due date, open/done). Updated once per call by a consolidation step;
// read at the start of every turn so the agent knows where to look.
//   data/memory/customers.json   { [id]: customer }
//   data/memory/actions.json     [ action ]
// Notes link to their customer via note.customerId (set after consolidation).

import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, readJson, writeJson, slug } from "./files.mjs";

const MAX_CUSTOMERS_IN_PROMPT = 25;
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
    return note.kunde_name ? findCustomer(all, { name: note.kunde_name, place: note.ort }) : null;
  }

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

      const notesBy = new Map(); // customer id → notes, newest first
      const unlinked = [];
      for (const n of notes) {
        const c = customerOf(n, all);
        if (c) notesBy.set(c.id, [...(notesBy.get(c.id) ?? []), n]);
        else unlinked.push(n);
      }
      const people = Object.values(all).sort((a, b) => String(b.lastContact).localeCompare(String(a.lastContact)));
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
        unlinked.length ? `\nOTHER NOTES (not linked to a customer yet):\n${unlinked.slice(0, 10).map(n => `- ${noteLine(n)}`).join("\n")}` : "",
      ].filter(line => line !== "").join("\n");
    },

    /** What the consolidation step needs to match against. */
    snapshot() {
      return {
        customers: Object.values(customers()).map(c => ({ id: c.id, name: c.name, place: c.place, summary: c.summary })),
        openActions: actions().filter(a => a.status === "open").map(a => ({ id: a.id, customer: a.customerName, text: a.text, due: a.due })),
      };
    },
  };
}

// One note, compact but with the specs a briefing needs.
export function noteLine(n) {
  const work = (n.arbeiten ?? []).map(a => [
    a.raum, a.bereich, a.flaeche_m2 ? `${a.flaeche_m2} m²` : "", a.fliese_format, a.fliese_material, a.fliese_optik,
    a.beschaffung ? `tiles: ${a.beschaffung}` : "", a.beschreibung,
  ].filter(Boolean).join(" ")).filter(Boolean);
  const parts = [
    n.termin_datum || n.created_at?.slice(0, 10),
    [n.kunde_name, n.adresse, n.ort].filter(Boolean).join(", ") || "?",
    n.zusammenfassung,
    work.length ? `work: ${work.join("; ")}` : "",
    n.untergrund ? `substrate: ${n.untergrund}` : "",
    n.sonderwuensche?.length ? `wishes: ${n.sonderwuensche.join("; ")}` : "",
    n.zeitrahmen ? `timeframe: ${n.zeitrahmen}` : "",
    n.budget ? `budget: ${n.budget}` : "",
    n.naechste_schritte?.length ? `next: ${n.naechste_schritte.map(s => `${s.was}${s.bis ? ` (${s.bis})` : ""}`).join("; ")}` : "",
    n.offene_fragen?.length ? `open: ${n.offene_fragen.join("; ")}` : "",
  ];
  return parts.filter(Boolean).join(" | ");
}
