// What one step of a template does in a call. Every hook is optional:
//   prompt(step, ctx)          instruction text for the system prompt (static: the same for everyone)
//   context(step, ctx)         per-call text for the prompt: data about him the step works from
//   fields(step, ctx)          note fields this step adds { properties, required } (capabilities)
//   output(step, ctx)          Gemini schema of what this step extracts under agenda.<key> (objectives)
//   rules(step, ctx)           extraction rules, one "- …" line each
//   missing(step, note, ctx)   what's still missing for the note (capabilities)
//   save(step, note)           worth saving as a note? (capabilities)
//   isDone(step, out, ctx)     checked in code after every extraction (objectives)
//   status(step, out, ctx)     one line for THIS CALL: where this step stands (a capability's `out` is his note)
//   tidy(step, note, ctx)      his note as the extraction returned it → as it's kept (capabilities)
//   result(step, out, ctx)     what the objective keeps after the call
//   validate(step, params)     checks and normalises an objective's params; throws on bad input
//   memory(step, ctx)          what the post-call memory step adds { schema, rules, prompt(snapshot) }
// ctx: { r(text, extra?) renders {{slots}}, lang, params, key, agentLabel, discovery, framework, locales,
//        previous (an objective's result from earlier calls), tools (the tool names this call has),
//        mode (a capability's mode id), outbound, lists (his lists from his People card, parsed),
//        output (an objective's extraction so far in this call) }.
// Primitives: capture (a note), checklist (his own lists, gone through after he told), inform
// (answer from what's known), ask (Max's questions), tell (one thing to tell him, once), research
// (the pilot week's questions), conversation (his day, a listening conversation).

import { hasLists, listsContext, listsSchema, listsRules, openOnLists, listFieldsIn } from "../quotes/lists.ts";
import { isRecord } from "../shared/is-record.ts";
import type { Lists } from "../quotes/lists.ts";
import type { Text } from "./render.ts";
import type { LangId, Turn } from "../types/common.ts";
import type { Schema } from "../types/gemini.ts";
import type { Step } from "../types/agenda.ts";
import type { Note } from "../types/note.ts";
import type { loadLocales } from "../locale/index.ts";

export type Locales = ReturnType<typeof loadLocales>;

/** The research framework (config/discovery.json), as far as an agenda reads it. */
export interface Framework {
  participant?: { name?: string; lang?: LangId; place?: string; trade?: string; accent?: string; timezone?: string };
  areas: readonly { id: string; title: string; phase?: string }[];
}
/** The research store (src/memory/research.ts), as far as an agenda uses it. */
export interface Discovery {
  context(): string;
  known(): string;
}

export interface StepContext {
  /** Renders {{slots}} in the step's language; `extra`: slots of its own. */
  r(text: Text, extra?: Record<string, unknown>): string;
  lang: LangId;
  locales: Locales;
  discovery: Discovery | null;
  framework: Framework | null;
  outbound: boolean;
  lists: Lists | null;
  /** A capability's mode id. */
  mode: string | null;
  params: Record<string, unknown>;
  /** Where an objective's answers go in the extraction (agenda.<key>). */
  key: string | undefined;
  questionLang: LangId | null;
  previous: Record<string, unknown> | null;
  output: unknown;
  agentLabel: string;
  tools: readonly string[];
}
/** The post-call memory step has no call: only rendering, the framework and the locales. */
export type MemoryContext = Pick<StepContext, "r" | "framework" | "locales" | "params">;
/** What the memory step needs to know about one call (src/memory: customers, to-dos, research). */
export type MemorySnapshot = { discovery?: unknown; [key: string]: unknown };
export interface MemoryExtra {
  schema: Record<string, Schema>;
  required?: string[];
  rules: string;
  prompt?(snapshot: MemorySnapshot): string;
}
export interface Fields {
  properties: Record<string, Schema>;
  required: string[];
}

