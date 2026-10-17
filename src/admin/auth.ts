// Admin login and signatures (ported from mano-app: server/totp.js, session.js, the
// login handler). No dependencies, Node's crypto only.
//   ADMIN_CODE          the owner's login code; unset = no admin (dev: admin routes fall
//                       back to DEV_TOKEN, like the rest of the API). The team logs in with
//                       their own email and password (src/admin/team.ts), once it's set.
//   ADMIN_TOTP_SECRET   base32 TOTP secret (npm run admin:totp makes one); set = a code from
//                       the authenticator app is needed too, with the code
//   SESSION_SECRET      signs sessions and confirm tokens; required on Cloud Run (K_SERVICE),
//                       derived from ADMIN_CODE only on local runs
// A session names who it is: { m: member id, v: their session_version, r: role, n: name },
// or m "code" for the code's login, which a new ADMIN_CODE ends (k, the code's fingerprint).
// Secrets and codes are credentials: never logged, never sent to a model.

import { safeEqual } from "../shared/safe-equal.ts";
import { isRecord } from "../shared/is-record.ts";
import crypto from "node:crypto";

const STEP = 30; // seconds per TOTP code
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 base32
const CODE_SESSION_MS = 12 * 60 * 60 * 1000; // the owner's code: half a day
export const MEMBER_SESSION_MS = 30 * 24 * 60 * 60 * 1000; // the team's own logins: a month (removal ends them sooner)
export const CONFIRM_TTL_MS = 30 * 60 * 1000; // an approval card is valid for half an hour
// Brute force on the logins: 5 failures from one address within the window lock it for 15 minutes;
// 20 on one account (the owner's code, or one email) from anywhere lock that account.
const LOCK_MS = 15 * 60 * 1000;
const PER_ADDRESS = 5;
const PER_ACCOUNT = 20;
const MAX_TRACKED = 5000; // addresses and accounts remembered; spoofed ones mustn't grow it without end

// ---------- TOTP (RFC 6238) ----------
export function base32Decode(str: string): Buffer {
  const clean = String(str).toUpperCase().replace(/[=\s]/g, "");
  let bits = "";
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i >= 0) bits += i.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** A code from the authenticator app, allowing ±`window` steps of clock drift. */
export function verifyTotp(secretBase32: string, code: unknown, { window = 1, now = Date.now() } = {}): boolean {
  const t = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(t)) return false;
  const secret = base32Decode(secretBase32);
  if (!secret.length) return false;
  const counter = Math.floor(now / 1000 / STEP);
  let ok = false;
  for (let w = -window; w <= window; w++) ok = crypto.timingSafeEqual(Buffer.from(hotp(secret, counter + w)), Buffer.from(t)) || ok;
  return ok;
}

