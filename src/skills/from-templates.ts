// A skill, built from a persona (personas/<id>.md) and templates (templates/*.json):
// "pilot" is the notebook persona with the research week, "admin" Max's own line.
// Each call gets its own agenda (src/agenda/agenda.ts): the
// persona's capabilities, plus the objectives for this call (Max's questions
// from the objectives store first, then standing ones like the pilot's research).

import { loadPersona, loadTemplates } from "../agenda/templates.ts";
import { createAgenda, isCapability } from "../agenda/agenda.ts";
import { primitives } from "../agenda/primitives.ts";
import { render } from "../agenda/render.ts";
import { loadFramework } from "../memory/research.ts";
import { locales as sharedLocales, promptWeekday } from "../locale/index.ts";
import { FEATURES, hasFeature } from "../features.ts";
import { parseLists } from "../quotes/lists.ts";
import { isRecord } from "../shared/is-record.ts";
import type { Agenda, AgendaObjective, AgendaProfile, Capability } from "../agenda/agenda.ts";
import type { Discovery, Locales, MemoryContext, MemoryExtra, MemorySnapshot } from "../agenda/primitives.ts";
import type { Text } from "../agenda/render.ts";
import type { Lists } from "../quotes/lists.ts";
import type { LangId, Turn } from "../types/common.ts";
import type { Schema } from "../types/gemini.ts";
import type { ObjectiveInput, Persona, Template } from "../types/agenda.ts";
import type { Direction } from "../types/call.ts";
import type { Note } from "../types/note.ts";
import type { CallUser } from "../types/user.ts";

/** The research framework as loaded (config/discovery.json); null for a persona without research. */
export type ResearchFramework = ReturnType<typeof loadFramework>;
/** Who a call is for, as far as the agenda needs him: his users row, a call scope's user. */
export type AgendaUser = Partial<Pick<CallUser, "name" | "lang" | "timezone" | "profile">>;

export interface SkillAgendaOptions {
  /** Stored objectives picked for this call (src/memory/pg.ts), best first; `stored: false` ones (a rehearsal's) aren't written back. */
  objectives?: ObjectiveInput[];
  /** The research store (src/memory/research.ts), if the persona researches; a call scope has it as `unknown`, anything else counts as none. */
  discovery?: unknown;
  direction?: Direction;
  user?: AgendaUser | null;
  /** His lists, already parsed (as quote_send gets them); left out, they're parsed from user.profile.lists. */
  lists?: Lists | null;
}

export interface MemoryPromptInput {
  turns: readonly Turn[];
  note: Note | null | undefined;
  /** What memory knows to match against (src/memory: customers, openActions, discovery). */
  snapshot: unknown;
}

export interface Skill {
  name: string;
  PERSONA: string;
  DEFAULT_LANG: LangId;
  framework: ResearchFramework | null;
  persona: Persona;
  templates: Map<string, Template>;
  profile: AgendaProfile;
  createAgenda(opts?: SkillAgendaOptions): Agenda;
  /** Checks an objective's params against its template; returns them normalised (throws on bad input). */
  objectiveParams(templateId: string, params?: Record<string, unknown> | null): Record<string, unknown>;
  MEMORY_SCHEMA: Schema;
  MEMORY_SYSTEM: string;
  memoryPrompt(input: MemoryPromptInput): string;
}

const PERSONA_OF: Record<string, string> = { pilot: "notebook", admin: "admin" };
const MAX_OBJECTIVES = 1; // the agent's own items per call, always after his business (research joins a heads-up, see createAgenda)
const S: Schema = { type: "STRING" };

