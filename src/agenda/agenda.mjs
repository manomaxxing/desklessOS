// One call's agenda: the persona, what he can ask for (capability templates)
// and what the agent brings (objective instances: the pilot's research, Max's
// questions). It writes the system prompt, the note extraction (one schema for
// his note and the objectives' answers), checks after every extraction which
// objectives are done, and says what each objective got at the end.
//
// The prompt goes static → per call → per turn, so the long static part is the
// same request prefix on every turn (Gemini's implicit prefix caching):
//   persona, jobs, output format, tools | today, own agenda, memory | THIS CALL

import { render } from "./render.mjs";
import { primitives } from "./primitives.mjs";
import { toolRules } from "../tools/prompt.mjs";
import { promptDate, promptWeekday } from "../locale/index.mjs";

const LETTERS = "ABCDEFGHIJ";
const P = step => primitives[step.primitive];

/**
 * persona: parsed personas/<id>.md. capabilities: capability templates, in order.
 * objectives: [{ id, key, template, params, stored, questionLang }] (key: where its answers go in the extraction).
 * profile: who the persona serves ({{profile.*}}).
 */
export function createAgenda({ persona, capabilities, objectives = [], profile, locales, discovery = null, framework = null, direction = "inbound" }) {
  const items = objectives.map(o => ({ ...o, output: undefined, done: false }));
  const outbound = direction === "outbound";
  let last = {}; // the latest extraction, his note and the objectives' answers
  let outcome = { consent: "unknown", callbackWhen: "" }; // outbound: did he agree to talk, call back when

  function slotContext(lang) {
    const lines = locales.persona(lang, persona.id) ?? {};
    const exAll = {};
    for (const id of locales.enabled()) {
      for (const [k, v] of Object.entries(locales.persona(id, persona.id)?.examples ?? {})) (exAll[k] ??= []).push(v);
    }
    return { ex: lines.examples ?? {}, lines, exAll, lang: { id: lang, name: locales.name(lang) }, langs: { names: locales.enabled().map(locales.name) }, profile };
  }
  const renderer = (lang, where) => {
    const ctx = slotContext(lang);
    return (text, extra) => render(text, extra ? { ...ctx, ...extra } : ctx, where);
  };
  const stepContext = (item, lang) => ({
    r: renderer(lang, item ? `templates/${item.template.id}` : `personas/${persona.id}`),
    lang, locales, discovery, framework,
    params: item?.params ?? {}, key: item?.key, questionLang: item?.questionLang ?? null,
    agentLabel: persona.agentLabel ?? "Agent",
  });
  const stepsText = (t, item, lang) => t.steps.map(s => P(s).prompt?.(s, stepContext(item, lang)) ?? "").filter(Boolean).join("\n");

  function missing(note) {
    if (!note) return [];
    const cap = note.mode ? capabilities.find(t => t.mode.id === note.mode) : capabilities.find(t => t.mode.default);
    if (!cap) return [];
    return cap.steps.flatMap(s => P(s).missing?.(s, note, stepContext(null, profile.lang)) ?? []);
  }

  function statusLines(lang) {
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
    prompt({ engine = "cascade", lang = profile.lang, note = {}, missing: miss = missing(note), memory = "", tools = [], today = promptDate() }) {
      const r = renderer(lang, `personas/${persona.id}`);
      const section = name => r(persona.sections[name]);
      const jobs = capabilities.map((t, i) => `${LETTERS[i]}) ${r(t.title)}\n${stepsText(t, null, lang)}`);
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
        `Today is ${today}.`,
        outbound ? section("outbound") : "",
        own.length ? `${section("agenda")}\n\nItems for this call, in this order:\n${own.join("\n\n")}` : "",
        `MEMORY (persists across calls: to-dos, customers and their notes):\n${memory || "(empty)"}`,
        // per turn
        `THIS CALL (changes every turn, so it comes last):
The note so far (may lag one turn behind):
${JSON.stringify(note ?? {}, null, 0)}
Still missing: ${miss?.length ? miss.join(", ") : "nothing"}${status.length ? `\nYour own agenda so far: ${status.join(" | ")}` : ""}`,
      ].filter(Boolean).join("\n\n");
    },

    /** One schema for the slow path: his note (mode + the capabilities' fields) and agenda.<key> per objective. */
    schema() {
      const properties = { mode: { type: "STRING", enum: [...new Set([...capabilities.map(t => t.mode.id), "unclear"])] } };
      const required = ["mode"];
      for (const t of capabilities) {
        for (const s of t.steps) {
          const f = P(s).fields?.(s);
          if (f) { Object.assign(properties, f.properties); required.push(...f.required); }
        }
      }
      const agenda = {};
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
      const ruleLines = item => t => t.steps.flatMap(s => P(s).rules?.(s, stepContext(item, lang)) ?? []);
      return [
        ...intro,
        `- mode: ${modes}; otherwise "unclear".`,
        ...modeRules,
        ...capabilities.flatMap(ruleLines(null)),
        ...general,
        ...items.flatMap(o => ruleLines(o)(o.template)),
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
      const { agenda: answers = {}, call_consent: consent, callback_when: callbackWhen, ...note } = last;
      if (outbound) outcome = { consent: consent ?? "unknown", callbackWhen: callbackWhen ?? "" };
      const changes = [];
      for (const o of items) {
        if (!(o.key in answers)) continue;
        o.output = answers[o.key];
        const checks = o.template.steps.filter(s => P(s).isDone);
        const done = checks.length > 0 && checks.every(s => P(s).isDone(s, o.output, stepContext(o, profile.lang)));
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
        result: Object.assign({}, ...o.template.steps.map(s => P(s).result?.(s, o.output, stepContext(o, profile.lang)) ?? {})),
      }));
    },
  };
}
