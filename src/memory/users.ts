// The people Toni works for: who's calling, the People list, and the admin's edits.
// Who calls: caller ID → users.phone_e164. A number that isn't on file is nobody: an empty
// memory, nothing kept, never someone else's memory however few users there are. No caller ID
// at all (the online test phone, scripted calls: both need DEV_TOKEN) → the demo user; without
// one, DEFAULT_USER_ID, else the first user.

import type { Queryable, SqlParam } from "../db/client.ts";
import type { Log } from "../types/common.ts";
import type { Business, FeatureId, Profile, User, UserPatch, UserRow } from "../types/user.ts";
import { FEATURES, allFeatures } from "../features.ts";
import { listsIn } from "../quotes/lists.ts";
import { validateCallWindow } from "../jobs/windows.ts";
import { badRequest, e164, isUuid, json, userOut } from "./rows.ts";
import { isRecord } from "../shared/is-record.ts";
import { locales } from "../locale/index.ts";

/** What memory needs of the persona: who the first user is, in which language. */
export interface FirstUser {
  profile?: Profile & { owner?: string; phone?: string };
  DEFAULT_LANG: string;
}

// His business, for quotes (src/quotes/quote.ts): only these fields, as text; VAT and the days a
// quote stays valid as numbers.
const BUSINESS_FIELDS = ["name", "address", "phone", "email", "taxId", "currency", "vatRate", "validDays"] as const;
export function businessIn(b: Record<string, unknown> | undefined): Business {
  const out: Business = {};
  for (const k of BUSINESS_FIELDS) {
    const raw = b?.[k];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const v = String(raw).trim().slice(0, 200);
    if (k === "vatRate") {
      const n = Number(v.replace(",", "."));
      if (!(n >= 0 && n <= 50)) throw badRequest("VAT: a percentage between 0 and 50");
      out.vatRate = n;
    } else if (k === "validDays") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 365) throw badRequest("valid for: a number of days from 1 to 365");
      out.validDays = n;
    } else if (k === "currency") {
      if (!/^[A-Za-z]{3}$/.test(v)) throw badRequest("currency: a three-letter code like EUR");
      out.currency = v.toUpperCase();
    } else out[k] = v;
  }
  return out;
}

/**
 * The People card's edit, from a request body: each field's type checked, a 400 with a plain
 * message otherwise. update() then checks the values (a phone number, a time zone, …).
 */
export function userPatchIn(body: Record<string, unknown>): UserPatch {
  const out: UserPatch = {};
  const text = (name: string, v: unknown, max: number): string => {
    if (typeof v !== "string") throw badRequest(`${name}: text`);
    return v.trim().slice(0, max);
  };
  const flag = (name: string, v: unknown): boolean => {
    if (typeof v !== "boolean") throw badRequest(`${name}: true or false`);
    return v;
  };
  const object = (name: string, v: unknown): Record<string, unknown> => {
    if (!isRecord(v)) throw badRequest(`${name}: an object`);
    return v;
  };
  if ("name" in body) out.name = text("name", body.name, 120);
  if ("phone" in body) out.phone = body.phone === null ? null : text("phone", body.phone, 40) || null;
  if ("lang" in body) {
    const lang = text("lang", body.lang, 20);
    if (!locales().isEnabled(lang)) throw badRequest(`language: one of ${locales().enabled().join(", ")}`);
    out.lang = lang;
  }
  if ("timezone" in body) out.timezone = text("timezone", body.timezone, 64);
  if ("callWindow" in body) out.callWindow = validateCallWindow(body.callWindow);
  if ("consentOutbound" in body) out.consentOutbound = flag("consentOutbound", body.consentOutbound);
  if ("outboundPaused" in body) out.outboundPaused = flag("outboundPaused", body.outboundPaused);
  if ("business" in body) out.business = object("business", body.business);
  if ("lists" in body) out.lists = object("lists", body.lists);
  if ("features" in body) {
    const asked = object("features", body.features);
    out.features = Object.fromEntries(FEATURES.filter(f => f in asked).map(f => [f, flag(`features.${f}`, asked[f])]));
  }
  return out;
}

