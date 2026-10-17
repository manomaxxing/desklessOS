// His lists (users.profile.lists, set on his People card), so a quote comes out complete:
//   jobs    what Toni asks per kind of job (his site-measure list), with his price where he has one
//   site    what makes a site harder; all of it unfavourable = his maximum factor (e.g. 1.8)
//   levels  his quality levels, a factor each (Standard 1, Hochwertig 1.25, …)
// In the call Toni goes through what's still open (the checklist primitive, src/agenda/primitives.ts);
// in the quote a line priced from his list costs his price × quality factor × site factor,
// computed here, never by the model. A price he says in the call is taken as it is.
// Text in, the way he'd write it, so Max can paste what he sends:
//   jobs:    "# Badumbau" starts a list; then one item per line:
//            "Bodenfläche | m² | 65" (asked and priced), "Lochbohrungen | Stück" (asked, priced later),
//            "Format Fliesen Boden" (just asked), "Restliche Wände: Putz, glatt oder Pandomo" (asked as
//            "Restliche Wände"; the choices after the colon only to recognise his answer, or after his yes)
//   site:    "Parkplatz | kein Parkplatz am Haus" (the question | when it counts as unfavourable);
//            a line without "|" is just asked ("Adresse")
//   levels:  "Hochwertig | 1,25"

import { isRecord } from "../shared/is-record.ts";
import { roundedTimes } from "./quote.ts";
import type { HttpError } from "../types/common.ts";
import type { Schema } from "../types/gemini.ts";
import type { Note, ListAnswer } from "../types/note.ts";
import type { ListsText } from "../types/user.ts";
import type { Fields } from "../agenda/primitives.ts";
import type { QuoteCalc } from "../types/quote.ts";

/** One item of a job list: what Toni asks (`label`, the choices aside), and his price if it has one. */
export interface ListItem {
  ask: string;
  label: string;
  choices: string;
  unit: string;
  price: number | null;
}
export interface JobList {
  name: string;
  items: ListItem[];
}
/** A site question; `bad`: when his answer counts as unfavourable ("" = just asked). */
export interface SiteLine {
  ask: string;
  bad: string;
}
export interface Level {
  name: string;
  factor: number | null;
}
/** His lists, parsed. `errors` name the lines that don't work (empty for lists saved through listsIn). */
export interface Lists {
  jobs: JobList[];
  site: SiteLine[];
  siteMax: number | null;
  levels: Level[];
  errors: string[];
}
/** The texts as they come in (People card, a users row): anything, cleaned here. */
export type ListsInput = Partial<Record<keyof ListsText, unknown>>;

const LIMITS = { text: 6000, lists: 12, items: 30, site: 12, levels: 8 };
const clean = (v: unknown, max = 120) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const bad = (msg: string, status = 400): HttpError => Object.assign(new Error(msg), { status });

/** "65", "65,50", "1.234,50 €", "1,8", "1.200" → a number; null if it isn't one. */
export function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null; // already one (the model's NUMBER)
  let s = String(v ?? "").replace(/[^\d,.-]/g, "");
  if (!s) return null;
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  // One kind of separator, each followed by exactly three digits: thousands ("1.200", "1,200", "12.500.000"),
  // not 1.2. "1,5", "58,50", "0,850" stay decimals.
  else if (/^-?[1-9]\d{0,2}([.,])\d{3}(?:\1\d{3})*$/.test(s)) s = s.replace(/[.,]/g, "");
  else s = s.replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// "Restliche Wände: Putz, glatt oder Pandomo" → what to ask ("Restliche Wände") and the choices.
const labelled = (ask: string) => {
  const i = ask.indexOf(":");
  return i > 0 && clean(ask.slice(i + 1)) ? { label: clean(ask.slice(0, i)), choices: clean(ask.slice(i + 1)) } : { label: ask, choices: "" };
};
const rows = (text: unknown) => String(text ?? "").split(/\r?\n/).map((raw, i) => ({ n: i + 1, raw: raw.trim() })).filter(r => r.raw && !r.raw.startsWith("//"));
const cells = (raw: string) => raw.split("|").map(c => clean(c));