export interface Primitive {
  prompt?(step: Step, c: StepContext): string;
  context?(step: Step, c: StepContext): string;
  fields?(step: Step, c: StepContext): Fields | null;
  output?(step: Step, c: StepContext): Schema;
  rules?(step: Step, c: StepContext): string[];
  missing?(step: Step, note: Note | null | undefined, c: StepContext): string[];
  save?(step: Step, note: Note | null | undefined): boolean;
  isDone?(step: Step, out: unknown, c: StepContext): boolean;
  status?(step: Step, out: unknown, c: StepContext): string;
  tidy?(step: Step, note: Note, c: StepContext): Note;
  result?(step: Step, out: unknown, c: StepContext): Record<string, unknown>;
  validate?(step: Step, params: Record<string, unknown>): Record<string, unknown>;
  memory?(step: Step, c: MemoryContext): MemoryExtra;
}

const S: Schema = { type: "STRING" };
const filled = (v: unknown) => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null && v !== false);
function lines<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
// What the extraction got under agenda.<key>, an objective's params, what an earlier call kept:
// JSON in the shape the step asked for, but from a model or a database row, so any field may be
// missing. Read through optional fields only.
const view = <T extends object>(v: unknown): Partial<T> => (isRecord(v) ? v : {}) as Partial<T>;
const frameworkOf = (c: { framework: Framework | null }): Framework => {
  if (!c.framework) throw new Error("research: no framework (config/discovery.json)");
  return c.framework;
};

// He tells, the agent takes a structured note. Fields, rules and what's required come from the template.
const capture: Primitive = {
  // A tool's instructions only when the call has that tool: a rule about a tool it doesn't have
  // would have the agent claim to do what it can't ("it's on its way to your WhatsApp").
  prompt: (s, c) => [c.r(s.instructions), ...Object.entries(s.toolInstructions ?? {}).filter(([name]) => c.tools.includes(name)).map(([, text]) => c.r(text))].join("\n"),
  fields: s => ({ properties: s.fields ?? {}, required: s.required ?? [] }),
  rules: (s, c) => lines(s.rules).map(l => c.r(l)),
  missing: (s, note) => lines(s.missing).filter(g => !g.anyOf.some(k => filled(note?.[k]))).map(g => g.label),
  save: (s, note) => lines(s.save?.anyOf).some(k => filled(note?.[k])),
};

// His own lists (People card, src/quotes/lists.ts): once he has told about a job of one of his
// kinds, the agent goes through what's still open before the summary: the job's items, the site,
// the quality level. The template says how; his lists come per call; what's open, every turn.
// Nothing at all for someone without lists, or on a call the agent makes (that's for its errand).
const listsOn = (c: StepContext) => !c.outbound && hasLists(c.lists);
const checklist: Primitive = {
  prompt: (s, c) => (listsOn(c) ? c.r(s.instructions) : ""),
  context: (s, c) => (listsOn(c) ? listsContext(c.lists) : ""),
  fields: (s, c) => (listsOn(c) ? listsSchema(c.lists) : null),
  rules: (s, c) => (listsOn(c) ? listsRules(c.lists) : []),
  status(s, out, c) {
    const note = view<Note>(out);
    const open = listsOn(c) && note.mode === c.mode ? openOnLists(c.lists, note) : "";
    return open ? `Open on his lists: ${open}` : "";
  },
  tidy: (s, note, c) => (listsOn(c) ? listFieldsIn(note) : note),
};

// Answers from what's known (a briefing, the agenda): instructions only, nothing to extract.
const inform: Primitive = {
  prompt: (s, c) => c.r(s.instructions),
};

