// A quote as data: line items as he said them in the call, totals computed here (in
// cents), never by the model. The business behind it (his name, address, VAT) comes from
// his People card (users.profile.business); without a business name it's a draft
// ("Angebotsentwurf"). Language and number formats are the PDF's (src/quotes/pdf.ts).

import { localParts } from "../jobs/windows.ts";
import { isRecord } from "../shared/is-record.ts";
import type { HttpError, LangId } from "../types/common.ts";
import type { Profile } from "../types/user.ts";
import type { QuoteCalc, QuoteData, QuoteLine } from "../types/quote.ts";

export type QuoteBusiness = QuoteData["business"];
/** A line as cleaned from the tool's arguments, before its total. */
export type CleanItem = Omit<QuoteLine, "pos" | "total">;

const DEFAULTS = { currency: "EUR", vatRate: 19, validDays: 30 }; // the business's own settings override these

/**
 * a × b rounded to a whole number, exactly when b has up to 6 decimal places (a quantity, a price, a
 * factor): b is taken as the decimal it reads as, so 1999 × 32.5 is 64967.5 → 64968, where the float
 * product is 64967.4999… → 64967. Money here is whole cents: cents × quantity, 100 × euros.
 */
export function roundedTimes(a: number, b: number): number {
  const m = /^-?\d+(?:\.(\d{1,6}))?$/.exec(String(b));
  if (!m) return Math.round(a * b); // finer than any price or quantity (or 1e21): the float product
  const scale = 10 ** (m[1]?.length ?? 0);
  return Math.round((a * Math.round(b * scale)) / scale);
}
const cents = (euros: number) => roundedTimes(100, euros);
const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const text = (v: unknown, max = 300) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const bad = (msg: string): HttpError => Object.assign(new Error(msg), { status: 400 });

/** The business settings a quote uses, with the defaults filled in. */
export function businessOf(profile: Pick<Profile, "business"> | null | undefined = {}): QuoteBusiness {
  const b = profile?.business ?? {};
  const currency = b.currency ?? "";
  const vatRate = num(b.vatRate);
  const validDays = num(b.validDays);
  return {
    name: text(b.name, 120), address: text(b.address, 200), phone: text(b.phone, 60), email: text(b.email, 120), taxId: text(b.taxId, 60),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : DEFAULTS.currency,
    vatRate: vatRate !== null && vatRate >= 0 && vatRate <= 50 ? vatRate : DEFAULTS.vatRate,
    validDays: validDays !== null && validDays > 0 ? Math.round(validDays) : DEFAULTS.validDays,
  };
}

/**
 * The tool's arguments, cleaned: at most 40 items, numbers as numbers, nothing invented. A price
 * without any quantity is a lump sum (1 × the price); a quantity of 0 or less is no quantity, so
 * that line stays unpriced rather than becoming 1 × the price. Unit prices in whole cents.
 */
export function cleanItems(items: unknown = []): CleanItem[] {
  return (Array.isArray(items) ? items : []).slice(0, 40).map((raw: unknown) => {
    const i = isRecord(raw) ? raw : {};
    const price = num(i.unit_price ?? i.unitPrice);
    const unitPrice = price !== null && price >= 0 ? cents(price) / 100 : null;
    const given = num(i.quantity);
    const quantity = given === null ? (unitPrice !== null ? 1 : null) : given > 0 ? given : null; // 1: a lump sum, "pauschal 2.500"
    return { description: text(i.description), quantity, unit: text(i.unit, 30), unitPrice };
  }).filter(i => i.description);
}

const plusDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export interface BuildQuoteInput {
  number: string;
  /** The tool's line items, as they came (cleaned here). */
  items: unknown;
  customer?: { name?: unknown; address?: unknown };
  business?: QuoteBusiness;
  lang: LangId;
  now?: Date;
  timeZone?: string;
  calc?: QuoteCalc | null;
}

/**
 * buildQuote({ number, items, customer, business, lang, now, timeZone, calc }) → the quote's data,
 * all a PDF needs: items with their totals, net, VAT, gross; `complete` when every item has a price.
 * calc: how list prices were worked out (src/quotes/lists.ts), kept for the dashboard; its
 * quality level goes on the PDF, the site factor doesn't (it's in the prices).
 * Throws a 400 for no items, or totals too large to be a price.
 */
export function buildQuote({ number, items, customer = {}, business = businessOf(), lang, now = new Date(), timeZone = "Europe/Berlin", calc = null }: BuildQuoteInput): QuoteData {
  const lines: (QuoteLine & { cents: number | null })[] = cleanItems(items).map((i, n) => {
    // In cents, from the price in cents: 32.5 × 19.99 is 649.68, not the float product's 649.67.
    const c = i.unitPrice !== null && i.quantity !== null ? roundedTimes(cents(i.unitPrice), i.quantity) : null;
    return { pos: n + 1, ...i, cents: c, total: c === null ? null : c / 100 };
  });
  if (!lines.length) throw bad("no line items");
  const netCents = lines.reduce((s, l) => s + (l.cents ?? 0), 0);
  const priced = lines.some(l => l.total !== null);
  const vatCents = Math.round((netCents * business.vatRate) / 100);
  // Too large to add up exactly (or past Infinity): a mistake, not a quote; never "∞" on the PDF.
  if (![...lines.map(l => l.cents ?? 0), netCents + vatCents].every(Number.isSafeInteger)) throw bad("the amounts are too large for a quote");
  const date = localParts(now, timeZone).date;
  return {
    number, lang, date, validUntil: plusDays(date, business.validDays), currency: business.currency, vatRate: business.vatRate,
    draft: !business.name,
    business,
    customer: { name: text(customer.name, 120), address: text(customer.address, 200) },
    items: lines.map(({ cents: _, ...l }) => l),
    net: priced ? netCents / 100 : null,
    vat: priced ? vatCents / 100 : null,
    gross: priced ? (netCents + vatCents) / 100 : null,
    complete: lines.every(l => l.total !== null),
    quality: calc?.quality?.name ?? "",
    ...(calc ? { calc } : {}),
  };
}
