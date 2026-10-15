import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { render, slots } from "../src/agenda/render.mjs";
import { loadTemplates, loadPersona, parsePersona } from "../src/agenda/templates.mjs";
import { loadSkillFromTemplates } from "../src/skills/from-templates.mjs";
import { createDiscovery, loadFramework } from "../src/memory/research.mjs";
import { loadLocales, LOCALES_DIR } from "../src/locale/index.mjs";

const tmp = () => mkdtempSync(path.join(tmpdir(), "deskless-agenda-"));
const question = { template: "inquiry", params: { purpose: "how long quotes take", questions: [{ ask: "Wie lange hast du an deinem letzten Angebot gesessen?", probe: "Ungefähr reicht." }] } };

test("render: filters, and a missing slot is an error, not a silent gap", () => {
  const ctx = { ex: { confirm: "Passt das?", list: ["a", "b"], back: ["x at y?", "x bei y?"] }, lang: { name: "German" } };
  assert.equal(render("{{q ex.confirm}} {{qs ex.list}} {{qq ex.list}} {{ex.list}} {{upper lang.name}}", ctx), '"Passt das?" "a", "b" "a" "b" a, b GERMAN');
  assert.equal(render("{{alts ex.back}}", ctx), '"x at y" / "x bei y"');
  assert.throws(() => render("{{q ex.nope}}", ctx, "t"), /t: no value for \{\{q ex.nope\}\}/);
  assert.deepEqual(slots(["{{q ex.a}}", "{{b.c}}"]), ["ex.a", "b.c"]);
});

test("personas: frontmatter and every required section", () => {
  assert.throws(() => parsePersona("---\nid: x\n---\n## role\nhi\n", "x.md"), /section "## language" missing/);
  const p = loadPersona("notebook");
  assert.deepEqual(p.capabilities, ["notebook.capture", "notebook.brief", "notebook.agenda"]);
  assert.deepEqual(p.standing, ["research.discovery"]);
  assert.deepEqual(loadPersona("admin").standing, []);
});

