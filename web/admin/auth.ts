// Who's logged in: the login form (team email + password, or the owner's code + TOTP), an
// invite link's form (/admin#invite=<token>: after the #, so it never reaches a server log),
// and logging out.

import { $, busy } from "../shared/html.ts";
import { getJson, postJson, withDev } from "../shared/api.ts";
import type { InviteInfo, LoginOut, Me } from "../shared/types.ts";

/** The session's facts (GET /api/admin/me); null until known. */
export let me: Me | null = null;
export const agentName = (): string => me?.agent || "Toni";
/** May manage the team: an owner, or anyone on a server without logins. */
export const isOwner = (): boolean => !me?.login || me?.me?.role === "owner";

type Screen = "login" | "invite" | "app";
let screen: Screen | null = null;
export const appShown = (): boolean => screen === "app";

export function showOnly(id: Screen): void {
  screen = id;
  for (const s of ["login", "invite", "app"] as const) $(s).style.display = s === id ? "" : "none";
  $("nav").classList.toggle("hide", id !== "app");
}
export function showLogin(): void {
  showOnly("login");
  $("logout").style.display = "none";
  $("whoami").textContent = "";
}

export async function loadMe(): Promise<Me> {
  me = await getJson<Me>("/api/admin/me");
  return me;
}

let inviteToken = "";
export async function showInvite(token: string): Promise<void> {
  inviteToken = token;
  showOnly("invite");
  try {
    const info = await postJson<InviteInfo>("/api/team/invite-info", { token }, { anonymous: true });
    $("inviteHint").textContent = info.existing ? `A new password for ${info.email}.` : `For ${info.email}. You'll log in with this email and the password you choose here.`;
    if (info.name) $<HTMLInputElement>("invName").value = info.name;
  } catch (err) {
    $("inviteHint").textContent = "";
    $("invErr").textContent = (err as Error).message;
    $<HTMLButtonElement>("invBtn").disabled = true;
  }
}

/** The forms' buttons; loggedIn: what happens once the session cookie is set. */
export function initAuth({ loggedIn }: { loggedIn: () => void }): void {
  const email = $<HTMLInputElement>("email"), code = $<HTMLInputElement>("code"), totp = $<HTMLInputElement>("totp");
  const loginBtn = $<HTMLButtonElement>("loginBtn");
  async function login(): Promise<void> {
    if (loginBtn.disabled) return;
    $("loginErr").textContent = "";
    try {
      const address = email.value.trim();
      const out = await busy(loginBtn, null, () => postJson<LoginOut>("/api/admin/login", address ? { email: address, password: code.value } : { code: code.value, totp: totp.value }, { anonymous: true }));
      if (out.needTotp) {
        totp.style.display = "";
        $("loginHint").textContent = "And the code from your authenticator app.";
        totp.focus();
        return;
      }
      code.value = "";
      totp.value = "";
      loggedIn();
    } catch (err) { $("loginErr").textContent = (err as Error).message; }
  }
  loginBtn.addEventListener("click", login);
  for (const input of [email, code, totp]) input.addEventListener("keydown", e => { if (e.key === "Enter") void login(); });

  $("logout").addEventListener("click", async () => {
    await postJson("/api/admin/logout", {}, { anonymous: true }).catch(() => {});
    showLogin();
  });

  const invBtn = $<HTMLButtonElement>("invBtn"), invPass = $<HTMLInputElement>("invPass");
  async function accept(): Promise<void> {
    if (invBtn.disabled) return;
    $("invErr").textContent = "";
    try {
      await busy(invBtn, null, () => postJson("/api/team/accept", { token: inviteToken, name: $<HTMLInputElement>("invName").value.trim(), password: invPass.value }, { anonymous: true }));
      invPass.value = "";
      history.replaceState(null, "", `${location.pathname}${location.search}#calls`);
      loggedIn();
    } catch (err) { $("invErr").textContent = (err as Error).message; }
  }
  invBtn.addEventListener("click", accept);
  invPass.addEventListener("keydown", e => { if (e.key === "Enter") void accept(); });
}

/** Once logged in: the top bar's facts. */
export function showMe(m: Me): void {
  showOnly("app");
  $("logout").style.display = m.login ? "" : "none";
  $("devNote").style.display = m.login ? "none" : "";
  $("whoami").textContent = m.me?.name ?? "";
  $("notify").textContent = m.notify?.length ? `results by ${m.notify.join(" + ")}` : "results here only";
  $<HTMLAnchorElement>("monitorLink").href = withDev("/monitor");
}
