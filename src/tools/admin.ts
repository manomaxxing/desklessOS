// Tools for Max's own line (persona admin): draft a request, approve it with his PIN,
// hear where requests stand. Drafting is harmless (nothing reaches a user's call until
// approved); approving and reading answers need ADMIN_PIN, because a caller ID can be
// faked. Three wrong PINs and this call can't try again. The PIN never shows in the
// monitor (secretArgs).

import { defineTool } from "./registry.ts";
import { planHash } from "../admin/auth.ts";
import { locales } from "../locale/index.ts";
import { isRecord } from "../shared/is-record.ts";
import { safeEqual } from "../shared/safe-equal.ts";
import type { CallTool } from "./registry.ts";
import type { Request } from "../types/request.ts";

/** What the tools need of Max's requests (src/admin/requests.ts). */
export interface AdminRequests {
  plan(input: { instruction: string; by: string }): Promise<{ request: Request; confirmToken: string | null }>;
  get(id: string): Promise<Request | null>;
  approve(id: string, opts: { confirmToken: string }): Promise<Request>;
  list(): Promise<Request[]>;
}
export interface AdminAuth {
  confirmToken(requestId: string, planHash: string): string;
}

// "4711", "4 7 1 1", "vier sieben eins eins": the digits (number words from every locale pack's lexicon.digits).
function digits(said: unknown): string {
  const words = new Map<string, string>();
  for (const id of locales().enabled()) (locales().get(id).lexicon?.digits ?? []).forEach((w: string, d: number) => words.set(w.toLowerCase(), String(d)));
  return String(said ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).map(t => (/^\d+$/.test(t) ? t : words.get(t) ?? "")).join("");
}

// The same instruction, however it was punctuated: letters and digits of any script ("Müller" isn't "Möller").
const draftKey = (instruction: unknown) => String(instruction ?? "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export function adminTools({ requests, auth, pin = process.env.ADMIN_PIN?.trim() || "" }: { requests: AdminRequests; auth: AdminAuth; pin?: string }): CallTool[] {
  let wrong = 0;
  const drafts = new Map<string, ReturnType<typeof brief>>(); // this call's drafts by instruction: asking again doesn't plan again
  let lastDraft: string | null = null; // the draft Max last heard read back: "approve" without an id means this one
  function checkPin(given: unknown): string | null {
    const expected = digits(pin);
    // A PIN without digits would match anything said without digits ("" = ""): as good as none.
    if (!expected) return "No PIN is set up for the phone: approve it on the admin page.";
    if (wrong >= 3) return "Three wrong PINs on this call: approve it on the admin page.";
    if (!safeEqual(digits(given), expected)) { wrong += 1; return `Wrong PIN (${3 - wrong} tries left on this call).`; }
    return null;
  }
  function brief(view: { request: Request; confirmToken: string | null }) {
    const { request: r } = view;
    const card = r.card;
    return {
      request_id: r.id, status: r.status, summary: card?.summary ?? "", who: card?.who ?? "", when: card?.when ?? "",
      questions: (card?.questions ?? []).map(q => q.ask), warnings: card?.warnings ?? [], clarifications: card?.clarifications ?? [],
      can_approve: Boolean(view.confirmToken), blocked: card?.blocked ?? [],
    };
  }

  return [
    defineTool({
      name: "request_create",
      description: "Draft a task for the assistant from what Max just said (who to ask what, and whether to call them). Returns the card to read back. Drafting only: nothing happens until it's approved.",
      parameters: { type: "OBJECT", properties: { instruction: { type: "STRING", description: "Max's words, as he said them" } }, required: ["instruction"] },
      timeoutMs: 60000,
      run: async ({ instruction }, ctx) => {
        const key = draftKey(instruction);
        const known = drafts.get(key);
        const draft = known ?? await (async () => {
          const out = brief(await requests.plan({ instruction: String(instruction ?? ""), by: "phone" }));
          const made = { ...out, summary: out.summary || `draft ${out.request_id}` };
          drafts.set(key, made);
          return made;
        })();
        // Only a card he heard is "the one drafted last": a turn taken back while it was planned drops
        // the result (the planning itself goes on, and is kept for when he asks again).
        if (!ctx.signal?.aborted) lastDraft = draft.request_id;
        return known ? { ...draft, note: "already drafted on this call; read it back again or approve it" } : draft;
      },
    }),
    defineTool({
      name: "request_approve",
      description: "Approve the task drafted on this call, once Max said yes to the read-back and told you his PIN.",
      parameters: { type: "OBJECT", properties: { pin: { type: "STRING", description: "the PIN as he said it, digits or words" }, request_id: { type: "STRING", description: "only if it's not the one drafted last" } }, required: ["pin"] },
      effect: "write",
      secretArgs: ["pin"],
      // His PIN is the confirmation (the flow is read-back → yes → PIN), so no NEXT: confirm gate here.
      timeoutMs: 15000,
      // The same request approved twice is one approval.
      key: input => ({ id: input.request_id || lastDraft }),
      // A refusal is an error, not a result: the runner keeps results of writes, and a wrong PIN must not stick.
      run: async ({ request_id, pin: given }) => {
        const id = request_id ? String(request_id) : lastDraft;
        if (!id) throw new Error("nothing drafted on this call yet: call request_create first");
        const refused = checkPin(given);
        if (refused) throw new Error(refused);
        const r = await requests.get(id);
        if (!r) throw new Error(`there's no request ${id}`);
        // He approved what was read back to him: the current card of this request.
        const approved = await requests.approve(id, { confirmToken: auth.confirmToken(id, planHash(r.plan)) });
        return { approved: true, status: approved.status, summary: `approved: ${approved.card?.summary || approved.instruction}` };
      },
    }),
    defineTool({
      name: "request_status",
      description: "Where Max's recent tasks stand, with the answers that came back. Needs his PIN.",
      parameters: { type: "OBJECT", properties: { pin: { type: "STRING" } }, required: ["pin"] },
      secretArgs: ["pin"],
      timeoutMs: 5000,
      run: async ({ pin: given }) => {
        const refused = checkPin(given);
        if (refused) throw new Error(refused);
        const list = (await requests.list()).slice(0, 5).map(r => {
          const questions = r.result?.questions;
          return {
            id: r.id, asked: r.instruction, status: r.status,
            answers: (Array.isArray(questions) ? questions : []).filter(isRecord).map(q => ({ question: q.ask, status: q.status, answer: q.answer, words: q.quote })),
            notes: (r.log ?? []).slice(-2).map(l => l.text),
          };
        });
        return { requests: list, summary: `${list.length} recent requests` };
      },
    }),
  ];
}
