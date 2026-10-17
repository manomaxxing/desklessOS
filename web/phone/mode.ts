// The Mode sheet: which engine, model, latency mask and Live voice this test phone's calls
// use (kept in this browser). Phone calls use the server's settings, shown at the bottom.

import { $, html, setHtml, delegate } from "../shared/html.ts";
import { getJson } from "../shared/api.ts";
import type { ConfigOut, Mode } from "../shared/types.ts";

const KEY = "deskless-mode";
export const mode: Mode = { engine: "cascade", model: "gemini-3.5-flash", mask: "typing", liveModel: "", liveVoice: "Kore" };
try { Object.assign(mode, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch { /* storage blocked, or not JSON */ }

export const modeLabel = (m: Partial<Mode>): string =>
  m.engine === "live" ? `Gemini Live · ${m.liveVoice}` : `${String(m.model).replace("gemini-", "")} + Fish · ${m.mask}`;

function save(): void {
  try { localStorage.setItem(KEY, JSON.stringify(mode)); } catch { /* storage blocked */ }
  $("sheet").dataset.engine = mode.engine;
  $("modeLabel").textContent = modeLabel(mode);
}

/** A segmented choice (data-v on its buttons) bound to mode[key]. */
function bindSeg(id: string, key: "engine" | "mask"): () => void {
  const seg = $(id);
  const paint = () => {
    for (const b of seg.querySelectorAll<HTMLElement>("button")) {
      const on = b.dataset.v === mode[key];
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  };
  delegate(seg, "click", "button[data-v]", (_, b) => { mode[key] = b.dataset.v ?? mode[key]; paint(); save(); });
  return paint;
}
/** A select of the server's choices bound to mode[key] (the first one if the saved one is gone). */
function fill(id: string, list: string[], key: "model" | "liveModel" | "liveVoice"): void {
  const el = $<HTMLSelectElement>(id);
  setHtml(el, html`${list.map(v => html`<option>${v}</option>`)}`);
  if (!list.includes(mode[key])) mode[key] = list[0] ?? mode[key];
  el.value = mode[key];
  el.onchange = () => { mode[key] = el.value; save(); };
}

export function openSheet(on: boolean, { focus = true } = {}): void {
  const sheet = $("sheet"), btn = $("modeBtn");
  if (sheet.classList.contains("on") === on) return;
  sheet.classList.toggle("on", on);
  $("sheetBg").classList.toggle("on", on);
  btn.setAttribute("aria-expanded", String(on));
  if (!focus) return;
  if (on) sheet.querySelector<HTMLElement>("button.on, button, select")?.focus();
  else btn.focus();
}

export function initMode(): void {
  const paintEngine = bindSeg("engineSeg", "engine"), paintMask = bindSeg("maskSeg", "mask");
  paintEngine();
  paintMask();
  save();
  $("modeBtn").addEventListener("click", () => openSheet(!$("sheet").classList.contains("on")));
  $("sheetBg").addEventListener("click", () => openSheet(false));
  $("sheetDone").addEventListener("click", () => openSheet(false));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && $("sheet").classList.contains("on")) openSheet(false); });
  getJson<ConfigOut>("/api/config").then(r => {
    fill("modelSel", r.modes.models, "model");
    fill("liveModelSel", r.modes.liveModels, "liveModel");
    fill("liveVoiceSel", r.modes.liveVoices, "liveVoice");
    paintEngine();
    paintMask();
    $("phoneMode").textContent = `Phone calls use: ${modeLabel(r.phone)}`;
    save();
  }).catch(() => { /* the sheet still works with what's saved */ });
}
