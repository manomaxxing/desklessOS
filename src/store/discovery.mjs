// The pilot week's research log: what we've learned about how he works, and
// which framework questions (config/discovery.json) were asked. Filled by the
// consolidation step after every call; the state store of the research
// primitive (src/agenda/primitives.mjs), which puts context() into the agenda
// to pick at most one question for the end of this call.
//   data/discovery/findings.json   [ finding ]
//   data/discovery/questions.json  { [questionId]: { asked, lastAsked, answered, declined } }
//   data/discovery/calls.json      [ { callId, date, asked, answered, declined, findings } ]

import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, readJson, writeJson } from "./files.mjs";

const FINDINGS_PER_AREA_IN_PROMPT = 4;
const RETRIES_PER_QUESTION = 2; // asked twice without an answer: drop it

export const loadFramework = (file = new URL("../../config/discovery.json", import.meta.url)) => JSON.parse(readFileSync(file, "utf8"));

const day = d => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export function createDiscovery({ framework = loadFramework(), dir = dataDir("discovery", "DISCOVERY_DIR") } = {}) {
  mkdirSync(dir, { recursive: true });
  const file = name => path.join(dir, name);
  const cache = {};
  const read = (name, fallback) => (cache[name] ??= readJson(file(name), fallback));
  const write = (name, data) => { writeJson(file(name), data); cache[name] = data; };
  const findings = () => read("findings.json", []);
  const questions = () => read("questions.json", {});
  const calls = () => read("calls.json", []);

  const areaIds = framework.areas.map(a => a.id);
  const questionIds = new Set(framework.areas.flatMap(a => a.questions.map(q => q.id)));
  const hypothesisIds = new Set(framework.hypotheses.map(h => h.id));

  /** The questions for this call: start-phase areas first, end-phase from the last pilot day, else the least-covered area. */
  function next({ today = new Date() } = {}) {
    const date = day(today);
    const log = calls();
    const intro = log.length === 0;
    const pilotDay = log.length ? daysBetween(log[0].date, date) + 1 : 1;
    if (log.filter(c => c.date === date && c.asked.length).length >= framework.dailyQuestionCap) return { intro, pilotDay, questions: [], capped: true };
    const state = questions();
    const open = q => !state[q.id]?.answered && (state[q.id]?.asked ?? 0) < RETRIES_PER_QUESTION && state[q.id]?.lastAsked !== date;
    const coverage = a => findings().filter(f => f.area === a.id).length;
    const rank = a => (a.phase === "start" ? 0 : a.phase === "end" ? 1 : 2);
    const areas = framework.areas
      .filter(a => a.phase !== "end" || pilotDay >= framework.pilotDays)
      .filter(a => a.questions.some(open))
      .sort((a, b) => rank(a) - rank(b) || coverage(a) - coverage(b) || areaIds.indexOf(a.id) - areaIds.indexOf(b.id));
    return { intro, pilotDay, questions: areas.slice(0, 3).map(a => ({ area: a, question: a.questions.find(open) })), capped: false };
  }

  return {
    framework,
    findings,
    questions,
    calls,
    next,

    /** Applies the `discovery` part of one call's consolidation result. */
    apply(d = {}, { callId, date = day(new Date()) } = {}) {
      const known = ids => [...new Set((ids ?? []).filter(id => questionIds.has(id)))];
      const asked = known(d.asked_question_ids), answered = known(d.answered_question_ids), declined = known(d.declined_question_ids);
      const state = structuredClone(questions());
      for (const id of asked) state[id] = { ...state[id], asked: (state[id]?.asked ?? 0) + 1, lastAsked: date };
      for (const id of answered) state[id] = { ...state[id], answered: true };
      for (const id of declined) state[id] = { ...state[id], declined: (state[id]?.declined ?? 0) + 1 };
      const added = (d.findings ?? []).filter(f => f.text && areaIds.includes(f.area)).map(f => {
        const hypothesis = hypothesisIds.has(f.hypothesis) ? f.hypothesis : "";
        const stance = hypothesis && ["supports", "contradicts"].includes(f.stance) ? f.stance : "";
        return { id: randomUUID().slice(0, 8), area: f.area, hypothesis, stance, kind: f.kind || "", text: f.text, quote: f.quote || "", callId, date };
      });
      write("findings.json", [...findings(), ...added]);
      write("questions.json", state);
      write("calls.json", [...calls(), { callId, date, asked, answered, declined, findings: added.length }]);
      return { asked, answered, declined, findings: added };
    },

    /** The prompt block: what we know so far and the question for this call. */
    context({ today = new Date() } = {}) {
      const { intro, pilotDay, questions: picks, capped } = next({ today });
      const known = framework.areas.map(a => {
        const own = findings().filter(f => f.area === a.id).slice(-FINDINGS_PER_AREA_IN_PROMPT).map(f => f.text);
        return `- ${a.title}: ${own.length ? own.join(" ") : "(nothing yet)"}`;
      });
      const ask = picks.map(({ area, question }, i) =>
        `${i + 1}. [${question.id}] (${area.title}) "${question.ask}"${question.probe ? ` If his answer is vague, one follow-up: "${question.probe}"` : ""}`);
      return [
        `WHAT WE'VE LEARNED ABOUT HIM AND HIS BUSINESS (pilot week, day ${pilotDay} of ${framework.pilotDays}):`,
        ...known,
        "",
        intro ? "FIRST CALL: yes, this is his first call to the notebook (see RESEARCH above)." : "FIRST CALL: no. He knows the notebook already; don't introduce yourself again.",
        capped || !picks.length
          ? "DISCOVERY QUESTION FOR THIS CALL: none. Don't ask any research question in this call."
          : `DISCOVERY QUESTION FOR THIS CALL (ask at most one, at the end; take the first unless another one links directly to what he said):\n${ask.join("\n")}`,
      ].filter(Boolean).join("\n");
    },

    /** What the consolidation step needs: the framework ids and recent findings, so it can tag without duplicating. */
    snapshot() {
      return {
        areas: framework.areas.map(a => ({ id: a.id, title: a.title, goal: a.goal })),
        hypotheses: framework.hypotheses.map(h => ({ id: h.id, area: h.area, text: h.text })),
        questions: framework.areas.flatMap(a => a.questions.map(q => ({ id: q.id, area: a.id, ask: q.ask }))),
        recentFindings: findings().slice(-40).map(f => `${f.area}: ${f.text}`),
      };
    },

    reset() { for (const k of Object.keys(cache)) delete cache[k]; mkdirSync(dir, { recursive: true }); },
  };
}

/**
 * Long-term memory plus the research log, behind the memory interface the
 * sessions and the post-call step use: apply() also files the call's findings,
 * snapshot() adds the framework. The question for this call is the research
 * objective's business (its agenda item), not memory's.
 */
export function withDiscovery(memory, discovery) {
  return {
    ...memory,
    discovery,
    apply(result, meta) {
      const changed = memory.apply(result, meta);
      changed.discovery = discovery.apply(result.discovery, meta);
      return changed;
    },
    snapshot() {
      return { ...memory.snapshot(), discovery: discovery.snapshot() };
    },
    reset() { memory.reset(); discovery.reset(); },
  };
}
