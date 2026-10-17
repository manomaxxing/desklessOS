// quote_send: the job he just confirmed, as a quote PDF into his WhatsApp chat while he's
// still on the call (free: his call opened the chat window). Only right after his yes
// (requiresConfirm), at most once per call for the same items. Offered on WhatsApp calls;
// on the online test phone it's saved for the dashboard only. Line items come from the
// model; totals are computed in code (src/quotes/quote.ts), the PDF in src/quotes/pdf.ts.
// With his lists (People card), a line can name the list item it's priced from: his price
// × quality level × site factor (src/quotes/lists.ts).
// A send that failed may be tried again: the same items get the same quote (its number), sent again.

import { defineTool, hashValue } from "./registry.ts";
import { renderQuotePdf, quoteFileName, quoteCaption } from "../quotes/pdf.ts";
import { quoteParams, priceFromLists } from "../quotes/lists.ts";
import type { CallTool } from "./registry.ts";
import type { Lists } from "../quotes/lists.ts";
import type { QuoteStore } from "../quotes/store.ts";
import type { Log } from "../types/common.ts";
import type { CallScope } from "../types/call.ts";
import type { Quote } from "../types/quote.ts";
import type { Schema } from "../types/gemini.ts";

/** How a PDF gets into his chat (src/telephony/whatsapp.ts). */
export interface DocumentSender {
  sendDocument(doc: { to: string; bytes: Uint8Array; filename: string; caption: string }): Promise<{ messageId: string | null }>; // Graph may answer without an id
}

export interface QuoteSendOptions {
  /** The call's scope (its user). */
  memory: Pick<CallScope, "user">;
  quotes: QuoteStore;
  /** His WhatsApp, if this call has one. */
  sender?: DocumentSender | null;
  to?: string | null;
  agent?: string;
  /** His lists, parsed. */
  lists?: Lists | null;
  log?: Log;
}

const S: Schema = { type: "STRING" };
const N: Schema = { type: "NUMBER" };

export function quoteSend({ memory, quotes, sender = null, to = null, agent = "Toni", lists = null, log = () => {} }: QuoteSendOptions): CallTool {
  const fromLists = quoteParams(lists);
  const made = new Map<string, Promise<Quote>>(); // "callId:items" → the quote made for them: a retry sends that one again
  return defineTool({
    name: "quote_send",
    description: "Send him the quote for the job he described, as a PDF into his WhatsApp chat (he gets it during the call). Only after he confirmed your summary and said yes to sending it.",
    parameters: {
      type: "OBJECT",
      properties: {
        customer_name: { ...S, description: "the customer as he named them, e.g. \"Familie Huber\" or \"Kliniken Schmieder\"" },
        address: { ...S, description: "the job's address or place, as he said it" },
        items: {
          type: "ARRAY",
          description: "one line per piece of work, as he said it",
          items: {
            type: "OBJECT",
            properties: {
              description: { ...S, description: "the work, short (room or area, what, material), written as on a quote: numbers and sizes in digits (60×60, 2,50 m)" },
              quantity: { ...N, description: "the number only, e.g. 32.5" },
              unit: { ...S, description: "as he said it: m², m, Stück, Std., pauschal" },
              unit_price: { ...N, description: "net price per unit, ONLY if he said one; leave it out otherwise" },
              ...fromLists.item,
            },
            required: ["description"],
          },
        },
        ...fromLists.top,
      },
      required: ["items"],
    },
    effect: "write",
    requiresConfirm: true,
    confirmAbout: "send", // a yes to the job's summary isn't a yes to sending it
    timeoutMs: 20000,
    available: () => Boolean(memory?.user),
    async run(input, ctx) {
      const user = memory.user;
      if (!user) throw new Error("no known caller on this call: there's no one to make the quote for");
      // The same items again (after a failed send) are the quote already made, not a new number.
      const key = `${ctx.callId}:${hashValue(input)}`;
      let pending = made.get(key);
      if (!pending) {
        const { items, calc } = priceFromLists(input.items, lists, input);
        pending = quotes.create({ user, callId: ctx.callId, lang: ctx.lang, items, calc, customer: { name: input.customer_name, address: input.address } });
        made.set(key, pending);
        pending.catch(() => made.delete(key)); // not made at all: the next try makes it
      }
      const quote = await pending;
      const q = quote.data;
      const about = { number: q.number, items: q.items.length, priced: q.items.filter(i => i.total !== null).length, total_with_vat: q.gross, currency: q.currency, draft: q.draft };
      if (!sender || !to) {
        ctx.emit?.("quote", { id: quote.id, number: q.number, sent: false });
        return { ...about, sent: false, saved: true, summary: `quote ${q.number} saved (this call has no WhatsApp; it's on the dashboard)` };
      }
      try {
        const bytes = await renderQuotePdf(q, { agent });
        const { messageId } = await sender.sendDocument({ to, bytes, filename: quoteFileName(q), caption: quoteCaption(q) });
        await quotes.markSent(quote.id, { to, messageId });
        ctx.emit?.("quote", { id: quote.id, number: q.number, sent: true });
        return { ...about, sent: true, summary: `quote ${q.number} sent to his WhatsApp` };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`quote ${q.number}: not sent: ${message}`);
        await quotes.markFailed(quote.id, message).catch(() => {});
        ctx.emit?.("quote", { id: quote.id, number: q.number, sent: false, error: message.slice(0, 200) });
        // What he hears: the reason in plain words, and that the quote isn't lost.
        const why = /131030/.test(message) ? "WhatsApp hasn't approved his number for messages from this test number yet; Max has to add it"
          : /131047|re-?engagement/i.test(message) ? "his WhatsApp chat window is closed (more than 24 hours since he last wrote or called)"
            : "WhatsApp didn't take it just now";
        throw new Error(`NOT sent to his WhatsApp: ${why}. The quote ${q.number} is saved; Max sees it on the dashboard. Say that plainly, don't guess other reasons, and promise nothing more.`);
      }
    },
  });
}