// One thing to tell him, once, at the end of a call (a feature just switched on for him).
// Done once the extraction sees it was said, in any wording.
type TellParams = { feature: string; message: string };
const told = (out: unknown) => Boolean(view<{ told: boolean }>(out).told);
const tell: Primitive = {
  validate(s, params = {}): TellParams {
    const message = String(params.message ?? "").trim();
    if (message.length < 3 || message.length > 400) throw new Error("message: what to tell him, up to 400 characters");
    return { feature: String(params.feature ?? "").slice(0, 40), message };
  },
  prompt: (s, c) => `${c.r(s.title ?? "TELL HIM")}: news for him, not a question. Once, as a short heads-up in one or two sentences of your own (don't read it out word for word, don't start with "Kurze Frage", don't ask whether he likes it): "${view<TellParams>(c.params).message}" If he already used it in this call, skip it: it counts as told.`,
  output: () => ({ type: "OBJECT", properties: { told: { type: "BOOLEAN" } }, required: ["told"] }),
  rules: (s, c) => [`- agenda.${c.key}: told = true once the ${c.agentLabel.toLowerCase()} has told him this, in any wording, or he already used it in this call: "${view<TellParams>(c.params).message}".`],
  isDone: (s, out) => told(out),
  status: (s, out, c) => `${c.r(s.title ?? "TELL HIM")}: ${told(out) ? "told, don't repeat it" : "not told yet"}`,
  result: (s, out) => ({ told: told(out) }),
};

// The agent asks questions someone gave it ("find out X"): 1–5 questions with an optional follow-up each.
const ASK_STATUS = ["not_asked", "answered", "vague", "declined"];
type AskQuestion = { id: string; ask: string; probe: string; required: boolean };
type AskParams = { purpose: string; questions: AskQuestion[] };
type AskAnswer = { asked: boolean; probed: boolean; status: string; answer: string; quote: string };
const questionsOf = (c: StepContext) => view<AskParams>(c.params).questions ?? [];
const answersOf = (out: unknown) => view<Record<string, Partial<AskAnswer> | undefined>>(out);
// Vague counts only once the follow-up was asked: "find out X" presses once for a real answer.
const settled = (a: Partial<AskAnswer> | undefined) => a?.status === "answered" || a?.status === "declined" || (a?.status === "vague" && Boolean(a.probed));
const ask: Primitive = {
  validate(s, params = {}): AskParams {
    const list = params.questions;
    if (!Array.isArray(list) || list.length < 1 || list.length > 5) throw new Error("questions: 1 to 5 questions");
    const text = (v: unknown, name: string, max = 300) => {
      if (v == null || v === "") return "";
      if (typeof v !== "string" || v.length > max) throw new Error(`${name}: text up to ${max} characters`);
      return v.trim();
    };
    const questions = list.map((q: unknown, i: number) => {
      const asked = text(typeof q === "string" ? q : isRecord(q) ? q.ask : undefined, `questions[${i}].ask`);
      if (asked.length < 3) throw new Error(`questions[${i}].ask: the question is missing`);
      return { id: `q${i + 1}`, ask: asked, probe: text(isRecord(q) ? q.probe : undefined, `questions[${i}].probe`), required: !(isRecord(q) && q.required === false) };
    });
    return { purpose: text(params.purpose, "purpose"), questions };
  },
  prompt(s, c) {
    const questions = questionsOf(c);
    const { purpose } = view<AskParams>(c.params);
    const written = c.questionLang ? ` They are written in ${c.locales.name(c.questionLang)}; ask in the language of the call.` : "";
    return [
      `${c.r(s.title ?? "MAX'S QUESTION")}${purpose ? ` (${purpose})` : ""}: ${questions.length === 1 ? "ask this" : "ask these, one at a time"}.${written}`,
      ...questions.map(q => `   ${q.id}: "${q.ask}"${q.probe ? ` If his answer is vague, one follow-up: "${q.probe}"` : ""}${q.required ? "" : " (only if he has time)"}`),
    ].join("\n");
  },
  output: (s, c) => ({
    type: "OBJECT",
    properties: Object.fromEntries(questionsOf(c).map(q => [q.id, {
      type: "OBJECT",
      properties: { asked: { type: "BOOLEAN" }, probed: { type: "BOOLEAN" }, status: { type: "STRING", enum: ASK_STATUS }, answer: S, quote: S },
      required: ["asked", "probed", "status", "answer", "quote"],
    } satisfies Schema])),
    required: questionsOf(c).map(q => q.id),
  }),
  rules: (s, c) => [
    `- agenda.${c.key}: the questions under "${c.r(s.title ?? "MAX'S QUESTION")}" (${questionsOf(c).map(q => `${q.id} "${q.ask}"`).join("; ")}).`,
    `  Per question: asked = true once the ${c.agentLabel.toLowerCase()} asked it, in any wording; probed = true once it asked a`,
    `  follow-up to his answer; status = "answered" when he gave a real answer, "vague" when he answered without a concrete`,
    `  case or number (a bare "yes", "okay" or "it depends" to an open question is vague), "declined" when he had no time or`,
    `  didn't want to, else "not_asked"; answer = his answer in one neutral sentence, in the language of the call; quote = his`,
    "  exact words if short and telling, else \"\". An answer he gives before being asked counts too. Never invent an answer.",
  ],
  // Every required question settled; and something actually came of it: with only optional
  // questions, [].every() alone would call it done at the first extraction, before a word was asked.
  isDone(s, out, c) {
    const questions = questionsOf(c);
    const answers = answersOf(out);
    const asked = questions.length > 0 && questions.every(q => answers[q.id]?.asked);
    return questions.filter(q => q.required).every(q => settled(answers[q.id])) && (questions.some(q => settled(answers[q.id])) || asked);
  },
  status(s, out, c) {
    const label = (a: Partial<AskAnswer> | undefined) => {
      if (a?.status === "answered") return "answered, don't ask again";
      if (a?.status === "declined") return "declined, don't ask again";
      if (a?.status === "vague") return a.probed ? "still vague after the follow-up, move on" : "vague: ask the one follow-up now";
      return a?.asked ? "asked, no answer yet" : "not asked yet";
    };
    const answers = answersOf(out);
    return `${c.r(s.title ?? "MAX'S QUESTION")}: ${questionsOf(c).map(q => `${q.id} ${label(answers[q.id])}`).join("; ")}`;
  },
  result(s, out, c) {
    const answers = answersOf(out);
    return {
      questions: questionsOf(c).map(q => {
        const a = answers[q.id];
        return { id: q.id, ask: q.ask, status: a?.status ?? "not_asked", asked: Boolean(a?.asked), probed: Boolean(a?.probed), answer: a?.answer ?? "", quote: a?.quote ?? "" };
      }),
    };
  },
};

