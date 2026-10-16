// The quote as an A4 PDF (pdf-lib, the PDF standard fonts: nothing to download, no browser).
// Texts come from the locale pack (documents.quote), number and date formats from its
// numberLocale, so a new language is a pack, not code. Characters the standard fonts can't
// draw (e.g. "ł") lose their accent, or become "?".

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { locales as sharedLocales } from "../locale/index.mjs";

const PAGE = [595.28, 841.89];
const M = 56; // margin
const INK = rgb(0.11, 0.11, 0.12), MUTED = rgb(0.43, 0.43, 0.45), LINE = rgb(0.85, 0.85, 0.87), BAND = rgb(0.95, 0.95, 0.96);
const fill = (s, v) => String(s ?? "").replace(/\{(\w+)\}/g, (_, k) => v[k] ?? "");

/** The texts and formats for a quote's language. */
function wording(q, L) {
  const t = L.document(q.lang, "quote");
  if (!t) throw new Error(`no quote texts for "${q.lang}" (documents.quote in its locale pack)`);
  const nl = L.get(q.lang).format?.numberLocale ?? L.bcp47(q.lang);
  return {
    t,
    money: n => new Intl.NumberFormat(nl, { style: "currency", currency: q.currency }).format(n),
    qty: n => new Intl.NumberFormat(nl, { maximumFractionDigits: 2 }).format(n),
    date: iso => new Date(`${iso}T12:00:00Z`).toLocaleDateString(nl, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }),
    rate: n => new Intl.NumberFormat(nl, { maximumFractionDigits: 2 }).format(n),
  };
}

const title = (q, t) => (q.draft ? t.draftTitle : t.title);

