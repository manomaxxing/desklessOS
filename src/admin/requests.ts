// Admin requests: Max's instruction → a plan and its card → his approval → an
// objective for the user's next call → the result back on his page (and by webhook
// or email, as a "notify" job). The request follows its objective: done when the
// objective is done, expired when it ran out of calls.
//   draft → approved → done | expired       draft | approved → cancelled
// Every status change is conditional on the status it starts from (a double click, a second
// tab, a cancel during an approval: one of them wins, the other is told), and the objective
// exists only for the approval that won.
// Approval needs the confirm token issued with the card: it's signed over the
// request id and the plan's hash, so what gets approved is exactly what was shown.

import { randomUUID } from "node:crypto";
import { draftPlan, editPlan, cardFor, callable, planParams } from "./planner.ts";
import { planHash } from "./auth.ts";
import { isRecord } from "../shared/is-record.ts";
import type { DraftPlan, PlanEdits, PlannerLlm, PlannerSkill, PlannerUser } from "./planner.ts";
import type { Auth } from "./auth.ts";
import type { Queue } from "../jobs/queue.ts";
import type { Notifier } from "../notify.ts";
import type { PlanParams, Request, RequestStatus } from "../types/request.ts";
import type { Objective, ObjectiveMode } from "../types/agenda.ts";
import type { HttpError, Iso, Log, Turn } from "../types/common.ts";
import type { User } from "../types/user.ts";

/** A request as stored: its plan may still be a draft's (who or what not known yet). */
export type StoredRequest = Omit<Request, "plan"> & { plan: DraftPlan | null };
export type NewRequest = Pick<StoredRequest, "id" | "userId" | "instruction" | "plan" | "planHash" | "card"> & { turns?: unknown[]; status?: RequestStatus; createdBy?: string };
export type RequestPatch = Partial<Pick<StoredRequest, "userId" | "plan" | "planHash" | "card" | "turns" | "status" | "objectiveId" | "result" | "approvedAt" | "closedAt" | "notifiedAt" | "log">>;

/** Max's requests in memory (src/memory/pg.ts). */
export interface RequestStore {
  create(r: NewRequest): Promise<StoredRequest>;
  get(id: string): Promise<StoredRequest | null>;
  list(): Promise<StoredRequest[]>;
  update(id: string, patch: RequestPatch): Promise<StoredRequest | null>;
  byObjective(objectiveId: string): Promise<StoredRequest | null>;
  /**
   * The status change, only while the request's status is one of `from`, in one statement
   * (`update requests set status = $to, … where id = $1 and status = any($from) returning *`).
   * Null when it wasn't (someone else got there first).
   */
  transition(id: string, from: RequestStatus[], to: RequestStatus, patch?: RequestPatch): Promise<StoredRequest | null>;
}

export interface RequestsMemory {
  listUsers(): Promise<(PlannerUser & Pick<User, "demo">)[]>;
  requests: RequestStore;
  objectives: {
    create(o: { template: string; params: Record<string, unknown>; mode: ObjectiveMode; lang?: string | null; userId: string | null; notBefore?: Iso | null; deadline?: Iso | null; createdBy: string }): Promise<Pick<Objective, "id">>;
    cancel(id: string): Promise<unknown>;
  };
}

/** An objective as the after-call step sees it now: its status and what it got. */
export type ObjectiveState = Pick<Objective, "id" | "status"> & Partial<Pick<Objective, "result" | "calls">>;

/** A draft with the token that approves exactly it (none when something blocks approval). */
export interface RequestView {
  request: StoredRequest;
  confirmToken: string | null;
}

const httpError = (status: number, message: string): HttpError => Object.assign(new Error(message), { status });
const now = (): Iso => new Date().toISOString();

