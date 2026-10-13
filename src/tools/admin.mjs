// Tools for Max's own line (persona admin): draft a request, approve it with his PIN,
// hear where requests stand. Drafting is harmless (nothing reaches a user's call until
// approved); approving and reading answers need ADMIN_PIN, because a caller ID can be
// faked. Three wrong PINs and this call can't try again.

import { timingSafeEqual } from "node:crypto";
import { defineTool } from "./registry.mjs";
import { planHash } from "../admin/auth.mjs";
import { locales } from "../locale/index.mjs";

// "4711", "4 7 1 1", "vier sieben eins eins": the digits (number words from every locale pack's lexicon.digits).
function digits(said) {
  const words = new Map();
  for (const id of locales().enabled()) (locales().get(id).lexicon?.digits ?? []).forEach((w, d) => words.set(w.toLowerCase(), String(d)));
  return String(said ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).map(t => (/^\d+$/.test(t) ? t : words.get(t) ?? "")).join("");
}

export function adminTools({ requests, auth, pin = process.env.ADMIN_PIN?.trim() || "" }) {
  let wrong = 0;
  const drafts = new Map(); // this call's drafts by instruction: asking again doesn't plan again
  let lastDraft = null;
  function checkPin(given) {
    if (!pin) return "No PIN is set up for the phone: approve it on the admin page.";
    if (wrong >= 3) return "Three wrong PINs on this call: approve it on the admin page.";
    const a = Buffer.from(digits(given)), b = Buffer.from(digits(pin));
    if (a.length !== b.length || !timingSafeEqual(a, b)) { wrong += 1; return `Wrong PIN (${3 - wrong} tries left on this call).`; }
    return null;
  }
  const brief = view => {
    const { request: r } = view;
    return {
      request_id: r.id, status: r.status, summary: r.card.summary, who: r.card.who, when: r.card.when,
      questions: r.card.questions.map(q => q.ask), warnings: r.card.warnings, clarifications: r.card.clarifications,
      can_approve: Boolean(view.confirmToken), blocked: r.card.blocked,
    };
  };

  return [
    defineTool({
      name: "request_create",
      description: "Draft a task for the assistant from what Max just said (who to ask what, and whether to call them). Returns the card to read back. Drafting only: nothing happens until it's approved.",
      parameters: { type: "OBJECT", properties: { instruction: { type: "STRING", description: "Max's words, as he said them" } }, required: ["instruction"] },
      timeoutMs: 60000,
      run: async ({ instruction }) => {
        const key = String(instruction ?? "").toLowerCase().replace(/\W+/g, " ").trim();
        if (drafts.has(key)) return { ...drafts.get(key), note: "already drafted on this call; read it back again or approve it" };
        const out = brief(await requests.plan({ instruction, by: "phone" }));
        const draft = { ...out, summary: out.summary || `draft ${out.request_id}` };
        drafts.set(key, draft);
        lastDraft = draft.request_id;
        return draft;
      },
    }),
    defineTool({
      name: "request_approve",
      description: "Approve the task drafted on this call, once Max said yes to the read-back and told you his PIN.",
      parameters: { type: "OBJECT", properties: { pin: { type: "STRING", description: "the PIN as he said it, digits or words" }, request_id: { type: "STRING", description: "only if it's not the one drafted last" } }, required: ["pin"] },
      effect: "write",
      // His PIN is the confirmation (the flow is read-back → yes → PIN), so no NEXT: confirm gate here.
      timeoutMs: 15000,
      // The same request approved twice is one approval.
      key: input => ({ id: input.request_id || lastDraft }),
      // A refusal is an error, not a result: the runner keeps results of writes, and a wrong PIN must not stick.
      run: async ({ request_id, pin: given }) => {
        const id = request_id || lastDraft;
        if (!id) throw new Error("nothing drafted on this call yet: call request_create first");
        const bad = checkPin(given);
        if (bad) throw new Error(bad);
        const r = await requests.get(id);
        if (!r) throw new Error(`there's no request ${id}`);
        // He approved what was read back to him: the current card of this request.
        const approved = await requests.approve(id, { confirmToken: auth.confirmToken(id, planHash(r.plan)) });
        return { approved: true, status: approved.status, summary: `approved: ${approved.card.summary || approved.instruction}` };
      },
    }),
    defineTool({
      name: "request_status",
      description: "Where Max's recent tasks stand, with the answers that came back. Needs his PIN.",
      parameters: { type: "OBJECT", properties: { pin: { type: "STRING" } }, required: ["pin"] },
      timeoutMs: 5000,
      run: async ({ pin: given }) => {
        const bad = checkPin(given);
        if (bad) throw new Error(bad);
        const list = (await requests.list()).slice(0, 5).map(r => ({
          id: r.id, asked: r.instruction, status: r.status,
          answers: (r.result?.questions ?? []).map(q => ({ question: q.ask, status: q.status, answer: q.answer, words: q.quote })),
          notes: (r.log ?? []).slice(-2).map(l => l.text),
        }));
        return { requests: list, summary: `${list.length} recent requests` };
      },
    }),
  ];
}
