// The quote as an A4 PDF (pdf-lib, the PDF standard fonts: nothing to download, no browser).
// Texts come from the locale pack (documents.quote), number and date formats from its
// numberLocale, so a new language is a pack, not code. Characters the standard fonts can't
// draw (e.g. "ł") lose their accent, or become "?".

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { PDFFont, PDFPage, RGB } from "pdf-lib";
import { locales as sharedLocales } from "../locale/index.ts";
import type { Locales } from "../agenda/primitives.ts";
import type { QuoteData } from "../types/quote.ts";

const PAGE: [number, number] = [595.28, 841.89];
const M = 56; // margin
const INK = rgb(0.11, 0.11, 0.12), MUTED = rgb(0.43, 0.43, 0.45), LINE = rgb(0.85, 0.85, 0.87), BAND = rgb(0.95, 0.95, 0.96);
const fill = (s: string | undefined, v: Record<string, string | number | undefined>) => String(s ?? "").replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ""));

/** A quote's texts in one language (locale pack: documents.quote); a missing line prints as nothing. */
type QuoteTexts = Partial<Record<string, string>>;

/** The texts and formats for a quote's language. */
function wording(q: QuoteData, L: Locales) {
  const t: QuoteTexts | null = L.document(q.lang, "quote");
  if (!t) throw new Error(`no quote texts for "${q.lang}" (documents.quote in its locale pack)`);
  const nl: string = L.get(q.lang).format?.numberLocale ?? L.bcp47(q.lang);
  return {
    t,
    money: (n: number) => new Intl.NumberFormat(nl, { style: "currency", currency: q.currency }).format(n),
    qty: (n: number) => new Intl.NumberFormat(nl, { maximumFractionDigits: 2 }).format(n),
    date: (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(nl, { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" }),
    rate: (n: number) => new Intl.NumberFormat(nl, { maximumFractionDigits: 2 }).format(n),
  };
}

const title = (q: QuoteData, t: QuoteTexts) => (q.draft ? t.draftTitle : t.title);
const UMLAUTS: Record<string, string> = { ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss" };

/** "Angebot-2026-001-Huber.pdf" */
export function quoteFileName(q: QuoteData, L: Locales = sharedLocales()): string {
  const { t } = wording(q, L);
  const ascii = (s: unknown) => String(s ?? "").replace(/[äöüÄÖÜß]/g, c => UMLAUTS[c] ?? c).normalize("NFKD").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
  const who = ascii(q.customer?.name).slice(0, 30);
  return `${ascii(t.fileName) || "quote"}-${q.number}${who ? `-${who}` : ""}.pdf`;
}

/** The line under the document in the chat. */
export function quoteCaption(q: QuoteData, L: Locales = sharedLocales()): string {
  const { t } = wording(q, L);
  return fill(q.customer?.name ? t.caption : t.captionNoCustomer, { title: title(q, t), number: q.number, customer: q.customer?.name ?? "" });
}

/** renderQuotePdf(quote) → the PDF's bytes. `agent`: the assistant's name in a draft's note. */
export async function renderQuotePdf(q: QuoteData, { agent = "Toni", L = sharedLocales() }: { agent?: string; L?: Locales } = {}): Promise<Uint8Array> {
  const { t, money, qty, date, rate } = wording(q, L);
  const doc = await PDFDocument.create();
  doc.setTitle(`${title(q, t)} ${q.number}`);
  doc.setCreator("DesklessOS");
  doc.setProducer("DesklessOS");
  doc.setLanguage(L.bcp47(q.lang));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const charset = new Set(font.getCharacterSet());
  const drawable = (ch: string) => charset.has(ch.codePointAt(0) ?? -1);
  const safe = (s: unknown) => [...String(s ?? "")].map(ch => {
    if (drawable(ch)) return ch;
    const plain = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    return plain && [...plain].every(drawable) ? plain : "?";
  }).join("");
  const width = (s: string, size: number, f: PDFFont = font) => f.widthOfTextAtSize(safe(s), size);
  // Lines of at most `w` points; a word longer than a line is cut.
  const wrap = (s: unknown, size: number, w: number, f: PDFFont = font) => {
    const out: string[] = [];
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

  let page: PDFPage = doc.addPage(PAGE);
  let y = PAGE[1] - M;
  const text = (s: unknown, x: number, yy: number, { size = 10, f = font, color = INK, right = false }: { size?: number; f?: PDFFont; color?: RGB; right?: boolean } = {}) => {
    const str = safe(s);
    page.drawText(str, { x: right ? x - f.widthOfTextAtSize(str, size) : x, y: yy, size, font: f, color });
  };
  const rule = (yy: number, color = LINE) => page.drawLine({ start: { x: M, y: yy }, end: { x: PAGE[0] - M, y: yy }, thickness: 0.7, color });
  const newPage = () => { page = doc.addPage(PAGE); y = PAGE[1] - M; };

  // ---------- header: the business (left), the document (right) ----------
  const b: Partial<QuoteData["business"]> = q.business ?? {};
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
  const notes: (string | undefined)[] = [];
  const { net, vat, gross } = q;
  if (net !== null && vat !== null && gross !== null) { // all three, or none (src/quotes/quote.ts)
    if (y < M + 110) newPage();
    y -= 10;
    const row = (k: string | undefined, v: string, f = font) => { text(k, col.unit - 70, y, { f, right: true }); text(v, col.total, y, { f, right: true }); y -= 16; };
    row(t.net, money(net));
    if (q.vatRate > 0) row(fill(t.vat, { rate: rate(q.vatRate) }), money(vat));
    y -= 2;
    page.drawLine({ start: { x: col.unit - 150, y: y + 12 }, end: { x: right, y: y + 12 }, thickness: 0.7, color: INK });
    row(t.gross, money(gross), bold);
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