// Research in tiny bits (config/discovery.json): one question per call from the framework,
// chosen by the discovery store. One is checked in code: once the extraction sees it asked,
// the questions leave the prompt for the rest of the call. Findings are filed after the call.
type ResearchSnapshot = { areas: unknown; hypotheses: unknown; questions: unknown; recentFindings: string[] };
const research: Primitive = {
  prompt(s, c) {
    if (view<{ asked: boolean }>(c.output).asked) return `${c.r(s.title ?? "RESEARCH")}: done for this call, your one question is asked. If his answer was vague, one follow-up of your own is fine; then no more research questions in this call.`;
    const framework = frameworkOf(c);
    return `${c.r(s.instructions, { research: { startArea: framework.areas.find(a => a.phase === "start")?.title ?? "the business", questionLang: c.locales.name(framework.participant?.lang ?? c.lang) } })}\n\n${c.discovery?.context() ?? ""}`;
  },
  output: () => ({ type: "OBJECT", properties: { asked: { type: "BOOLEAN" } }, required: ["asked"] }),
  rules: (s, c) => [`- agenda.${c.key}: asked = true once the ${c.agentLabel.toLowerCase()} has asked him a research question (one of DISCOVERY QUESTION FOR THIS CALL, in any wording) in this call, else false.`],
  status: (s, out, c) => (view<{ asked: boolean }>(out).asked ? `${c.r(s.title ?? "RESEARCH")}: asked, no more research questions` : ""),
  memory: (s, c) => ({
    schema: {
      discovery: {
        type: "OBJECT",
        properties: {
          asked_question_ids: { type: "ARRAY", items: S },
          answered_question_ids: { type: "ARRAY", items: S },
          declined_question_ids: { type: "ARRAY", items: S },
          findings: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                area: { type: "STRING", enum: frameworkOf(c).areas.map(a => a.id) },
                hypothesis: S,
                stance: { type: "STRING", enum: ["supports", "contradicts", "none"] },
                kind: { type: "STRING", enum: ["fact", "number", "story", "opinion"] },
                text: S,
                quote: S,
              },
              required: ["area", "kind", "text"],
            },
          },
        },
        required: ["asked_question_ids", "answered_question_ids", "declined_question_ids", "findings"],
      },
    },
    required: ["discovery"],
    rules: c.r(s.memoryRules),
    prompt: snapshot => {
      const d = view<ResearchSnapshot>(snapshot.discovery);
      return `Research framework (areas, hypotheses, questions):
${JSON.stringify({ areas: d.areas, hypotheses: d.hypotheses, questions: d.questions })}

Recent findings (don't repeat these):
${(d.recentFindings ?? []).join("\n") || "(none)"}`;
    },
  }),
};

