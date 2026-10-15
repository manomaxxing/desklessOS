// Quotes: totals in code, numbering, the PDF in any language pack, the WhatsApp send,
// and the tool (only after his yes, once per call, saved when the call has no WhatsApp).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { openDb } from "../src/db/client.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { openPgMemory } from "../src/memory/pg.mjs";
import { loadSkillFromTemplates } from "../src/skills/from-templates.mjs";
import { buildQuote, businessOf, cleanItems } from "../src/quotes/quote.mjs";
import { renderQuotePdf, quoteFileName, quoteCaption } from "../src/quotes/pdf.mjs";
import { createQuoteStore } from "../src/quotes/store.mjs";
import { whatsappSender } from "../src/telephony/whatsapp.mjs";
import { quoteSend } from "../src/tools/quote.mjs";
import { createToolRunner } from "../src/tools/registry.mjs";
import { loadLocales, LOCALES_DIR } from "../src/locale/index.mjs";

const ITEMS = [
  { description: "Alte Fliesen entfernen", quantity: 18, unit: "m²", unit_price: 22 },
  { description: "Wandfliesen verlegen", quantity: 32.5, unit: "m²", unit_price: 65.15 },
  { description: "Bodenfliesen verlegen", quantity: 9, unit: "m²" },
  { description: "Silikonfugen", unit: "pauschal", unit_price: 180 },
  { description: "  " },
];

let db, memory, quotes;
const skill = loadSkillFromTemplates("pilot");
before(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
  memory = openPgMemory({ db, skill });
  await memory.ensureUser();
  quotes = createQuoteStore({ db });
});
after(async () => { await db?.close(); });

test("a quote's totals: in cents, VAT on what's priced, lump sums, nothing invented", () => {
  assert.equal(cleanItems(ITEMS).length, 4, "an empty line is dropped");
  assert.deepEqual(cleanItems([{ description: "x", quantity: -2, unit_price: "abc" }]), [{ description: "x", quantity: null, unit: "", unitPrice: null }]);
  const q = buildQuote({ number: "2026-001", items: ITEMS, business: businessOf({}), lang: "de", now: new Date("2026-10-14T22:30:00Z"), timeZone: "Europe/Berlin" });
  assert.deepEqual(q.items.map(i => i.total), [396, 2117.38, null, 180], "32.5 × 65.15 = 2117.375 → 2117.38");
  assert.deepEqual([q.net, q.vat, q.gross, q.complete, q.draft], [2693.38, 511.74, 3205.12, false, true]);
  assert.equal(q.items[3].quantity, 1, "a price without a quantity is a lump sum");
  assert.deepEqual([q.date, q.validUntil], ["2026-10-15", "2026-11-14"], "his day, in his time zone; 30 days");
  const small = buildQuote({ number: "x", items: [{ description: "a", quantity: 1, unit_price: 100 }], business: businessOf({ business: { name: "Muster", vatRate: 0, currency: "chf", validDays: 14 } }), lang: "de" });
  assert.deepEqual([small.vat, small.gross, small.draft, small.currency], [0, 100, false, "EUR"], "VAT 0 (Kleinunternehmer); a bad currency falls back");
  assert.equal(buildQuote({ number: "y", items: [{ description: "a" }], business: businessOf({}), lang: "de" }).gross, null, "no price at all: no totals");
  assert.throws(() => buildQuote({ number: "z", items: [], business: businessOf({}), lang: "de" }), /no line items/);
});