// Who the persona serves ({{profile.*}}): the pilot participant (the default), the caller
// (his users row, per call), or Max on his own line.
type Who = { name: string; lang: LangId; place?: string; trade?: string; accent?: string; timezone?: string };
const described = (who: Who, L: Locales): AgendaProfile => ({
  ...who,
  langName: L.name(who.lang),
  accentNote: who.accent ? ` (${who.accent})` : "",
  tradeNoun: who.trade ? `a ${who.trade}` : "a tradesperson (his trade isn't known yet; it comes out in a call)",
  inPlace: who.place ? ` in ${who.place}` : "",
});
function profileFor(persona: Persona, framework: ResearchFramework | null, L: Locales): AgendaProfile {
  if (persona.profile === "participant") {
    const who = framework?.participant;
    if (!who?.name || !who.lang) throw new Error(`personas/${persona.id}.md: profile "participant" needs participant.name and .lang (config/discovery.json)`);
    return described({ ...who, name: who.name, lang: who.lang }, L);
  }
  if (persona.profile === "admin") {
    // Max, on his own line (ADMIN_PHONE): ADMIN_NAME, ADMIN_LANG.
    const wanted = process.env.ADMIN_LANG;
    const lang = wanted && L.isEnabled(wanted) ? wanted : L.defaultId;
    return { name: process.env.ADMIN_NAME || "Max", lang, langName: L.name(lang) };
  }
  throw new Error(`personas/${persona.id}.md: unknown profile "${persona.profile}"`);
}

const isDiscovery = (d: unknown): d is Discovery => isRecord(d) && typeof d.context === "function" && typeof d.known === "function";

// Max's questions, as one text: what language they're written in.
const questionText = (params: Record<string, unknown>) => {
  const questions = params.questions;
  return Array.isArray(questions) ? questions.map((q: unknown) => (isRecord(q) && typeof q.ask === "string" ? q.ask : "")).join(" ") : "";
};

