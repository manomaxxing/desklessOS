// Quotes: line items as he said them, totals computed in code (src/quotes/quote.ts).
import type { Day, Iso, LangId } from "./common.ts";
import type { Business } from "./user.ts";

export interface QuoteLine {
  pos: number;
  description: string;
  quantity: number | null;
  unit: string;
  unitPrice: number | null;
  total: number | null;
}

/** How list prices were worked out (src/quotes/lists.ts): kept for the dashboard. */
export interface QuoteCalc {
  quality: { name: string; factor: number } | null;
  site: { factor: number; unfavourable: string[] };
  factor: number;
  fromList: number;
}

export interface QuoteData {
  number: string;
  lang: LangId;
  date: Day;
  validUntil: Day;
  currency: string;
  vatRate: number;
  draft: boolean;
  business: Required<Pick<Business, "name" | "address" | "phone" | "email" | "taxId" | "currency" | "vatRate" | "validDays">>;
  customer: { name: string; address: string };
  items: QuoteLine[];
  net: number | null;
  vat: number | null;
  gross: number | null;
  complete: boolean;
  quality: string;
  calc?: QuoteCalc;
}

export type QuoteStatus = "saved" | "sent" | "failed";

export interface Quote {
  id: string;
  number: string;
  lang: LangId;
  callId: string | null;
  userId: string;
  status: QuoteStatus;
  sentTo: string | null;
  messageId: string | null;
  error: string | null;
  createdAt: Iso;
  data: QuoteData;
}