test("the PDF: one per language pack, a draft without his business, file name and caption", async () => {
  const draft = buildQuote({ number: "2026-001", items: ITEMS, customer: { name: "Familie Huber", address: "Seestraße 4, Allensbach" }, business: businessOf({}), lang: "de" });
  const de = await PDFDocument.load(await renderQuotePdf(draft));
  assert.equal(de.getTitle(), "Angebotsentwurf 2026-001");
  assert.equal(de.getPageCount(), 1);
  assert.equal(quoteFileName(draft), "Angebot-2026-001-Familie-Huber.pdf");
  assert.equal(quoteCaption(draft), "Angebotsentwurf 2026-001 für Familie Huber");
  const business = businessOf({ business: { name: "Fliesen Niko", taxId: "DE1" } });
  const en = buildQuote({ number: "2026-002", items: [{ description: "Łukasz's bathroom 🛁", quantity: 1, unit_price: 50 }], business, lang: "en" });
  assert.equal((await PDFDocument.load(await renderQuotePdf(en))).getTitle(), "Quote 2026-002", "letters the font can't draw don't break it");
  // Many items: more pages.
  const long = buildQuote({ number: "2026-003", items: Array.from({ length: 40 }, (_, i) => ({ description: `Position ${i + 1} mit einer etwas längeren Beschreibung, die umbricht`, quantity: 2, unit: "Std.", unit_price: 58 })), business, lang: "de" });
  assert.ok((await PDFDocument.load(await renderQuotePdf(long))).getPageCount() >= 2);
  // A new language is a pack: the test-only "xx" renders without code.
  const dir = mkdtempSync(path.join(tmpdir(), "locales-"));
  for (const f of readdirSync(LOCALES_DIR).filter(f => f.endsWith(".json"))) copyFileSync(path.join(LOCALES_DIR, f), path.join(dir, f));
  copyFileSync(new URL("./fixtures/locales/xx.json", import.meta.url), path.join(dir, "xx.json"));
  const L = loadLocales(dir, { only: "de,en,xx", fallback: "de" });
  const xx = buildQuote({ number: "2026-004", items: ITEMS, business, lang: "xx" });
  assert.equal((await PDFDocument.load(await renderQuotePdf(xx, { L }))).getTitle(), "xx:Quote 2026-004");
});

test("numbered per org and year; the call's quotes for its page", async () => {
  const [u] = await memory.listUsers();
  const user = { id: u.id, orgId: u.orgId, timezone: "Europe/Berlin", profile: {} };
  const a = await quotes.create({ user, callId: "call-q", lang: "de", items: ITEMS, now: new Date("2026-03-01T10:00:00Z") });
  const b = await quotes.create({ user, callId: "call-q", lang: "de", items: ITEMS, now: new Date("2026-03-01T10:00:00Z") });
  const c = await quotes.create({ user, lang: "de", items: ITEMS, now: new Date("2027-01-02T10:00:00Z") });
  assert.deepEqual([a.number, b.number, c.number], ["2026-001", "2026-002", "2027-001"]);
  await quotes.markSent(a.id, { to: "+491", messageId: "wamid.1" });
  const list = await quotes.forCall("call-q");
  assert.deepEqual(list.map(q => [q.number, q.status, q.draft]), [["2026-001", "sent", true], ["2026-002", "saved", true]]);
  assert.equal((await quotes.get(a.id)).data.items.length, 4);
  assert.equal(await quotes.get("nope"), null);
});

test("WhatsApp: the PDF is uploaded, then sent as a document to his number", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: init.body, auth: init.headers.authorization });
    if (url.endsWith("/media")) return { ok: true, json: async () => ({ id: "media-1" }) };
    return { ok: true, json: async () => ({ messages: [{ id: "wamid.9" }] }) };
  };
  const sender = whatsappSender({ env: { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "123" }, fetchImpl });
  const out = await sender.sendDocument({ to: "+49 151 1444", bytes: new Uint8Array([37, 80, 68, 70]), filename: "Angebot-1.pdf", caption: "Angebot 1" });
  assert.deepEqual(out, { messageId: "wamid.9" });
  assert.match(seen[0].url, /\/v26\.0\/123\/media$/);
  assert.ok(seen[0].body instanceof FormData && seen[0].body.get("file").name === "Angebot-1.pdf");
  assert.deepEqual(JSON.parse(seen[1].body), { messaging_product: "whatsapp", recipient_type: "individual", to: "491511444", type: "document", document: { id: "media-1", filename: "Angebot-1.pdf", caption: "Angebot 1" } });
  assert.equal(seen[1].auth, "Bearer tok");
  assert.equal(whatsappSender({ env: {} }), null, "off without its settings");
  const failing = whatsappSender({ env: { WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "1" }, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: "Re-engagement message" } }) }) });
  await assert.rejects(failing.sendDocument({ to: "1", bytes: new Uint8Array(1), filename: "a.pdf" }), /media 400: Re-engagement/);
});

