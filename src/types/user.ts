// The people Toni works for: their row, what the API and the pages see, and what a call knows.
import type { Day, Iso, LangId } from "./common.ts";

export type FeatureId = "note_whatsapp" | "quotes";
export type UserRole = "owner" | "member" | "user" | string;

/** When Toni may call him: weekdays 1 (Mon) … 7 (Sun), local "HH:MM" from/to. */
export interface CallWindow {
  days?: number[];
  from?: string;
  to?: string;
}

/** His business, for quotes (People card). Text as typed; VAT as a percentage. */
export interface Business {
  name?: string;
  address?: string;
  phone?: string;
  email?: string;
  taxId?: string;
  currency?: string;
  vatRate?: number;
  validDays?: number;
}

/** His lists for quotes, as he wrote them (src/quotes/lists.ts parses them). */
export interface ListsText {
  jobs?: string;
  site?: string;
  levels?: string;
  siteMax?: number | null;
}

/** users.profile: what we know about him beyond the columns. */
export interface Profile {
  name?: string;
  lang?: LangId;
  place?: string;
  trade?: string;
  accent?: string;
  timezone?: string;
  demo?: boolean;
  business?: Business;
  features?: Partial<Record<FeatureId, Iso>>;
  lists?: ListsText;
  [key: string]: unknown;
}

/** A row of the users table. */
export interface UserRow {
  id: string;
  org_id: string;
  name: string;
  phone_e164: string | null;
  lang: LangId;
  role: UserRole;
  timezone: string;
  call_window: CallWindow | null;
  consent_outbound_at: Date | Iso | null;
  outbound_paused: boolean;
  demo: boolean;
  profile: Profile | null;
  created_at: Date | Iso;
}

/** A person as the API and the pages see him. */
export interface User {
  id: string;
  orgId: string;
  name: string;
  phone: string;
  lang: LangId;
  role: UserRole;
  timezone: string;
  callWindow: CallWindow;
  consentOutboundAt: Iso | null;
  outboundPaused: boolean;
  demo: boolean;
  business: Business;
  features: Partial<Record<FeatureId, Iso>>;
  lists: ListsText;
}

/** What a call knows about the person it's for (a call scope's `user`). */
export interface CallUser {
  id: string;
  orgId: string;
  name: string;
  lang: LangId;
  timezone: string;
  profile: Profile | null;
}

/** A change to a person (People card). Only the keys present change. */
export interface UserPatch {
  name?: string;
  phone?: string | null;
  lang?: LangId;
  timezone?: string;
  callWindow?: CallWindow;
  consentOutbound?: boolean;
  outboundPaused?: boolean;
  business?: Record<string, unknown>;
  features?: Partial<Record<FeatureId, boolean>>;
  lists?: Record<string, unknown>;
}

export type { Day };
