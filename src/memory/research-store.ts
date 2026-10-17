// The research state in Postgres: findings are facts tagged area:/hyp:/stance:, the question
// states and the call log one research_state row (src/memory/research.ts works on it).

import type { Queryable } from "../db/client.ts";
import type { UserRow } from "../types/user.ts";
import { createDiscovery, type Discovery, type Finding, type Framework, type ResearchCall, type QuestionState } from "./research.ts";
import { day, json, type FactRow } from "./rows.ts";

const tag = (f: FactRow, name: string): string => f.tags?.find(t => t.startsWith(`${name}:`))?.slice(name.length + 1) ?? "";

/** His research state for a call or the after-call step; null for the demo (no research) or without a framework. */
export async function loadResearch(q: Queryable, framework: Framework | null, user: Pick<UserRow, "id" | "demo">): Promise<Discovery | null> {
  if (!framework || user.demo) return null; // the demo gets no research questions
  const [[state], facts] = await Promise.all([
    q.query<{ questions: Record<string, QuestionState> | null; calls: ResearchCall[] | null }>("select questions, calls from research_state where user_id = $1", [user.id]),
    q.query<FactRow>("select id, kind, text, quote, tags, source_call_id, created_at from facts where user_id = $1 and subject = 'user' and superseded_by is null and exists (select 1 from unnest(tags) t where t like 'area:%') order by created_at", [user.id]),
  ]);
  const findings: Finding[] = facts.map(f => ({
    id: f.id, area: tag(f, "area"), hypothesis: tag(f, "hyp"), stance: tag(f, "stance") === "supports" || tag(f, "stance") === "contradicts" ? (tag(f, "stance") as Finding["stance"]) : "",
    kind: f.kind, text: f.text, quote: f.quote, callId: f.source_call_id, date: day(f.created_at),
  }));
  return createDiscovery({ framework, state: { findings, questions: state?.questions ?? {}, calls: state?.calls ?? [] } });
}

/** Saves what apply() changed: the new findings as facts, the question states and the call log. */
export async function saveResearch(q: Queryable, user: Pick<UserRow, "id" | "org_id">, discovery: Discovery, added: Finding[], callId: string): Promise<void> {
  for (const f of added) {
    await q.query("insert into facts (org_id, user_id, subject, kind, text, quote, tags, source_call_id) values ($1, $2, 'user', $3, $4, $5, $6, $7)",
      [user.org_id, user.id, f.kind || "fact", f.text, f.quote || "", [`area:${f.area}`, ...(f.hypothesis ? [`hyp:${f.hypothesis}`] : []), ...(f.stance ? [`stance:${f.stance}`] : [])], callId]);
  }
  await q.query(`insert into research_state (user_id, org_id, questions, calls, updated_at) values ($1, $2, $3, $4, now())
    on conflict (user_id) do update set questions = excluded.questions, calls = excluded.calls, updated_at = now()`, [user.id, user.org_id, json(discovery.state.questions), json(discovery.state.calls)]);
}