export function createRequests({ memory, skill, auth, llm, queue = null, notifier = null, publicUrl = "", log = () => {}, onCancel = async () => {}, outbound = () => false }: {
  memory: RequestsMemory;
  skill: PlannerSkill;
  auth: Pick<Auth, "confirmToken" | "checkConfirm">;
  llm: PlannerLlm;
  queue?: Pick<Queue, "enqueue"> | null;
  notifier?: Pick<Notifier, "channels" | "send"> | null;
  publicUrl?: string;
  log?: Log;
  /** An objective was cancelled: its outbound call too (the scheduler's cancelFor). */
  onCancel?: (objectiveId: string) => Promise<unknown> | unknown;
  /** Can this server place calls? */
  outbound?: () => boolean;
}) {
  const store = memory.requests;
  // A draft goes out with its confirm token, unless something blocks approval.
  const withToken = (r: StoredRequest): RequestView => ({ request: r, confirmToken: r.status === "draft" && r.card && !r.card.blocked.length ? auth.confirmToken(r.id, r.planHash) : null });

  /** The request moves from one of `from` to `to` (with `patch`), or nothing happens and it's null. */
  const transition = (id: string, from: RequestStatus[], to: RequestStatus, patch: RequestPatch = {}) => store.transition(id, from, to, patch);
  const already = async (id: string) => httpError(409, `it's ${(await store.get(id))?.status ?? "gone"} already`);

  async function plan({ instruction, by = "admin" }: { instruction: unknown; by?: string }): Promise<RequestView> {
    const text = String(instruction ?? "").trim();
    if (text.length < 5) throw httpError(400, "say what you want to find out");
    if (text.length > 2000) throw httpError(400, "that's too long for one request");
    const users = await memory.listUsers();
    const { plan, card } = await draftPlan({ instruction: text, users, skill, llm, outbound: outbound() });
    const r = await store.create({
      id: `req_${randomUUID().slice(0, 8)}`, userId: plan.target?.userId ?? null, instruction: text, plan, planHash: planHash(plan), card, turns: [],
      status: "draft", createdBy: by,
    });
    log(`request ${r.id} planned: ${card.summary || card.title}`);
    return withToken(r);
  }

  /**
   * A conversation about his day (template discovery.day): no questions to plan, so no model.
   * mode: outbound (Toni calls him) | next_inbound | either; without outbound calls on this
   * server, or without his consent, it becomes his next call, with a warning on the card.
   */
  async function planConversation({ userId = null, focus = "", mode = "outbound", by = "admin" }: { userId?: string | null; focus?: string; mode?: string; by?: string } = {}): Promise<RequestView> {
    const users = await memory.listUsers();
    const people = users.filter(u => !u.demo); // "the only one" means the only real person
    const user = users.find(u => u.id === userId) ?? (people.length === 1 ? people[0] : null);
    if (!user) throw httpError(400, "who should Toni talk to? (userId)");
    let params: PlanParams;
    try { params = planParams(skill.objectiveParams("discovery.day", { focus })); } catch (err) { throw Object.assign(err instanceof Error ? err : new Error(String(err)), { status: 400 }); }
    const warnings: string[] = [];
    let m: ObjectiveMode = mode === "next_inbound" || mode === "either" ? mode : "outbound";
    if (m !== "next_inbound" && !outbound()) { warnings.push("Outbound calls aren't set up on this server yet (Twilio); it'll happen in his next call instead."); m = "next_inbound"; }
    else if (m !== "next_inbound" && !callable(user)) { warnings.push(`${user.name} can't be called yet (${!user.phone ? "no phone number" : user.outboundPaused ? "calls to him are paused" : "he hasn't agreed to be called"}); it'll happen in his next call instead.`); m = "next_inbound"; }
    const plan: DraftPlan = {
      template: "discovery.day", version: skill.templates.get("discovery.day")?.version ?? 1,
      target: { userId: user.id, name: user.name, lang: user.lang, confidence: 1, alternatives: [] },
      params, mode: m, lang: user.lang, notBefore: null, deadline: null, clarifications: [],
      summary: `${user.name} tells Toni about his day; Toni listens, and only now and then asks lightly about what went wrong, or about the problem behind an idea. If the drive ends, the next call picks up where it stopped.`,
    };
    const card = { ...cardFor(plan, { warnings }), title: `Talk with ${user.name} about his day` };
    const r = await store.create({
      id: `req_${randomUUID().slice(0, 8)}`, userId: user.id, instruction: `Talk with ${user.name} about his day${params.focus ? ` (${params.focus})` : ""}`, plan, planHash: planHash(plan), card, turns: [],
      status: "draft", createdBy: by,
    });
    log(`request ${r.id} planned: ${card.title}`);
    return withToken(r);
  }

  /** Max answers a clarification (`answer`, the model plans again) or edits the card (`edits`, no model). */
  async function revise(id: string, { answer = "", edits = null }: { answer?: unknown; edits?: PlanEdits | null } = {}): Promise<RequestView> {
    const r = await store.get(id);
    if (!r) throw httpError(404, "no such request");
    if (r.status !== "draft") throw httpError(409, `it's ${r.status} already`);
    if (!r.plan || r.plan.template !== "inquiry") throw httpError(409, "this one has nothing to re-plan: discard it and plan a new one");
    const said = String(answer ?? "").trim();
    const users = await memory.listUsers();
    const next = edits
      ? editPlan(r.plan, edits, { users, skill, outbound: outbound() })
      : await draftPlan({ instruction: r.instruction, users, skill, llm, previous: r.plan, answer: said, outbound: outbound() });
    const turns: unknown[] = said ? [...(r.turns ?? []), { role: "admin", text: said } satisfies Turn] : r.turns ?? [];
    // Still a draft when it's written: an approval in between keeps the plan it approved.
    const revised = await transition(id, ["draft"], "draft", { plan: next.plan, planHash: planHash(next.plan), card: next.card, turns, userId: next.plan.target?.userId ?? null });
    if (!revised) throw await already(id);
    return withToken(revised);
  }

  async function approve(id: string, { confirmToken }: { confirmToken?: unknown }): Promise<StoredRequest> {
    const r = await store.get(id);
    if (!r) throw httpError(404, "no such request");
    if (r.status !== "draft") throw httpError(409, `it's ${r.status} already`);
    const why = auth.checkConfirm(confirmToken, r.id, planHash(r.plan));
    if (why) throw httpError(409, why);
    if (r.card?.blocked.length) throw httpError(409, `can't approve: ${r.card.blocked.join("; ")}`);
    const p = r.plan;
    if (!p?.target || !p.params) throw httpError(409, "can't approve: it's not clear who should be asked what");
    // Draft → approved once: a second approval (a double click, another tab) is told it's approved already.
    const approved = await transition(id, ["draft"], "approved", { approvedAt: now() });
    if (!approved) throw await already(id);
    if (approved.planHash !== r.planHash) { // revised between the card's check and here
      await transition(id, ["approved"], "draft", { approvedAt: null });
      throw httpError(409, "the plan changed since this card was shown");
    }
    let objective: Pick<Objective, "id">;
    try {
      objective = await memory.objectives.create({
        template: p.template, params: p.params, mode: p.mode, lang: p.lang, userId: p.target.userId,
        notBefore: p.notBefore, deadline: p.deadline ? `${p.deadline}T23:59:59Z` : null, createdBy: `request ${r.id}`,
      });
    } catch (err) {
      await transition(id, ["approved"], "draft", { approvedAt: null }); // nothing was made: it's a draft again
      throw err;
    }
    // Linked while it's still approved; cancelled in the meantime, the objective goes too.
    const linked = await transition(id, ["approved"], "approved", { objectiveId: objective.id });
    if (!linked) {
      await memory.objectives.cancel(objective.id);
      await onCancel(objective.id);
      throw await already(id);
    }
    log(`request ${r.id} approved → objective ${objective.id}`);
    return linked;
  }

  async function cancel(id: string): Promise<StoredRequest> {
    const r = await store.get(id);
    if (!r) throw httpError(404, "no such request");
    const cancelled = await transition(id, ["draft", "approved"], "cancelled", { closedAt: now() });
    const out = cancelled ?? (await store.get(id)) ?? r;
    // Also when an earlier cancel stopped halfway: its objective is cancelled however often this runs.
    if (out.status === "cancelled" && out.objectiveId) { await memory.objectives.cancel(out.objectiveId); await onCancel(out.objectiveId); }
    return out;
  }

  const notifying = () => Boolean(queue && notifier?.channels.length);

  /**
   * After a call: its objectives as they stand now (src/calls/after-call.ts) close their requests, and
   * Max is told. Idempotent: run again after a crash, it closes what's still open and queues what
   * wasn't queued (the job's key makes it once). Returns the requests it changed.
   */
  async function objectivesChanged(objectives: ObjectiveState[] = []): Promise<StoredRequest[]> {
    const changed: StoredRequest[] = [];
    for (const o of objectives) {
      const r = await store.byObjective(o.id);
      if (!r) continue;
      const status = o.status === "done" ? "done" : o.status === "expired" ? "expired" : null;
      let current = r;
      if (r.status === "approved") {
        const result = { ...(o.result ?? {}), calls: o.calls ?? [] };
        // Without a status: partial answers so far.
        const updated = await transition(r.id, ["approved"], status ?? "approved", status ? { result, closedAt: now() } : { result });
        if (updated) { changed.push(updated); current = updated; }
      }
      if (status && current.status === status && !current.notifiedAt && notifying()) await queue?.enqueue("notify", { requestId: r.id }, { key: `notify:${r.id}:${status}` });
    }
    return changed;
  }

  /** Something happened on the way (couldn't reach him, moved to his next call): logged on the card, and Max is told. */
  async function note(objectiveId: string, text: string): Promise<StoredRequest | null> {
    const r = await store.byObjective(objectiveId);
    if (!r) return null;
    const entries = [...(r.log ?? []), { at: now(), text }];
    const updated = await store.update(r.id, { log: entries });
    if (notifying()) await queue?.enqueue("notify", { requestId: r.id, text }, { key: `notify:${r.id}:note:${entries.length}` });
    return updated;
  }

  const link = (r: StoredRequest) => (publicUrl ? `${publicUrl.replace(/\/$/, "")}/admin#${r.id}` : "");
  // The answers in the result (the ask step's: { ask, status, answer, quote } per question).
  const answers = (r: StoredRequest) => (Array.isArray(r.result?.questions) ? r.result.questions : []).filter(isRecord).map(q => {
    const status = String(q.status ?? "not_asked");
    return `- ${String(q.ask ?? "")}\n  ${status === "answered" || status === "vague" ? `${String(q.answer ?? "")}${q.quote ? ` ("${String(q.quote)}")` : ""}` : `(${status.replace("_", " ")})`}`;
  }).join("\n");
  function message(r: StoredRequest): { subject: string; text: string } {
    const who = r.plan?.target?.name ?? "?";
    const calls = Array.isArray(r.result?.calls) ? r.result.calls.length : 0;
    const head = r.status === "done" ? `${who} answered` : `${who} wasn't asked in ${calls} calls; the request expired`;
    return { subject: `${head}: ${r.instruction.slice(0, 60)}`, text: `${head}.\n\n${r.instruction}\n\n${answers(r)}${link(r) ? `\n\n${link(r)}` : ""}` };
  }

  /** The "notify" job: tells Max by webhook / email. Throws on failure, so the queue retries it. */
  async function sendNotification({ requestId, text = null }: { requestId?: unknown; text?: unknown }): Promise<void> {
    if (typeof requestId !== "string") throw new Error("notify job without a requestId");
    const r = await store.get(requestId);
    if (!r || !notifier?.channels.length) return;
    if (typeof text === "string" && text) {
      await notifier.send({ subject: `${r.plan?.target?.name ?? "Request"}: ${text.slice(0, 80)}`, text: `${text}\n\n${r.instruction}${link(r) ? `\n\n${link(r)}` : ""}`, payload: { type: "request.note", request: { id: r.id, instruction: r.instruction, text, link: link(r) } } });
      return;
    }
    const { subject, text: body } = message(r);
    await notifier.send({ subject, text: body, payload: { type: `request.${r.status}`, request: { id: r.id, instruction: r.instruction, status: r.status, who: r.plan?.target?.name, result: r.result, link: link(r) } } });
    await store.update(r.id, { notifiedAt: now() });
  }

  return {
    plan, planConversation, revise, approve, cancel, objectivesChanged, note, sendNotification,
    list: () => store.list(),
    get: (id: string) => store.get(id),
    /** A request as the admin page shows it (drafts with their confirm token). */
    view: (r: StoredRequest | null) => (r ? withToken(r) : null),
  };
}

export type Requests = ReturnType<typeof createRequests>;
