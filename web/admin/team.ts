// Under the people: who can log in here. An owner invites (a link, valid once for 7 days),
// sends a new link (which also resets a password), and removes people.

import { $, html, setHtml, delegate, copyText, busy } from "../shared/html.ts";
import { getJson, postJson, seg } from "../shared/api.ts";
import { fmtDate, fmtDateTime } from "../shared/format.ts";
import { me, isOwner } from "./auth.ts";
import type { InviteOut, Member } from "../shared/types.ts";

let inviteLink = "";

function memberHtml(m: Member, self: string | undefined) {
  return html`<div class="member">
    <div class="grow"><b>${m.name || m.email}</b> <span class="chip ${m.role === "owner" ? "approved" : ""}">${m.role}</span>${m.status === "invited" && html` <span class="chip draft">invited</span>`}${m.id === self && html` <span class="chip">you</span>`}
      <div class="muted small">${m.email} · ${m.status === "invited" ? `link valid until ${m.inviteExpiresAt ? fmtDate(m.inviteExpiresAt) : "?"}` : m.lastLoginAt ? `last login ${fmtDateTime(m.lastLoginAt)}` : "never logged in"}${m.invitedBy ? ` · invited by ${m.invitedBy}` : ""}</div></div>
    ${isOwner() && m.id !== self && html`<button class="btn" data-reinvite="${m.email}" title="A new link; it also resets their password">New link</button><button class="btn danger" data-remove="${m.id}" data-name="${m.name || m.email}">Remove</button>`}
  </div>`;
}

export async function loadTeam(signal?: AbortSignal): Promise<void> {
  try {
    const { members } = await getJson<{ members: Member[] }>("/api/team", { signal });
    const self = me?.me?.id;
    setHtml($("team"), members.length
      ? html`${members.map(m => memberHtml(m, self))}`
      : html`<div class="muted small" style="padding:6px 0 10px">Nobody yet${self === "code" ? ": you're logged in with the admin code. Invite yourself too, so you have your own login." : "."}</div>`);
    $("inviteForm").classList.toggle("hide", !isOwner());
    $("teamNote").classList.toggle("hide", isOwner());
  } catch (err) {
    if (signal?.aborted) throw err;
    setHtml($("team"), html`<div class="err" role="alert">${(err as Error).message}</div>`);
  }
}

async function invite(email: string, role: string, button: HTMLButtonElement): Promise<void> {
  $("teamErr").textContent = "";
  try {
    const { member, token } = await busy(button, null, () => postJson<InviteOut>("/api/team/invite", { email, role }));
    inviteLink = `${location.origin}/admin#invite=${token}`;
    setHtml($("invOut"), html`<div class="note">Send this link to ${member.email}${member.status === "active" ? " (it sets a new password)" : ""}. It works once, for 7 days.
      <div class="row" style="margin-top:8px"><input type="text" readonly value="${inviteLink}" aria-label="Invite link" style="flex:1;width:auto;min-width:200px"><button class="btn" id="copyInvite">Copy</button></div></div>`);
    $<HTMLInputElement>("invEmail").value = "";
    await loadTeam();
  } catch (e) { $("teamErr").textContent = (e as Error).message; }
}

export function initTeam(): void {
  const createBtn = $<HTMLButtonElement>("invCreate");
  createBtn.addEventListener("click", () => {
    if (!createBtn.disabled) void invite($<HTMLInputElement>("invEmail").value.trim(), $<HTMLSelectElement>("invRole").value, createBtn);
  });
  delegate($("invOut"), "click", "#copyInvite", (_, b) => void copyText(inviteLink, b));
  delegate($("team"), "click", "[data-reinvite]", (_, b) => void invite(b.dataset.reinvite ?? "", "member", b as HTMLButtonElement));
  delegate($("team"), "click", "[data-remove]", async (_, b) => {
    if (!confirm(`Remove ${b.dataset.name}? They're logged out right away.`)) return;
    $("teamErr").textContent = "";
    try {
      await busy(b as HTMLButtonElement, null, () => postJson(`/api/team/${seg(b.dataset.remove ?? "")}/remove`, {}));
      await loadTeam();
    } catch (e) { $("teamErr").textContent = (e as Error).message; }
  });
}
