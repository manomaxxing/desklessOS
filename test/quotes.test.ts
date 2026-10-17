// Quotes: totals in code, numbering, the PDF in any language pack, the WhatsApp send,
// and the tool (only after his yes, once per call, saved when the call has no WhatsApp).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { openDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { openPgMemory } from "../src/memory/pg.ts";
import { loadSkillFromTemplates } from "../src/skills/from-templates.ts";
import { buildQuote, businessOf, cleanItems } from "../src/quotes/quote.ts";
import { renderQuotePdf, quoteFileName, quoteCaption } from "../src/quotes/pdf.ts";
import { createQuoteStore } from "../src/quotes/store.ts";
import { whatsappSender } from "../src/telephony/whatsapp.ts";
import { quoteSend } from "../src/tools/quote.ts";
import { createToolRunner } from "../src/tools/registry.ts";
import { loadLocales, LOCALES_DIR } from "../src/locale/index.ts";
import type { HttpError } from "../src/types/common.ts";

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

test("money in exact cents: the unit price to cents first, then × the quantity as it was said", () => {
  const q = buildQuote({ number: "m", items: [{ description: "Wand", quantity: 32.5, unit_price: 19.99 }, { description: "Dübel", quantity: 3, unit_price: 1.005 }, { description: "Rund", quantity: 2, unit_price: 19.999 }], business: businessOf({}), lang: "de" });
  assert.deepEqual(q.items.map(i => [i.unitPrice, i.total]), [[19.99, 649.68], [1.01, 3.03], [20, 40]], "649.675 → 649.68 (the float product gave 649.67); the price as the PDF shows it");
  assert.deepEqual([q.net, q.vat, q.gross], [692.71, 131.61, 824.32]);
});

test("a quantity of 0 or less is no quantity: the line stays unpriced, not 1 × the price", () => {
  assert.deepEqual(cleanItems([{ description: "x", quantity: 0, unit_price: 50 }, { description: "y", quantity: -1, unit_price: 50 }, { description: "z", unit_price: 50 }]).map(i => i.quantity), [null, null, 1], "only a price with no quantity at all is a lump sum");
  const q = buildQuote({ number: "0", items: [{ description: "x", quantity: 0, unit_price: 50 }, { description: "y", quantity: 2, unit_price: 10 }], business: businessOf({}), lang: "de" });
  assert.deepEqual([q.items[0].total, q.net, q.complete], [null, 20, false], "\"0 × 50 €\" isn't billed as 50 €");
});

test("amounts too large to be a price: a 400, never \"∞\" on the PDF", () => {
  const huge = (items: unknown[]) => () => buildQuote({ number: "h", items, business: businessOf({}), lang: "de" });
  assert.throws(huge([{ description: "x", quantity: 1e10, unit_price: 1e300 }]), (e: HttpError) => e.status === 400 && /too large/.test(e.message));
  assert.throws(huge([{ description: "x", quantity: 2, unit_price: 9e15 }]), (e: HttpError) => e.status === 400, "past what adds up exactly");
  assert.equal(huge([{ description: "x", quantity: 2, unit_price: 1e6 }])().gross, 2380000);
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
  const fetchImpl = async (url: string, init: RequestInit & { headers?: Record<string, string> }) => {
    seen.push({ url, body: init.body, auth: init.headers.authorization });
    if (url.endsWith("/media")) return Response.json({ id: "media-1" });
    return Response.json({ messages: [{ id: "wamid.9" }] });
  };
  const sender = whatsappSender({ env: { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "123" }, fetchImpl });
  const out = await sender.sendDocument({ to: "+49 151 1444", bytes: new Uint8Array([37, 80, 68, 70]), filename: "Angebot-1.pdf", caption: "Angebot 1" });
  assert.deepEqual(out, { messageId: "wamid.9" });
  assert.match(seen[0].url, /\/v26\.0\/123\/media$/);
  assert.ok(seen[0].body instanceof FormData && seen[0].body.get("file").name === "Angebot-1.pdf");
  assert.deepEqual(JSON.parse(seen[1].body), { messaging_product: "whatsapp", recipient_type: "individual", to: "491511444", type: "document", document: { id: "media-1", filename: "Angebot-1.pdf", caption: "Angebot 1" } });
  assert.equal(seen[1].auth, "Bearer tok");
  assert.equal(whatsappSender({ env: {} }), null, "off without its settings");
  const failing = whatsappSender({ env: { WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_NUMBER_ID: "1" }, fetchImpl: async () => Response.json({ error: { message: "Re-engagement message" } }, { status: 400 }) });
  await assert.rejects(failing.sendDocument({ to: "1", bytes: new Uint8Array(1), filename: "a.pdf" }), /media 400: Re-engagement/);
});