// A conversation, not a questionnaire: he talks about his day; the agent listens like a colleague
// and only now and then asks one light follow-up (Mom Test: what really happened, the last time,
// what it cost). Ideas and feedback he brings get the same: the problem behind them. A call can
// end mid-conversation (he arrived): what it got so far is kept, and the next call picks up where
// it stopped (`previous`: the result of earlier calls). The guide is the step's instructions.
const STORY: Schema = { type: "OBJECT", properties: { title: S, when: S, what_happened: S, what_he_did: S, cost: S, how_often: S, quote: S }, required: ["title", "what_happened", "quote"] };
const IDEA: Schema = { type: "OBJECT", properties: { idea: S, last_time: S, how_often: S, cost: S, today: S, quote: S }, required: ["idea", "quote"] };
type Story = Partial<{ title: string; when: string; what_happened: string; what_he_did: string; cost: string; how_often: string; quote: string }>;
type Idea = Partial<{ idea: string; last_time: string; how_often: string; cost: string; today: string; quote: string }>;
type Conversation = { agreed: boolean; day: string; stories: Story[]; ideas: Idea[]; open_thread: string; wrapped_up: boolean };
/** What earlier calls kept (its result), and how the last one ended. */
type ConversationKept = { days: string[]; stories: Story[]; ideas: Idea[]; open_thread: string; lastCall: { turns?: Turn[] } | null };
const sameTitle = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const addNew = <T extends object>(old: T[] = [], now: T[] = [], key: keyof T) => [...old, ...now.filter(n => !old.some(o => sameTitle(o[key], n[key])))];
const conversation: Primitive = {
  validate(s, params = {}) {
    const focus = params.focus == null ? "" : String(params.focus).trim();
    if (focus.length > 200) throw new Error("focus: one line, up to 200 characters");
    return { focus };
  },
  prompt(s, c) {
    const prev = view<ConversationKept>(c.previous);
    const { focus } = view<{ focus: string }>(c.params);
    const covered = [...(prev.stories ?? []).map(x => x.title), ...(prev.ideas ?? []).map(x => x.idea)].filter(Boolean);
    const turns = prev.lastCall?.turns ?? [];
    const last = turns.length
      ? `The last call ended like this:\n${turns.map(t => `  ${t.role === "user" ? "He" : "You"}: ${t.text}`).join("\n")}\n`
      : "";
    return [
      c.r(s.instructions),
      // A call Toni makes for a focus leads with it: "how was your day" gets "okay", the last concrete case gets a story.
      focus && c.outbound
        ? `THIS CALL'S FOCUS (why you called): ${focus}. This comes before his day in general: your one sentence why you're calling is this focus, in a few plain words, linked to what he told before if it fits (${c.r("{{q ex.knownBefore}}")}). Once he has time, ask straight away about the last concrete case of it, one small question at a time (first when it was; what happened next only after his answer), and follow that story. His day in general only afterwards, if there's time.`
        : focus ? `If it comes up naturally, Max is especially curious about: ${focus}.` : "",
      prev.open_thread || covered.length || last
        ? `FROM EARLIER CALLS: ${covered.length ? `he already told you about: ${covered.join("; ")}. ` : ""}${prev.open_thread ? `It stopped while: ${prev.open_thread}. ` : ""}\n${last}If it stopped in the middle of something, pick up from there, naming what he actually told you (in the form of ${c.r("{{q ex.dayPickUp}}")}, the … being his topic); don't start over and don't ask about what's covered again.`
        : "",
    ].filter(Boolean).join("\n");
  },
  output: () => ({
    type: "OBJECT",
    properties: { agreed: { type: "BOOLEAN" }, day: S, stories: { type: "ARRAY", items: STORY }, ideas: { type: "ARRAY", items: IDEA }, open_thread: S, wrapped_up: { type: "BOOLEAN" } },
    required: ["agreed", "day", "stories", "ideas", "open_thread", "wrapped_up"],
  }),
  rules: (s, c) => [
    `- agenda.${c.key}: the conversation about his day (${c.r(s.title)}). agreed = he's up for it (he has a few minutes, or he simply`,
    "  started telling); day = his day as he told it (yesterday, today so far or what's planned), one or two neutral sentences;",
    "  stories = things that really happened and were annoying, slow, costly or got forgotten: title (a few words), when,",
    "  what_happened, what_he_did (how he handled it), cost (time, money, nerves, as he said it), how_often, quote (his exact",
    "  words, short and telling); ideas = features or feedback he brought up himself: idea, last_time (the concrete case",
    "  behind it), how_often, cost, today (how he handles it now), quote. \"\" for whatever he didn't say; one entry per",
    "  distinct thing. open_thread = if the call ended in the middle of something (he arrived, had to go, the line dropped, a",
    "  question or story was still open): a few words on where it stopped; \"\" only if it ran out on its own. wrapped_up = true",
    `  ONLY if the ${c.agentLabel.toLowerCase()} asked whether there's anything else (or similar) and he said there isn't; a goodbye because`,
    "  he had to stop is NOT wrapped up. Values in the language of the call; never invent.",
  ],
  // Done when it ran out on its own; cut off (he arrived), it stays open and the next call picks it up.
  isDone: (s, out) => {
    const o = view<Conversation>(out);
    return Boolean(o.wrapped_up) && !o.open_thread;
  },
  status(s, out, c) {
    const o = view<Conversation>(out);
    const n = (o.stories?.length ?? 0) + (o.ideas?.length ?? 0);
    return `${c.r(s.title)}: ${o.agreed ? `${n ? `${n} thing${n === 1 ? "" : "s"} he told about so far` : "he's talking"}; keep it a conversation` : "not started yet"}`;
  },
  // Adds this call to what earlier calls got; the latest call says where it stopped.
  result(s, out, c) {
    const o = view<Conversation>(out);
    const prev = view<ConversationKept>(c.previous);
    const stories = addNew(prev.stories, o.stories ?? [], "title");
    const ideas = addNew(prev.ideas, o.ideas ?? [], "idea");
    const days = [...(prev.days ?? []), ...(o.day ? [o.day] : [])];
    const line = (...parts: (string | false | undefined)[]) => parts.filter(Boolean).join(" · ");
    return {
      days, stories, ideas, open_thread: o.open_thread ?? "",
      // the same as questions and answers, for the admin card and Max's message
      questions: [
        ...stories.map((x, i) => ({ id: `s${i + 1}`, ask: x.title, status: "answered", asked: true, probed: true, quote: x.quote ?? "",
          answer: line(x.what_happened, x.what_he_did && `what he did: ${x.what_he_did}`, x.cost && `cost: ${x.cost}`, x.how_often && `how often: ${x.how_often}`, x.when) })),
        ...ideas.map((x, i) => ({ id: `i${i + 1}`, ask: `Idea: ${x.idea}`, status: "answered", asked: true, probed: true, quote: x.quote ?? "",
          answer: line(x.last_time && `last needed: ${x.last_time}`, x.how_often && `how often: ${x.how_often}`, x.cost && `cost today: ${x.cost}`, x.today && `today: ${x.today}`) })),
      ],
    };
  },
};

export const primitives: Record<string, Primitive> = { capture, checklist, inform, ask, tell, research, conversation };
