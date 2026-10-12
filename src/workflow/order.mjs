// The office behind the voice: turns a confirmed order from the call into a
// customer record, a calendar entry, to-dos and a quote that goes to the outbox.

import { money } from "./quote-template.mjs";
import { locales } from "../locale/index.mjs";

// "{name}"-style placeholders in the locale pack's documents.order texts.
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

const isoDay = d => d.toISOString().slice(0, 10);
const addDays = (iso, n) => isoDay(new Date(new Date(`${iso}T12:00:00`).getTime() + n * 86400000));

export function createOffice({ company, catalog, calendar, quotes, memory }) {
  const cur = company.currency ?? catalog.currency ?? "USD";
  const fmt = (n, lang) => money(n, lang, cur);
  const catalogLines = lang => catalog.items.map(i => `- ${i.id} | ${i.name[lang] ?? i.name[company.lang]} | ${i.price.toFixed(2)} ${cur} / ${i.unit}${i.taxable === false ? " (labor/service, not taxed)" : ""}`).join("\n");

  return {
    company,
    catalog,

    /** What the agent needs to know about the office, for the system prompt. */
    context(lang = company.lang) {
      const today = isoDay(new Date());
      const events = calendar.list({ from: today, to: addDays(today, 21) }).slice(0, 15);
      const recent = quotes.list().slice(0, 6);
      return [
        `COMPANY: ${company.name} (${company.tagline}), ${company.city}, owner ${company.owner}. Prices in ${cur}; ${company.taxLabel?.[company.lang] ?? "sales tax"} applies to materials only.`,
        `PRICE LIST (id | item | net price per unit):\n${catalogLines(lang)}`,
        `CALENDAR, next 3 weeks:\n${events.length ? events.map(e => `- ${e.start.slice(0, 16).replace("T", " ")}–${e.end.slice(11, 16)} ${e.title}${e.location ? ` @ ${e.location}` : ""}`).join("\n") : "- nothing booked"}`,
        `RECENT QUOTES:\n${recent.length ? recent.map(q => `- ${q.number} ${q.customer?.name ?? "?"} ${fmt(q.gross, company.lang)} total, ${q.status}${q.sentTo ? ` to ${q.sentTo}` : ""}`).join("\n") : "- none yet"}`,
      ].join("\n\n");
    },

    /** Executes the confirmed order draft. Returns what was created plus a one-line summary for the agent. */
    execute({ draft, lang = company.lang, callId = null }) {
      const text = locales().document(lang, "order");
      const done = { customer: null, event: null, todos: [], quote: null, email: null };
      const name = draft.customer_name?.trim();
      done.customer = memory.upsertCustomer(
        { name, company: draft.customer_company, email: draft.customer_email, phone: draft.customer_phone, address: draft.address, place: draft.place },
        { callId, summary: draft.summary || "" },
      );

      // Quote lines: catalog price unless he named a price; totals computed in quotes.create.
      const lines = (draft.items ?? []).filter(i => i.description || i.catalog_id).map(i => {
        const entry = catalog.items.find(c => c.id === i.catalog_id);
        return {
          description: entry ? entry.name[lang] ?? entry.name[company.lang] : i.description,
          note: i.note || "",
          quantity: Number(i.quantity) || 1,
          unit: i.unit || entry?.unit || text.unitFallback,
          unitPrice: i.unit_price ?? entry?.price ?? null,
          catalogId: entry?.id ?? null,
          taxable: entry ? entry.taxable !== false : true,
        };
      });

      const date = draft.appointment?.date || draft.needed_by;
      if (draft.add_calendar !== false && date) {
        const time = /^\d{1,2}:\d{2}$/.test(draft.appointment?.start_time ?? "") ? draft.appointment.start_time.padStart(5, "0") : "09:00";
        const minutes = Number(draft.appointment?.duration_min) || 120;
        const start = new Date(`${date}T${time}:00`);
        const end = new Date(start.getTime() + minutes * 60000);
        const local = d => `${isoDay(new Date(d.getTime() - d.getTimezoneOffset() * 60000))}T${d.toTimeString().slice(0, 5)}`;
        done.event = calendar.add({
          title: draft.appointment?.title || fill(text.calendarTitle, { name }),
          start: local(start), end: local(end), location: draft.address || draft.place || "",
          customer: name, customerId: done.customer?.id ?? null, notes: draft.summary || "", callId,
        });
      }

      if (draft.add_todo !== false) {
        const todos = draft.todos?.length ? draft.todos : [{ text: fill(text.followUpTodo, { name }), due: addDays(isoDay(new Date()), 3) }];
        for (const t of todos) if (t.text) done.todos.push(memory.addAction({ text: t.text, due: t.due || "", customerId: done.customer?.id ?? null, customerName: name, sourceCallId: callId }));
      }

      if (draft.send_quote !== false && lines.length) {
        const q = quotes.create({
          customer: { name, company: draft.customer_company || "", email: draft.customer_email || "", address: draft.address || "" },
          lines, lang, company, notes: draft.quote_notes || "", neededBy: draft.needed_by || "", eventId: done.event?.id ?? null, callId,
        });
        const vars = { name, first: String(name).split(" ")[0], number: q.number, total: fmt(q.gross, lang), validUntil: q.validUntil, owner: company.owner, company: company.name, phone: company.phone };
        const body = `${fill(text.emailSalutation, vars)}\n\n${fill(text.emailBody, vars)}`;
        done.email = quotes.send(q.id, { to: draft.customer_email, subject: fill(text.emailSubject, vars), body });
        done.quote = quotes.get(q.id);
      }

      const parts = [];
      if (done.event) parts.push(`calendar: "${done.event.title}" on ${done.event.start.replace("T", " ")}`);
      if (done.todos.length) parts.push(`to-do: ${done.todos.map(t => `"${t.text}"${t.due ? ` due ${t.due}` : ""}`).join(", ")}`);
      if (done.quote) parts.push(`quote ${done.quote.number}: ${done.quote.lines.length} line(s), total ${fmt(done.quote.gross, lang)} including tax${done.quote.unpriced ? `, ${done.quote.unpriced} line(s) without price` : ""}, sent to ${done.email?.to}`);
      done.summary = parts.join("; ") || "nothing to do";
      return done;
    },
  };
}