test("quote_send: only after his yes; sent once; saved when the call has no WhatsApp", async () => {
  const [u] = await memory.listUsers();
  const scope = { user: { id: u.id, orgId: u.orgId, name: u.name, lang: u.lang, timezone: "Europe/Berlin", profile: {} } };
  const sent = [];
  const sender = { sendDocument: async d => { sent.push(d); return { messageId: "wamid.7" }; } };
  const runner = createToolRunner({ tools: [quoteSend({ memory: scope, quotes, sender, to: "+4915114441541" })] });
  const args = { customer_name: "Kliniken Schmieder", address: "Allensbach", items: [{ description: "Bäder sanieren", quantity: 40, unit: "Stück" }] };
  const ctx = (over = {}) => ({ callId: "call-t", lang: "de", confirmed: true, emit: () => {}, ...over });
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

test("quote_send after a failed send: a retry sends the same quote again (same number), not a new one", async () => {
  const [u] = await memory.listUsers();
  const scope = { user: { id: u.id, orgId: u.orgId, name: u.name, lang: u.lang, timezone: "Europe/Berlin", profile: {} } };
  const sent = [];
  let down = true;
  const sender = { sendDocument: async d => { if (down) throw new Error("whatsapp messages 500: try later"); sent.push(d); return { messageId: "wamid.r" }; } };
  const runner = createToolRunner({ tools: [quoteSend({ memory: scope, quotes, sender, to: "+491" })] });
  const args = { customer_name: "Familie Retry", items: [{ description: "Bad fliesen", quantity: 10, unit: "m²", unit_price: 60 }] };
  const ctx = { callId: "call-retry", lang: "de", confirmed: true, emit: () => {} };
  const failed = await runner.run({ name: "quote_send", args }, ctx);
  assert.equal(failed.status, "error");
  down = false;
  const retried = await runner.run({ name: "quote_send", args }, ctx);
  assert.equal(retried.status, "ok");
  assert.equal(retried.result.number, failed.result.error.match(/The quote (\S+) is saved/)[1], "the number he heard about");
  assert.deepEqual((await quotes.forCall("call-retry")).map(q => [q.number, q.status]), [[retried.result.number, "sent"]], "one quote, sent");
  const changed = await runner.run({ name: "quote_send", args: { ...args, items: [{ ...args.items[0], quantity: 12 }] } }, ctx);
  assert.notEqual(changed.result.number, retried.result.number, "other items: a new quote");
});

test("his business for quotes: only known fields, VAT checked, cleared by saving it empty", async () => {
  const [u] = await memory.listUsers();
  const saved = await memory.updateUser(u.id, { business: { name: "Fliesen Niko", vatRate: "7,5", currency: "eur", hack: "x", phone: "" } });
  assert.deepEqual(saved.business, { name: "Fliesen Niko", vatRate: 7.5, currency: "EUR" });
  await assert.rejects(memory.updateUser(u.id, { business: { vatRate: "120" } }), /VAT/);
  assert.deepEqual((await memory.updateUser(u.id, { business: { name: "" } })).business, {});
});
