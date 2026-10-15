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
// ctx: { r(text, extra?) renders {{slots}}, lang, params, key, agentLabel, discovery, framework, locales,
//        previous (an objective's result from earlier calls), tools (the tool names this call has) }.
// Primitives: capture (a note), inform (answer from what's known), ask (Max's questions),
// tell (one thing to tell him, once), research (the pilot week's questions), conversation
// (his day, a listening conversation).

const S = { type: "STRING" };
const filled = v => (Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null && v !== false);
const lines = v => [].concat(v ?? []);

// He tells, the agent takes a structured note. Fields, rules and what's required come from the template.
const capture = {
  // A tool's instructions only when the call has that tool: a rule about a tool it doesn't have
  // would have the agent claim to do what it can't ("it's on its way to your WhatsApp").
  prompt: (s, c) => [c.r(s.instructions), ...Object.entries(s.toolInstructions ?? {}).filter(([name]) => c.tools?.includes(name)).map(([, text]) => c.r(text))].join("\n"),
  fields: s => ({ properties: s.fields ?? {}, required: s.required ?? [] }),
  rules: (s, c) => lines(s.rules).map(l => c.r(l)),
  missing: (s, note) => lines(s.missing).filter(g => !g.anyOf.some(k => filled(note?.[k]))).map(g => g.label),
  save: (s, note) => lines(s.save?.anyOf).some(k => filled(note?.[k])),
};

// Answers from what's known (a briefing, the agenda): instructions only, nothing to extract.
const inform = {
  prompt: (s, c) => c.r(s.instructions),
};

// One thing to tell him, once, at the end of a call (a feature just switched on for him).
// Done once the extraction sees it was said, in any wording.
const tell = {
  validate(s, params = {}) {
    const message = String(params.message ?? "").trim();
    if (message.length < 3 || message.length > 400) throw new Error("message: what to tell him, up to 400 characters");
    return { feature: String(params.feature ?? "").slice(0, 40), message };
  },
  prompt: (s, c) => `${c.r(s.title ?? "TELL HIM")}: news for him, not a question. Once, as a short heads-up in one or two sentences of your own (don't read it out word for word, don't start with "Kurze Frage", don't ask whether he likes it): "${c.params.message}" If he already used it in this call, skip it: it counts as told.`,
  output: () => ({ type: "OBJECT", properties: { told: { type: "BOOLEAN" } }, required: ["told"] }),
  rules: (s, c) => [`- agenda.${c.key}: told = true once the ${c.agentLabel.toLowerCase()} has told him this, in any wording, or he already used it in this call: "${c.params.message}".`],
  isDone: (s, out) => Boolean(out?.told),
  status: (s, out, c) => `${c.r(s.title ?? "TELL HIM")}: ${out?.told ? "told, don't repeat it" : "not told yet"}`,
  result: (s, out) => ({ told: Boolean(out?.told) }),
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
  prompt: (s, c) => `${c.r(s.instructions, { research: { startArea: c.framework.areas.find(a => a.phase === "start")?.title ?? "the business", questionLang: c.locales.name(c.framework.participant?.lang ?? c.lang) } })}\n\n${c.discovery.context()}`,
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

// A conversation, not a questionnaire: he talks about his day; the agent listens like a colleague
// and only now and then asks one light follow-up (Mom Test: what really happened, the last time,
// what it cost). Ideas and feedback he brings get the same: the problem behind them. A call can
// end mid-conversation (he arrived): what it got so far is kept, and the next call picks up where
// it stopped (`previous`: the result of earlier calls). The guide is the step's instructions.
const STORY = { type: "OBJECT", properties: { title: S, when: S, what_happened: S, what_he_did: S, cost: S, how_often: S, quote: S }, required: ["title", "what_happened", "quote"] };
const IDEA = { type: "OBJECT", properties: { idea: S, last_time: S, how_often: S, cost: S, today: S, quote: S }, required: ["idea", "quote"] };
const sameTitle = (a, b) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();
const addNew = (old = [], now = [], key) => [...old, ...now.filter(n => !old.some(o => sameTitle(o[key], n[key])))];
const conversation = {
  validate(s, params = {}) {
    const focus = params.focus == null ? "" : String(params.focus).trim();
    if (focus.length > 200) throw new Error("focus: one line, up to 200 characters");
    return { focus };
  },
  prompt(s, c) {
    const prev = c.previous;
    const covered = [...(prev?.stories ?? []).map(x => x.title), ...(prev?.ideas ?? []).map(x => x.idea)].filter(Boolean);
    const last = prev?.lastCall?.turns?.length
      ? `The last call ended like this:\n${prev.lastCall.turns.map(t => `  ${t.role === "user" ? "He" : "You"}: ${t.text}`).join("\n")}\n`
      : "";
    return [
      c.r(s.instructions),
      // A call Toni makes for a focus leads with it: "how was your day" gets "okay", the last concrete case gets a story.
      c.params.focus && c.outbound
        ? `THIS CALL'S FOCUS (why you called): ${c.params.focus}. This comes before his day in general: your one sentence why you're calling is this focus, in a few plain words, linked to what he told before if it fits (${c.r("{{q ex.knownBefore}}")}). Once he has time, ask straight away about the last concrete case of it (when it was, what happened next), and follow that story. His day in general only afterwards, if there's time.`
        : c.params.focus ? `If it comes up naturally, Max is especially curious about: ${c.params.focus}.` : "",
      prev?.open_thread || covered.length || last
        ? `FROM EARLIER CALLS: ${covered.length ? `he already told you about: ${covered.join("; ")}. ` : ""}${prev?.open_thread ? `It stopped while: ${prev.open_thread}. ` : ""}\n${last}If it stopped in the middle of something, pick up from there, naming what he actually told you (in the form of ${c.r("{{q ex.dayPickUp}}")}, the … being his topic); don't start over and don't ask about what's covered again.`
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
  isDone: (s, out) => Boolean(out?.wrapped_up) && !out?.open_thread,
  status(s, out, c) {
    const n = (out?.stories?.length ?? 0) + (out?.ideas?.length ?? 0);
    return `${c.r(s.title)}: ${out?.agreed ? `${n ? `${n} thing${n === 1 ? "" : "s"} he told about so far` : "he's talking"}; keep it a conversation` : "not started yet"}`;
  },
  // Adds this call to what earlier calls got; the latest call says where it stopped.
  result(s, out, c) {
    const prev = c.previous ?? {};
    const stories = addNew(prev.stories, out?.stories ?? [], "title");
    const ideas = addNew(prev.ideas, out?.ideas ?? [], "idea");
    const days = [...(prev.days ?? []), ...(out?.day ? [out.day] : [])];
    const line = (...parts) => parts.filter(Boolean).join(" · ");
    return {
      days, stories, ideas, open_thread: out?.open_thread ?? "",
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

export const primitives = { capture, inform, ask, tell, research, conversation };
