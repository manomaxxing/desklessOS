// One call's agenda: the persona, what he can ask for (capability templates)
// and what the agent brings (objective instances: the pilot's research, Max's
// questions). It writes the system prompt, the note extraction (one schema for
// his note and the objectives' answers), checks after every extraction which
// objectives are done, and says what each objective got at the end.
//
// The prompt goes static → per call → per turn, so the long static part is the
// same request prefix on every turn (Gemini's implicit prefix caching):
//   persona, jobs, output format, tools | today, own agenda, memory | THIS CALL

import { render } from "./render.ts";
import { primitives } from "./primitives.ts";
import { toolRules } from "../tools/prompt.ts";
import { promptDate, promptWeekday, promptTime } from "../locale/index.ts";
import { isRecord } from "../shared/is-record.ts";
import type { Text } from "./render.ts";
import type { Discovery, Framework, Locales, StepContext } from "./primitives.ts";
import type { Lists } from "../quotes/lists.ts";
import type { LangId, Turn } from "../types/common.ts";
import type { Schema } from "../types/gemini.ts";
import type { ObjectiveResult, Persona, Step, Template } from "../types/agenda.ts";
import type { Direction } from "../types/call.ts";
import type { Note } from "../types/note.ts";
import type { PersonaLines } from "../types/locale.ts";

/** A capability template: one he starts, standing for a note mode. */
export type Capability = Template & { mode: NonNullable<Template["mode"]> };
export const isCapability = (t: Template): t is Capability => t.kind === "capability" && Boolean(t.mode?.id);

/** Who the persona serves: the {{profile.*}} slots. */
export interface AgendaProfile {
  name: string;
  lang: LangId;
  langName: string;
  timezone?: string;
  [key: string]: unknown;
}

/** An objective as an agenda takes it. `key`: where its answers go in the extraction (agenda.<key>). */
export interface AgendaObjective {
  id: string;
  key: string;
  template: Template;
  params: Record<string, unknown>;
  stored: boolean;
  /** What it got in earlier calls (its stored result, and how the last call ended). */
  previous?: Record<string, unknown> | null;
  questionLang?: LangId | null;
}
/** …and as it goes through the call: what the extraction got so far, and whether that's enough. */
export interface AgendaItem extends AgendaObjective {
  output: unknown;
  done: boolean;
}

export interface AgendaOptions {
  persona: Persona;
  capabilities: Capability[];
  objectives?: AgendaObjective[];
  profile: AgendaProfile;
  locales: Locales;
  discovery?: Discovery | null;
  framework?: Framework | null;
  direction?: Direction;
  lists?: Lists | null;
}

export interface PromptOptions {
  /** "cascade": the model writes a header and its reply, which Fish reads aloud; "live": Gemini Live hears and speaks itself. */
  engine?: "cascade" | "live";
  lang?: LangId;
  note?: Note | null;
  missing?: readonly string[];
  memory?: string;
  tools?: readonly string[];
  now?: Date;
  today?: string;
}

/** An objective whose done-ness changed with an extraction. */
export interface AgendaChange {
  id: string;
  template: string;
  done: boolean;
  status: string;
}

/** Outbound calls: did he agree to talk, and when to call back. */
export interface CallOutcome {
  consent: string;
  callbackWhen: string;
}

export interface Agenda {
  persona: Persona;
  capabilities: Capability[];
  objectives: AgendaItem[];
  prompt(opts?: PromptOptions): string;
  schema(): Schema;
  extractSystem(lang?: LangId): string;
  extractPrompt(opts: { turns: readonly Turn[]; lang?: LangId; today?: Date }): string;
  update(extracted?: Record<string, unknown> | null): { note: Note; missing: string[]; changes: AgendaChange[] };
  missing(note: Note | null | undefined): string[];
  worthSaving(note: Note | null | undefined): boolean;
  direction: Direction;
  callOutcome(): CallOutcome | null;
  tools(): string[];
  results(): ObjectiveResult[];
}

const LETTERS = "ABCDEFGHIJ";
const P = (step: Step) => primitives[step.primitive];

