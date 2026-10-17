// The orb: the call's state as colour and motion, its level as size. One animation frame
// loop (the browser pauses it while the page is hidden); the DOM is touched only on change.
// ?orb=listening|thinking|speaking shows a state without a call (screenshots, slides).

import { $ } from "../shared/html.ts";
import { activity, callState, level } from "./call.ts";

const LABEL = { idle: "Tap to call", connecting: "Connecting…", listening: "Listening", thinking: "Thinking", speaking: "Speaking" } as const;
type OrbState = keyof typeof LABEL;
const isOrbState = (s: string | null): s is OrbState => s != null && s in LABEL;

export function startOrb(forced: string | null): void {
  const preview = isOrbState(forced) ? forced : null;
  const orb = $("orb"), stage = $("stage"), label = $("label");
  let shown = "";
  let current = 0;
  let drawn = "";

  function stateNow(): OrbState {
    const call = callState();
    if (call === "live") return activity();
    return preview ?? call;
  }
  function frame(): void {
    const s = stateNow();
    if (s !== shown) {
      shown = s;
      orb.dataset.state = s;
      stage.dataset.state = s;
      label.textContent = LABEL[s];
      orb.setAttribute("aria-disabled", String(callState() !== "idle"));
    }
    let target = 0;
    if (callState() === "live") {
      const lv = level(s === "speaking" || s === "thinking" ? s : "listening");
      target = s === "thinking" ? 0.12 + Math.sin(performance.now() / 260) * 0.05 : lv;
    }
    else if (preview) target = preview === "thinking" ? 0.12 + Math.sin(performance.now() / 260) * 0.05 : 0.35 + Math.sin(performance.now() / 180) * 0.2 + Math.sin(performance.now() / 97) * 0.12;
    current += (target - current) * (target > current ? 0.35 : 0.12);
    const v = current.toFixed(3);
    if (v !== drawn) { drawn = v; orb.style.setProperty("--level", v); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
