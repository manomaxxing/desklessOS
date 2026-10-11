// Long-term memory across calls: customers (rolling summary + history) and
// to-dos (due date, open/done). Updated once per call by a consolidation step;
// read at the start of every call so the agent knows where to look.
//   data/memory/customers.json   { [id]: customer }
//   data/memory/actions.json     [ action ]

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const slug = s => String(s ?? "").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/^(frau|herr|familie|fam\.?|mrs?\.?|ms\.?|mr\.?)\s+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export function createMemory(dir = process.env.MEMORY_DIR || "data/memory") {
  mkdirSync(dir, { recursive: true });
  const file = name => path.join(dir, name);
  const read = (name, fallback) => { try { return existsSync(file(name)) ? JSON.parse(readFileSync(file(name), "utf8")) : fallback; } catch { return fallback; } };
  const write = (name, data) => writeFileSync(file(name), JSON.stringify(data, null, 2));

  const customers = () => read("customers.json", {});
  const actions = () => read("actions.json", []);

  function findCustomer(all, { existing_id, name, place }) {
    if (existing_id && all[existing_id]) return all[existing_id];
    const key = slug(name);
    if (!key) return null;
    return Object.values(all).find(c => slug(c.name) === key && (!place || !c.place || slug(c.place) === slug(place))) ?? null;
  }

  return {
    customers,
    actions,

    /** Applies one call's consolidation result. Returns what changed (for the monitor). */
    apply(result, { callId, noteId, date = new Date().toISOString().slice(0, 10), lang }) {
      const all = customers();
      const list = actions();
      const changed = { customer: null, added: [], completed: [], updated: [] };
      let customer = null;
      const c = result.customer ?? {};
      if (c.name || c.existing_id) {
        customer = findCustomer(all, c);
        if (!customer) {
          customer = { id: slug(`${c.name}-${c.place || ""}`) || randomUUID().slice(0, 8), name: c.name, createdAt: new Date().toISOString(), history: [] };
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
      const list = actions();
      const a = list.find(x => x.id === id);
      if (!a) return null;
      a.status = status === "done" ? "done" : "open";
      a.doneAt = a.status === "done" ? new Date().toISOString() : null;
      write("actions.json", list);
      return a;
    },

    /** Compact memory for the system prompt: open to-dos first, then customers. */
    context(today = new Date()) {
      const day = today.toISOString().slice(0, 10);
      const open = actions().filter(a => a.status === "open").sort((a, b) => (a.due || "9999").localeCompare(b.due || "9999")).slice(0, 15);
      const recentlyDone = actions().filter(a => a.status === "done").sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt))).slice(0, 5);
      const people = Object.values(customers()).sort((a, b) => String(b.lastContact).localeCompare(String(a.lastContact))).slice(0, 20);
      const dueLabel = due => {
        if (!due) return "no due date";
        const days = Math.round((Date.parse(due) - Date.parse(day)) / 86400000);
        return `due ${due}${days < 0 ? ` (OVERDUE by ${-days} d)` : days === 0 ? " (today)" : days === 1 ? " (tomorrow)" : ` (in ${days} d)`}`;
      };
      return [
        "OPEN TO-DOS (id | customer | task | due):",
        open.length ? open.map(a => `- [${a.id}] ${a.customerName || "?"} | ${a.text} | ${dueLabel(a.due)}`).join("\n") : "- none",
        recentlyDone.length ? `RECENTLY DONE: ${recentlyDone.map(a => `${a.customerName}: ${a.text}`).join("; ")}` : "",
        "",
        "CUSTOMERS (most recent contact first):",
        people.length
          ? people.map(c => `- [${c.id}] ${c.name}${c.place ? `, ${c.place}` : ""} | last contact ${c.lastContact} | ${c.summary || ""}`).join("\n")
          : "- none yet",
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
