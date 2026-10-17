// The admin page (/admin): the calls, requests and people, after a login.
// One poller loads what the current view shows: the calls every 10 s, a live call every 3 s,
// the requests every 10 s, the people only when the view opens. Nothing while the page is
// hidden, never two loads at once, and a newer load always wins over an older one.

import { onUnauthorized, isAbort, ApiError } from "../shared/api.ts";
import { poll } from "../shared/poll.ts";
import { appShown, initAuth, loadMe, showInvite, showLogin, showMe } from "./auth.ts";
import { currentView, inviteToken } from "./router.ts";
import { loadCalls } from "./calls.ts";
import { initCall, leaveCall, liveCallShown, loadCall, openCall } from "./call.ts";
import { initRequests, loadRequests } from "./requests.ts";
import { initPeople, loadPeople } from "./people.ts";
import { initTeam, loadTeam } from "./team.ts";

let opened = true; // the view was just opened: load everything it shows

async function refresh(signal: AbortSignal): Promise<void> {
  if (!appShown()) return;
  const v = currentView();
  const full = opened;
  opened = false;
  try {
    if (v.name === "calls") await loadCalls(signal);
    if (v.name === "call") await loadCall(v.id, signal);
    if (v.name === "requests") await loadRequests(signal, { opened: full });
    if (v.name === "people") await Promise.all([loadPeople(signal, { opened: full }), full ? loadTeam(signal) : null]);
  } catch (err) {
    if (full && !isAbort(err)) opened = true; // try the whole view again next time
    throw err;
  }
}
const every = (): number | null => {
  if (!appShown()) return null;
  const v = currentView().name;
  return v === "people" ? null : v === "call" && liveCallShown() ? 3000 : 10000;
};
const poller = poll(refresh, every, { immediate: false });

function showView(): void {
  const v = currentView();
  for (const el of document.querySelectorAll<HTMLElement>(".view")) el.style.display = el.id === `view-${v.name}` ? "" : "none";
  const navName = v.name === "call" ? "calls" : v.name;
  for (const a of document.querySelectorAll<HTMLAnchorElement>("#nav a")) {
    const on = a.dataset.view === navName;
    a.classList.toggle("on", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (v.name === "call") openCall(v.id);
  else leaveCall();
  opened = true;
  void poller.now();
  if (v.name !== "requests") scrollTo(0, 0);
}

async function start(): Promise<void> {
  const token = inviteToken();
  if (token) return showInvite(token);
  try {
    const m = await loadMe();
    if (!m.admin) return showLogin();
    showMe(m);
    showView();
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) console.debug("admin: /api/admin/me", err);
    showLogin();
  }
}

onUnauthorized(showLogin);
initAuth({ loggedIn: () => void start() });
initCall();
initRequests(() => poller.now());
initPeople();
initTeam();
addEventListener("hashchange", () => {
  const token = inviteToken();
  if (token) void showInvite(token);
  else if (appShown()) showView();
});
void start();
