// quote_send: the job he just confirmed, as a quote PDF into his WhatsApp chat while he's
// still on the call (free: his call opened the chat window). Only right after his yes
// (requiresConfirm), at most once per call for the same items. Offered on WhatsApp calls;
// on the online test phone it's saved for the dashboard only. Line items come from the
// model; totals are computed in code (src/quotes/quote.mjs), the PDF in src/quotes/pdf.mjs.
// With his lists (People card), a line can name the list item it's priced from: his price
// × quality level × site factor (src/quotes/lists.mjs).

import { defineTool } from "./registry.mjs";
import { renderQuotePdf, quoteFileName, quoteCaption } from "../quotes/pdf.mjs";
import { quoteParams, priceFromLists } from "../quotes/lists.mjs";

const S = { type: "STRING" };
const N = { type: "NUMBER" };

/** `memory`: the call's scope (its user); `quotes`: src/quotes/store.mjs; `sender` + `to`: his WhatsApp, if this call has one; `lists`: his lists, parsed. */
export function quoteSend({ memory, quotes, sender = null, to = null, agent = "Toni", lists = null, log = () => {} }) {
  const fromLists = quoteParams(lists);
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
      const { items, calc } = priceFromLists(input.items, lists, input);
      const quote = await quotes.create({ user: memory.user, callId: ctx.callId, lang: ctx.lang, items, calc, customer: { name: input.customer_name, address: input.address } });
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
        log(`quote ${q.number}: not sent: ${err.message}`);
        await quotes.markFailed(quote.id, err.message).catch(() => {});
        ctx.emit?.("quote", { id: quote.id, number: q.number, sent: false, error: err.message.slice(0, 200) });
        // What he hears: the reason in plain words, and that the quote isn't lost.
        const why = /131030/.test(err.message) ? "WhatsApp hasn't approved his number for messages from this test number yet; Max has to add it"
          : /131047|re-?engagement/i.test(err.message) ? "his WhatsApp chat window is closed (more than 24 hours since he last wrote or called)"
            : "WhatsApp didn't take it just now";
        throw new Error(`NOT sent to his WhatsApp: ${why}. The quote ${q.number} is saved; Max sees it on the dashboard. Say that plainly, don't guess other reasons, and promise nothing more.`);
      }
    },
  });
}
