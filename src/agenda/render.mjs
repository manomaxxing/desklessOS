// Fills {{slots}} in persona and template text from a context object.
//   {{path}}         the value; a list is joined with ", "
//   {{q path}}       "value" in quotes
//   {{qs path}}      "a", "b", "c"
//   {{qq path}}      "a" "b" "c"
//   {{alts path}}    "a" / "b"   (a trailing "?" dropped: read-backs in several languages)
//   {{upper path}}   VALUE
// Paths are dotted ("ex.confirm", "profile.place"). A path that isn't there is an
// error, so a template can't silently lose a line in one language.

const SLOT = /\{\{\s*(?:(q|qs|qq|alts|upper)\s+)?([\w.]+)\s*\}\}/g;

const quote = s => `"${s}"`;
const FILTERS = {
  raw: v => (Array.isArray(v) ? v.join(", ") : String(v)),
  q: v => quote(v),
  qs: v => [].concat(v).map(quote).join(", "),
  qq: v => [].concat(v).map(quote).join(" "),
  alts: v => [].concat(v).map(s => quote(String(s).replace(/\?$/, ""))).join(" / "),
  upper: v => String(v).toUpperCase(),
};

export function lookup(ctx, path) {
  let v = ctx;
  for (const key of path.split(".")) {
    if (v == null || !(key in Object(v))) return undefined;
    v = v[key];
  }
  return v;
}

/** Renders `text` (a string or a list of lines). `where` names the source in errors. */
export function render(text, ctx, where = "template") {
  const src = Array.isArray(text) ? text.join("\n") : String(text ?? "");
  return src.replace(SLOT, (_, filter = "raw", path) => {
    const v = lookup(ctx, path);
    if (v === undefined || v === null) throw new Error(`${where}: no value for {{${filter === "raw" ? "" : filter + " "}${path}}}`);
    return FILTERS[filter](v);
  });
}

/** The slot paths a text uses (for checks). */
export const slots = text => [...String(Array.isArray(text) ? text.join("\n") : text ?? "").matchAll(SLOT)].map(m => m[2]);
