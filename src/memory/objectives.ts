// Objectives: what the agent brings into a call ("find out X"), each an instance of an
// objective template (templates/*.json, kind "objective"). Stored in Postgres
// (src/memory/objectives-store.ts); status pending → done | expired | cancelled. Every call it
// was on counts an attempt; answers from several calls add up.

import type { ObjectiveMode } from "../types/agenda.ts";
import type { Direction } from "../types/call.ts";

export const MODES_FOR: Record<Direction, ObjectiveMode[]> = { inbound: ["next_inbound", "either"], outbound: ["outbound", "either"] };

interface Answered { id: string; status?: string; [key: string]: unknown }
type Result = Record<string, unknown> & { questions?: Answered[] };

const questionsOf = (r: Record<string, unknown> | null | undefined): Answered[] | null =>
  r && Array.isArray(r.questions) ? (r.questions as Answered[]) : null; // results are jsonb we wrote ourselves

// Answers from this call replace older ones per question, unless this call didn't get to it.
export function mergeResult(old: Record<string, unknown> | null | undefined, now: Record<string, unknown> | null | undefined): Result | null {
  const before = questionsOf(old);
  const fresh = questionsOf(now);
  if (!before || !fresh) return (now ?? old ?? null) as Result | null;
  const byId = new Map(before.map(q => [q.id, q]));
  return { ...old, ...now, questions: fresh.map(q => (q.status === "not_asked" && byId.has(q.id) ? byId.get(q.id) ?? q : q)) };
}
