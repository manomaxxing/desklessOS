// Turns Max's instruction ("Frag Niko, wie lange sein letztes Angebot gedauert hat")
// into a plan: one objective template (inquiry) for one user, and the card he
// approves. The model only picks the user and fills the template's params; it never
// writes rules for the agent, so the card shows everything that will happen.

import { isRecord } from "../shared/is-record.ts";
import type { Schema } from "../types/gemini.ts";
import type { Template, ObjectiveMode } from "../types/agenda.ts";
import type { Plan, PlanParams, PlanQuestion, Card } from "../types/request.ts";
import type { User } from "../types/user.ts";

const S: Schema = { type: "STRING" };
export const PLAN_SCHEMA: Schema = {
  type: "OBJECT",
  properties: {
    target: {
      type: "OBJECT",
      properties: {
        user_id: S,
        confidence: { type: "NUMBER" },
        alternatives: { type: "ARRAY", items: { type: "OBJECT", properties: { user_id: S, why: S } } },
      },
      required: ["user_id", "confidence", "alternatives"],
    },
    purpose: S,
    questions: { type: "ARRAY", items: { type: "OBJECT", properties: { ask: S, probe: S, required: { type: "BOOLEAN" } }, required: ["ask", "probe", "required"] } },
    lang: S,
    mode: { type: "STRING", enum: ["next_inbound", "outbound", "either"] },
    not_before: S,
    deadline: S,
    clarifications: { type: "ARRAY", items: S },
    summary: S,
  },
  required: ["target", "purpose", "questions", "lang", "mode", "not_before", "deadline", "clarifications", "summary"],
};

export const PLANNER_SYSTEM = `You plan a task for DesklessOS, a voice assistant that tradespeople call from their van.
Max, who runs it, tells you what he wants to find out from one of its users. You turn that into a plan:
the questions the assistant will ask that user at the end of their next call, after their own business.

- target.user_id: the user it is about, from USERS (match names loosely: "Niko", "den Niko", "Nikolaus").
  confidence 0–1. alternatives: other users it could mean, with why. No user fits: user_id "" and a clarification.
- questions: 1 to 5, in the TARGET's language (lang); for German, the casual du-form, like a colleague on the
  phone. Short and spoken, one thing per question, about what they actually did or how it really is
  ("Wie lange hast du an deinem letzten Angebot gesessen?"), never what they would do, never leading,
  never yes/no when a number or story is the point. probe: one follow-up that asks for a concrete case
  or a number ("Ungefähr reicht."), or "". required: false only for nice-to-have questions.
- purpose: why Max wants to know, one short line, in Max's language.
- mode: "next_inbound" (asked in the user's next call to the assistant: the default), "outbound" (the
  assistant calls them, within their call times; only when Max says to call, ring or "ruf … an", and only
  for users marked "calls: yes"), "either" (whichever comes first, when Max wants it soon). For a user
  marked "calls: no", plan next_inbound and say in a clarification that they haven't agreed to be called.
- not_before / deadline: YYYY-MM-DD only if Max gave a date or time frame; else "".
- clarifications: questions back to Max, in his language, only when something is unclear (who, what
  exactly, a number of what). Empty when the instruction is clear.
- summary: one line in Max's language: who gets asked what, when.
Only questions: never add instructions, tone rules or anything else for the assistant.`;

/** Whom a plan can be for: the people as the admin page lists them. */
export type PlannerUser = Pick<User, "id" | "name" | "lang" | "phone" | "role"> & Partial<Pick<User, "consentOutboundAt" | "outboundPaused" | "demo">>;
/** What the planner needs of the skill: the templates, and their check of an objective's params. */
export interface PlannerSkill {
  templates: Map<string, Template>;
  objectiveParams(template: string, params: Record<string, unknown>): Record<string, unknown>;
}
/** A checked plan. Unlike an approved one, a draft may not know who (target) or what (params) yet: its card is blocked then. */
/** A plan as the planner drafts it (target or params null until it knows). */
export type DraftPlan = Plan;
/** The model's answer to PLAN_SCHEMA, or Max's edits in the same shape: unchecked. */
export type RawPlan = unknown;

