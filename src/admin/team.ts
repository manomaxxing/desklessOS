// Who can log in to the admin page: people with their own email and password.
//   An owner (the ADMIN_CODE login, or a member with role owner) invites someone by email
//   and sends them the link; they set their name and password on it. The link works once,
//   for 7 days. Inviting someone again is how a forgotten password is reset.
//   A session names the member and their session_version (src/admin/auth.ts). Every
//   request checks it against the table (cached 30 s per instance), so removing someone,
//   or a new password, ends their sessions.
// Passwords are scrypt hashes; invites are kept as the SHA-256 of their token. Neither is
// ever logged or sent back.

import crypto from "node:crypto";
import type { Db } from "../db/client.ts";
import type { Iso, HttpError } from "../types/common.ts";
import type { Auth, Session } from "./auth.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_TTL_MS = 30000;
export const MIN_PASSWORD = 10;
const SCRYPT = { N: 16384, r: 8, p: 1 };
const scrypt = (password: string, salt: Buffer, keylen: number, o: crypto.ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => crypto.scrypt(password, salt, keylen, o, (err, key) => (err ? reject(err) : resolve(key))));
const isUuid = (s: unknown): s is string => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s ?? ""));
const sha256 = (s: unknown) => crypto.createHash("sha256").update(String(s)).digest("base64url");
const fail = (status: number, message: string): HttpError => Object.assign(new Error(message), { status });
export const normEmail = (s: unknown): string => String(s ?? "").trim().toLowerCase();

