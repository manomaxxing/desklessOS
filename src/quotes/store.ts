// Quotes in Postgres (migration 004): numbered per org and year ("2026-001"), the whole
// quote in `data`, so its PDF can be made again exactly; whether it reached his WhatsApp.

import { buildQuote, businessOf } from "./quote.ts";
import { localParts } from "../jobs/windows.ts";
import type { Queryable } from "../db/client.ts";
import type { Iso, LangId } from "../types/common.ts";
import type { CallUser } from "../types/user.ts";
import type { Quote, QuoteCalc, QuoteData, QuoteStatus } from "../types/quote.ts";

/** A row of the quotes table. */
interface QuoteRow {
  id: string;
  org_id: string;
  user_id: string;
  call_id: string | null;
  number: string;
  lang: LangId;
  status: QuoteStatus;
  sent_to: string | null;
  message_id: string | null;
  error: string | null;
  created_at: Date | Iso;
  data: QuoteData;
}

/** A call's quote as its page on the dashboard lists it (without the full data). */
export type QuoteListing = Omit<Quote, "data"> & {
  draft: boolean;
  gross: number | null;
  net: number | null;
  currency: string;
  customer: string;
  items: number;
  calc: QuoteCalc | null;
};

export interface NewQuote {
  /** A call scope's user: id, orgId, timezone, profile. */
  user: Pick<CallUser, "id" | "orgId" | "timezone" | "profile">;
  callId?: string | null;
  lang: LangId;
  /** The tool's line items, as they came (src/quotes/quote.ts cleans them). */
  items: unknown;
  customer?: { name?: unknown; address?: unknown };
  calc?: QuoteCalc | null;
  now?: Date;
}

export interface QuoteStore {
  create(input: NewQuote): Promise<Quote>;
  markSent(id: string, sent: { to: string; messageId: string | null }): Promise<void>;
  markFailed(id: string, error: unknown): Promise<void>;
  get(id: unknown): Promise<Quote | null>;
  forCall(callId: string): Promise<QuoteListing[]>;
}

const out = (r: QuoteRow): Quote => ({
  id: r.id, number: r.number, lang: r.lang, callId: r.call_id, userId: r.user_id, status: r.status, sentTo: r.sent_to, messageId: r.message_id, error: r.error,
  createdAt: new Date(r.created_at).toISOString(), data: r.data,
});

export function createQuoteStore({ db }: { db: Queryable }): QuoteStore {
  return {
    /** A new quote for `user` (a call scope's user: id, orgId, timezone, profile): numbered and saved. */
    async create({ user, callId = null, lang, items, customer = {}, calc = null, now = new Date() }) {
      const timeZone = user.timezone || "Europe/Berlin";
      const year = localParts(now, timeZone).date.slice(0, 4);
      const business = businessOf(user.profile);
      // The next number; two quotes at once in one org (rare) meet the unique key, and the second takes the next.
      for (let attempt = 0; attempt < 5; attempt++) {
        const [count] = await db.query<{ n: number }>("select count(*)::int n from quotes where org_id = $1 and number like $2", [user.orgId, `${year}-%`]);
        const number = `${year}-${String((count?.n ?? 0) + 1 + attempt).padStart(3, "0")}`;
        const data = buildQuote({ number, items, customer, business, lang, now, timeZone, calc });
        const [row] = await db.query<QuoteRow>(`insert into quotes (org_id, user_id, call_id, number, lang, data) values ($1, $2, $3, $4, $5, $6)
          on conflict (org_id, number) do nothing returning *`, [user.orgId, user.id, callId, number, lang, JSON.stringify(data)]);
        if (row) return out(row);
      }
      throw new Error("couldn't give the quote a number");
    },
    async markSent(id, { to, messageId }) {
      await db.query("update quotes set status = 'sent', sent_to = $2, message_id = $3, error = null where id = $1", [id, to, messageId]);
    },
    async markFailed(id, error) {
      await db.query("update quotes set status = 'failed', error = $2 where id = $1", [id, String(error).slice(0, 500)]);
    },
    async get(id) {
      if (!/^[0-9a-f-]{36}$/i.test(String(id))) return null;
      const [row] = await db.query<QuoteRow>("select * from quotes where id = $1", [String(id)]);
      return row ? out(row) : null;
    },
    /** A call's quotes, for its page on the dashboard (without the full data). */
    async forCall(callId) {
      return (await db.query<QuoteRow>("select * from quotes where call_id = $1 order by created_at", [callId])).map(r => {
        const { data, ...q } = out(r);
        return { ...q, draft: data.draft, gross: data.gross, net: data.net, currency: data.currency, customer: data.customer?.name ?? "", items: data.items.length, calc: data.calc ?? null };
      });
    },
  };
}
