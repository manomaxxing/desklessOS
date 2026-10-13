// Is every locale pack complete? The reference is the default pack: every key
// it has (lexicon lists, persona lines, examples, document text) must exist in
// every other enabled pack, with the same type. Extra keys are fine.

const REQUIRED_TOP = ["id", "name", "bcp47", "status", "countryCodes", "voices", "lexicon", "personas"];
const REQUIRED_PERSONA = ["greeting", "outboundGreeting", "wrapUp", "backchannel", "fillers", "oops", "working", "looking"];

function missingKeys(ref, pack, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(ref ?? {})) {
    const here = pack?.[k];
    const name = `${prefix}${k}`;
    if (here === undefined || here === null || here === "") { if (v !== "" && !(Array.isArray(v) && !v.length)) out.push(name); continue; }
    if (Array.isArray(v) !== Array.isArray(here) || typeof v !== typeof here) { out.push(`${name} (type)`); continue; }
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...missingKeys(v, here, `${name}.`));
  }
  return out;
}

/** Problems per pack id, e.g. { en: ["personas.notebook.examples.probes"] }; empty when all is well. */
export function checkLocales(locales) {
  const ref = locales.get(locales.defaultId);
  const problems = {};
  for (const id of locales.enabled()) {
    const pack = locales.get(id);
    const list = REQUIRED_TOP.filter(k => pack[k] === undefined).map(k => `missing ${k}`);
    for (const [name, persona] of Object.entries(pack.personas ?? {})) {
      for (const k of REQUIRED_PERSONA) if (!persona?.[k]?.length) list.push(`personas.${name}.${k}`);
    }
    if (!pack.voices?.fish) list.push("voices.fish (or set FISH_VOICE_" + id.toUpperCase() + ")");
    if (id !== ref.id) {
      list.push(...missingKeys(ref.lexicon, pack.lexicon, "lexicon.").filter(k => k !== "lexicon.letters"));
      list.push(...missingKeys(ref.personas, pack.personas, "personas."));
      list.push(...missingKeys(ref.documents, pack.documents, "documents."));
    }
    if (list.length) problems[id] = list;
  }
  return problems;
}
