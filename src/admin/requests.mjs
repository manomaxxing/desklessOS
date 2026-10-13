// Admin requests: Max's instruction → a plan and its card → his approval → an
// objective for the user's next call → the result back on his page (and by webhook
// or email). The request follows its objective: done when the objective is done,
// expired when it ran out of calls.
//   draft → approved → done | expired       draft | approved → cancelled
// Approval needs the confirm token issued with the card: it's signed over the
// request id and the plan's hash, so what gets approved is exactly what was shown.

import { randomUUID } from "node:crypto";
import { draftPlan, editPlan } from "./planner.mjs";
import { planHash } from "./auth.mjs";

export function createRequests({ memory, skill, auth, llm, notifier = null, publicUrl = "", log = () => {} }) {
  // A draft goes out with its confirm token, unless something blocks approval.
  const withToken = r => ({ request: r, confirmToken: r.status === "draft" && !r.card.blocked.length ? auth.confirmToken(r.id, r.planHash) : null });

  async function plan({ instruction, by = "admin" }) {
    const text = String(instruction ?? "").trim();
    if (text.length < 5) throw Object.assign(new Error("say what you want to find out"), { status: 400 });
    if (text.length > 2000) throw Object.assign(new Error("that's too long for one request"), { status: 400 });
    const users = await memory.listUsers();
    const { plan, card } = await draftPlan({ instruction: text, users, skill, llm });
    const r = await memory.requests.create({
      id: `req_${randomUUID().slice(0, 8)}`, userId: plan.target?.userId ?? null, instruction: text, plan, planHash: planHash(plan), card, turns: [],
      status: "draft", createdBy: by, createdAt: new Date().toISOString(), notifyStatus: "none", notifyAttempts: 0,
    });
    log(`request ${r.id} planned: ${card.summary || card.title}`);
    return withToken(r);
  }

  /** Max answers a clarification (`answer`, the model plans again) or edits the card (`edits`, no model). */
  async function revise(id, { answer = "", edits = null } = {}) {
    const r = await memory.requests.get(id);
    if (!r) throw Object.assign(new Error("no such request"), { status: 404 });
    if (r.status !== "draft") throw Object.assign(new Error(`it's ${r.status} already`), { status: 409 });
    const users = await memory.listUsers();
    const next = edits
      ? editPlan(r.plan, edits, { users, skill })
      : await draftPlan({ instruction: r.instruction, users, skill, llm, previous: r.plan, answer: String(answer).trim() });
    const turns = answer ? [...(r.turns ?? []), { role: "admin", text: String(answer).trim() }] : r.turns ?? [];
    return withToken(await memory.requests.update(id, { plan: next.plan, planHash: planHash(next.plan), card: next.card, turns, userId: next.plan.target?.userId ?? null }));
  }

  async function approve(id, { confirmToken }) {
    const r = await memory.requests.get(id);
    if (!r) throw Object.assign(new Error("no such request"), { status: 404 });
    if (r.status !== "draft") throw Object.assign(new Error(`it's ${r.status} already`), { status: 409 });
    const why = auth.checkConfirm(confirmToken, r.id, planHash(r.plan));
    if (why) throw Object.assign(new Error(why), { status: 409 });
    if (r.card.blocked.length) throw Object.assign(new Error(`can't approve: ${r.card.blocked.join("; ")}`), { status: 409 });
    const p = r.plan;
    const objective = await memory.objectives.create({
      template: p.template, params: p.params, mode: p.mode, lang: p.lang, userId: p.target.userId,
      notBefore: p.notBefore, deadline: p.deadline ? `${p.deadline}T23:59:59Z` : null, createdBy: `request ${r.id}`,
    });
    log(`request ${r.id} approved → objective ${objective.id}`);
    return memory.requests.update(id, { status: "approved", objectiveId: objective.id, approvedAt: new Date().toISOString() });
  }

  async function cancel(id) {
    const r = await memory.requests.get(id);
    if (!r) throw Object.assign(new Error("no such request"), { status: 404 });
    if (!["draft", "approved"].includes(r.status)) return r;
    if (r.objectiveId) await memory.objectives.cancel(r.objectiveId);
    return memory.requests.update(id, { status: "cancelled", closedAt: new Date().toISOString() });
  }

  /** After a call: objectives that changed (scope.recordObjectives) close their requests. */
  async function objectivesChanged(objectives = []) {
    const closed = [];
    for (const o of objectives) {
      const r = await memory.requests.byObjective(o.id);
      if (!r || r.status !== "approved") continue;
      const status = o.status === "done" ? "done" : o.status === "expired" ? "expired" : null;
      const result = { ...(o.result ?? {}), calls: o.calls ?? [] };
      const patch = status
        ? { status, result, closedAt: new Date().toISOString(), notifyStatus: notifier?.channels.length ? "pending" : "none" }
        : { result }; // partial answers so far
      closed.push(await memory.requests.update(r.id, patch));
    }
    if (closed.some(r => r.notifyStatus === "pending")) flushNotifications().catch(err => log("notify error", err.message));
    return closed;
  }

  const link = r => (publicUrl ? `${publicUrl.replace(/\/$/, "")}/admin#${r.id}` : "");
  function message(r) {
    const who = r.plan?.target?.name ?? "?";
    const answers = (r.result?.questions ?? []).map(q => `- ${q.ask}\n  ${q.status === "answered" || q.status === "vague" ? `${q.answer}${q.quote ? ` ("${q.quote}")` : ""}` : `(${q.status.replace("_", " ")})`}`).join("\n");
    const head = r.status === "done" ? `${who} answered` : `${who} wasn't asked in ${r.result?.calls?.length ?? 0} calls; the request expired`;
    return { subject: `${head}: ${r.instruction.slice(0, 60)}`, text: `${head}.\n\n${r.instruction}\n\n${answers}${link(r) ? `\n\n${link(r)}` : ""}` };
  }

  /** The outbox: delivers pending notifications, retrying failed ones up to five times. One run at a time. */
  let flushing = null;
  function flushNotifications() {
    flushing ??= deliver().finally(() => { flushing = null; });
    return flushing;
  }
  async function deliver() {
    if (!notifier?.channels.length) return [];
    const sent = [];
    for (const r of await memory.requests.pendingNotifications()) {
      try {
        const { subject, text } = message(r);
        await notifier.send({ subject, text, payload: { type: `request.${r.status}`, request: { id: r.id, instruction: r.instruction, status: r.status, who: r.plan?.target?.name, result: r.result, link: link(r) } } });
        sent.push(await memory.requests.update(r.id, { notifyStatus: "sent", notifiedAt: new Date().toISOString(), notifyAttempts: (r.notifyAttempts ?? 0) + 1, notifyError: null }));
      } catch (err) {
        await memory.requests.update(r.id, { notifyStatus: "failed", notifyAttempts: (r.notifyAttempts ?? 0) + 1, notifyError: err.message.slice(0, 300) });
        log(`notify ${r.id} failed: ${err.message}`);
      }
    }
    return sent;
  }

  return {
    plan, revise, approve, cancel, objectivesChanged, flushNotifications,
    list: () => memory.requests.list(),
    get: id => memory.requests.get(id),
    /** A request as the admin page shows it (drafts with their confirm token). */
    view: r => (r ? withToken(r) : null),
  };
}
