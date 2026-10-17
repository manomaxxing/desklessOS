// Who may call what:
//   public  anyone (pages, health, login; Twilio's and WhatsApp's webhooks are the adapters' and carry a signature)
//   user    DEV_TOKEN (x-dev-token header, or ?token= where a URL is all there is: links, WebSockets) or an admin session
//   admin   an admin session once ADMIN_CODE is set (before that, the user rule)
//   owner   an owner's session: the ADMIN_CODE login, or a team member with role owner (managing the team)
//   tick    X-Tick-Token: TICK_TOKEN (Cloud Scheduler, and the instance that just ended a call)
// An admin session is the HttpOnly cookie the login sets (SameSite=Lax), or a token as
// Authorization: Bearer … (scripts, tests). A team member's is checked against the team on every
// request (src/admin/team.ts). With neither DEV_TOKEN nor ADMIN_CODE set (a local run) everything
// is open; on Cloud Run the config refuses to start that way.

import type { IncomingMessage } from "node:http";
import type { Session } from "../admin/auth.ts";
import { safeEqual } from "../shared/safe-equal.ts";

export type Access = "public" | "user" | "admin" | "owner" | "tick";
export type { Session };

export interface Who {
  dev: boolean;
  session: Session | null;
  viaCookie: boolean;
}

export interface AccessDeps {
  cfg: { devToken: string; tickToken: string };
  auth: { enabled: boolean; session(token: string): Session | null };
  team?: { check(session: Session | null): Promise<Session | null> } | null;
}

const COOKIE = "deskless_session";
const cookieOf = (req: IncomingMessage): string => (req.headers.cookie ?? "").split(/;\s*/).find(c => c.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? "";
const header = (req: IncomingMessage, name: string): string => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};
/** A secret compared in constant time; an empty one never matches. */
const same = (a: string, b: string): boolean => Boolean(a && b) && safeEqual(a, b);

/** The caller's address. Cloud Run appends the address it saw to X-Forwarded-For: the right-most entry; the rest is the client's to write. */
export function clientIp(req: IncomingMessage): string {
  const hops = header(req, "x-forwarded-for").split(",").map(s => s.trim()).filter(Boolean);
  return hops.at(-1) || req.socket.remoteAddress || "?";
}

export function createAccess({ cfg, auth, team = null }: AccessDeps) {
  const open = !cfg.devToken && !auth.enabled;

  /** Who's asking: { dev } for DEV_TOKEN (or a local run with no login at all), { session } for an admin session. */
  async function identify(req: IncomingMessage, url: URL): Promise<Who> {
    const bearer = header(req, "authorization").replace(/^Bearer\s+/i, "");
    const cookie = cookieOf(req);
    const param = url.searchParams.get("token") || "";
    const signed = [bearer, cookie, param].map(t => (t ? auth.session(t) : null));
    const i = signed.findIndex(Boolean);
    const found = i < 0 ? null : signed[i] ?? null;
    const session = !found ? null : team ? await team.check(found) : found.m === "code" ? found : null;
    const devToken = header(req, "x-dev-token") || param;
    return { dev: open || same(devToken, cfg.devToken), session, viaCookie: i === 1 };
  }
  const isUser = (who: Who): boolean => who.dev || Boolean(who.session);
  const isAdmin = (who: Who): boolean => (auth.enabled ? Boolean(who.session) : isUser(who));
  const rules: Record<Access, (who: Who, req: IncomingMessage) => boolean> = {
    public: () => true,
    user: isUser,
    admin: isAdmin,
    owner: who => (auth.enabled ? who.session?.r === "owner" : isUser(who)),
    tick: (_who, req) => (cfg.tickToken ? same(header(req, "x-tick-token"), cfg.tickToken) : open),
  };

  return {
    identify,
    isUser,
    isAdmin,
    allowed: (access: Access, who: Who, req: IncomingMessage): boolean => rules[access](who, req),
    me: (who: Who) => (who.session ? { name: who.session.n, email: who.session.e ?? "", role: who.session.r, id: who.session.m } : null),
    sessionCookie: (req: IncomingMessage, token: string, maxAgeMs: number): string =>
      `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.round(maxAgeMs / 1000))}${header(req, "x-forwarded-proto") === "https" ? "; Secure" : ""}`,
  };
}
export type AccessControl = ReturnType<typeof createAccess>;
