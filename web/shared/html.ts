// Building the pages' HTML safely, and the small DOM helpers every page uses.
// Everything that goes into innerHTML is made with `html`: each interpolated value is escaped
// (text and attributes alike) unless it's html`…` itself or wrapped in raw().

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
/** Text → HTML text or a quoted attribute's value. */
export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, c => ESC[c] ?? c);

/** HTML that's already safe: what `html` returns, or what raw() vouches for. */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) { this.value = value; }
  toString(): string { return this.value; }
}
/** null, undefined and booleans render as nothing, so `${cond && html`…`}` works; arrays are joined. */
export type Interpolation = SafeHtml | string | number | boolean | null | undefined | readonly Interpolation[];

function part(v: Interpolation): string {
  if (v == null || typeof v === "boolean") return "";
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(v);
}
export function html(strings: TemplateStringsArray, ...values: Interpolation[]): SafeHtml {
  let out = strings[0] ?? "";
  values.forEach((v, i) => { out += part(v) + (strings[i + 1] ?? ""); });
  return new SafeHtml(out);
}
/** Trusted markup (our own constants, like an icon's SVG), inserted as it is. */
export const raw = (s: string): SafeHtml => new SafeHtml(s);

const drawn = new WeakMap<Element, string>();
export function setHtml(el: Element, content: SafeHtml): void { drawn.delete(el); el.innerHTML = content.value; }
/** Sets it only when it changed (no re-render when nothing did); the focus stays on the same field. */
export function patchHtml(el: Element, content: SafeHtml): boolean {
  if (drawn.get(el) === content.value) return false;
  drawn.set(el, content.value);
  keepFocus(el, () => { el.innerHTML = content.value; });
  return true;
}
/** One element from markup. */
export function fragment(content: SafeHtml): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = content.value.trim();
  const el = t.content.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error("fragment: no element");
  return el;
}

/** The element with this id (the page's own markup: it's a bug if it's missing). */
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing`);
  return el as T;
}

/** One listener on the container for all its (current and future) children matching selector. */
export function delegate<K extends keyof HTMLElementEventMap>(
  root: HTMLElement | Document, type: K, selector: string, fn: (e: HTMLElementEventMap[K], el: HTMLElement) => void,
): void {
  root.addEventListener(type, e => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const el = target.closest<HTMLElement>(selector);
    if (el && root.contains(el)) fn(e as HTMLElementEventMap[K], el);
  });
}

/** What a field or button is known by, so it gets the focus back after it's drawn again. */
const focusKey = (el: Element): string => {
  if (el.id) return `#${el.id}`;
  const data = el instanceof HTMLElement ? Object.entries(el.dataset).sort().join(";") : "";
  return `${el.tagName}|${el.getAttribute("name") ?? ""}|${data}`;
};
const FOCUSABLE = "input, textarea, select, button, a[href], [tabindex]";
/**
 * Runs change (which redraws what's inside root, or replaces root: then pass the new root as
 * `after`); the focus, if it was inside, goes back to the same field, caret and all.
 */
export function keepFocus(root: Element, change: () => void, after: () => Element | null = () => root): void {
  const active = document.activeElement;
  if (!active || active === document.body || !root.contains(active)) { change(); return; }
  const key = focusKey(active);
  const sel = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] as const : null;
  change();
  const scope = after();
  const same = scope && [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].find(x => focusKey(x) === key);
  if (!same) return;
  same.focus({ preventScroll: true });
  if (sel && (same instanceof HTMLInputElement || same instanceof HTMLTextAreaElement)) {
    try { same.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ }
  }
}
/** Replaces old with next; the focus, if it was in old, goes to the same field in next. */
export const replaceKeepingFocus = (old: Element, next: Element): void => keepFocus(old, () => old.replaceWith(next), () => next);

/**
 * A list drawn by key: an item whose signature didn't change keeps its element (and what's
 * typed into it, and the focus); a changed one is drawn again; the order follows items.
 */
export function renderKeyed<T>(
  container: HTMLElement, items: readonly T[],
  { key, signature, render, empty }: { key: (t: T) => string; signature: (t: T) => string; render: (t: T) => SafeHtml; empty: SafeHtml },
): void {
  if (!items.length) { delete container.dataset.keyed; setHtml(container, empty); return; }
  const old = new Map<string, HTMLElement>();
  if (container.dataset.keyed) {
    for (const el of container.children) if (el instanceof HTMLElement && el.dataset.key) old.set(el.dataset.key, el);
  } else {
    container.replaceChildren(); // what was there before (a placeholder)
    container.dataset.keyed = "1";
  }
  let cursor: Element | null = container.firstElementChild; // where the next item belongs
  for (const item of items) {
    const k = key(item), sig = signature(item);
    let el = old.get(k);
    old.delete(k);
    if (!el || el.dataset.sig !== sig) {
      const next = fragment(render(item));
      next.dataset.key = k;
      next.dataset.sig = sig;
      if (el) {
        const wasCursor = el === cursor;
        replaceKeepingFocus(el, next);
        if (wasCursor) cursor = next;
      }
      el = next;
    }
    if (el === cursor) cursor = cursor.nextElementSibling;
    else container.insertBefore(el, cursor);
  }
  for (const el of old.values()) el.remove();
}

/** To the clipboard (with the old way as a fallback); the button says "Copied" for a moment. */
export async function copyText(text: string, button: HTMLElement): Promise<void> {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (button.dataset.copied) return;
  const was = button.innerHTML;
  button.dataset.copied = "1";
  button.innerHTML = "Copied";
  setTimeout(() => { button.innerHTML = was; delete button.dataset.copied; }, 1400);
}

/** A button busy with a request: disabled meanwhile, and its own label back after (whatever happened). */
export async function busy<T>(button: HTMLButtonElement, label: string | null, work: () => Promise<T>): Promise<T> {
  const was = button.textContent ?? "";
  button.disabled = true;
  if (label) button.textContent = label;
  try { return await work(); } finally {
    if (button.isConnected) { button.disabled = false; if (label) button.textContent = was; }
  }
}
