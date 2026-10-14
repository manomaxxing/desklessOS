// What one step of a template does in a call. Every hook is optional:
//   prompt(step, ctx)          instruction text for the system prompt
//   fields(step, ctx)          note fields this step adds { properties, required } (capabilities)
//   output(step, ctx)          Gemini schema of what this step extracts under agenda.<key> (objectives)
//   rules(step, ctx)           extraction rules, one "- …" line each
//   missing(step, note, ctx)   what's still missing for the note (capabilities)
//   save(step, note)           worth saving as a note? (capabilities)
//   isDone(step, out, ctx)     checked in code after every extraction (objectives)
//   status(step, out, ctx)     one line for THIS CALL: where this step stands
//   result(step, out, ctx)     what the objective keeps after the call
//   validate(step, params)     checks and normalises an objective's params; throws on bad input
//   memory(step, ctx)          what the post-call memory step adds { schema, rules, prompt(snapshot) }
// ctx: { r(text, extra?) renders {{slots}}, lang, params, key, agentLabel, discovery, framework, locales }.

const S = { type: "STRING" };
const filled = v => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null && v !== false);
const lines = v => [].concat(v ?? []);

// He tells, the agent takes a structured note. Fields, rules and what's required come from the template.
const capture = {
  prompt: (s, c) => c.r(s.instructions),
  fields: s => ({ properties: s.fields ?? {}, required: s.required ?? [] }),
  rules: (s, c) => lines(s.rules).map(l => c.r(l)),
  missing: (s, note) => lines(s.missing).filter(g => !g.anyOf.some(k => filled(note?.[k]))).map(g => g.label),
  save: (s, note) => lines(s.save?.anyOf).some(k => filled(note?.[k])),
};

// Answers from what's known (a briefing, the agenda): instructions only, nothing to extract.
const inform = {
  prompt: (s, c) => c.r(s.instructions),
};

// The agent asks questions someone gave it ("find out X"): 1–5 questions with an optional follow-up each.
const ASK_STATUS = ["not_asked", "answered", "vague", "declined"];
const ask = {
  validate(s, params = {}) {
    const list = params.questions;
    if (!Array.isArray(list) || list.length < 1 || list.length > 5) throw new Error("questions: 1 to 5 questions");
    const text = (v, name, max = 300) => {
      if (v == null || v === "") return "";
      if (typeof v !== "string" || v.length > max) throw new Error(`${name}: text up to ${max} characters`);
      return v.trim();
    };
    const questions = list.map((q, i) => {
      const ask = text(typeof q === "string" ? q : q?.ask, `questions[${i}].ask`);
      if (ask.length < 3) throw new Error(`questions[${i}].ask: the question is missing`);
      return { id: `q${i + 1}`, ask, probe: text(q?.probe, `questions[${i}].probe`), required: q?.required !== false };
    });
    return { purpose: text(params.purpose, "purpose"), questions };
  },
  prompt(s, c) {
    const { questions, purpose } = c.params;
    const written = c.questionLang ? ` They are written in ${c.locales.name(c.questionLang)}; ask in the language of the call.` : "";
    return [
      `${c.r(s.title ?? "MAX'S QUESTION")}${purpose ? ` (${purpose})` : ""}: ${questions.length === 1 ? "ask this" : "ask these, one at a time"}.${written}`,
      ...questions.map(q => `   ${q.id}: "${q.ask}"${q.probe ? ` If his answer is vague, one follow-up: "${q.probe}"` : ""}${q.required ? "" : " (only if he has time)"}`),
    ].join("\n");
  },
  output: (s, c) => ({
    type: "OBJECT",
    properties: Object.fromEntries(c.params.questions.map(q => [q.id, {
      type: "OBJECT",
      properties: { asked: { type: "BOOLEAN" }, probed: { type: "BOOLEAN" }, status: { type: "STRING", enum: ASK_STATUS }, answer: S, quote: S },
      required: ["asked", "probed", "status", "answer", "quote"],
    }])),
    required: c.params.questions.map(q => q.id),
  }),
  rules: (s, c) => [
    `- agenda.${c.key}: the questions under "${c.r(s.title ?? "MAX'S QUESTION")}" (${c.params.questions.map(q => `${q.id} "${q.ask}"`).join("; ")}).`,
    `  Per question: asked = true once the ${c.agentLabel.toLowerCase()} asked it, in any wording; probed = true once it asked a`,
    `  follow-up to his answer; status = "answered" when he gave a real answer, "vague" when he answered without a concrete`,
    `  case or number (a bare "yes", "okay" or "it depends" to an open question is vague), "declined" when he had no time or`,
    `  didn't want to, else "not_asked"; answer = his answer in one neutral sentence, in the language of the call; quote = his`,
    "  exact words if short and telling, else \"\". An answer he gives before being asked counts too. Never invent an answer.",
  ],
  // Vague counts only once the follow-up was asked: "find out X" presses once for a real answer.
  isDone: (s, out, c) => c.params.questions.filter(q => q.required).every(q => {
    const a = out?.[q.id];
    return a?.status === "answered" || a?.status === "declined" || (a?.status === "vague" && a.probed);
  }),
  status(s, out, c) {
    const label = a => ({
      answered: "answered, don't ask again",
      declined: "declined, don't ask again",
      vague: a?.probed ? "still vague after the follow-up, move on" : "vague: ask the one follow-up now",
    })[a?.status] ?? (a?.asked ? "asked, no answer yet" : "not asked yet");
    return `${c.r(s.title ?? "MAX'S QUESTION")}: ${c.params.questions.map(q => `${q.id} ${label(out?.[q.id])}`).join("; ")}`;
  },
  result: (s, out, c) => ({
    questions: c.params.questions.map(q => ({ id: q.id, ask: q.ask, status: out?.[q.id]?.status ?? "not_asked", asked: Boolean(out?.[q.id]?.asked), probed: Boolean(out?.[q.id]?.probed), answer: out?.[q.id]?.answer ?? "", quote: out?.[q.id]?.quote ?? "" })),
  }),
};

// The pilot week's research (config/discovery.json): one question per call from the
// framework, chosen by the discovery store. Findings are filed by the post-call step.
const research = {
  prompt: (s, c) => `${c.r(s.instructions, { research: { startArea: c.framework.areas.find(a => a.phase === "start")?.title ?? "the business" } })}\n\n${c.discovery.context()}`,
  status: () => "",
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
                area: { type: "STRING", enum: c.framework.areas.map(a => a.id) },
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
      const d = snapshot.discovery ?? {};
      return `Research framework (areas, hypotheses, questions):
${JSON.stringify({ areas: d.areas, hypotheses: d.hypotheses, questions: d.questions })}

Recent findings (don't repeat these):
${(d.recentFindings ?? []).join("\n") || "(none)"}`;
    },
  }),
};

export const primitives = { capture, inform, ask, research };