/**
 * persona: parsed personas/<id>.md. capabilities: capability templates, in order.
 * objectives: [{ id, key, template, params, stored, questionLang }] (key: where its answers go in the extraction).
 * profile: who the persona serves ({{profile.*}}). lists: his own lists (src/quotes/lists.ts, parsed), for the checklist primitive.
 */
export function createAgenda({ persona, capabilities, objectives = [], profile, locales, discovery = null, framework = null, direction = "inbound", lists = null }: AgendaOptions): Agenda {
  const items: AgendaItem[] = objectives.map(o => ({ ...o, output: undefined, done: false }));
  const outbound = direction === "outbound";
  let last: Record<string, unknown> = {}; // the latest extraction, his note and the objectives' answers
  let outcome: CallOutcome = { consent: "unknown", callbackWhen: "" }; // outbound: did he agree to talk, call back when

  function slotContext(lang: LangId) {
    const lines: PersonaLines = locales.persona(lang, persona.id) ?? {};
    const exAll: Record<string, (string | string[])[]> = {};
    for (const id of locales.enabled()) {
      const examples: Record<string, string | string[]> = locales.persona(id, persona.id)?.examples ?? {};
      for (const [k, v] of Object.entries(examples)) (exAll[k] ??= []).push(v);
    }
    return { ex: lines.examples ?? {}, lines, exAll, lang: { id: lang, name: locales.name(lang) }, langs: { names: locales.enabled().map(locales.name) }, profile };
  }
  const renderer = (lang: LangId, where: string) => {
    const ctx = slotContext(lang);
    return (text: Text, extra?: Record<string, unknown>) => render(text, extra ? { ...ctx, ...extra } : ctx, where);
  };
  // `cap`: the capability template a step belongs to (its mode), for a capability's steps.
  const stepContext = (item: AgendaItem | null, lang: LangId, tools: readonly string[] = [], cap: Capability | null = null): StepContext => ({
    r: renderer(lang, item ? `templates/${item.template.id}` : `personas/${persona.id}`),
    lang, locales, discovery, framework, outbound, lists, mode: cap?.mode.id ?? null,
    params: item?.params ?? {}, key: item?.key, questionLang: item?.questionLang ?? null,
    previous: item?.previous ?? null, // what this objective got in earlier calls (its stored result)
    output: item?.output, // what it got so far in this call (the latest extraction)
    agentLabel: persona.agentLabel ?? "Agent",
    tools,
  });
  const stepsText = (t: Template, item: AgendaItem | null, lang: LangId, tools: readonly string[] = [], cap: Capability | null = null) =>
    t.steps.map(s => P(s).prompt?.(s, stepContext(item, lang, tools, cap)) ?? "").filter(Boolean).join("\n");
  // The capabilities' steps, each with its context: their per-call text, their lines for THIS CALL, the note as kept.
  const capSteps = () => capabilities.flatMap(t => t.steps.map(s => ({ s, t })));
  const capContext = (lang: LangId) => capSteps().map(({ s, t }) => P(s).context?.(s, stepContext(null, lang, [], t)) ?? "").filter(Boolean);
  const capStatus = (note: Note | null, lang: LangId) => capSteps().map(({ s, t }) => P(s).status?.(s, note, stepContext(null, lang, [], t)) ?? "").filter(Boolean);
  const tidy = (note: Note) => capSteps().reduce((n, { s, t }) => P(s).tidy?.(s, n, stepContext(null, profile.lang, [], t)) ?? n, note);

  function missing(note: Note | null | undefined): string[] {
    if (!note) return [];
    const cap = note.mode ? capabilities.find(t => t.mode.id === note.mode) : capabilities.find(t => t.mode.default);
    if (!cap) return [];
    return cap.steps.flatMap(s => P(s).missing?.(s, note, stepContext(null, profile.lang, [], cap)) ?? []);
  }

  function statusLines(lang: LangId): string[] {
    return items.map(o => o.template.steps.map(s => P(s).status?.(s, o.output, stepContext(o, lang)) ?? "").filter(Boolean).join("; ")).filter(Boolean);
  }

  return {
    persona,
    capabilities,
    objectives: items,

    /**
     * The system prompt. engine "cascade": the model writes a header and its reply, which Fish
     * reads aloud; "live": Gemini Live hears and speaks itself, and hangs up with end_call.
     */
    prompt({ engine = "cascade", lang = profile.lang, note = {}, missing: miss = missing(note), memory = "", tools = [], now = new Date(), today = promptDate(now) } = {}) {
      const r = renderer(lang, `personas/${persona.id}`);
      const section = (name: string) => r(persona.sections[name]);
      const jobs = capabilities.map((t, i) => `${LETTERS[i]}) ${r(t.title)}\n${stepsText(t, null, lang, tools, t)}`);
      const live = engine === "live";
      const intro = live
        ? "You speak directly; keep it brief and natural.\nWhen he pauses mid-thought, stay silent and let him continue."
        : "Everything you write is read aloud by a text-to-speech voice.";
      const format = live
        ? "When the call is over and you've said goodbye, call end_call."
        : `OUTPUT FORMAT, always, exactly:
HEARD: <word for word what he just said, in his language>
LANG: <${locales.enabled().join(" | ")}>
NEXT: <listen | wait | ask | confirm | hangup>

<your spoken reply>

${section("next")}`;
      const own = items.map((o, i) => `${i + 1}. ${stepsText(o.template, o, lang)}`);
      const status = statusLines(lang);
      // What he told in earlier calls' research questions: the research item shows it; without one (a call Toni makes), this does.
      const researching = items.some(o => o.template.steps.some(s => s.primitive === "research"));
      const known = !researching && discovery?.known();
      const capLines = capStatus(note, lang);
      return [
        // static: the same on every turn of every call in this language
        `${section("role")}\n${intro}`,
        section("language"),
        `YOUR JOBS\n\n${jobs.join("\n\n")}`,
        section("closing"),
        section("sound"),
        section("interruptions"),
        section("silence"),
        format,
        !live && tools.length ? toolRules(tools, slotContext(lang).lines) : "",
        // per call
        `Today is ${today}; it's ${promptTime(now, profile.timezone)} for him.`,
        outbound ? section("outbound") : "",
        own.length ? `${section("agenda")}\n\nItems for this call, in this order:\n${own.join("\n\n")}` : "",
        known ? `WHAT HE TOLD YOU IN EARLIER CALLS (about his business): known, so never ask it again; build on it instead (${r("{{q ex.knownBefore}}")}):\n${known}` : "",
        ...capContext(lang),
        `MEMORY (persists across calls: to-dos, customers and their notes):\n${memory || "(empty)"}`,
        // per turn
        `THIS CALL (changes every turn, so it comes last):
The note so far (may lag one turn behind):
${JSON.stringify(note ?? {}, null, 0)}
Still missing: ${miss?.length ? miss.join(", ") : "nothing"}${capLines.map(l => `\n${l}`).join("")}${status.length ? `\nYour own agenda so far: ${status.join(" | ")}` : ""}`,
      ].filter(Boolean).join("\n\n");
    },

    /** One schema for the slow path: his note (mode + the capabilities' fields) and agenda.<key> per objective. */
    schema() {
      const properties: Record<string, Schema> = { mode: { type: "STRING", enum: [...new Set([...capabilities.map(t => t.mode.id), "unclear"])] } };
      const required = ["mode"];
      for (const t of capabilities) {
        for (const s of t.steps) {
          const f = P(s).fields?.(s, stepContext(null, profile.lang, [], t));
          if (f) { Object.assign(properties, f.properties); required.push(...f.required); }
        }
      }
      const agenda: Record<string, Schema> = {};
      for (const o of items) {
        for (const s of o.template.steps) {
          const out = P(s).output?.(s, stepContext(o, profile.lang));
          if (out) agenda[o.key] = out;
        }
      }
      if (Object.keys(agenda).length) {
        properties.agenda = { type: "OBJECT", properties: agenda, required: Object.keys(agenda) };
        required.push("agenda");
      }
      if (outbound) {
        properties.call_consent = { type: "STRING", enum: ["unknown", "yes", "no", "later", "never"] };
        properties.callback_when = { type: "STRING" };
        required.push("call_consent", "callback_when");
      }
      return { type: "OBJECT", properties, required: [...new Set(required)] };
    },

    extractSystem(lang = profile.lang) {
      const r = renderer(lang, `personas/${persona.id}`);
      const text = r(persona.sections.extract).split("\n");
      const firstRule = text.findIndex(l => l.startsWith("- "));
      const [intro, general] = firstRule < 0 ? [text, []] : [text.slice(0, firstRule), text.slice(firstRule)];
      const modes = capabilities.map(t => `"${t.mode.id}" ${t.mode.when}`).join("; ");
      const modeRules = capabilities.map(t => t.mode.rule).filter(Boolean).map(l => `  ${l}`);
      const ruleLines = (item: AgendaItem | null, t: Template, cap: Capability | null) => t.steps.flatMap(s => P(s).rules?.(s, stepContext(item, lang, [], cap)) ?? []);
      return [
        ...intro,
        `- mode: ${modes}; otherwise "unclear".`,
        ...modeRules,
        ...capabilities.flatMap(t => ruleLines(null, t, t)),
        ...general,
        ...items.flatMap(o => ruleLines(o, o.template, null)),
        ...(outbound ? [
          `- call_consent: the ${(persona.agentLabel ?? "agent").toLowerCase()} made this call. Did he agree to talk now? "yes"; "no" (no time, no`,
          "  other time named); \"later\" (call him back: callback_when = YYYY-MM-DDTHH:MM in his local time if he named a",
          "  time, else \"\"); \"never\" (he doesn't want such calls); \"unknown\" (not asked or not answered yet).",
        ] : []),
      ].join("\n");
    },

    extractPrompt({ turns, lang = profile.lang, today = new Date() }) {
      const transcript = turns.map(t => `${t.role === "user" ? "Tradesperson" : persona.agentLabel ?? "Agent"}: ${t.text}`).join("\n");
      return `Today is ${today.toISOString().slice(0, 10)} (${promptWeekday(today)}).
Language of the call: ${locales.name(lang)}.

So far: ${JSON.stringify(last)}

Transcript:
${transcript}

Return the updated note.`;
    },

    /** Takes one extraction: his note, what's still missing, and objectives that just got done. */
    update(extracted = {}) {
      last = extracted ?? {};
      const { agenda, call_consent: consent, callback_when: callbackWhen, ...raw } = last;
      const answers = isRecord(agenda) ? agenda : {};
      const note = tidy(raw);
      if (outbound) outcome = { consent: typeof consent === "string" ? consent : "unknown", callbackWhen: typeof callbackWhen === "string" ? callbackWhen : "" };
      const changes: AgendaChange[] = [];
      for (const o of items) {
        if (!(o.key in answers)) continue;
        o.output = answers[o.key];
        const checks = o.template.steps.filter(s => P(s).isDone);
        const done = checks.length > 0 && checks.every(s => P(s).isDone?.(s, o.output, stepContext(o, profile.lang)) === true);
        if (done !== o.done) changes.push({ id: o.id, template: o.template.id, done, status: statusLines(profile.lang)[items.indexOf(o)] ?? "" });
        o.done = done;
      }
      return { note, missing: missing(note), changes };
    },

    missing,

    worthSaving(note) {
      const cap = capabilities.find(t => t.mode.id === note?.mode);
      return Boolean(cap?.steps.some(s => P(s).save?.(s, note)));
    },

    direction,
    /** Outbound calls: { consent: yes|no|later|never|unknown, callbackWhen } for the scheduler. */
    callOutcome: () => (outbound ? outcome : null),

    /** Tool names the templates on this call may use. */
    tools: () => [...new Set([...capabilities, ...items.map(o => o.template)].flatMap(t => t.tools ?? []))],

    /** After the call: what each stored objective got (answers, quotes) and whether it's done. */
    results() {
      return items.filter(o => o.stored).map(o => ({
        id: o.id,
        template: `${o.template.id}@${o.template.version}`,
        done: o.done,
        result: Object.fromEntries(o.template.steps.flatMap(s => Object.entries(P(s).result?.(s, o.output, stepContext(o, profile.lang)) ?? {}))),
      }));
    },
  };
}