export function loadSkillFromTemplates(name: string, { locales = sharedLocales(), templates = loadTemplates() }: { locales?: Locales; templates?: Map<string, Template> } = {}): Skill {
  const persona = loadPersona(PERSONA_OF[name] ?? name);
  const byId = (id: string): Template => {
    const t = templates.get(id);
    if (!t) throw new Error(`personas/${persona.id}.md: no template "${id}"`);
    return t;
  };
  const capability = (id: string): Capability => {
    const t = byId(id);
    if (!isCapability(t)) throw new Error(`personas/${persona.id}.md: "${id}" is not a capability template (kind "capability", with a mode)`);
    return t;
  };
  const capabilities = persona.capabilities.map(capability);
  const standing = persona.standing.map(byId);
  const usesResearch = standing.some(t => t.steps.some(s => s.primitive === "research"));
  const framework: ResearchFramework | null = usesResearch ? loadFramework() : null;
  const profile = profileFor(persona, framework, locales);
  // The caller as his users row knows him: trade, place, accent, language, time zone (nothing borrowed from the pilot's).
  const profileOf = (user: AgendaUser): AgendaProfile => {
    const p = user.profile ?? {};
    const lang = user.lang && locales.isEnabled(user.lang) ? user.lang : profile.lang;
    return described({ ...profile, name: user.name ?? p.name ?? profile.name, lang, place: p.place ?? "", trade: p.trade ?? "", accent: p.accent ?? "", timezone: user.timezone || p.timezone || profile.timezone }, locales);
  };

  // ---------- after the call: long-term memory (customers, to-dos) plus what standing objectives file ----------
  const memoryCtx: MemoryContext = { r: (text: Text) => render(text, { profile, ex: {}, lines: {}, exAll: {}, lang: { id: profile.lang, name: profile.langName }, langs: { names: locales.enabled().map(locales.name) } }, `personas/${persona.id}`), framework, locales, params: {} };
  const extras: MemoryExtra[] = standing.flatMap(t => t.steps.flatMap(s => primitives[s.primitive].memory?.(s, memoryCtx) ?? []));
  const MEMORY_SCHEMA: Schema = {
    type: "OBJECT",
    properties: {
      call_type: { type: "STRING", enum: [...new Set([...capabilities.map(t => t.mode.id), "other"])] },
      call_summary: S,
      customer: { type: "OBJECT", properties: { existing_id: S, name: S, place: S, address: S, phone: S, summary_update: S } },
      new_actions: { type: "ARRAY", items: { type: "OBJECT", properties: { text: S, due: S, customer_name: S } } },
      completed_action_ids: { type: "ARRAY", items: S },
      updated_actions: { type: "ARRAY", items: { type: "OBJECT", properties: { id: S, text: S, due: S } } },
      // What he asked for that the agent can't do yet: Max gets told (src/calls/after-call.ts).
      wishes: { type: "ARRAY", items: { type: "OBJECT", properties: { what: S, why: S, quote: S }, required: ["what"] } },
      ...Object.fromEntries(extras.flatMap(e => Object.entries(e.schema))),
    },
    required: ["call_type", "call_summary", "customer", "new_actions", "completed_action_ids", "wishes", ...extras.flatMap(e => e.required ?? [])],
  };
  const MEMORY_SYSTEM = [memoryCtx.r(persona.sections.memory), ...extras.map(e => e.rules)].join("\n");
  function memoryPrompt({ turns, note, snapshot: known }: MemoryPromptInput): string {
    const snapshot: MemorySnapshot = isRecord(known) ? known : {};
    const transcript = turns.map(t => `${t.role === "user" ? "Tradesperson" : persona.agentLabel ?? "Agent"}: ${t.text}`).join("\n");
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
     * (src/memory/pg.ts), best first; `stored: false` ones (a rehearsal's) aren't written back. `discovery`: the research state, if the
     * persona researches. At most MAX_OBJECTIVES of the agent's own items per call, plus the research question when that item only tells him something.
     * `lists`: his lists already parsed (start.ts has them for quote_send); left out, they come from user.profile.lists.
     */
    createAgenda({ objectives = [], discovery: store = null, direction = "inbound", user = null, lists }: SkillAgendaOptions = {}) {
      const discovery = isDiscovery(store) ? store : null;
      const own: AgendaObjective[] = objectives.map(o => ({ id: o.id, key: o.id, template: byId(o.template), params: o.params, stored: o.stored !== false, previous: o.result || o.lastCall ? { ...(o.result ?? {}), lastCall: o.lastCall ?? null } : null, questionLang: o.lang ?? locales.guess(questionText(o.params)) ?? profile.lang }));
      const always: AgendaObjective[] = standing.filter(t => discovery || !t.steps.some(s => s.primitive === "research")).map(t => ({ id: t.id, key: t.id.replace(/\W/g, "_"), template: t, params: {}, stored: false }));
      // A call the agent makes is for its errand only, and a "standalone" item (a whole conversation,
      // like his day) is the call's own item too: no standing items (research) on top.
      const standalone = own.some(o => o.template.standalone);
      // One own item per call; the research question comes along unless that item already asks him
      // something (Max's questions): a heads-up ("tell") asks nothing, so research is in every call.
      const first = own.slice(0, MAX_OBJECTIVES);
      const asks = first.some(o => o.template.steps.some(s => s.primitive !== "tell"));
      const items = direction === "outbound" || standalone || asks ? first : [...first, ...always];
      // His lists (People card), for templates with a checklist step.
      const parsed = lists !== undefined ? lists : user?.profile?.lists ? parseLists(user.profile.lists) : null;
      return createAgenda({ persona, capabilities, objectives: items, profile: user ? profileOf(user) : profile, locales, discovery, framework, direction, lists: parsed, features: FEATURES.filter(f => hasFeature(user, f)) });
    },

    objectiveParams(templateId, params) {
      const t = byId(templateId);
      if (t.kind !== "objective") throw new Error(`${templateId} is not an objective template`);
      return t.steps.reduce<Record<string, unknown>>((p, s) => primitives[s.primitive].validate?.(s, p) ?? p, params ?? {});
    },

    MEMORY_SCHEMA,
    MEMORY_SYSTEM,
    memoryPrompt,
  };
}
