// Admin requests: Max's instruction → a plan and its card → his approval → an
// objective for the user's next call → the result back on his page (and by webhook
// or email, as a "notify" job). The request follows its objective: done when the
// objective is done, expired when it ran out of calls.
//   draft → approved → done | expired       draft | approved → cancelled
// Approval needs the confirm token issued with the card: it's signed over the
// request id and the plan's hash, so what gets approved is exactly what was shown.

import { randomUUID } from "node:crypto";
import { draftPlan, editPlan, cardFor, callable } from "./planner.mjs";
import { planHash } from "./auth.mjs";

export function createRequests({ memory, skill, auth, llm, queue = null, notifier = null, publicUrl = "", log = () => {}, onCancel = async () => {}, outbound = () => false }) {
  // A draft goes out with its confirm token, unless something blocks approval.
  const withToken = r => ({ request: r, confirmToken: r.status === "draft" && !r.card.blocked.length ? auth.confirmToken(r.id, r.planHash) : null });

  async function plan({ instruction, by = "admin" }) {
    const text = String(instruction ?? "").trim();
    if (text.length < 5) throw Object.assign(new Error("say what you want to find out"), { status: 400 });
    if (text.length > 2000) throw Object.assign(new Error("that's too long for one request"), { status: 400 });
    const users = await memory.listUsers();
    const { plan, card } = await draftPlan({ instruction: text, users, skill, llm, outbound: outbound() });
    const r = await memory.requests.create({
      id: `req_${randomUUID().slice(0, 8)}`, userId: plan.target?.userId ?? null, instruction: text, plan, planHash: planHash(plan), card, turns: [],
      status: "draft", createdBy: by, createdAt: new Date().toISOString(),
    });
    log(`request ${r.id} planned: ${card.summary || card.title}`);
    return withToken(r);
  }

  /**
   * A conversation about his day (template discovery.day): no questions to plan, so no model.
   * mode: outbound (Toni calls him) | next_inbound | either; without outbound calls on this
   * server, or without his consent, it becomes his next call, with a warning on the card.
   */
  async function planConversation({ userId = null, focus = "", mode = "outbound", by = "admin" } = {}) {
    const users = await memory.listUsers();
    const user = users.find(u => u.id === userId) ?? (users.length === 1 ? users[0] : null);
    if (!user) throw Object.assign(new Error("who should Toni talk to? (userId)"), { status: 400 });
    let params;
    try { params = skill.objectiveParams("discovery.day", { focus }); } catch (err) { throw Object.assign(err, { status: 400 }); }
    const warnings = [];
    let m = ["outbound", "next_inbound", "either"].includes(mode) ? mode : "outbound";
    if (m !== "next_inbound" && !outbound()) { warnings.push("Outbound calls aren't set up on this server yet (Twilio); it'll happen in his next call instead."); m = "next_inbound"; }
    else if (m !== "next_inbound" && !callable(user)) { warnings.push(`${user.name} can't be called yet (${!user.phone ? "no phone number" : user.outboundPaused ? "calls to him are paused" : "he hasn't agreed to be called"}); it'll happen in his next call instead.`); m = "next_inbound"; }
    const plan = {
      template: "discovery.day", version: skill.templates.get("discovery.day")?.version ?? 1,
      target: { userId: user.id, name: user.name, lang: user.lang, confidence: 1, alternatives: [] },
      params, mode: m, lang: user.lang, notBefore: null, deadline: null, clarifications: [],
      summary: `${user.name} tells Toni about his day; Toni listens, and only now and then asks lightly about what went wrong, or about the problem behind an idea. If the drive ends, the next call picks up where it stopped.`,
    };
    const card = { ...cardFor(plan, { warnings }), title: `Talk with ${user.name} about his day` };
    const r = await memory.requests.create({
      id: `req_${randomUUID().slice(0, 8)}`, userId: user.id, instruction: `Talk with ${user.name} about his day${params.focus ? ` (${params.focus})` : ""}`, plan, planHash: planHash(plan), card, turns: [],
      status: "draft", createdBy: by, createdAt: new Date().toISOString(),
    });
    log(`request ${r.id} planned: ${card.title}`);
    return withToken(r);
  }

  /** Max answers a clarification (`answer`, the model plans again) or edits the card (`edits`, no model). */
  async function revise(id, { answer = "", edits = null } = {}) {
    const r = await memory.requests.get(id);
    if (!r) throw Object.assign(new Error("no such request"), { status: 404 });
    if (r.status !== "draft") throw Object.assign(new Error(`it's ${r.status} already`), { status: 409 });
    if (r.plan?.template !== "inquiry") throw Object.assign(new Error("this one has nothing to re-plan: discard it and plan a new one"), { status: 409 });
    const users = await memory.listUsers();
    const next = edits
      ? editPlan(r.plan, edits, { users, skill, outbound: outbound() })
      : await draftPlan({ instruction: r.instruction, users, skill, llm, previous: r.plan, answer: String(answer).trim(), outbound: outbound() });
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
    if (r.objectiveId) { await memory.objectives.cancel(r.objectiveId); await onCancel(r.objectiveId); }
    return memory.requests.update(id, { status: "cancelled", closedAt: new Date().toISOString() });
  }

  const notifying = () => Boolean(queue && notifier?.channels.length);

  /** After a call: objectives that changed (scope.recordObjectives) close their requests; Max is told. */
  async function objectivesChanged(objectives = []) {
    const closed = [];
    for (const o of objectives) {
      const r = await memory.requests.byObjective(o.id);
      if (!r || r.status !== "approved") continue;
      const status = o.status === "done" ? "done" : o.status === "expired" ? "expired" : null;
      const result = { ...(o.result ?? {}), calls: o.calls ?? [] };
      const updated = await memory.requests.update(r.id, status ? { status, result, closedAt: new Date().toISOString() } : { result }); // without a status: partial answers so far
      if (status && notifying()) await queue.enqueue("notify", { requestId: r.id }, { key: `notify:${r.id}:${status}` });
      closed.push(updated);
    }
    return closed;
  }

  /** Something happened on the way (couldn't reach him, moved to his next call): logged on the card, and Max is told. */
  async function note(objectiveId, text) {
    const r = await memory.requests.byObjective(objectiveId);
    if (!r) return null;
    const log = [...(r.log ?? []), { at: new Date().toISOString(), text }];
    const updated = await memory.requests.update(r.id, { log });
    if (notifying()) await queue.enqueue("notify", { requestId: r.id, text }, { key: `notify:${r.id}:note:${log.length}` });
    return updated;
  }

  const link = r => (publicUrl ? `${publicUrl.replace(/\/$/, "")}/admin#${r.id}` : "");
  function message(r) {
    const who = r.plan?.target?.name ?? "?";
    const answers = (r.result?.questions ?? []).map(q => `- ${q.ask}\n  ${q.status === "answered" || q.status === "vague" ? `${q.answer}${q.quote ? ` ("${q.quote}")` : ""}` : `(${q.status.replace("_", " ")})`}`).join("\n");
    const head = r.status === "done" ? `${who} answered` : `${who} wasn't asked in ${r.result?.calls?.length ?? 0} calls; the request expired`;
    return { subject: `${head}: ${r.instruction.slice(0, 60)}`, text: `${head}.\n\n${r.instruction}\n\n${answers}${link(r) ? `\n\n${link(r)}` : ""}` };
  }

  /** The "notify" job: tells Max by webhook / email. Throws on failure, so the queue retries it. */
  async function sendNotification({ requestId, text = null }) {
    const r = await memory.requests.get(requestId);
    if (!r || !notifier?.channels.length) return;
    if (text) {
      await notifier.send({ subject: `${r.plan?.target?.name ?? "Request"}: ${text.slice(0, 80)}`, text: `${text}\n\n${r.instruction}${link(r) ? `\n\n${link(r)}` : ""}`, payload: { type: "request.note", request: { id: r.id, instruction: r.instruction, text, link: link(r) } } });
      return;
    }
    const { subject, text: body } = message(r);
    await notifier.send({ subject, text: body, payload: { type: `request.${r.status}`, request: { id: r.id, instruction: r.instruction, status: r.status, who: r.plan?.target?.name, result: r.result, link: link(r) } } });
    await memory.requests.update(r.id, { notifiedAt: new Date().toISOString() });
  }

  return {
    plan, planConversation, revise, approve, cancel, objectivesChanged, note, sendNotification,
    list: () => memory.requests.list(),
    get: id => memory.requests.get(id),
    /** A request as the admin page shows it (drafts with their confirm token). */
    view: r => (r ? withToken(r) : null),
  };
}
