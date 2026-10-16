// A skill, built from a persona (personas/<id>.md) and templates (templates/*.json):
// "pilot" is the notebook persona with the research week, "admin" Max's own line.
// Each call gets its own agenda (src/agenda/agenda.mjs): the
// persona's capabilities, plus the objectives for this call (Max's questions
// from the objectives store first, then standing ones like the pilot's research).

import { loadPersona, loadTemplates } from "../agenda/templates.mjs";
import { createAgenda } from "../agenda/agenda.mjs";
import { primitives } from "../agenda/primitives.mjs";
import { render } from "../agenda/render.mjs";
import { loadFramework } from "../memory/research.mjs";
import { locales as sharedLocales, promptWeekday } from "../locale/index.mjs";
import { parseLists } from "../quotes/lists.mjs";

const PERSONA_OF = { pilot: "notebook", admin: "admin" };
const MAX_OBJECTIVES = 1; // the agent's own items per call, always after his business: one extra per call, never more
const S = { type: "STRING" };

// Who the persona serves ({{profile.*}}): the pilot participant (the default), the caller
// (his users row, per call), or Max on his own line.
const described = (who, L) => ({
  ...who,
  langName: L.name(who.lang),
  accentNote: who.accent ? ` (${who.accent})` : "",
  tradeNoun: who.trade ? `a ${who.trade}` : "a tradesperson (his trade isn't known yet; it comes out in a call)",
  inPlace: who.place ? ` in ${who.place}` : "",
});
function profileFor(persona, framework, L) {
  if (persona.profile === "participant") return described(framework.participant, L);
  if (persona.profile === "admin") {
    // Max, on his own line (ADMIN_PHONE): ADMIN_NAME, ADMIN_LANG.
    const lang = L.isEnabled?.(process.env.ADMIN_LANG) ? process.env.ADMIN_LANG : L.defaultId;
    return { name: process.env.ADMIN_NAME || "Max", lang, langName: L.name(lang) };
  }
  throw new Error(`personas/${persona.id}.md: unknown profile "${persona.profile}"`);
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
  // The caller as his users row knows him: trade, place, accent, language, time zone (nothing borrowed from the pilot's).
  const profileOf = user => {
    const p = user.profile ?? {};
    const lang = locales.isEnabled?.(user.lang) ? user.lang : profile.lang;
    return described({ ...profile, name: user.name ?? p.name ?? profile.name, lang, place: p.place ?? "", trade: p.trade ?? "", accent: p.accent ?? "", timezone: user.timezone || p.timezone || profile.timezone }, locales);
  };

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
     * (src/memory/pg.mjs), best first; `stored: false` ones (a rehearsal's) aren't written back. `discovery`: the research state, if the
     * persona researches. At most MAX_OBJECTIVES of the agent's own items per call.
     */
    createAgenda({ objectives = [], discovery = null, direction = "inbound", user = null } = {}) {
      const own = objectives.map(o => ({ id: o.id, key: o.id, template: byId(o.template), params: o.params, stored: o.stored !== false, previous: o.result || o.lastCall ? { ...(o.result ?? {}), lastCall: o.lastCall ?? null } : null, questionLang: o.lang ?? locales.guess(o.params.questions?.map(q => q.ask).join(" ") ?? "") ?? profile.lang }));
      const always = standing.filter(t => discovery || !t.steps.some(s => s.primitive === "research")).map(t => ({ id: t.id, key: t.id.replace(/\W/g, "_"), template: t, params: {}, stored: false }));
      // A call the agent makes is for its errand only, and a "standalone" item (a whole conversation,
      // like his day) is the call's own item too: no standing items (research) on top.
      const standalone = own.some(o => o.template.standalone);
      const items = direction === "outbound" || standalone ? own : [...own, ...always];
      // His lists (People card), for templates with a checklist step.
      const lists = user?.profile?.lists ? parseLists(user.profile.lists) : null;
      return createAgenda({ persona, capabilities, objectives: items.slice(0, MAX_OBJECTIVES), profile: user ? profileOf(user) : profile, locales, discovery, framework, direction, lists });
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
