import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDiscovery, loadFramework, withDiscovery } from "../src/store/discovery.mjs";
import { createMemory } from "../src/store/memory.mjs";
import { loadSkill } from "../src/skills/index.mjs";

const tmp = () => mkdtempSync(path.join(tmpdir(), "deskless-discovery-"));
const framework = loadFramework();
const mon = new Date("2026-10-19T10:00:00Z");
const fri = new Date("2026-10-23T10:00:00Z");
const call = (over = {}) => ({ asked_question_ids: [], answered_question_ids: [], declined_question_ids: [], findings: [], ...over });

test("first call: intro, and the business questions come first", () => {
  const d = createDiscovery({ framework, dir: tmp() });
  const next = d.next({ today: mon });
  assert.equal(next.intro, true);
  assert.equal(next.questions[0].area.id, "betrieb");
  assert.equal(next.questions[0].question.id, "b1");
  assert.ok(!next.questions.some(q => q.area.phase === "end"), "no wrap-up questions on day 1");
});

test("answered questions are skipped; a question isn't asked twice in a day", () => {
  const d = createDiscovery({ framework, dir: tmp() });
  d.apply(call({ asked_question_ids: ["b1"], answered_question_ids: ["b1"] }), { callId: "c1", date: "2026-10-19" });
  d.apply(call({ asked_question_ids: ["b2"] }), { callId: "c2", date: "2026-10-19" });
  const next = d.next({ today: mon });
  assert.equal(next.intro, false);
  assert.equal(next.questions[0].question.id, "b3", "b1 answered, b2 already asked today");
  assert.equal(d.next({ today: new Date("2026-10-20T10:00:00Z") }).questions[0].question.id, "b2", "unanswered b2 comes back the next day");
});

test("daily cap: no more questions once three calls today asked one", () => {
  const d = createDiscovery({ framework, dir: tmp() });
  for (const [i, id] of ["b1", "b2", "b3"].entries()) d.apply(call({ asked_question_ids: [id] }), { callId: `c${i}`, date: "2026-10-19" });
  const next = d.next({ today: mon });
  assert.equal(next.capped, true);
  assert.match(d.context({ today: mon }), /DISCOVERY QUESTION FOR THIS CALL: none/);
});

test("after the business questions, the least-covered area comes next; wrap-up only on the last day", () => {
  const d = createDiscovery({ framework, dir: tmp() });
  d.apply(call({ answered_question_ids: ["b1", "b2", "b3", "b4"], findings: [{ area: "anfrage", kind: "fakt", text: "Anfragen kommen per WhatsApp." }] }), { callId: "c1", date: "2026-10-19" });
  const tue = d.next({ today: new Date("2026-10-20T10:00:00Z") });
  assert.notEqual(tue.questions[0].area.id, "anfrage", "anfrage already has a finding");
  assert.equal(tue.questions[0].area.id, "angebot");
  assert.equal(d.next({ today: fri }).questions[0].area.id, "abschluss", "day 5 starts the wrap-up");
});

test("findings keep only known areas and hypotheses", () => {
  const d = createDiscovery({ framework, dir: tmp() });
  const { findings } = d.apply(call({
    findings: [
      { area: "angebot", hypothesis: "H2", stance: "supports", kind: "zahl", text: "Angebote schreibt er sonntags, ca. 3 Stunden.", quote: "Sonntag ist Angebotstag" },
      { area: "angebot", hypothesis: "H99", stance: "supports", kind: "fakt", text: "Unbekannte Hypothese." },
      { area: "nope", kind: "fakt", text: "Unbekannter Bereich." },
    ],
  }), { callId: "c1", date: "2026-10-19" });
  assert.equal(findings.length, 2);
  assert.equal(findings[0].hypothesis, "H2");
  assert.equal(findings[1].hypothesis, "", "unknown hypothesis dropped");
  assert.equal(findings[1].stance, "", "no stance without a hypothesis");
});

test("withDiscovery: memory and findings in one apply; the question goes to the agenda, not memory", () => {
  const dir = tmp();
  const discovery = createDiscovery({ framework, dir: path.join(dir, "discovery") });
  const memory = withDiscovery(createMemory(path.join(dir, "memory")), discovery);
  const changed = memory.apply({
    call_type: "capture", call_summary: "Bad Meier aufgenommen.", customer: { name: "Herr Meier", place: "Allensbach" },
    new_actions: [], completed_action_ids: [],
    discovery: call({ asked_question_ids: ["b1"], answered_question_ids: ["b1"], findings: [{ area: "betrieb", kind: "fact", text: "Er ist Fliesenleger mit zwei Gesellen." }] }),
  }, { callId: "c1", date: "2026-10-19" });
  assert.equal(changed.customer.name, "Herr Meier");
  assert.equal(changed.discovery.findings.length, 1);
  assert.match(memory.context({ today: mon }), /Herr Meier/);
  assert.doesNotMatch(memory.context({ today: mon }), /DISCOVERY QUESTION/);
  assert.match(discovery.context({ today: mon }), /Fliesenleger mit zwei Gesellen/);
  assert.match(discovery.context({ today: mon }), /\[b2\]/);
  assert.ok(memory.snapshot().discovery.questions.length > 10);
});

test("the pilot: its memory schema knows every framework area; research is on the agenda", async () => {
  const pilot = await loadSkill("pilot");
  const areas = pilot.MEMORY_SCHEMA.properties.discovery.properties.findings.items.properties.area.enum;
  assert.deepEqual(areas, framework.areas.map(a => a.id));
  const agenda = pilot.createAgenda({ discovery: createDiscovery({ framework, dir: tmp() }) });
  const prompt = agenda.prompt({ engine: "cascade", lang: "de" });
  assert.match(prompt, /RESEARCH, THIS WEEK ONLY/);
  assert.match(prompt, /DISCOVERY QUESTION FOR THIS CALL/);
  assert.match(pilot.MEMORY_SYSTEM, /asked_question_ids/);
});