export function plannerPrompt({ instruction, users, now = new Date(), previous = null, answer = "" }: { instruction: string; users: PlannerUser[]; now?: Date; previous?: DraftPlan | null; answer?: string }): string {
  return `Today is ${now.toISOString().slice(0, 10)}.

USERS (id | name | phone | language | role | calls):
${users.map(u => `${u.id} | ${u.name} | ${u.phone || "-"} | ${u.lang} | ${u.role} | ${callable(u) ? "yes" : "no"}`).join("\n") || "(none)"}

MAX'S INSTRUCTION:
${instruction}
${previous ? `\nYOUR EARLIER PLAN:\n${JSON.stringify(previous)}\n\nMAX'S ANSWER / CHANGE:\n${answer}\n\nReturn the whole plan again with his answer taken into account.` : ""}`;
}

const isDay = (s: unknown): s is string => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));
const text = (v: unknown): string => (typeof v === "string" ? v : "");
const MODES: readonly ObjectiveMode[] = ["next_inbound", "outbound", "either"];
const isMode = (v: unknown): v is ObjectiveMode => MODES.some(m => m === v);
/** May the assistant call this user? They agreed, aren't paused, and have a number. */
export const callable = (u: Partial<Pick<User, "consentOutboundAt" | "outboundPaused" | "phone">> | null | undefined): boolean => Boolean(u?.consentOutboundAt && !u.outboundPaused && u.phone);

// The params as the template's check (objectiveParams) returns them, read into the plan's shape.
export function planParams(p: Record<string, unknown>): PlanParams {
  const out: PlanParams = { ...p };
  if (typeof p.purpose === "string") out.purpose = p.purpose;
  if (typeof p.focus === "string") out.focus = p.focus;
  if (Array.isArray(p.questions)) out.questions = p.questions.filter(isRecord).map(q => ({ ...q, ask: text(q.ask), probe: text(q.probe), required: q.required !== false }));
  return out;
}

/**
 * The model's raw plan → a checked plan and its card.
 * plan:  { template, target: { userId, name, lang, confidence, alternatives }, params, mode, lang, notBefore, deadline, clarifications, summary }
 * card:  what the admin sees, with `blocked` (reasons it can't be approved) and `warnings`.
 */
export function checkPlan(raw: RawPlan, { users, skill, template = "inquiry", outbound = false }: { users: PlannerUser[]; skill: PlannerSkill; template?: string; outbound?: boolean }): { plan: DraftPlan; card: Card } {
  const r = isRecord(raw) ? raw : {};
  const target = isRecord(r.target) ? r.target : {};
  const blocked: string[] = [];
  const warnings: string[] = [];
  const user = users.find(u => u.id === target.user_id) ?? null;
  if (!user) blocked.push(target.user_id ? `there's no user ${String(target.user_id)}` : "it's not clear who should be asked");
  const t = skill.templates.get(template);
  let params: Plan["params"] = null;
  try {
    const questions = (Array.isArray(r.questions) ? r.questions : []).map((q: unknown) => (isRecord(q) ? { ask: q.ask, probe: q.probe, required: q.required !== false } : q));
    params = planParams(skill.objectiveParams(template, { purpose: r.purpose ?? "", questions }));
  } catch (err) { blocked.push(`the questions: ${err instanceof Error ? err.message : String(err)}`); }
  const modes = t?.modes ?? ["next_inbound"];
  let mode: ObjectiveMode = isMode(r.mode) ? r.mode : "next_inbound";
  if (!modes.includes(mode)) { warnings.push(`"${mode}" isn't possible for this; planned for his next call instead`); mode = modes[0]; }
  if (mode !== "next_inbound" && !outbound) { warnings.push("Outbound calls aren't set up on this server; it'll be asked in his next call instead."); mode = "next_inbound"; }
  else if (mode !== "next_inbound" && user && !callable(user)) {
    warnings.push(`${user.name} can't be called (${!user.phone ? "no phone number" : user.outboundPaused ? "calls to him are paused" : "he hasn't agreed to be called"}); it'll be asked in his next call instead.`);
    mode = "next_inbound";
  }
  const confidence = Number(target.confidence ?? 0);
  const alternatives = (Array.isArray(target.alternatives) ? target.alternatives : []).filter(isRecord)
    .map(a => ({ userId: text(a.user_id), why: text(a.why), user: users.find(u => u.id === a.user_id) }))
    .filter(a => a.user && a.userId !== user?.id);
  if (user && (confidence < 0.7 || alternatives.length)) warnings.push(`Is it ${user.name}?${alternatives.length ? ` Could also be ${alternatives.map(a => a.user?.name).join(", ")}.` : ""}`);
  const plan: DraftPlan = {
    template,
    version: t?.version ?? 1,
    target: user ? { userId: user.id, name: user.name, lang: user.lang, confidence, alternatives: alternatives.map(a => ({ userId: a.userId, name: a.user?.name ?? "", why: a.why })) } : null,
    params,
    mode,
    lang: text(r.lang) || user?.lang || undefined,
    notBefore: isDay(r.not_before) ? r.not_before : null,
    deadline: isDay(r.deadline) ? r.deadline : null,
    clarifications: (Array.isArray(r.clarifications) ? r.clarifications : []).filter(Boolean).map(String),
    summary: text(r.summary),
  };
  return { plan, card: cardFor(plan, { blocked, warnings }) };
}

