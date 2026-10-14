// Objectives: what the agent brings into a call ("find out X"), each an instance of an
// objective template (templates/*.json, kind "objective"). Stored in Postgres
// (src/memory/pg.mjs); status pending → done | expired | cancelled. Every call it was
// on counts an attempt; answers from several calls add up.

export const MODES_FOR = { inbound: ["next_inbound", "either"], outbound: ["outbound", "either"] };

// Answers from this call replace older ones per question, unless this call didn't get to it.
export function mergeResult(old, now) {
  if (!old?.questions || !now?.questions) return now ?? old ?? null;
  const before = new Map(old.questions.map(q => [q.id, q]));
  return { ...old, ...now, questions: now.questions.map(q => (q.status === "not_asked" && before.has(q.id) ? before.get(q.id) : q)) };
}