/** "Angebot-2026-001-Huber.pdf" */
export function quoteFileName(q, L = sharedLocales()) {
  const { t } = wording(q, L);
  const ascii = s => String(s ?? "").replace(/[äöüÄÖÜß]/g, c => ({ ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss" })[c]).normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
  const who = ascii(q.customer?.name).slice(0, 30);
  return `${ascii(t.fileName) || "quote"}-${q.number}${who ? `-${who}` : ""}.pdf`;
}

/** The line under the document in the chat. */
export function quoteCaption(q, L = sharedLocales()) {
  const { t } = wording(q, L);
  return fill(q.customer?.name ? t.caption : t.captionNoCustomer, { title: title(q, t), number: q.number, customer: q.customer?.name ?? "" });
}

/** renderQuotePdf(quote) → the PDF's bytes. `agent`: the assistant's name in a draft's note. */
export async function renderQuotePdf(q, { agent = "Toni", L = sharedLocales() } = {}) {
  const { t, money, qty, date, rate } = wording(q, L);
  const doc = await PDFDocument.create();
  doc.setTitle(`${title(q, t)} ${q.number}`);
  doc.setCreator("DesklessOS");
  doc.setProducer("DesklessOS");
  doc.setLanguage(L.bcp47(q.lang));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(font.getCharacterSet());
  const safe = s => [...String(s ?? "")].map(ch => {
    if (charset.has(ch.codePointAt(0))) return ch;
    const plain = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    return plain && [...plain].every(c => charset.has(c.codePointAt(0))) ? plain : "?";
  }).join("");
  const width = (s, size, f = font) => f.widthOfTextAtSize(safe(s), size);
  // Lines of at most `w` points; a word longer than a line is cut.
  const wrap = (s, size, w, f = font) => {
    const out = [];
    let line = "";
    for (let word of safe(s).split(/\s+/).filter(Boolean)) {
      while (width(word, size, f) > w) {
        let i = word.length;
        while (i > 1 && width(word.slice(0, i), size, f) > w) i--;
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, i));
        word = word.slice(i);
      }
      const next = line ? `${line} ${word}` : word;
      if (width(next, size, f) <= w) line = next;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
    return out.length ? out : [""];
  };

  let page = null;
  let y = 0;
  const text = (s, x, yy, { size = 10, f = font, color = INK, right = false } = {}) => {
    const str = safe(s);
    page.drawText(str, { x: right ? x - f.widthOfTextAtSize(str, size) : x, y: yy, size, font: f, color });
  };
  const rule = (yy, color = LINE) => page.drawLine({ start: { x: M, y: yy }, end: { x: PAGE[0] - M, y: yy }, thickness: 0.7, color });
  const newPage = () => { page = doc.addPage(PAGE); y = PAGE[1] - M; };

  // ---------- header: the business (left), the document (right) ----------
  newPage();
  const b = q.business ?? {};
  const right = PAGE[0] - M;
  text(title(q, t), right, y - 14, { size: 20, f: bold, right: true });
  [[t.number, q.number], [t.date, date(q.date)], [t.validUntil, date(q.validUntil)]].forEach(([k, v], i) => {
    const yy = y - 36 - i * 13;
    text(v, right, yy, { size: 9.5, right: true });
    text(k, right - 92, yy, { size: 9.5, color: MUTED });
  });
  if (b.name) {
    text(b.name, M, y - 12, { size: 14, f: bold });
    const contact = [b.phone && `${t.phone} ${b.phone}`, b.email && `${t.email} ${b.email}`].filter(Boolean).join("  ·  ");
    [b.address, contact].filter(Boolean).flatMap(line => wrap(line, 9, 260).slice(0, 2)).slice(0, 4).forEach((l, i) => text(l, M, y - 28 - i * 11, { size: 9, color: MUTED }));
  }
  y -= 100;

  // ---------- for whom ----------
  if (q.customer?.name || q.customer?.address) {
    text(t.for, M, y, { size: 9, color: MUTED });
    y -= 15;
    if (q.customer.name) { text(q.customer.name, M, y, { size: 11, f: bold }); y -= 14; }
    for (const l of wrap(q.customer.address, 10, 300)) { text(l, M, y); y -= 13; }
    y -= 12;
  }
  for (const l of wrap(t.intro, 10, PAGE[0] - 2 * M)) { text(l, M, y); y -= 13; }
  if (q.quality && t.quality) { y -= 2; text(fill(t.quality, { level: q.quality }), M, y, { f: bold }); y -= 13; }
  y -= 10;

  // ---------- the items ----------
  const col = { pos: M + 4, desc: M + 36, qty: right - 165, unit: right - 82, total: right - 4 };
  const descW = col.qty - 70 - col.desc;
  const head = () => {
    page.drawRectangle({ x: M, y: y - 6, width: PAGE[0] - 2 * M, height: 20, color: BAND });
    text(t.pos, col.pos, y, { size: 9, f: bold });
    text(t.description, col.desc, y, { size: 9, f: bold });
    text(t.quantity, col.qty, y, { size: 9, f: bold, right: true });
    text(t.unitPrice, col.unit, y, { size: 9, f: bold, right: true });
    text(t.total, col.total, y, { size: 9, f: bold, right: true });
    y -= 22;
  };
  head();
  for (const item of q.items) {
    const lines = wrap(item.description, 10, descW);
    const h = lines.length * 13 + 8;
    if (y - h < M + 40) { newPage(); head(); }
    text(String(item.pos), col.pos, y);
    lines.forEach((l, i) => text(l, col.desc, y - i * 13));
    if (item.quantity !== null) text(`${qty(item.quantity)}${item.unit ? ` ${item.unit}` : ""}`, col.qty, y, { right: true });
    else if (item.unit) text(item.unit, col.qty, y, { right: true });
    text(item.unitPrice !== null ? money(item.unitPrice) : t.noPrice, col.unit, y, { right: true, color: item.unitPrice !== null ? INK : MUTED });
    text(item.total !== null ? money(item.total) : "–", col.total, y, { right: true, color: item.total !== null ? INK : MUTED });
    y -= h;
    rule(y + 8);
  }

  // ---------- totals, notes ----------
  const notes = [];
  if (q.net !== null) {
    if (y < M + 110) newPage();
    y -= 10;
    const row = (k, v, f = font) => { text(k, col.unit - 70, y, { f, right: true }); text(v, col.total, y, { f, right: true }); y -= 16; };
    row(t.net, money(q.net));
    if (q.vatRate > 0) row(fill(t.vat, { rate: rate(q.vatRate) }), money(q.vat));
    y -= 2;
    page.drawLine({ start: { x: col.unit - 150, y: y + 12 }, end: { x: right, y: y + 12 }, thickness: 0.7, color: INK });
    row(t.gross, money(q.gross), bold);
    if (q.vatRate === 0) notes.push(t.noVat);
  }
  if (!q.complete) notes.push(t.incomplete);
  notes.push(t.closing);
  y -= 14;
  for (const n of notes) for (const l of wrap(n, 10, PAGE[0] - 2 * M)) { if (y < M + 30) newPage(); text(l, M, y); y -= 14; }
  if (q.draft) {
    y -= 8;
    for (const l of wrap(fill(t.draftNote, { agent }), 9, PAGE[0] - 2 * M)) { if (y < M + 30) newPage(); text(l, M, y, { size: 9, color: MUTED }); y -= 12; }
  }

  // ---------- footer on every page ----------
  const pages = doc.getPages();
  pages.forEach((p, i) => {
    page = p;
    const left = [b.name, b.taxId && `${t.taxId} ${b.taxId}`].filter(Boolean).join("  ·  ");
    if (left) text(left, M, M - 24, { size: 8, color: MUTED });
    text(fill(t.page, { n: i + 1, of: pages.length }), right, M - 24, { size: 8, color: MUTED, right: true });
  });
  return doc.save();
}
