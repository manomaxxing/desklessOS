// Quotes and the outbox: data/quotes/quotes.json, data/quotes/outbox.json.
// Totals are computed here, never by the model.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, readJson, writeJson } from "./files.mjs";

const round2 = n => Math.round(n * 100) / 100;

export function createQuotes(dir = dataDir("quotes", "QUOTES_DIR")) {
  mkdirSync(dir, { recursive: true });
  const qFile = path.join(dir, "quotes.json"), oFile = path.join(dir, "outbox.json");
  let quotes = null, outbox = null;
  const allQ = () => (quotes ??= readJson(qFile, []));
  const allO = () => (outbox ??= readJson(oFile, []));
  const saveQ = list => { writeJson(qFile, list); quotes = list; };
  const saveO = list => { writeJson(oFile, list); outbox = list; };

  return {
    reset() { quotes = null; outbox = null; mkdirSync(dir, { recursive: true }); },
    list: () => [...allQ()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    get: id => allQ().find(q => q.id === id || q.number === id) ?? null,
    outbox: () => [...allO()].sort((a, b) => b.sentAt.localeCompare(a.sentAt)),
    create({ customer, lines, lang, company, notes = "", neededBy = "", eventId = null, callId = null }) {
      const year = new Date().getFullYear();
      const seq = allQ().filter(q => q.number.startsWith(`ANG-${year}-`)).length + 1;
      const priced = lines.map((l, i) => ({ pos: i + 1, ...l, total: l.unitPrice == null ? null : round2(l.quantity * l.unitPrice) }));
      const net = round2(priced.reduce((n, l) => n + (l.total ?? 0), 0));
      const taxable = round2(priced.reduce((n, l) => n + (l.taxable === false ? 0 : l.total ?? 0), 0));
      const rate = company.taxRate ?? company.vatRate ?? 0;
      const vat = round2(taxable * rate); // sales tax on materials only (labor isn't taxed in CA)
      const created = new Date();
      const valid = new Date(created.getTime() + company.quoteValidDays * 86400000);
      const q = {
        id: randomUUID().slice(0, 8), number: `ANG-${year}-${String(seq).padStart(3, "0")}`, createdAt: created.toISOString(),
        validUntil: valid.toISOString().slice(0, 10), lang, customer, lines: priced, net, taxable, vatRate: rate, vat, gross: round2(net + vat), currency: company.currency ?? "USD",
        unpriced: priced.filter(l => l.unitPrice == null).length, notes, neededBy, eventId, callId, status: "draft",
      };
      saveQ([...allQ(), q]);
      return q;
    },
    /** Demo send: lands in the outbox (no email service is connected). */
    send(id, { to, subject, body }) {
      const list = allQ();
      const q = list.find(x => x.id === id);
      if (!q) return null;
      q.status = "sent"; q.sentAt = new Date().toISOString(); q.sentTo = to || null;
      saveQ(list);
      const mail = { id: randomUUID().slice(0, 8), quoteId: q.id, quoteNumber: q.number, to: to || "(no address)", subject, body, sentAt: q.sentAt, delivery: "demo-outbox" };
      saveO([...allO(), mail]);
      return mail;
    },
  };
}
