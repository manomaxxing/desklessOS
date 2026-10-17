// Max's requests (plan → card → approve), objectives by hand, and the background work.
import type { ApiDeps } from "../deps.ts";
import type { Route } from "../router.ts";
import type { NewObjective } from "../../memory/objectives-store.ts";
import type { ObjectiveMode } from "../../types/agenda.ts";
import { fail, param } from "../router.ts";

const MODES: readonly ObjectiveMode[] = ["next_inbound", "outbound", "either"];
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const isoOrNull = (v: unknown, name: string): string | null => {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) throw fail(400, `${name}: a date like 2026-10-20 or 2026-10-20T08:00:00Z`);
  return v;
};
/** An objective from the API's body: each field checked here; the template and its params by create(). */
function objectiveInput(body: Record<string, unknown>): NewObjective {
  const template = str(body.template);
  if (!template) throw fail(400, "template: which objective template (e.g. inquiry)");
  const mode = body.mode === undefined ? "next_inbound" : MODES.find(m => m === body.mode);
  if (!mode) throw fail(400, `mode: ${MODES.join(" | ")}`);
  const priority = body.priority === undefined ? undefined : Number(body.priority);
  if (priority !== undefined && !Number.isFinite(priority)) throw fail(400, "priority: a number");
  return {
    template, params: body.params ?? {}, mode, priority, lang: str(body.lang),
    notBefore: isoOrNull(body.notBefore, "notBefore"), deadline: isoOrNull(body.deadline, "deadline"), userId: str(body.userId), createdBy: "api",
  };
}

export function requestRoutes({ requests, memory, skill, monitor, scheduler, queue }: ApiDeps): Route[] {
  const objectiveTemplates = () => [...skill.templates.values()].filter(t => t.kind === "objective" && t.params).map(({ id, version, description, params, modes }) => ({ id, version, description, params, modes }));
  return [
    ["GET", "/api/requests", "admin", async () => ({ requests: (await requests.list()).map(r => requests.view(r)) })],
    ["POST", "/api/requests", "admin", ({ body, who }) => requests.plan({ instruction: body.instruction, by: who.session?.n ?? "admin" })],
    // A conversation about his day (problem discovery): { userId?, focus?, mode? } → a card to approve.
    ["POST", "/api/requests/conversation", "admin", ({ body, who }) => requests.planConversation({
      userId: typeof body.userId === "string" ? body.userId : null, focus: String(body.focus ?? ""), mode: String(body.mode ?? "outbound"), by: who.session?.n ?? "admin",
    })],
    ["GET", /^\/api\/requests\/(req_[\w-]+)$/, "admin", async ctx => {
      const r = await requests.get(param(ctx));
      if (!r) throw fail(404, "no such request");
      return requests.view(r);
    }],
    ["POST", /^\/api\/requests\/(req_[\w-]+)\/revise$/, "admin", ctx => requests.revise(param(ctx), ctx.body)],
    ["POST", /^\/api\/requests\/(req_[\w-]+)\/approve$/, "admin", async ctx => {
      const r = await requests.approve(param(ctx), ctx.body);
      monitor.system(`request ${param(ctx)} approved: ${r.card?.summary || r.instruction}`);
      return { request: r };
    }],
    ["POST", /^\/api\/requests\/(req_[\w-]+)\/cancel$/, "admin", async ctx => ({ request: await requests.cancel(param(ctx)) })],
    // Objectives by hand: { template: "inquiry", params: { questions: [{ ask, probe? }], purpose? }, mode?, priority?, lang? }.
    ["GET", "/api/objectives", "admin", async () => ({ objectives: await memory.objectives.list(), templates: objectiveTemplates() })],
    ["POST", "/api/objectives", "admin", async ({ body }) => {
      const input = objectiveInput(body); // a bad body is a 400 before anything is looked up
      const o = await memory.objectives.create(input).catch((err: unknown) => { throw fail(400, err instanceof Error ? err.message : String(err)); });
      const questions = Array.isArray(o.params.questions) ? (o.params.questions as { ask?: string }[]) : [];
      monitor.system(`objective ${o.id} (${o.template}): ${questions.map(q => q.ask).join(" / ")}`);
      return { objective: o };
    }],
    ["POST", /^\/api\/objectives\/([^/]+)\/cancel$/, "admin", async ctx => {
      const o = await memory.objectives.cancel(param(ctx));
      if (!o) throw fail(404, "unknown objective");
      return { objective: o };
    }],
    ["GET", "/api/jobs", "admin", async () => ({ jobs: scheduler ? await scheduler.list() : [], outbound: Boolean(scheduler), queue: await queue.list() })],
  ];
}