test("quote_send: only after his yes; sent once; saved when the call has no WhatsApp", async () => {
  const [u] = await memory.listUsers();
  const scope = { user: { id: u.id, orgId: u.orgId, timezone: "Europe/Berlin", profile: {} } };
  const sent = [];
  const sender = { sendDocument: async d => { sent.push(d); return { messageId: "wamid.7" }; } };
  const runner = createToolRunner({ tools: [quoteSend({ memory: scope, quotes, sender, to: "+4915114441541" })] });
  const args = { customer_name: "Kliniken Schmieder", address: "Allensbach", items: [{ description: "Bäder sanieren", quantity: 40, unit: "Stück" }] };
  const ctx = over => ({ callId: "call-t", lang: "de", confirmed: true, emit: () => {}, ...over });
  assert.equal((await runner.run({ name: "quote_send", args }, ctx({ confirmed: false }))).status, "rejected", "not before he said yes");
  const first = await runner.run({ name: "quote_send", args }, ctx());
  assert.equal(first.status, "ok");
  assert.equal(first.result.sent, true);
  assert.equal(sent[0].to, "+4915114441541");
  assert.match(sent[0].filename, /^Angebot-\d{4}-\d{3}-Kliniken-Schmieder\.pdf$/);
  assert.equal((await PDFDocument.load(sent[0].bytes)).getTitle().startsWith("Angebotsentwurf"), true);
  const again = await runner.run({ name: "quote_send", args }, ctx());
  assert.equal(again.status, "repeated", "the same quote isn't sent twice");
  assert.equal(sent.length, 1);
  assert.deepEqual((await quotes.forCall("call-t")).map(q => q.status), ["sent"]);

  // The online test phone: no WhatsApp, the quote is kept for the dashboard.
  const local = createToolRunner({ tools: [quoteSend({ memory: scope, quotes })] });
  const saved = await local.run({ name: "quote_send", args }, ctx({ callId: "call-t2" }));
  assert.deepEqual([saved.result.sent, saved.result.saved], [false, true]);
  // WhatsApp refuses: the quote is marked, and the agent hears it failed.
  const broken = createToolRunner({ tools: [quoteSend({ memory: scope, quotes, sender: { sendDocument: async () => { throw new Error("whatsapp messages 400: nope"); } }, to: "+491" })] });
  const failed = await broken.run({ name: "quote_send", args }, ctx({ callId: "call-t3" }));
  assert.equal(failed.status, "error");
  assert.deepEqual((await quotes.forCall("call-t3")).map(q => q.status), ["failed"]);
  // No known caller: not offered.
  assert.equal(quoteSend({ memory: { user: null }, quotes }).available(), false);
});

test("his business for quotes: only known fields, VAT checked, cleared by saving it empty", async () => {
  const [u] = await memory.listUsers();
  const saved = await memory.updateUser(u.id, { business: { name: "Fliesen Niko", vatRate: "7,5", currency: "eur", hack: "x", phone: "" } });
  assert.deepEqual(saved.business, { name: "Fliesen Niko", vatRate: 7.5, currency: "EUR" });
  await assert.rejects(memory.updateUser(u.id, { business: { vatRate: "120" } }), /VAT/);
  assert.deepEqual((await memory.updateUser(u.id, { business: { name: "" } })).business, {});
});
