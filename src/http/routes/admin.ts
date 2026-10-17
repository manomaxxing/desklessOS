// Logging in (the owner's code, or a team member's email and password) and the team.
import type { ApiDeps, LoginOut } from "../deps.ts";
import type { AccessControl } from "../access.ts";
import type { Route, RouteCtx } from "../router.ts";
import { clientIp } from "../access.ts";
import { fail, param } from "../router.ts";

export function adminRoutes({ auth, team, notifier, skill, monitor, log }: ApiDeps, access: AccessControl): Route[] {
  const by = (ctx: RouteCtx) => ctx.who.session?.n ?? "dev";
  const loggedIn = ({ req, setCookie }: RouteCtx, token: string) => {
    const session = auth.session(token);
    setCookie(access.sessionCookie(req, token, (session?.exp ?? Date.now()) - Date.now()));
    return { ok: true };
  };
  const noTeam = () => fail(503, "no team logins here");
  return [
    // { email, password } (the team), or { code, totp? } (the owner's code). Sets the session cookie.
    ["POST", "/api/admin/login", "public", async ctx => {
      const { req, body } = ctx;
      const ip = clientIp(req);
      const out: LoginOut = body.email
        ? team ? await team.login({ email: body.email, password: body.password, ip }) : { error: "no team logins here", status: 503 }
        : auth.login({ code: body.code ?? body.password, totp: body.totp, ip });
      if ("error" in out) { log(`admin login refused (${out.status ?? 401})`); throw fail(out.status ?? 401, out.error); }
      if ("needTotp" in out) return out;
      if (out.member) log(`admin login: ${out.member.email}`);
      return loggedIn(ctx, out.token);
    }],
    ["POST", "/api/admin/logout", "public", ({ req, setCookie }) => { setCookie(access.sessionCookie(req, "", 0)); return { ok: true }; }],
    ["GET", "/api/admin/me", "user", ({ who }) => ({ admin: access.isAdmin(who), login: auth.enabled, twoFactor: auth.twoFactor, notify: notifier.channels, me: access.me(who), team: Boolean(team), agent: skill.persona?.agentLabel ?? null })],

    // ---------- the team: who can log in ----------
    ["GET", "/api/team", "admin", async () => ({ members: team ? await team.list() : [] })],
    // { email, role? } → { member, token }; the page turns the token into the link (/admin#invite=…).
    ["POST", "/api/team/invite", "owner", async ctx => {
      if (!team) throw noTeam();
      const out = await team.invite({ email: ctx.body.email, role: ctx.body.role, by: by(ctx) });
      monitor.system(`login invite for ${out.member.email} (${out.member.role}) by ${by(ctx)}`);
      return out;
    }],
    ["POST", "/api/team/invite-info", "public", async ({ body }) => {
      const info = team && (await team.inviteInfo(String(body.token ?? "")));
      if (!info) throw fail(410, "this link was used already or has expired: ask for a new one");
      return info;
    }],
    ["POST", "/api/team/accept", "public", async ctx => {
      if (!team) throw noTeam();
      const out = await team.accept({ token: String(ctx.body.token ?? ""), name: ctx.body.name, password: ctx.body.password, ip: clientIp(ctx.req) });
      monitor.system(`${out.member.email} set up their login`);
      return loggedIn(ctx, out.token);
    }],
    ["POST", /^\/api\/team\/([\w-]+)\/remove$/, "owner", async ctx => {
      if (!team) throw noTeam();
      const m = await team.remove(param(ctx), { by: ctx.who.session?.m ?? null });
      monitor.system(`login removed: ${m.email} by ${by(ctx)}`);
      return { member: m };
    }],
  ];
}
