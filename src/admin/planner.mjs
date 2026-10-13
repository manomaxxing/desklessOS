// Turns Max's instruction ("Frag Niko, wie lange sein letztes Angebot gedauert hat")
// into a plan: one objective template (inquiry) for one user, and the card he
// approves. The model only picks the user and fills the template's params; it never
// writes rules for the agent, so the card shows everything that will happen.

const S = { type: "STRING" };
export const PLAN_SCHEMA = {
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

export function plannerPrompt({ instruction, users, now = new Date(), previous = null, answer = "" }) {
  return `Today is ${now.toISOString().slice(0, 10)}.

USERS (id | name | phone | language | role | calls):
${users.map(u => `${u.id} | ${u.name} | ${u.phone || "-"} | ${u.lang} | ${u.role} | ${callable(u) ? "yes" : "no"}`).join("\n") || "(none)"}

MAX'S INSTRUCTION:
${instruction}
${previous ? `\nYOUR EARLIER PLAN:\n${JSON.stringify(previous)}\n\nMAX'S ANSWER / CHANGE:\n${answer}\n\nReturn the whole plan again with his answer taken into account.` : ""}`;
}

const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));
/** May the assistant call this user? They agreed, aren't paused, and have a number. */
export const callable = u => Boolean(u?.consentOutboundAt && !u.outboundPaused && u.phone);

/**
 * The model's raw plan → a checked plan and its card.
 * plan:  { template, target: { userId, name, lang, confidence, alternatives }, params, mode, lang, notBefore, deadline, clarifications, summary }
 * card:  what the admin sees, with `blocked` (reasons it can't be approved) and `warnings`.
 */
export function checkPlan(raw, { users, skill, template = "inquiry", outbound = false }) {
  const blocked = [];
  const warnings = [];
  const user = users.find(u => u.id === raw?.target?.user_id) ?? null;
  if (!user) blocked.push(raw?.target?.user_id ? `there's no user ${raw.target.user_id}` : "it's not clear who should be asked");
  const t = skill.templates.get(template);
  let params = null;
  try {
    params = skill.objectiveParams(template, { purpose: raw?.purpose ?? "", questions: (raw?.questions ?? []).map(q => ({ ask: q.ask, probe: q.probe, required: q.required !== false })) });
  } catch (err) { blocked.push(`the questions: ${err.message}`); }
  const modes = t?.modes ?? ["next_inbound"];
  let mode = raw?.mode ?? "next_inbound";
  if (!modes.includes(mode)) { warnings.push(`"${mode}" isn't possible for this; planned for his next call instead`); mode = modes[0]; }
  if (mode !== "next_inbound" && !outbound) { warnings.push("Outbound calls aren't set up on this server; it'll be asked in his next call instead."); mode = "next_inbound"; }
  else if (mode !== "next_inbound" && user && !callable(user)) {
    warnings.push(`${user.name} can't be called (${!user.phone ? "no phone number" : user.outboundPaused ? "calls to him are paused" : "he hasn't agreed to be called"}); it'll be asked in his next call instead.`);
    mode = "next_inbound";
  }
  const confidence = Number(raw?.target?.confidence ?? 0);
  const alternatives = (raw?.target?.alternatives ?? []).map(a => ({ ...a, user: users.find(u => u.id === a.user_id) })).filter(a => a.user && a.user_id !== user?.id);
  if (user && (confidence < 0.7 || alternatives.length)) warnings.push(`Is it ${user.name}?${alternatives.length ? ` Could also be ${alternatives.map(a => a.user.name).join(", ")}.` : ""}`);
  const plan = {
    template,
    version: t?.version ?? 1,
    target: user ? { userId: user.id, name: user.name, lang: user.lang, confidence, alternatives: alternatives.map(a => ({ userId: a.user_id, name: a.user.name, why: a.why ?? "" })) } : null,
    params,
    mode,
    lang: raw?.lang || user?.lang || null,
    notBefore: isDay(raw?.not_before) ? raw.not_before : null,
    deadline: isDay(raw?.deadline) ? raw.deadline : null,
    clarifications: (raw?.clarifications ?? []).filter(Boolean),
    summary: raw?.summary ?? "",
  };
  return { plan, card: cardFor(plan, { blocked, warnings }) };
}

export function cardFor(plan, { blocked = [], warnings = [] } = {}) {
  const when = plan.mode === "next_inbound" ? "in his next call, after his own business" : plan.mode === "outbound" ? "the assistant calls him, within his call times" : "whichever comes first: his next call, or the assistant calls him";
  return {
    title: plan.target ? `Ask ${plan.target.name}` : "Ask …?",
    summary: plan.summary,
    who: plan.target ? `${plan.target.name} (${plan.target.lang})` : "?",
    when: `${when}${plan.notBefore ? `, not before ${plan.notBefore}` : ""}${plan.deadline ? `, until ${plan.deadline}` : ""}`,
    purpose: plan.params?.purpose ?? "",
    questions: plan.params?.questions?.map(q => ({ ask: q.ask, probe: q.probe, required: q.required })) ?? [],
    clarifications: plan.clarifications,
    warnings,
    blocked,
  };
}

/** Applies Max's edits on the card (questions, purpose, who) without asking the model again. */
export function editPlan(plan, edits, { users, skill, outbound = false }) {
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

/** Asks the model for a plan (or a revised one, with Max's answer) and checks it. */
export async function draftPlan({ instruction, users, skill, llm, now = new Date(), previous = null, answer = "", outbound = false }) {
  const raw = await llm({ system: PLANNER_SYSTEM, prompt: plannerPrompt({ instruction, users, now, previous, answer }), schema: PLAN_SCHEMA });
  return checkPlan(raw, { users, skill, outbound });
}