/**
 * parseLists({ jobs, site, siteMax, levels }) → { jobs: [{ name, items: [{ ask, label, choices, unit, price }] }],
 * site: [{ ask, bad }], siteMax, levels: [{ name, factor }], errors: ["jobs line 3: …"] }.
 * Empty input: empty lists. Never throws; `listsIn` turns errors into a 400.
 */
export function parseLists(input: ListsInput | null | undefined = {}): Lists {
  const src = input ?? {};
  const errors: string[] = [];
  const jobs: JobList[] = [];
  for (const { n, raw } of rows(src.jobs)) {
    if (raw.startsWith("#")) {
      const name = clean(raw.replace(/^#+/, ""), 60);
      if (!name) { errors.push(`jobs line ${n}: a name after #, e.g. "# Badumbau"`); continue; }
      jobs.push({ name, items: [] });
      continue;
    }
    const job = jobs.at(-1);
    if (!job) { errors.push(`jobs line ${n}: start with "# " and the kind of job, e.g. "# Badumbau"`); continue; }
    const [ask = "", unit = "", priceText = ""] = cells(raw);
    if (!ask) { errors.push(`jobs line ${n}: what Toni should ask comes first`); continue; }
    const price = priceText ? parseNumber(priceText) : null;
    if (priceText && (price === null || price < 0)) { errors.push(`jobs line ${n}: "${priceText}" isn't a price`); continue; }
    job.items.push({ ask, ...labelled(ask), unit: clean(unit, 20), price });
  }
  for (const j of jobs) if (!j.items.length) errors.push(`jobs: "${j.name}" has no items`);
  if (jobs.length > LIMITS.lists) errors.push(`jobs: at most ${LIMITS.lists} lists`);
  for (const j of jobs) if (j.items.length > LIMITS.items) errors.push(`jobs: "${j.name}" has more than ${LIMITS.items} items`);

  const site = rows(src.site).map(({ raw }) => { const [ask = "", badWhen = ""] = cells(raw); return { ask, bad: badWhen }; }).filter(s => s.ask);
  if (site.length > LIMITS.site) errors.push(`site: at most ${LIMITS.site} lines`);
  const maxText = clean(src.siteMax, 10);
  const siteMax = maxText ? parseNumber(maxText) : null;
  if (maxText && !(siteMax !== null && siteMax >= 1 && siteMax <= 3)) errors.push(`site: the factor when everything is unfavourable is a number from 1 to 3, e.g. 1.8 (not "${maxText}")`);
  if (siteMax !== null && siteMax > 1 && !site.some(s => s.bad)) errors.push('site: a factor needs at least one line that says when it counts, e.g. "Parkplatz | kein Parkplatz am Haus"');

  const levels: Level[] = [];
  for (const { n, raw } of rows(src.levels)) {
    const [name = "", factorText = ""] = cells(raw);
    const factor = factorText ? parseNumber(factorText) : null;
    if (factorText && !(factor !== null && factor >= 0.3 && factor <= 5)) { errors.push(`levels line ${n}: "${factorText}" isn't a factor (e.g. 1,25)`); continue; }
    if (name) levels.push({ name: clean(name, 40), factor });
  }
  if (levels.length > LIMITS.levels) errors.push(`levels: at most ${LIMITS.levels}`);
  return { jobs, site, siteMax, levels, errors };
}

/** For the users row: the texts as he wrote them; a 400 naming the lines that don't work. */
export function listsIn(input: ListsInput | null | undefined = {}): Required<ListsText> {
  const text = (k: "jobs" | "site" | "levels") => String(input?.[k] ?? "").replace(/\r/g, "").trim();
  const texts = { jobs: text("jobs"), site: text("site"), levels: text("levels") };
  for (const [k, v] of Object.entries(texts)) if (v.length > LIMITS.text) throw bad(`${k}: at most ${LIMITS.text} characters`);
  const parsed = parseLists({ ...texts, siteMax: input?.siteMax });
  if (parsed.errors.length) throw bad(`Lists: ${parsed.errors.slice(0, 3).join("; ")}`);
  return { ...texts, siteMax: parsed.siteMax };
}

/** Anything for Toni to go through? */
export const hasLists = (l: Lists | null | undefined): l is Lists => Boolean(l && (l.jobs?.length || l.site?.length || l.levels?.length));

// ---------- in the call ----------

const answered = (list: readonly ListAnswer[] | undefined, ask: string) => (Array.isArray(list) ? list : []).some(a => isRecord(a) && a.item === ask && clean(a.answer));

/** What's still open, for THIS CALL: the job's list (once it's known), the site, the quality level. "" when nothing. */
export function openOnLists(l: Lists | null | undefined, note: Note | null | undefined = {}): string {
  if (!hasLists(l) || note?.lists_done) return "";
  const job = l.jobs.find(j => j.name === note?.job_list);
  const parts: string[] = [];
  if (job) {
    const open = job.items.filter(i => !answered(note?.checklist, i.ask)).map(i => i.label);
    if (open.length) parts.push(`${job.name} list: ${open.join(", ")}`);
  }
  // The site and the quality level only for a job on his lists (or when he has no job lists at all).
  if (job || !l.jobs.length) {
    const site = l.site.filter(s => !answered(note?.site, s.ask)).map(s => s.ask);
    if (site.length) parts.push(`the site: ${site.join(", ")}`);
    if (l.levels.length && !l.levels.some(x => x.name === note?.quality)) parts.push("the quality level");
  }
  return parts.join("; ");
}

/** His lists for the prompt (per call): the items, the site, the levels. The how is the template's (checklist step). */
export function listsContext(l: Lists | null | undefined): string {
  if (!hasLists(l)) return "";
  const item = (i: ListItem) => `${i.label}${i.unit ? ` (${i.unit})` : ""}${i.choices ? ` [choices, to recognise his answer: ${i.choices}]` : ""}`;
  return [
    "HIS LISTS:",
    ...l.jobs.map(j => `- ${j.name}: ${j.items.map(item).join("; ")}`),
    l.site.length ? `- The site, for every job on his lists: ${l.site.map(x => x.ask).join("; ")}` : "",
    l.levels.length ? `- Quality levels, for every job on his lists (to recognise his answer; read them out only after his yes): ${l.levels.map(x => x.name).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

const enumOf = (values: string[]): Schema => ({ type: "STRING", enum: [...new Set(values)] });
// Gemini's schemas take no "" in an enum: "none" stands for "not said yet" and is "" again in the note.
const NONE = "none";

/** The extraction's "none" back to "", so the note reads as he said it. */
export function listFieldsIn(note: Note): Note {
  if (!note || typeof note !== "object") return note;
  const out = { ...note };
  if (out.job_list === NONE) out.job_list = "";
  if (out.quality === NONE) out.quality = "";
  return out;
}

/** Note fields for the extraction (added to his note's schema when he has lists). */
export function listsSchema(l: Lists | null | undefined): Fields | null {
  if (!hasLists(l)) return null;
  const properties: Record<string, Schema> = {};
  const required: string[] = [];
  if (l.jobs.length) {
    properties.job_list = enumOf([...l.jobs.map(j => j.name), NONE]);
    properties.checklist = { type: "ARRAY", items: { type: "OBJECT", properties: { item: enumOf(l.jobs.flatMap(j => j.items.map(i => i.ask))), answer: { type: "STRING" } }, required: ["item", "answer"] } };
    required.push("job_list", "checklist");
  }
  if (l.site.length) {
    properties.site = { type: "ARRAY", items: { type: "OBJECT", properties: { item: enumOf(l.site.map(s => s.ask)), answer: { type: "STRING" }, unfavourable: { type: "BOOLEAN" } }, required: ["item", "answer", "unfavourable"] } };
    required.push("site");
  }
  if (l.levels.length) { properties.quality = enumOf([...l.levels.map(x => x.name), NONE]); required.push("quality"); }
  properties.lists_done = { type: "BOOLEAN" };
  required.push("lists_done");
  return { properties, required };
}

/** Extraction rules for those fields. */
export function listsRules(l: Lists | null | undefined): string[] {
  if (!hasLists(l)) return [];
  return [
    l.jobs.length ? `- job_list: which of his lists the job he talks about is (${l.jobs.map(j => `"${j.name}"`).join(", ")}), "${NONE}" if none or not clear yet.` : "",
    l.jobs.length ? `- checklist: per item of that list he gave an answer to (also before being asked): item = the list's item exactly, answer = his answer, short, numbers and units exactly as he said them ("doesn't know yet" and "skip" count as answers).` : "",
    l.site.length ? `- site: per site item he answered (${l.site.map(s => (s.bad ? `"${s.ask}", unfavourable when: ${s.bad}` : `"${s.ask}"`)).join("; ")}): answer as he said it; unfavourable = true only if his answer meets that condition.` : "",
    l.levels.length ? `- quality: the quality level he chose (${l.levels.map(x => `"${x.name}"`).join(", ")}), "${NONE}" if not said.` : "",
    "- lists_done: true once he doesn't want to go through the rest of his lists (no time, enough), else false.",
  ].filter(Boolean);
}

// ---------- in the quote ----------

/** The site factor: 1 + (max − 1) × unfavourable / counted. Only lines with a condition count. */
export function siteFactor(l: Lists | null | undefined, unfavourable: readonly unknown[] = []): QuoteCalc["site"] {
  const counted = (l?.site ?? []).filter(s => s.bad);
  const max = l?.siteMax ?? 1;
  if (!(max > 1) || !counted.length) return { factor: 1, unfavourable: [] };
  const hit = counted.filter(s => unfavourable.includes(s.ask)).map(s => s.ask);
  return { factor: Math.round((1 + ((max - 1) * hit.length) / counted.length) * 1000) / 1000, unfavourable: hit };
}

/** The items his list prices (name → item); the first list that prices it wins. */
const pricedItems = (l: Lists | null | undefined) => new Map((l?.jobs ?? []).flatMap(j => j.items).filter(i => i.price !== null).reverse().map(i => [i.ask, i]));

/** Tool parameters quote_send gets when he has lists: which list item prices a line, the quality level, the unfavourable site items. */
export function quoteParams(l: Lists | null | undefined): { item: Record<string, Schema>; top: Record<string, Schema> } {
  const priced = [...pricedItems(l).keys()];
  return {
    item: priced.length ? { list_item: { ...enumOf(priced), description: "the item on his list this line is priced from, if it is one; then leave unit_price out (his list has the price)" } } : {},
    top: {
      ...(l?.levels.length ? { quality_level: { ...enumOf(l.levels.map(x => x.name)), description: "the quality level he chose, if he chose one" } } : {}),
      ...(l?.site.some(s => s.bad) ? { site_unfavourable: { type: "ARRAY", items: enumOf(l.site.filter(s => s.bad).map(s => s.ask)), description: "the site items whose answer was unfavourable" } } : {}),
    },
  };
}

/**
 * priceFromLists(items, lists, { quality_level, site_unfavourable }) → { items, calc }:
 * a line with a list_item and no price of his own gets his list price × quality × site factor
 * (and the list's unit if it has none). calc says how, for the dashboard; null without lists.
 * Items are the model's, as they came (src/quotes/quote.ts cleans them); anything not an object
 * is left out here (it would have no description there either).
 */
export function priceFromLists(items: unknown = [], l: Lists | null | undefined, { quality_level: qualityName = "", site_unfavourable: unfav = [] }: { quality_level?: unknown; site_unfavourable?: unknown } = {}): { items: Record<string, unknown>[]; calc: QuoteCalc | null } {
  const given = (Array.isArray(items) ? items : []).filter(isRecord);
  if (!hasLists(l)) return { items: given, calc: null };
  const level = l.levels.find(x => x.name === qualityName) ?? null;
  const site = siteFactor(l, Array.isArray(unfav) ? unfav : []);
  const factor = (level?.factor ?? 1) * site.factor;
  const priced = pricedItems(l);
  let fromList = 0;
  const out = given.map(i => {
    const own = parseNumber(i.unit_price ?? i.unitPrice);
    const li = typeof i.list_item === "string" ? priced.get(i.list_item) : undefined;
    if (own !== null || !li || li.price === null) return i;
    fromList++;
    // In cents, exactly: 0.35 × 1.5 is 0.53, not the float product's 0.52.
    return { ...i, unit: clean(i.unit) || li.unit, unit_price: roundedTimes(roundedTimes(100, li.price), Math.round(factor * 1e6) / 1e6) / 100 };
  });
  return { items: out, calc: { quality: level ? { name: level.name, factor: level.factor ?? 1 } : null, site, factor: Math.round(factor * 1000) / 1000, fromList } };
}
