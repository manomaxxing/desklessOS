// Fills {{slots}} in persona and template text from a context object.
//   {{path}}         the value; a list is joined with ", "
//   {{q path}}       "value" in quotes
//   {{qs path}}      "a", "b", "c"
//   {{qq path}}      "a" "b" "c"
//   {{alts path}}    "a" / "b"   (a trailing "?" dropped: read-backs in several languages)
//   {{upper path}}   VALUE
// Paths are dotted ("ex.confirm", "profile.place"). A path that isn't there is an
// error, so a template can't silently lose a line in one language.

/** Template text: one string, or a list of lines. */
export type Text = string | readonly string[] | null | undefined;
type Filter = "raw" | "q" | "qs" | "qq" | "alts" | "upper";

const SLOT = /\{\{\s*(?:(q|qs|qq|alts|upper)\s+)?([\w.]+)\s*\}\}/g;

const quote = (s: unknown) => `"${s}"`;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);
const FILTERS: Record<Filter, (v: unknown) => string> = {
  raw: v => (Array.isArray(v) ? v.join(", ") : String(v)),
  q: v => quote(v),
  qs: v => list(v).map(quote).join(", "),
  qq: v => list(v).map(quote).join(" "),
  alts: v => list(v).map(s => quote(String(s).replace(/\?$/, ""))).join(" / "),
  upper: v => String(v).toUpperCase(),
};
const isFilter = (f: string): f is Filter => f in FILTERS;

export function lookup(ctx: unknown, path: string): unknown {
  let v = ctx;
  for (const key of path.split(".")) {
    if (v == null) return undefined;
    const o: Record<string, unknown> = Object(v); // a string's length is a path too, as before
    if (!(key in o)) return undefined;
    v = o[key];
  }
  return v;
}

const joined = (text: Text): string => (typeof text === "string" || text == null ? String(text ?? "") : text.join("\n"));

/** Renders `text` (a string or a list of lines). `where` names the source in errors. */
export function render(text: Text, ctx: object, where = "template"): string {
  return joined(text).replace(SLOT, (_, filter: string | undefined, path: string) => {
    const f = filter && isFilter(filter) ? filter : "raw";
    const v = lookup(ctx, path);
    if (v === undefined || v === null) throw new Error(`${where}: no value for {{${f === "raw" ? "" : f + " "}${path}}}`);
    return FILTERS[f](v);
  });
}

/** The slot paths a text uses (for checks). */
export const slots = (text: Text): string[] => [...joined(text).matchAll(SLOT)].map(m => m[2]);
