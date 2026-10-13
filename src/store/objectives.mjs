// Objectives: what the agent should bring into a call ("find out X"), each an
// instance of an objective template (templates/*.json, kind "objective").
//   data/agenda/objectives.json   [ objective ]
// An objective: { id, template, version, params, mode, status, priority, lang,
//   createdAt, createdBy, notBefore, deadline, attempts, maxAttempts, calls, result, updatedAt }
// status: pending → done | expired | cancelled. Every call it was on counts an
// attempt; answers from several calls add up.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, readJson, writeJson } from "./files.mjs";

const MODES_FOR = { inbound: ["next_inbound", "either"], outbound: ["outbound", "either"] };

// Answers from this call replace older ones per question, unless this call didn't get to it.
function mergeResult(old, now) {
  if (!old?.questions || !now?.questions) return now ?? old ?? null;
  const before = new Map(old.questions.map(q => [q.id, q]));
  return { ...old, ...now, questions: now.questions.map(q => (q.status === "not_asked" && before.has(q.id) ? before.get(q.id) : q)) };
}

export function createObjectives({ skill, dir = dataDir("agenda", "AGENDA_DIR") }) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "objectives.json");
  let cache = null;
  const all = () => (cache ??= readJson(file, []));
  const save = list => { writeJson(file, list); cache = list; };
  const now = () => new Date().toISOString();

  return {
    list: () => all(),
    get: id => all().find(o => o.id === id) ?? null,

    /** A new objective from a template; params are checked by the template's primitives. Throws on bad input. */
    create({ template, params, mode = "next_inbound", priority, lang = null, notBefore = null, deadline = null, createdBy = "admin" } = {}) {
      const t = skill.templates.get(template);
      if (!t || t.kind !== "objective") throw new Error(`unknown objective template "${template}" (${[...skill.templates.values()].filter(x => x.kind === "objective" && x.params).map(x => x.id).join(", ")})`);
      if (!(t.modes ?? ["next_inbound"]).includes(mode)) throw new Error(`mode "${mode}" isn't possible for ${template} (${(t.modes ?? ["next_inbound"]).join(", ")})`);
      const objective = {
        id: `obj_${randomUUID().slice(0, 8)}`, template, version: t.version, params: skill.objectiveParams(template, params),
        mode, status: "pending", priority: Number.isFinite(priority) ? priority : t.priority ?? 0, lang,
        createdAt: now(), createdBy, notBefore, deadline, attempts: 0, maxAttempts: t.limits?.attempts ?? 3, calls: [], result: null, updatedAt: now(),
      };
      save([...all(), objective]);
      return objective;
    },

    cancel(id) {
      const list = structuredClone(all());
      const o = list.find(x => x.id === id);
      if (!o) return null;
      if (o.status === "pending") Object.assign(o, { status: "cancelled", updatedAt: now() });
      save(list);
      return o;
    },

    /** Pending objectives this call may take up, best first: higher priority, then older. */
    forCall({ direction = "inbound", at = new Date() } = {}) {
      const t = at.toISOString();
      return all()
        .filter(o => o.status === "pending" && MODES_FOR[direction]?.includes(o.mode) && (!o.notBefore || o.notBefore <= t) && (!o.deadline || o.deadline >= t))
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt.localeCompare(b.createdAt));
    },

    /** After a call: what each objective got (agenda.results()). Returns the objectives that changed. */
    record(callId, results = []) {
      const list = structuredClone(all());
      const changed = [];
      for (const r of results) {
        const o = list.find(x => x.id === r.id);
        if (!o || o.status !== "pending") continue;
        o.attempts += 1;
        o.calls = [...o.calls, callId];
        o.result = mergeResult(o.result, r.result);
        if (r.done) o.status = "done";
        else if (o.attempts >= o.maxAttempts) o.status = "expired";
        o.updatedAt = now();
        changed.push(o);
      }
      if (changed.length) save(list);
      return changed;
    },

    reset() { cache = null; mkdirSync(dir, { recursive: true }); },
  };
}