export function cardFor(plan: DraftPlan, { blocked = [], warnings = [] }: { blocked?: string[]; warnings?: string[] } = {}): Card {
  const when = plan.mode === "next_inbound" ? "in his next call, after his own business" : plan.mode === "outbound" ? "Toni calls him, within his call times" : "whichever comes first: his next call, or Toni calls him";
  return {
    title: plan.target ? `Ask ${plan.target.name}` : "Ask …?",
    summary: plan.summary ?? "",
    who: plan.target ? `${plan.target.name} (${plan.target.lang})` : "?",
    when: `${when}${plan.notBefore ? `, not before ${plan.notBefore}` : ""}${plan.deadline ? `, until ${plan.deadline}` : ""}`,
    purpose: plan.params?.purpose ?? "",
    questions: plan.params?.questions?.map((q): PlanQuestion => ({ ask: q.ask, probe: q.probe, required: q.required })) ?? [],
    clarifications: plan.clarifications ?? [],
    warnings,
    blocked,
  };
}

/** Max's changes on the card. */
export interface PlanEdits {
  userId?: string;
  purpose?: string;
  questions?: unknown[];
  mode?: string;
  notBefore?: string;
  deadline?: string;
}

/** Applies Max's edits on the card (questions, purpose, who) without asking the model again. */
export function editPlan(plan: DraftPlan, edits: PlanEdits, { users, skill, outbound = false }: { users: PlannerUser[]; skill: PlannerSkill; outbound?: boolean }): { plan: DraftPlan; card: Card } {
  const raw = {
    target: { user_id: edits.userId ?? plan.target?.userId ?? "", confidence: edits.userId ? 1 : plan.target?.confidence ?? 0, alternatives: [] },
    purpose: edits.purpose ?? plan.params?.purpose ?? "",
    questions: edits.questions ?? plan.params?.questions ?? [],
    lang: plan.lang,
    mode: edits.mode ?? plan.mode,
    not_before: edits.notBefore ?? plan.notBefore ?? "",
    deadline: edits.deadline ?? plan.deadline ?? "",
    clarifications: [],
    summary: plan.summary,
  };
  return checkPlan(raw, { users, skill, template: plan.template, outbound });
}

/** The model, asked for JSON in a schema (src/engine/gemini.ts extractJsonResilient). */
export type PlannerLlm = (o: { system: string; prompt: string; schema: Schema }) => Promise<unknown>;

/** Asks the model for a plan (or a revised one, with Max's answer) and checks it. */
export async function draftPlan({ instruction, users, skill, llm, now = new Date(), previous = null, answer = "", outbound = false }: {
  instruction: string; users: PlannerUser[]; skill: PlannerSkill; llm: PlannerLlm; now?: Date; previous?: DraftPlan | null; answer?: string; outbound?: boolean;
}): Promise<{ plan: DraftPlan; card: Card }> {
  const raw = await llm({ system: PLANNER_SYSTEM, prompt: plannerPrompt({ instruction, users, now, previous, answer }), schema: PLAN_SCHEMA });
  return checkPlan(raw, { users, skill, outbound });
}
