// A deployment's skill, built from a persona (personas/<id>.md) and templates
// (templates/*.json): SKILL=pilot runs the notebook persona, SKILL=office the
// office persona. Each call gets its own agenda (src/agenda/agenda.mjs): the
// persona's capabilities, plus the objectives for this call (Max's questions
// from the objectives store first, then standing ones like the pilot's research).

import { readFileSync } from "node:fs";
import { loadPersona, loadTemplates } from "../agenda/templates.mjs";
import { createAgenda } from "../agenda/agenda.mjs";
import { primitives } from "../agenda/primitives.mjs";
import { render } from "../agenda/render.mjs";
import { loadFramework } from "../store/discovery.mjs";
import { locales as sharedLocales, promptWeekday } from "../locale/index.mjs";

const PERSONA_OF = { pilot: "notebook", office: "office", admin: "admin" };
const MAX_OBJECTIVES = 2; // the agent's own items per call, always after his business
const config = name => JSON.parse(readFileSync(new URL(`../../config/${name}.json`, import.meta.url), "utf8"));
const S = { type: "STRING" };

// Who the persona serves ({{profile.*}}): the pilot participant or the demo company.
// In v2 phase 4 this becomes the user's row in the database.
function profileFor(persona, framework, L) {
  if (persona.profile === "participant") {
    const who = framework.participant;
    return {
      ...who,
      langName: L.name(who.lang),
      accentNote: who.accent ? ` (${who.accent})` : "",
      tradeNoun: who.trade ? `a ${who.trade}` : "a tradesperson (his trade isn't known yet; it comes out in the first call)",
    };
  }
  if (persona.profile === "company") {
    const company = config("company");
    return { ...company, langName: L.name(company.lang), business: company.business ?? "a contractor" };
  }
  if (persona.profile === "admin") {
    // Max, on his own line (ADMIN_PHONE): ADMIN_NAME, ADMIN_LANG.
    const lang = L.isEnabled?.(process.env.ADMIN_LANG) ? process.env.ADMIN_LANG : L.defaultId;
    return { name: process.env.ADMIN_NAME || "Max", lang, langName: L.name(lang) };
  }
  throw new Error(`personas/${persona.id}.md: unknown profile "${persona.profile}"`);
}

// Extra context for the note extraction: the price list, for the office.
function extractContextFor(persona, profile) {
  if (persona.profile !== "company") return () => "";
  const catalog = config("catalog");
  return lang => `PRICE LIST (id | item | price):\n${catalog.items.map(i => `- ${i.id} | ${i.name[lang] ?? i.name[profile.lang]} | ${i.price.toFixed(2)} ${catalog.currency} / ${i.unit}`).join("\n")}`;
}

export function loadSkillFromTemplates(name, { locales = sharedLocales(), templates = loadTemplates() } = {}) {
  const persona = loadPersona(PERSONA_OF[name] ?? name);
  const byId = id => {
    const t = templates.get(id);
    if (!t) throw new Error(`personas/${persona.id}.md: no template "${id}"`);
    return t;
  };
  const capabilities = persona.capabilities.map(byId);
  const standing = persona.standing.map(byId);
  const usesResearch = standing.some(t => t.steps.some(s => s.primitive === "research"));
  const framework = usesResearch ? loadFramework() : null;
  const profile = profileFor(persona, framework, locales);
  const extractContext = extractContextFor(persona, profile);

  // ---------- after the call: long-term memory (customers, to-dos) plus what standing objectives file ----------
  const memoryCtx = { r: text => render(text, { profile, ex: {}, lines: {}, exAll: {}, lang: { id: profile.lang, name: profile.langName }, langs: { names: locales.enabled().map(locales.name) } }, `personas/${persona.id}`), framework, locales, params: {} };
  const extras = standing.flatMap(t => t.steps.map(s => primitives[s.primitive].memory?.(s, memoryCtx)).filter(Boolean));
  const MEMORY_SCHEMA = {
    type: "OBJECT",
    properties: {
      call_type: { type: "STRING", enum: [...new Set([...capabilities.map(t => t.mode.id), "other"])] },
      call_summary: S,
      customer: { type: "OBJECT", properties: { existing_id: S, name: S, place: S, address: S, phone: S, summary_update: S } },
      new_actions: { type: "ARRAY", items: { type: "OBJECT", properties: { text: S, due: S, customer_name: S } } },
      completed_action_ids: { type: "ARRAY", items: S },
      updated_actions: { type: "ARRAY", items: { type: "OBJECT", properties: { id: S, text: S, due: S } } },
      ...Object.assign({}, ...extras.map(e => e.schema)),
    },
    required: ["call_type", "call_summary", "customer", "new_actions", "completed_action_ids", ...extras.flatMap(e => e.required ?? [])],
  };
  const MEMORY_SYSTEM = [memoryCtx.r(persona.sections.memory), ...extras.map(e => e.rules)].join("\n");
  function memoryPrompt({ turns, note, snapshot }) {
    const transcript = turns.map(t => `${t.role === "user" ? "Tradesperson" : persona.agentLabel}: ${t.text}`).join("\n");
    return [
      `Today is ${new Date().toISOString().slice(0, 10)} (${promptWeekday()}).`,
      `Known customers:\n${JSON.stringify(snapshot.customers)}`,
      `Open to-dos:\n${JSON.stringify(snapshot.openActions)}`,
      ...extras.map(e => e.prompt?.(snapshot)).filter(Boolean),
      `Note from this call:\n${JSON.stringify(note ?? {})}`,
      `Transcript:\n${transcript}`,
    ].join("\n\n");
  }

  return {
    name,
    PERSONA: persona.id,
    DEFAULT_LANG: profile.lang,
    framework,
    persona,
    templates,
    profile,

    /**
     * The agenda for one call. `objectives`: stored objectives picked for this call
     * (src/store/objectives.mjs), best first. `discovery`: the research store, if the
     * persona researches. At most MAX_OBJECTIVES of the agent's own items per call.
     */
    createAgenda({ objectives = [], discovery = null, direction = "inbound" } = {}) {
      const own = objectives.map(o => ({ id: o.id, key: o.id, template: byId(o.template), params: o.params, stored: true, questionLang: o.lang ?? locales.guess(o.params.questions?.map(q => q.ask).join(" ") ?? "") ?? profile.lang }));
      const always = standing.filter(t => discovery || !t.steps.some(s => s.primitive === "research")).map(t => ({ id: t.id, key: t.id.replace(/\W/g, "_"), template: t, params: {}, stored: false }));
      // A call the agent makes is for its errand only: no standing items (research) on top.
      const items = direction === "outbound" ? own : [...own, ...always];
      return createAgenda({ persona, capabilities, objectives: items.slice(0, MAX_OBJECTIVES), profile, locales, discovery, framework, extractContext, direction });
    },

    /** Checks an objective's params against its template; returns them normalised (throws on bad input). */
    objectiveParams(templateId, params) {
      const t = byId(templateId);
      if (t.kind !== "objective") throw new Error(`${templateId} is not an objective template`);
      return t.steps.reduce((p, s) => primitives[s.primitive].validate?.(s, p) ?? p, params ?? {});
    },

    MEMORY_SCHEMA,
    MEMORY_SYSTEM,
    memoryPrompt,
  };
}
