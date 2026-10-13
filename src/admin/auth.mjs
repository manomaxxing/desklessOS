// Admin login and signatures (ported from mano-app: server/totp.js, session.js, the
// login handler). No dependencies, Node's crypto only.
//   ADMIN_CODE          the admin's login code; unset = no admin (dev: admin routes fall
//                       back to DEV_TOKEN, like the rest of the API)
//   ADMIN_TOTP_SECRET   base32 TOTP secret (npm run admin:totp makes one); set = a code from
//                       the authenticator app is needed too
//   SESSION_SECRET      signs sessions and confirm tokens (default: derived from ADMIN_CODE)
// Secrets and codes are credentials: never logged, never sent to a model.

import crypto from "node:crypto";

const STEP = 30; // seconds per TOTP code
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; // RFC 4648 base32
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const CONFIRM_TTL_MS = 30 * 60 * 1000; // an approval card is valid for half an hour

// ---------- TOTP (RFC 6238) ----------
export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[=\s]/g, "");
  let bits = "";
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i >= 0) bits += i.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac("sha1", secret).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** A code from the authenticator app, allowing ±`window` steps of clock drift. */
export function verifyTotp(secretBase32, code, { window = 1, now = Date.now() } = {}) {
  const t = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(t)) return false;
  const secret = base32Decode(secretBase32);
  if (!secret.length) return false;
  const counter = Math.floor(now / 1000 / STEP);
  let ok = false;
  for (let w = -window; w <= window; w++) ok = crypto.timingSafeEqual(Buffer.from(hotp(secret, counter + w)), Buffer.from(t)) || ok;
  return ok;
}

export function generateSecret(bytes = 20) {
  let bits = "";
  for (const b of crypto.randomBytes(bytes)) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
export const otpauthUri = (secret, { label = "admin", issuer = "DesklessOS" } = {}) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(DIGITS), period: String(STEP) })}`;

// ---------- signatures ----------
export function createAuth(env = process.env) {
  const code = env.ADMIN_CODE?.trim() || "";
  const totpSecret = env.ADMIN_TOTP_SECRET?.trim() || "";
  const key = env.SESSION_SECRET?.trim() || `deskless:${code || "dev"}`;
  const mac = body => crypto.createHmac("sha256", key).update(body).digest("base64url");
  const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const sign = payload => { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); return `${body}.${mac(body)}`; };
  const open = token => {
    const [body, sig] = String(token ?? "").split(".");
    if (!body || !sig || !same(sig, mac(body))) return null;
    try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  };

  // Brute force on the login: 5 failures from one address lock it for 15 minutes.
  const failures = new Map();
  const locked = ip => (failures.get(ip)?.until ?? 0) > Date.now();
  const fail = ip => {
    const f = failures.get(ip) ?? { n: 0, until: 0 };
    f.n += 1;
    if (f.n >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.n = 0; }
    failures.set(ip, f);
  };

  return {
    /** Is there an admin at all? Without ADMIN_CODE, admin routes use the dev rule (DEV_TOKEN). */
    enabled: Boolean(code),
    twoFactor: Boolean(totpSecret),

    /** { token } | { needTotp } | { error, status } */
    login({ code: given, totp, ip = "?" }) {
      if (!code) return { error: "no admin configured (set ADMIN_CODE)", status: 503 };
      if (locked(ip)) return { error: "too many attempts, try again later", status: 429 };
      if (!same(String(given ?? "").trim(), code)) { fail(ip); return { error: "wrong code", status: 401 }; }
      if (totpSecret) {
        // Right code but no TOTP yet: ask for it, without counting this as a success.
        if (!totp) return { needTotp: true };
        if (!verifyTotp(totpSecret, totp)) { fail(ip); return { error: "wrong authenticator code", status: 401 }; }
      }
      failures.delete(ip);
      return { token: sign({ role: "admin", exp: Date.now() + SESSION_TTL_MS }) };
    },

    /** The session payload, or null. */
    session(token) {
      const p = open(token);
      return p?.role === "admin" && p.exp > Date.now() ? p : null;
    },

    /** Approval binds to exactly this plan: request id + the plan's hash + an expiry. */
    confirmToken(requestId, planHash, ttlMs = CONFIRM_TTL_MS) {
      return sign({ role: "confirm", id: requestId, plan: planHash, exp: Date.now() + ttlMs });
    },
    checkConfirm(token, requestId, planHash) {
      const p = open(token);
      if (!p || p.role !== "confirm") return "not a valid approval";
      if (p.exp < Date.now()) return "this card has expired; plan it again";
      if (p.id !== requestId) return "this approval belongs to another request";
      if (p.plan !== planHash) return "the plan changed since this card was shown";
      return null;
    },
  };
}

/** A stable hash of a plan (key order doesn't matter). */
export function planHash(plan) {
  const stable = v => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v);
  return crypto.createHash("sha256").update(JSON.stringify(stable(plan))).digest("base64url").slice(0, 22);
}
