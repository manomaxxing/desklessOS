import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { render, slots } from "../src/agenda/render.mjs";
import { loadTemplates, loadPersona, parsePersona } from "../src/agenda/templates.mjs";
import { loadSkillFromTemplates } from "../src/skills/from-templates.mjs";
import { createObjectives } from "../src/store/objectives.mjs";
import { createDiscovery, loadFramework } from "../src/store/discovery.mjs";
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
  assert.deepEqual(loadPersona("office").standing, []);
});

test("every persona renders in every language and both engines, the test-only 'xx' pack included", () => {
  const dir = tmp();
  for (const f of readdirSync(LOCALES_DIR).filter(f => f.endsWith(".json"))) copyFileSync(path.join(LOCALES_DIR, f), path.join(dir, f));
  copyFileSync(new URL("./fixtures/locales/xx.json", import.meta.url), path.join(dir, "xx.json"));
  const locales = loadLocales(dir, { only: "de,en,xx", fallback: "de" });
  for (const name of ["pilot", "office"]) {
    const skill = loadSkillFromTemplates(name, { locales });
    const objectives = [{ id: "obj_1", ...question, params: skill.objectiveParams("inquiry", question.params) }];
    const agenda = skill.createAgenda({ objectives, discovery: skill.framework ? createDiscovery({ framework: skill.framework, dir: tmp() }) : null });
    for (const lang of ["de", "en", "xx"]) {
      for (const engine of ["cascade", "live"]) {
        const prompt = agenda.prompt({ engine, lang, tools: agenda.tools() });
        assert.doesNotMatch(prompt, /\{\{|undefined|\[object Object\]/, `${name} ${lang} ${engine}`);
      }
      assert.doesNotMatch(agenda.extractSystem(lang), /\{\{|undefined/);
    }
    if (name === "pilot") assert.match(agenda.prompt({ lang: "xx" }), /Then ask "xx:Sound right\?"/, "examples come from the xx pack");
  }
});

test("templates: capabilities name their mode; objectives their primitive", () => {
  const t = loadTemplates();
  for (const id of ["notebook.capture", "notebook.brief", "notebook.agenda", "office.order", "office.calendar", "office.brief", "research.discovery", "inquiry"]) assert.ok(t.has(id), id);
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
  assert.deepEqual(agenda.tools(), ["memory_search"]);
});

test("the office agenda: order missing per item, order_execute allowed", () => {
  const agenda = loadSkillFromTemplates("office").createAgenda();
  assert.deepEqual(agenda.missing({}), [], "no default mode in the office");
  assert.deepEqual(agenda.missing({ mode: "order", customer_name: "Peter", items: [{ description: "tiles", catalog_id: "" }] }), ["quantity of tiles", "price per unit for tiles (not on the price list)", "when the customer needs it", "customer's email address for the quote"]);
  assert.ok(agenda.tools().includes("order_execute"));
  assert.match(agenda.prompt({ engine: "cascade", lang: "en" }), /then call order_execute in the same response/);
  assert.match(agenda.prompt({ engine: "live", lang: "en" }), /say only "On it\." and call the tool order_execute/);
  assert.match(agenda.extractPrompt({ turns: [{ role: "user", text: "hi" }], lang: "en" }), /PRICE LIST/);
});

test("an inquiry on the agenda: asked at the end, extracted, done in code, answer kept", () => {
  const skill = loadSkillFromTemplates("pilot");
  const objectives = [{ id: "obj_1", ...question, params: skill.objectiveParams("inquiry", question.params) }];
  const agenda = skill.createAgenda({ objectives, discovery: createDiscovery({ framework: loadFramework(), dir: tmp() }) });
  assert.deepEqual(agenda.objectives.map(o => o.template.id), ["inquiry", "research.discovery"], "Max's question first, research after");
  const prompt = agenda.prompt({ engine: "cascade", lang: "de" });
  assert.match(prompt, /1\. MAX'S QUESTION \(how long quotes take\): ask this\. They are written in German/);
  assert.match(prompt, /q1: "Wie lange hast du an deinem letzten Angebot gesessen\?" If his answer is vague, one follow-up: "Ungefähr reicht\."/);
  assert.match(prompt, /2\. RESEARCH, THIS WEEK ONLY/);
  assert.match(prompt, /Your own agenda so far: MAX'S QUESTION: q1 not asked yet/);
  assert.match(agenda.extractSystem("de"), /agenda\.obj_1: the questions under "MAX'S QUESTION"/);
  const schema = agenda.schema();
  assert.deepEqual(schema.properties.agenda.properties.obj_1.properties.q1.properties.status.enum, ["not_asked", "answered", "vague", "declined"]);
  assert.ok(schema.required.includes("agenda"));

  let u = agenda.update({ mode: "capture", place: "Allensbach", agenda: { obj_1: { q1: { asked: true, probed: false, status: "vague", answer: "", quote: "" } } } });
  assert.deepEqual(u.changes, [], "a vague answer isn't done before the follow-up");
  assert.match(agenda.prompt({ engine: "cascade", lang: "de" }), /q1 vague: ask the one follow-up now/);
  assert.equal(u.note.agenda, undefined, "the answers stay out of his note");
  u = agenda.update({ mode: "capture", place: "Allensbach", agenda: { obj_1: { q1: { asked: true, probed: true, status: "answered", answer: "Zwei Stunden, am Sonntagabend.", quote: "so zwei Stunden, Sonntagabend halt" } } } });
  assert.deepEqual(u.changes.map(c => [c.id, c.done]), [["obj_1", true]]);
  assert.match(agenda.prompt({ engine: "cascade", lang: "de" }), /q1 answered, don't ask again/);
  assert.match(agenda.extractPrompt({ turns: [], lang: "de" }), /Zwei Stunden/, "the extraction sees the answers so far");
  const [r] = agenda.results();
  assert.equal(r.done, true);
  assert.equal(r.template, "inquiry@1");
  assert.equal(r.result.questions[0].quote, "so zwei Stunden, Sonntagabend halt");
});

test("at most two of the agent's own items per call; research needs its store", () => {
  const skill = loadSkillFromTemplates("pilot");
  const params = skill.objectiveParams("inquiry", question.params);
  const two = skill.createAgenda({ objectives: [{ id: "a", template: "inquiry", params }, { id: "b", template: "inquiry", params }], discovery: createDiscovery({ framework: loadFramework(), dir: tmp() }) });
  assert.deepEqual(two.objectives.map(o => o.id), ["a", "b"]);
  assert.deepEqual(skill.createAgenda().objectives, [], "no discovery store: no research item");
});

test("objectives store: create, pick for a call, record answers, done or expired", () => {
  const skill = loadSkillFromTemplates("pilot");
  const store = createObjectives({ skill, dir: tmp() });
  assert.throws(() => store.create({ template: "nope", params: {} }), /unknown objective template/);
  assert.throws(() => store.create({ ...question, mode: "smoke-signal" }), /mode "smoke-signal" isn't possible/);
  const a = store.create(question);
  const b = store.create({ ...question, priority: 5 });
  assert.equal(a.status, "pending");
  assert.deepEqual(store.forCall().map(o => o.id), [b.id, a.id], "higher priority first");
  assert.deepEqual(store.forCall({ direction: "outbound" }), []);
  const notAsked = { questions: [{ id: "q1", status: "not_asked", answer: "", quote: "" }] };
  store.record("call-1", [{ id: a.id, done: false, result: notAsked }]);
  assert.equal(store.get(a.id).attempts, 1);
  store.record("call-2", [{ id: a.id, done: true, result: { questions: [{ id: "q1", status: "answered", answer: "Zwei Stunden.", quote: "zwei Stunden" }] } }]);
  assert.equal(store.get(a.id).status, "done");
  assert.equal(store.get(a.id).result.questions[0].answer, "Zwei Stunden.");
  assert.deepEqual(store.get(a.id).calls, ["call-1", "call-2"]);
  for (let i = 0; i < 3; i++) store.record(`c${i}`, [{ id: b.id, done: false, result: notAsked }]);
  assert.equal(store.get(b.id).status, "expired", "three calls without getting to it");
  const c = store.create(question);
  assert.equal(store.cancel(c.id).status, "cancelled");
  assert.deepEqual(store.forCall(), []);
});
