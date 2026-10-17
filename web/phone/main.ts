// The browser test phone (/): call the notebook from this page, see what it heard, said and
// noted, the to-dos and the call's cost.
// Previews for screenshots and slides: ?orb=listening|thinking|speaking, ?tab=call|todos|cost,
// ?sheet=1 (the Mode sheet open).

import { $, delegate } from "../shared/html.ts";
import { withDev } from "../shared/api.ts";
import { initCall, toggleCall, callState, setMuted, isMuted, type CallState } from "./call.ts";
import { startOrb } from "./orb.ts";
import { initMode, mode, openSheet } from "./mode.ts";
import { onDebug, resetFeed, addLine, clearCaption } from "./feed.ts";
import { initTodos, showTodos, hideTodos, afterCall } from "./todos.ts";

const params = new URLSearchParams(location.search);
$<HTMLAnchorElement>("navMonitor").href = withDev("/monitor");

// ---------- the call ----------
let lang = "de";
const callBtn = $<HTMLButtonElement>("call"), muteBtn = $<HTMLButtonElement>("mute"), orb = $("orb");

function paintMute(): void {
  const on = isMuted();
  muteBtn.classList.toggle("on", on);
  muteBtn.setAttribute("aria-pressed", String(on));
  muteBtn.setAttribute("aria-label", on ? "Unmute" : "Mute");
  muteBtn.title = on ? "Unmute microphone" : "Mute microphone";
}
function paintCall(s: CallState): void {
  callBtn.classList.toggle("live", s === "live");
  callBtn.setAttribute("aria-label", s === "live" ? "Hang up" : s === "connecting" ? "Cancel the call" : "Call");
  muteBtn.disabled = s !== "live";
  paintMute();
}

initCall({
  onState: s => {
    paintCall(s);
    if (s === "idle") { $("sublabel").textContent = "Call ended"; clearCaption(); }
  },
  onStarting: resetFeed,
  onDebug,
  onError: message => addLine("sys bad", message),
  onEnded: afterCall,
  onTick: sec => { $("sublabel").textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; },
});
// A double tap is one tap (a second within half a second would cancel the call it just started).
let lastTap = -Infinity;
callBtn.addEventListener("click", () => {
  if (performance.now() - lastTap < 500) return;
  lastTap = performance.now();
  toggleCall({ lang, mode });
});
// The orb calls too (when nothing's going on): a button for the keyboard as well.
const orbCall = (): void => { if (callState() === "idle") toggleCall({ lang, mode }); };
orb.addEventListener("click", orbCall);
orb.addEventListener("keydown", e => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  orbCall();
});
muteBtn.addEventListener("click", () => { setMuted(!isMuted()); paintMute(); });

// The greeting's language (after that it follows the caller).
delegate($("langSeg"), "click", "button[data-lang]", (_, b) => {
  lang = b.dataset.lang ?? "de";
  for (const x of $("langSeg").querySelectorAll<HTMLElement>("button")) {
    x.classList.toggle("on", x === b);
    x.setAttribute("aria-pressed", String(x === b));
  }
});

// ---------- the side panel's tabs ----------
const TAB_ALIAS: Record<string, string> = { note: "call", memory: "todos" };
function selectTab(name: string, { focus = false } = {}): void {
  const tab = TAB_ALIAS[name] ?? name;
  const buttons = [...$("tabs").querySelectorAll<HTMLButtonElement>("button[data-tab]")];
  const target = buttons.find(b => b.dataset.tab === tab);
  if (!target) return;
  for (const b of buttons) {
    const on = b === target;
    b.classList.toggle("on", on);
    b.setAttribute("aria-selected", String(on));
    b.tabIndex = on ? 0 : -1;
  }
  for (const p of document.querySelectorAll<HTMLElement>(".pane")) p.classList.toggle("on", p.id === `pane-${tab}`);
  if (focus) target.focus();
  if (tab === "todos") showTodos();
  else hideTodos();
}
delegate($("tabs"), "click", "button[data-tab]", (_, b) => selectTab(b.dataset.tab ?? "call"));
delegate($("tabs"), "keydown", "button[data-tab]", (e, b) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  e.preventDefault();
  const buttons = [...$("tabs").querySelectorAll<HTMLButtonElement>("button[data-tab]")];
  const i = buttons.indexOf(b as HTMLButtonElement) + (e.key === "ArrowRight" ? 1 : -1);
  selectTab(buttons[(i + buttons.length) % buttons.length]?.dataset.tab ?? "call", { focus: true });
});

// ---------- the phone's clock ----------
const tickClock = (): void => {
  $("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).replace(/\s?[AP]M$/i, "");
};
tickClock();
setInterval(tickClock, 10000);

initTodos({ callActive: () => callState() !== "idle" });
initMode();
startOrb(params.get("orb"));
paintCall(callState());
if (params.get("sheet")) setTimeout(() => openSheet(true, { focus: false }), 300);
selectTab(params.get("tab") ?? "call");