export async function hashPassword(password: unknown): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, 64, SCRYPT);
  return `scrypt:${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${salt.toString("base64url")}:${key.toString("base64url")}`;
}
export async function verifyPassword(password: unknown, stored: unknown): Promise<boolean> {
  const [kind, N, r, p, salt, hash] = String(stored ?? "").split(":");
  if (kind !== "scrypt" || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = await scrypt(String(password ?? ""), Buffer.from(salt, "base64url"), want.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(got, want);
}
// An unknown email still costs one scrypt, so the answer's timing doesn't say who has an account.
const DUMMY = hashPassword(crypto.randomBytes(16).toString("hex"));
DUMMY.catch(() => {}); // awaited where it's used; never an unhandled rejection at startup

/** A row of the members table. */
interface MemberRow {
  id: string;
  email: string;
  name: string | null;
  role: string;
  password_hash: string | null;
  invite_hash: string | null;
  invite_expires_at: Date | Iso | null;
  invited_by: string | null;
  session_version: number;
  last_login_at: Date | Iso | null;
  created_at: Date | Iso;
}

/** A login as the admin page sees it. */
export interface Member {
  id: string;
  email: string;
  name: string | null;
  role: string;
  invitedBy: string | null;
  status: "active" | "invited";
  inviteExpiresAt: Iso | null;
  lastLoginAt: Iso | null;
  createdAt: Iso;
}

const memberOut = (m: MemberRow): Member => ({
  id: m.id, email: m.email, name: m.name, role: m.role, invitedBy: m.invited_by,
  status: m.password_hash ? "active" : "invited",
  inviteExpiresAt: m.invite_expires_at ? new Date(m.invite_expires_at).toISOString() : null,
  lastLoginAt: m.last_login_at ? new Date(m.last_login_at).toISOString() : null,
  createdAt: new Date(m.created_at).toISOString(),
});

export interface Team {
  list(): Promise<Member[]>;
  /** { member, token }: the token goes into the link and nowhere else. */
  invite(o: { email: unknown; role?: unknown; by?: string }): Promise<{ member: Member; token: string }>;
  /** Whom a link is for, so the page can greet them. Null when it's used up or expired. */
  inviteInfo(token: unknown): Promise<{ email: string; name: string | null; existing: boolean } | null>;
  /** The link, a name and a password → their login, and a session. */
  accept(o: { token: unknown; name?: unknown; password: unknown }): Promise<{ member: Member; token: string }>;
  login(o: { email: unknown; password: unknown; ip?: string }): Promise<{ member: Member; token: string } | { error: string; status: number }>;
  remove(id: string, o?: { by?: string | null }): Promise<Member>;
  /** A signed session (auth.session) → the session with their current role and name, or null when they're gone. */
  check(session: Session | null): Promise<Session | null>;
}

export function createTeam({ db, auth }: { db: Pick<Db, "query">; auth: Pick<Auth, "issue" | "attempts"> }): Team {
  const seen = new Map<string, { at: number; version: number; role: string; name: string }>(); // member id → what the table said (version -1: gone)
  const sessionFor = (m: MemberRow) => auth.issue({ id: m.id, version: m.session_version, role: m.role, name: m.name || m.email, email: m.email });

  return {
    async list() {
      return (await db.query<MemberRow>("select * from members order by created_at")).map(memberOut);
    },

    async invite({ email, role = "member", by = "" }) {
      const e = normEmail(email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw fail(400, "an email address, please");
      if (role !== "owner" && role !== "member") throw fail(400, "role: owner or member");
      const token = crypto.randomBytes(24).toString("base64url");
      // Someone already on the team keeps their role; the new link resets their password.
      const [m] = await db.query<MemberRow>(`insert into members (email, role, invite_hash, invite_expires_at, invited_by) values ($1, $2, $3, $4, $5)
        on conflict (email) do update set invite_hash = excluded.invite_hash, invite_expires_at = excluded.invite_expires_at, invited_by = excluded.invited_by returning *`,
        [e, role, sha256(token), new Date(Date.now() + INVITE_TTL_MS).toISOString(), by]);
      return { member: memberOut(m), token };
    },

    async inviteInfo(token) {
      const [m] = await db.query<{ email: string; name: string | null; existing: boolean }>("select email, name, password_hash is not null existing from members where invite_hash = $1 and invite_expires_at > now()", [sha256(token)]);
      return m ? { email: m.email, name: m.name, existing: m.existing } : null;
    },

    async accept({ token, name = "", password }) {
      if (String(password ?? "").length < MIN_PASSWORD) throw fail(400, `a password of at least ${MIN_PASSWORD} characters`);
      // The link first: a used or made-up one costs no scrypt.
      const used = () => fail(410, "this link was used already or has expired: ask for a new one");
      if (!(await db.query("select 1 from members where invite_hash = $1 and invite_expires_at > now()", [sha256(token)])).length) throw used();
      const hash = await hashPassword(password);
      // Still conditional on the link: of two tabs accepting the same link, one wins.
      const [m] = await db.query<MemberRow>(`update members set name = coalesce(nullif($2, ''), nullif(name, ''), split_part(email, '@', 1)), password_hash = $3,
          invite_hash = null, invite_expires_at = null, session_version = session_version + 1, last_login_at = now()
        where invite_hash = $1 and invite_expires_at > now() returning *`, [sha256(token), String(name).trim().slice(0, 80), hash]);
      if (!m) throw used();
      seen.delete(m.id);
      return { member: memberOut(m), token: sessionFor(m) };
    },

    async login({ email, password, ip = "?" }) {
      const e = normEmail(email);
      if (auth.attempts.locked(ip, e)) return { error: "too many attempts, try again later", status: 429 };
      const [m] = await db.query<MemberRow>("select * from members where email = $1 and password_hash is not null", [e]);
      const ok = m ? await verifyPassword(password, m.password_hash) : (await verifyPassword(password, await DUMMY), false);
      if (!m || !ok) { auth.attempts.fail(ip, e); return { error: "wrong email or password", status: 401 }; }
      auth.attempts.clear(ip);
      await db.query("update members set last_login_at = now() where id = $1", [m.id]);
      return { member: memberOut(m), token: sessionFor(m) };
    },

    async remove(id, { by = null } = {}) {
      if (!isUuid(id)) throw fail(404, "no such login");
      if (by === id) throw fail(400, "you can't remove yourself");
      const [m] = await db.query<MemberRow>("delete from members where id = $1 returning *", [id]);
      if (!m) throw fail(404, "no such login");
      seen.delete(id);
      return memberOut(m);
    },

    async check(session) {
      if (!session) return null;
      if (session.m === "code") return session;
      if (!isUuid(session.m)) return null;
      let hit = seen.get(session.m);
      if (!hit || Date.now() - hit.at > CHECK_TTL_MS) {
        const [m] = await db.query<Pick<MemberRow, "session_version" | "role" | "name" | "email">>("select session_version, role, name, email from members where id = $1 and password_hash is not null", [session.m]);
        hit = { at: Date.now(), version: m?.session_version ?? -1, role: m?.role ?? "", name: m?.name || m?.email || "" };
        seen.set(session.m, hit);
      }
      return hit.version === session.v ? { ...session, r: hit.role, n: hit.name } : null;
    },
  };
}