test("every persona renders in every language and both engines, the test-only 'xx' pack included", () => {
  const dir = tmp();
  for (const f of readdirSync(LOCALES_DIR).filter(f => f.endsWith(".json"))) copyFileSync(path.join(LOCALES_DIR, f), path.join(dir, f));
  copyFileSync(new URL("./fixtures/locales/xx.json", import.meta.url), path.join(dir, "xx.json"));
  const locales = loadLocales(dir, { only: "de,en,xx", fallback: "de" });
  for (const name of ["pilot", "admin"]) {
    const skill = loadSkillFromTemplates(name, { locales });
    const objectives = [{ id: "obj_1", ...question, params: skill.objectiveParams("inquiry", question.params) }];
    const agenda = skill.createAgenda({ objectives, discovery: skill.framework ? createDiscovery({ framework: skill.framework }) : null });
    for (const lang of ["de", "en", "xx"]) {
      for (const engine of ["cascade", "live"]) {
        const prompt = agenda.prompt({ engine, lang, tools: agenda.tools() });
        assert.doesNotMatch(prompt, /\{\{|undefined|\[object Object\]/, `${name} ${lang} ${engine}`);
        if (engine === "live") assert.match(prompt, /call end_call/, "Live hangs up with its tool, not a header");
        else assert.match(prompt, /NEXT: <listen/);
      }
      assert.doesNotMatch(agenda.extractSystem(lang), /\{\{|undefined/);
    }
    if (name === "pilot") assert.match(agenda.prompt({ lang: "xx" }), /Then ask "xx:Sound right\?"/, "examples come from the xx pack");
  }
});

test("templates: capabilities name their mode; objectives their primitive", () => {
  const t = loadTemplates();
  for (const id of ["notebook.capture", "notebook.brief", "notebook.agenda", "research.discovery", "inquiry", "admin.requests"]) assert.ok(t.has(id), id);
  assert.equal(t.get("notebook.capture").mode.default, true);
  assert.equal(t.get("inquiry").kind, "objective");
});

test("inquiry params: 1 to 5 questions, each a real question; ids are added", async () => {
  const skill = loadSkillFromTemplates("pilot");
  assert.throws(() => skill.objectiveParams("inquiry", { questions: [] }), /1 to 5/);
  assert.throws(() => skill.objectiveParams("inquiry", { questions: [{ ask: "" }] }), /question is missing/);
  assert.throws(() => skill.objectiveParams("inquiry", { questions: Array(6).fill({ ask: "Wie?" }) }), /1 to 5/);
  assert.throws(() => skill.objectiveParams("notebook.capture", {}), /not an objective/);
  const p = skill.objectiveParams("inquiry", { questions: ["Wie lange dauert ein Angebot?", { ask: "Wann?", probe: "Gestern?", required: false }] });
  assert.deepEqual(p.questions.map(q => [q.id, q.required]), [["q1", true], ["q2", false]]);
});

test("the pilot agenda: the note works as before (missing, saving, schema)", () => {
  const agenda = loadSkillFromTemplates("pilot").createAgenda();
  assert.deepEqual(agenda.missing({}), ["customer or place", "the work to be done", "next step"], "no mode yet: the note's required details");
  assert.deepEqual(agenda.missing({ mode: "brief" }), []);
  assert.deepEqual(agenda.missing({ mode: "capture", place: "Allensbach", work: [{ area: "Bad" }] }), ["next step"]);
  assert.equal(agenda.worthSaving({ mode: "capture", place: "Allensbach" }), true);
  assert.equal(agenda.worthSaving({ mode: "brief", place: "Allensbach" }), false);
  const schema = agenda.schema();
  assert.deepEqual(schema.properties.mode.enum, ["capture", "brief", "agenda", "unclear"]);
  assert.equal(schema.properties.agenda, undefined, "nothing to extract for the agent's own items");
  assert.deepEqual(agenda.tools(), ["quote_send", "memory_search"]);
});

test("an inquiry on the agenda: asked at the end, extracted, done in code, answer kept", () => {
  const skill = loadSkillFromTemplates("pilot");
  const objectives = [{ id: "obj_1", ...question, params: skill.objectiveParams("inquiry", question.params) }];
  const agenda = skill.createAgenda({ objectives, discovery: createDiscovery({ framework: loadFramework() }) });
  assert.deepEqual(agenda.objectives.map(o => o.template.id), ["inquiry"], "one extra per call: Max's question, research waits for another call");
  const prompt = agenda.prompt({ lang: "de" });
  assert.match(prompt, /1\. MAX'S QUESTION \(how long quotes take\): ask this\. They are written in German/);
  assert.match(prompt, /q1: "Wie lange hast du an deinem letzten Angebot gesessen\?" If his answer is vague, one follow-up: "Ungefähr reicht\."/);
  assert.doesNotMatch(prompt, /RESEARCH, THIS WEEK ONLY/, "no research question in the same call");
  assert.match(prompt, /Your own agenda so far: MAX'S QUESTION: q1 not asked yet/);
  assert.match(agenda.extractSystem("de"), /agenda\.obj_1: the questions under "MAX'S QUESTION"/);
  const schema = agenda.schema();
  assert.deepEqual(schema.properties.agenda.properties.obj_1.properties.q1.properties.status.enum, ["not_asked", "answered", "vague", "declined"]);
  assert.ok(schema.required.includes("agenda"));

  let u = agenda.update({ mode: "capture", place: "Allensbach", agenda: { obj_1: { q1: { asked: true, probed: false, status: "vague", answer: "", quote: "" } } } });
  assert.deepEqual(u.changes, [], "a vague answer isn't done before the follow-up");
  assert.match(agenda.prompt({ lang: "de" }), /q1 vague: ask the one follow-up now/);
  assert.equal(u.note.agenda, undefined, "the answers stay out of his note");
  u = agenda.update({ mode: "capture", place: "Allensbach", agenda: { obj_1: { q1: { asked: true, probed: true, status: "answered", answer: "Zwei Stunden, am Sonntagabend.", quote: "so zwei Stunden, Sonntagabend halt" } } } });
  assert.deepEqual(u.changes.map(c => [c.id, c.done]), [["obj_1", true]]);
  assert.match(agenda.prompt({ lang: "de" }), /q1 answered, don't ask again/);
  assert.match(agenda.extractPrompt({ turns: [], lang: "de" }), /Zwei Stunden/, "the extraction sees the answers so far");
  const [r] = agenda.results();
  assert.equal(r.done, true);
  assert.equal(r.template, "inquiry@1");
  assert.equal(r.result.questions[0].quote, "so zwei Stunden, Sonntagabend halt");
});

test("one extra per call: the agent's own items, best first; research needs its store", () => {
  const skill = loadSkillFromTemplates("pilot");
  const params = skill.objectiveParams("inquiry", question.params);
  const discovery = createDiscovery({ framework: loadFramework() });
  const two = skill.createAgenda({ objectives: [{ id: "a", template: "inquiry", params }, { id: "b", template: "inquiry", params }], discovery });
  assert.deepEqual(two.objectives.map(o => o.id), ["a"], "never two extras in one call");
  assert.deepEqual(skill.createAgenda({ discovery }).objectives.map(o => o.template.id), ["research.discovery"], "nothing queued: the research question");
  assert.deepEqual(skill.createAgenda().objectives, [], "no discovery store: no research item");
  const intro = { id: "f", template: "feature.intro", params: skill.objectiveParams("feature.intro", { feature: "note_whatsapp", message: "Ab jetzt kommt die Notiz auf WhatsApp." }) };
  const told = skill.createAgenda({ objectives: [intro], discovery });
  assert.deepEqual(told.objectives.map(o => o.template.id), ["feature.intro"], "a new feature to mention is the call's one extra");
  assert.match(told.prompt({ lang: "de" }), /NEW FOR HIM: news for him, not a question\. .*"Ab jetzt kommt die Notiz auf WhatsApp\." If he already used it in this call, skip it/);
  assert.equal(told.update({ agenda: { f: { told: true } } }).changes?.[0]?.done ?? told.objectives[0].done, true, "done once it was said");
});

test("his day: a conversation by his time of day, picking up where the last call stopped", () => {
  const skill = loadSkillFromTemplates("pilot");
  const day = { id: "obj_d", template: "discovery.day", params: skill.objectiveParams("discovery.day", {}) };
  const first = skill.createAgenda({ objectives: [day], discovery: createDiscovery({ framework: loadFramework() }) });
  assert.deepEqual(first.objectives.map(o => o.template.id), ["discovery.day"], "a whole conversation: no research question on top");
  const morning = first.prompt({ lang: "de", now: new Date("2026-10-14T06:40:00Z") });
  assert.match(morning, /it's 08:40, early morning, his day has barely started for him/);
  assert.match(morning, /"Wie war's gestern\? Oder was steht heute an\?"/);
  assert.match(morning, /mostly listen/);
  assert.doesNotMatch(morning, /FROM EARLIER CALLS/);
  assert.match(first.prompt({ lang: "de", now: new Date("2026-10-14T16:10:00Z") }), /it's 18:10, evening for him/);

  // The first call is cut off mid-story: not done, and what it got is kept.
  first.update({ mode: "unclear", agenda: { obj_d: { agreed: true, day: "Bad in Allensbach.", stories: [{ title: "Angebot am Sonntag", what_happened: "Angebot nachts geschrieben", quote: "Sonntagabend halt" }], ideas: [], open_thread: "erzählte gerade vom Fliesenhändler", wrapped_up: false } } });
  const [r1] = first.results();
  assert.equal(r1.done, false, "he arrived: it stays open for the next call");
  assert.equal(r1.result.open_thread, "erzählte gerade vom Fliesenhändler");
  assert.equal(r1.result.questions[0].ask, "Angebot am Sonntag", "shown on the admin card like an answer");

  // The next call picks it up (also from how the last call actually ended), and adds to it.
  const lastCall = { reason: "caller_hangup", turns: [{ role: "user", text: "Ich musste zum Händler und, oh, ich bin da. Tschüss." }, { role: "model", text: "Klar, bis später!" }] };
  const next = skill.createAgenda({ objectives: [{ ...day, result: r1.result, lastCall }] });
  const p = next.prompt({ lang: "de" });
  assert.match(p, /FROM EARLIER CALLS: he already told you about: Angebot am Sonntag\. It stopped while: erzählte gerade vom Fliesenhändler\./);
  assert.match(p, /The last call ended like this:\n {2}He: Ich musste zum Händler und, oh, ich bin da\. Tschüss\.\n {2}You: Klar, bis später!/);
  assert.match(skill.createAgenda({ objectives: [{ ...day, lastCall }] }).prompt({ lang: "de" }), /The last call ended like this/, "even when the extraction missed it");
  next.update({ mode: "unclear", agenda: { obj_d: { agreed: true, day: "Heute Küche.", stories: [{ title: "angebot am sonntag", what_happened: "dup", quote: "" }, { title: "Fliesen falsch geliefert", what_happened: "Händler hat falsche Farbe geschickt", quote: "schon wieder" }], ideas: [{ idea: "Bestellungen per Anruf", last_time: "letzte Woche", quote: "wär super" }], open_thread: "", wrapped_up: true } } });
  const [r2] = next.results();
  assert.equal(r2.done, true, "ended naturally");
  assert.deepEqual(r2.result.stories.map(s => s.title), ["Angebot am Sonntag", "Fliesen falsch geliefert"], "added, not repeated");
  assert.deepEqual(r2.result.days, ["Bad in Allensbach.", "Heute Küche."]);
  assert.equal(r2.result.open_thread, "");
  assert.match(r2.result.questions.at(-1).ask, /^Idea: Bestellungen per Anruf/);
});

test("a tool's instructions only on a call that has the tool: no promise it can't keep", () => {
  const skill = loadSkillFromTemplates("pilot");
  const agenda = skill.createAgenda();
  assert.doesNotMatch(agenda.prompt({ lang: "de" }), /quote_send|als Angebot auf WhatsApp/, "no quote tool: not a word about sending quotes");
  const withTool = agenda.prompt({ lang: "de", tools: ["quote_send"] });
  assert.match(withTool, /- QUOTE \(the job has work to quote\): .*"Soll ich dir das als Angebot auf WhatsApp schicken\?"/);
});

test("what he told before: in a call Toni makes (no research item), not twice in his own calls", () => {
  const skill = loadSkillFromTemplates("pilot");
  const discovery = createDiscovery({ framework: skill.framework });
  discovery.apply({ findings: [{ area: skill.framework.areas[1].id, kind: "fact", text: "Anfragen kommen meistens per Anruf." }] }, { callId: "c0", date: "2026-10-14" });
  const out = skill.createAgenda({ objectives: [{ id: "errand_1", template: "discovery.day", params: {}, stored: false }], discovery, direction: "outbound" }).prompt({});
  assert.match(out, /WHAT HE TOLD YOU IN EARLIER CALLS[^]*Anfragen kommen meistens per Anruf\./);
  const inbound = skill.createAgenda({ discovery }).prompt({});
  assert.doesNotMatch(inbound, /WHAT HE TOLD YOU IN EARLIER CALLS/, "his own calls have the research block");
  assert.match(inbound, /Anfragen kommen meistens per Anruf\./);
  assert.doesNotMatch(skill.createAgenda({ objectives: [{ id: "errand_1", template: "discovery.day", params: {}, stored: false }], discovery: createDiscovery({ framework: skill.framework }), direction: "outbound" }).prompt({}), /EARLIER CALLS/, "nothing told yet: no block");
});

test("a focus: a call Toni makes leads with it; in his own calls it waits until it comes up", () => {
  const skill = loadSkillFromTemplates("pilot");
  const objectives = [{ id: "errand_1", template: "discovery.day", params: { focus: "how his last quote went" }, stored: false }];
  assert.match(skill.createAgenda({ objectives, direction: "outbound" }).prompt({}), /THIS CALL'S FOCUS \(why you called\): how his last quote went\./);
  const inbound = skill.createAgenda({ objectives }).prompt({});
  assert.match(inbound, /If it comes up naturally, Max is especially curious about: how his last quote went\./);
  assert.doesNotMatch(inbound, /THIS CALL'S FOCUS/);
});