export function generateSecret(bytes = 20): string {
  let bits = "";
  for (const b of crypto.randomBytes(bytes)) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
export const otpauthUri = (secret: string, { label = "admin", issuer = "DesklessOS" } = {}): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP) })}`;

// ---------- signatures ----------
/** A signed admin session: the owner's code (m "code", k its fingerprint) or a team member (m their id, v their session_version). */
export interface Session {
  role: "admin";
  m: string;
  v?: number;
  k?: string;
  r: string;
  n: string;
  e?: string;
  exp: number;
}

export type LoginResult = { token: string } | { needTotp: true } | { error: string; status: number };

/** The brute-force guard: per address, and per account (the code, or a member's email) whoever tries. */
export interface Attempts {
  locked(ip: string, account?: string): boolean;
  fail(ip: string, account?: string): void;
  clear(ip: string): void;
}

export interface Auth {
  /** Is there an admin at all? Without ADMIN_CODE, admin routes use the dev rule (DEV_TOKEN). */
  enabled: boolean;
  twoFactor: boolean;
  /** The brute-force guard, for the team's logins too. */
  attempts: Attempts;
  /** A member's session (src/admin/team.ts checks they still exist on every request). */
  issue(member: { id: string; version: number; role: string; name: string; email: string }): string;
  login(o: { code?: unknown; totp?: unknown; ip?: string }): LoginResult;
  /** The session payload, or null. Signature and expiry only: a member's is checked against the team too. */
  session(token: unknown): Session | null;
  /** Approval binds to exactly this plan: request id + the plan's hash + an expiry. */
  confirmToken(requestId: string, planHash: string | null, ttlMs?: number): string;
  /** Null when the token approves exactly this plan; else why not. */
  checkConfirm(token: unknown, requestId: string, planHash: string): string | null;
}

export type Env = Record<string, string | undefined>;

const CODE_ACCOUNT = "code"; // the owner's code is one account, whoever tries it
const CODE_KEY = `account:${CODE_ACCOUNT}`;

function lockout(now: () => number = Date.now): Attempts {
  const failures = new Map<string, { n: number; at: number; until: number }>(); // key → failures in the window, the last one, locked until
  const live = (f: { at: number; until: number }, t: number) => f.until > t || t - f.at < LOCK_MS;
  function count(key: string, limit: number): void {
    const t = now();
    const old = failures.get(key);
    const f = old && live(old, t) ? old : { n: 0, at: t, until: 0 };
    f.n += 1;
    f.at = t;
    if (f.n >= limit) { f.until = t + LOCK_MS; f.n = 0; }
    failures.delete(key); // re-added: the map's order is oldest first
    failures.set(key, f);
    if (failures.size > MAX_TRACKED) {
      // Forgotten first: what's over, then the oldest that aren't locked, then (all locked) the oldest locks.
      // The owner code's own count is never forgotten: a flood of made-up addresses can't unlock it.
      for (const [k, v] of failures) if (!live(v, t)) failures.delete(k);
      for (const [k, v] of failures) { if (failures.size <= MAX_TRACKED) break; if (v.until <= t && k !== CODE_KEY) failures.delete(k); }
      for (const k of failures.keys()) { if (failures.size <= MAX_TRACKED) break; if (k !== CODE_KEY) failures.delete(k); }
    }
  }
  const isLocked = (key: string) => (failures.get(key)?.until ?? 0) > now();
  return {
    locked: (ip, account) => isLocked(`ip:${ip}`) || (account !== undefined && isLocked(`account:${account}`)),
    fail(ip, account) {
      count(`ip:${ip}`, PER_ADDRESS);
      if (account !== undefined) count(`account:${account}`, PER_ACCOUNT);
    },
    clear: ip => { failures.delete(`ip:${ip}`); },
  };
}

const isSession = (p: unknown): p is Session => isRecord(p) && p.role === "admin" && typeof p.m === "string" && typeof p.exp === "number";

export function createAuth(env: Env = process.env, { now = Date.now }: { now?: () => number } = {}): Auth {
  const code = env.ADMIN_CODE?.trim() || "";
  const totpSecret = env.ADMIN_TOTP_SECRET?.trim() || "";
  const secret = env.SESSION_SECRET?.trim() || "";
  // On Cloud Run the sessions' key must be its own secret: one derived from ADMIN_CODE would let
  // anyone who learns the code forge sessions that outlive a new code, and "dev" would be guessable.
  if (env.K_SERVICE && !secret) throw new Error("SESSION_SECRET is required on Cloud Run: set it to a long random value (openssl rand -hex 32)");
  const key = secret || `deskless:${code || "dev"}`;
  const fingerprint = crypto.createHmac("sha256", key).update(`code:${code}`).digest("base64url").slice(0, 12);
  const mac = (body: string) => crypto.createHmac("sha256", key).update(body).digest("base64url");
  const same = safeEqual;
  const sign = (payload: Record<string, unknown>) => { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); return `${body}.${mac(body)}`; };
  const open = (token: unknown): unknown => {
    const [body, sig] = String(token ?? "").split(".");
    if (!body || !sig || !same(sig, mac(body))) return null;
    try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  };
  const attempts = lockout(now);

  return {
    enabled: Boolean(code),
    twoFactor: Boolean(totpSecret),
    attempts,
    issue: ({ id, version, role, name, email }) => sign({ role: "admin", m: id, v: version, r: role, n: name, e: email, exp: now() + MEMBER_SESSION_MS }),

    login({ code: given, totp, ip = "?" }) {
      if (!code) return { error: "no admin configured (set ADMIN_CODE)", status: 503 };
      if (attempts.locked(ip, CODE_ACCOUNT)) return { error: "too many attempts, try again later", status: 429 };
      if (!same(String(given ?? "").trim(), code)) { attempts.fail(ip, CODE_ACCOUNT); return { error: "wrong code", status: 401 }; }
      if (totpSecret) {
        // Right code but no TOTP yet: ask for it, without counting this as a success.
        if (!totp) return { needTotp: true };
        if (!verifyTotp(totpSecret, totp, { now: now() })) { attempts.fail(ip, CODE_ACCOUNT); return { error: "wrong authenticator code", status: 401 }; }
      }
      attempts.clear(ip);
      return { token: sign({ role: "admin", m: "code", k: fingerprint, r: "owner", n: "Admin", exp: now() + CODE_SESSION_MS }) };
    },

    session(token) {
      const p = open(token);
      if (!isSession(p) || !(p.exp > now())) return null;
      if (p.m === "code") return code && p.k === fingerprint ? p : null;
      return p.m ? p : null;
    },

    confirmToken(requestId, planHash, ttlMs = CONFIRM_TTL_MS) {
      return sign({ role: "confirm", id: requestId, plan: planHash, exp: now() + ttlMs });
    },
    checkConfirm(token, requestId, planHash) {
      const p = open(token);
      if (!isRecord(p) || p.role !== "confirm") return "not a valid approval";
      if (!(Number(p.exp) >= now())) return "this card has expired; plan it again";
      if (p.id !== requestId) return "this approval belongs to another request";
      if (p.plan !== planHash) return "the plan changed since this card was shown";
      return null;
    },
  };
}

/** A stable hash of a plan (key order doesn't matter). */
export function planHash(plan: unknown): string {
  const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v);
  return crypto.createHash("sha256").update(JSON.stringify(stable(plan))).digest("base64url").slice(0, 22);
}