export function createUsers({ db, persona, log = () => {} }: { db: Queryable; persona: FirstUser; log?: Log }) {
  /** First start on an empty database: an org and a user from the persona's profile. */
  async function ensureUser(): Promise<void> {
    if ((await db.query("select 1 from users limit 1")).length) return;
    const p = persona.profile ?? {};
    const orgName = p.name ?? "Pilot";
    const [org] = await db.query<{ id: string }>("insert into orgs (name) values ($1) returning id", [orgName]);
    const profile = Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v !== "function"));
    await db.query("insert into users (org_id, name, phone_e164, lang, timezone, profile) values ($1, $2, $3, $4, $5, $6)",
      [org!.id, p.owner ?? p.name ?? "User", e164(p.phone), p.lang ?? persona.DEFAULT_LANG, p.timezone ?? "Europe/Berlin", json(profile)]);
    log(`memory: created org "${orgName}" and its first user`);
  }

  async function ensureDemoUser(): Promise<void> {
    if ((await db.query("select 1 from users where demo")).length) return;
    const lang = persona.profile?.lang ?? persona.DEFAULT_LANG;
    const [org] = await db.query<{ id: string }>("insert into orgs (name) values ('Demo') returning id");
    await db.query("insert into users (org_id, name, lang, timezone, demo, profile) values ($1, 'Demo', $2, $3, true, $4)",
      [org!.id, lang, persona.profile?.timezone ?? "Europe/Berlin", json({ name: "Demo", lang, demo: true, features: allFeatures() })]);
    log("memory: created the demo user");
  }

  async function resolveUser(from: unknown): Promise<UserRow | null> {
    const phone = e164(from);
    if (phone) { const [u] = await db.query<UserRow>("select * from users where phone_e164 = $1", [phone]); if (u) return u; }
    if (isUuid(process.env.DEFAULT_USER_ID)) { const [u] = await db.query<UserRow>("select * from users where id = $1", [process.env.DEFAULT_USER_ID]); if (u) return u; }
    const rows = await db.query<UserRow>("select * from users where not demo order by created_at limit 2");
    return rows.length === 1 ? rows[0]! : null;
  }

  async function callerUser(from: unknown): Promise<UserRow | null> {
    const phone = e164(from);
    if (phone) return (await db.query<UserRow>("select * from users where phone_e164 = $1", [phone]))[0] ?? null;
    const [demo] = await db.query<UserRow>("select * from users where demo order by created_at limit 1");
    if (demo) return demo;
    if (isUuid(process.env.DEFAULT_USER_ID)) return resolveUser(null);
    const [first] = await db.query<UserRow>("select * from users order by created_at limit 1");
    return first ?? null;
  }

  const row = async (id: string): Promise<UserRow | null> => (isUuid(id) ? (await db.query<UserRow>("select * from users where id = $1", [id]))[0] ?? null : null);

  async function get(id: string): Promise<User | null> {
    const u = await row(id);
    return u ? userOut(u) : null;
  }

  /** Admin edits: phone, language, time zone, call window, consent to outbound calls (with its date), pause, business, lists, features. */
  async function update(id: string, patch: UserPatch): Promise<User | null> {
    if (!isUuid(id)) return null;
    const sets: string[] = [];
    const values: SqlParam[] = [id];
    const set = (col: string, v: SqlParam) => { values.push(v); sets.push(`${col} = $${values.length}`); };
    if ("name" in patch) set("name", String(patch.name || "").trim() || "?");
    if ("phone" in patch) {
      const p = patch.phone ? e164(patch.phone) : null;
      if (patch.phone && !p) throw badRequest("phone: an international number like +4915112345678");
      set("phone_e164", p);
    }
    if ("lang" in patch) set("lang", String(patch.lang));
    if ("timezone" in patch) {
      try { new Intl.DateTimeFormat(undefined, { timeZone: patch.timezone }); } catch { throw badRequest(`unknown time zone ${patch.timezone}`); }
      set("timezone", patch.timezone);
    }
    if ("callWindow" in patch) set("call_window", json(validateCallWindow(patch.callWindow))); // tidied, or a 400 he can read
    if ("consentOutbound" in patch) set("consent_outbound_at", patch.consentOutbound ? new Date().toISOString() : null);
    if ("outboundPaused" in patch) set("outbound_paused", Boolean(patch.outboundPaused));
    // In the profile: his business and his lists (for quotes), and the features (src/features.ts).
    const profile: Profile = {};
    if ("business" in patch) profile.business = businessIn(patch.business);
    if ("lists" in patch) profile.lists = listsIn(patch.lists);
    // Features: { id: true | false }; one switched on keeps the date it was first switched on.
    if ("features" in patch) {
      const [cur] = await db.query<{ f: Partial<Record<FeatureId, string>> | null }>("select profile->'features' f from users where id = $1", [id]);
      const now = new Date().toISOString();
      const asked = patch.features ?? {};
      const features: Partial<Record<FeatureId, string>> = {};
      for (const f of FEATURES) {
        const on = f in asked ? Boolean(asked[f]) : Boolean(cur?.f?.[f]);
        if (on) features[f] = cur?.f?.[f] ?? now;
      }
      profile.features = features;
    }
    if (Object.keys(profile).length) { values.push(json(profile)); sets.push(`profile = profile || $${values.length}::jsonb`); }
    if (!sets.length) return get(id);
    const [u] = await db.query<UserRow>(`update users set ${sets.join(", ")} where id = $1 returning *`, values);
    return u ? userOut(u) : null;
  }

  return {
    ensureUser,
    ensureDemoUser,
    resolveUser,
    callerUser,
    row,
    get,
    update,
    /** Who can be asked something. */
    list: async (): Promise<User[]> => (await db.query<UserRow>("select * from users order by created_at")).map(userOut),
    defaultUser: () => resolveUser(null),
  };
}
export type Users = ReturnType<typeof createUsers>;
