// Quotes in Postgres (migration 004): numbered per org and year ("2026-001"), the whole
// quote in `data`, so its PDF can be made again exactly; whether it reached his WhatsApp.

import { buildQuote, businessOf } from "./quote.mjs";
import { localParts } from "../jobs/windows.mjs";

const out = r => r && ({
  id: r.id, number: r.number, lang: r.lang, callId: r.call_id, userId: r.user_id, status: r.status, sentTo: r.sent_to, messageId: r.message_id, error: r.error,
  createdAt: new Date(r.created_at).toISOString(), data: r.data,
});

export function createQuoteStore({ db }) {
  return {
    /** A new quote for `user` (a call scope's user: id, orgId, timezone, profile): numbered and saved. */
    async create({ user, callId = null, lang, items, customer = {}, now = new Date() }) {
      const timeZone = user.timezone || "Europe/Berlin";
      const year = localParts(now, timeZone).date.slice(0, 4);
      const business = businessOf(user.profile);
      // The next number; two quotes at once in one org (rare) meet the unique key, and the second takes the next.
      for (let attempt = 0; attempt < 5; attempt++) {
        const [{ n }] = await db.query("select count(*)::int n from quotes where org_id = $1 and number like $2", [user.orgId, `${year}-%`]);
        const number = `${year}-${String(n + 1 + attempt).padStart(3, "0")}`;
        const data = buildQuote({ number, items, customer, business, lang, now, timeZone });
        const [row] = await db.query(`insert into quotes (org_id, user_id, call_id, number, lang, data) values ($1, $2, $3, $4, $5, $6)
          on conflict (org_id, number) do nothing returning *`, [user.orgId, user.id, callId, number, lang, JSON.stringify(data)]);
        if (row) return out(row);
      }
      throw new Error("couldn't give the quote a number");
    },
    markSent: (id, { to, messageId }) => db.query("update quotes set status = 'sent', sent_to = $2, message_id = $3, error = null where id = $1", [id, to, messageId]),
    markFailed: (id, error) => db.query("update quotes set status = 'failed', error = $2 where id = $1", [id, String(error).slice(0, 500)]),
    get: async id => (/^[0-9a-f-]{36}$/i.test(String(id)) ? out((await db.query("select * from quotes where id = $1", [id]))[0]) ?? null : null),
    /** A call's quotes, for its page on the dashboard (without the full data). */
    async forCall(callId) {
      return (await db.query("select * from quotes where call_id = $1 order by created_at", [callId])).map(r => {
        const { data, ...q } = out(r);
        return { ...q, draft: data.draft, gross: data.gross, net: data.net, currency: data.currency, customer: data.customer?.name ?? "", items: data.items.length };
      });
    },
  };
}
