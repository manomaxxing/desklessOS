// A quote as data: line items as he said them in the call, totals computed here (in
// cents), never by the model. The business behind it (his name, address, VAT) comes from
// his People card (users.profile.business); without a business name it's a draft
// ("Angebotsentwurf"). Language and number formats are the PDF's (src/quotes/pdf.mjs).

import { localParts } from "../jobs/windows.mjs";

const DEFAULTS = { currency: "EUR", vatRate: 19, validDays: 30 }; // the business's own settings override these
const cents = n => Math.round(Number(n) * 100);
const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const text = (v, max = 300) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The business settings a quote uses, with the defaults filled in. */
export function businessOf(profile = {}) {
  const b = profile?.business ?? {};
  return {
    name: text(b.name, 120), address: text(b.address, 200), phone: text(b.phone, 60), email: text(b.email, 120), taxId: text(b.taxId, 60),
    currency: /^[A-Z]{3}$/.test(b.currency ?? "") ? b.currency : DEFAULTS.currency,
    vatRate: num(b.vatRate) !== null && num(b.vatRate) >= 0 && num(b.vatRate) <= 50 ? num(b.vatRate) : DEFAULTS.vatRate,
    validDays: num(b.validDays) > 0 ? Math.round(num(b.validDays)) : DEFAULTS.validDays,
  };
}

/** The tool's arguments, cleaned: at most 40 items, numbers as numbers, nothing invented. */
export function cleanItems(items = []) {
  return (Array.isArray(items) ? items : []).slice(0, 40).map(i => {
    const unitPrice = num(i?.unit_price ?? i?.unitPrice);
    let quantity = num(i?.quantity);
    if (quantity !== null && quantity <= 0) quantity = null;
    if (quantity === null && unitPrice !== null) quantity = 1; // a lump sum: "pauschal 2.500"
    return { description: text(i?.description), quantity, unit: text(i?.unit, 30), unitPrice: unitPrice !== null && unitPrice >= 0 ? unitPrice : null };
  }).filter(i => i.description);
}

const plusDays = (iso, n) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * buildQuote({ number, items, customer, business, lang, now, timeZone, calc }) → the quote's data,
 * all a PDF needs: items with their totals, net, VAT, gross; `complete` when every item has a price.
 * calc: how list prices were worked out (src/quotes/lists.mjs), kept for the dashboard; its
 * quality level goes on the PDF, the site factor doesn't (it's in the prices).
 */
export function buildQuote({ number, items, customer = {}, business = businessOf(), lang, now = new Date(), timeZone = "Europe/Berlin", calc = null }) {
  const lines = cleanItems(items).map((i, n) => ({ pos: n + 1, ...i, total: i.unitPrice !== null && i.quantity !== null ? cents(i.unitPrice * i.quantity) / 100 : null }));
  if (!lines.length) throw Object.assign(new Error("no line items"), { status: 400 });
  const netCents = lines.reduce((s, l) => s + (l.total === null ? 0 : cents(l.total)), 0);
  const priced = lines.some(l => l.total !== null);
  const vatCents = Math.round((netCents * business.vatRate) / 100);
  const date = localParts(now, timeZone).date;
  return {
    number, lang, date, validUntil: plusDays(date, business.validDays), currency: business.currency, vatRate: business.vatRate,
    draft: !business.name,
    business,
    customer: { name: text(customer.name, 120), address: text(customer.address, 200) },
    items: lines,
    net: priced ? netCents / 100 : null,
    vat: priced ? vatCents / 100 : null,
    gross: priced ? (netCents + vatCents) / 100 : null,
    complete: lines.every(l => l.total !== null),
    quality: calc?.quality?.name ?? "",
    ...(calc ? { calc } : {}),
  };
}
