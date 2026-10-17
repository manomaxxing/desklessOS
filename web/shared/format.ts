// Numbers, times and names as the pages show them: one version of each.

/** "Fri, Oct 16, 01:43 PM" */
export const fmtWhen = (ms: number | string): string =>
  new Date(ms).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** "45 s", "2 min", "2 min 5 s" */
export const fmtDur = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ""}`;
};

/** "13:43:27" (seconds: false → "13:43"). */
export const fmtTime = (ms: number | Date, { seconds = true } = {}): string =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });

/** "$0.0123", "$0.123"; "—" when there's no price. */
export const usd = (v: number | null | undefined): string =>
  v == null ? "—" : v === 0 ? "$0" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(3)}`;

/** Tokens: "950", "1.2k". */
export const ktok = (n: number | null | undefined): string => ((n ?? 0) >= 1000 ? `${((n ?? 0) / 1000).toFixed(1)}k` : String(n ?? 0));

/** "1.234,50 €" in the browser's locale; "1234.5 XYZ" for a currency it doesn't know. */
export const money = (n: number, currency: string): string => {
  try { return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n); } catch { return `${n} ${currency}`; }
};

/** A language id's own name ("de" → "Deutsch"), from the browser. */
export const langName = (id: string | null | undefined): string => {
  if (!id) return "?";
  try { return new Intl.DisplayNames([id], { type: "language" }).of(id) ?? id; } catch { return id; }
};

/** A to-do's due day (YYYY-MM-DD): "Overdue 2 d", "Today", "Tomorrow", "Mon, Oct 20"; days from today. */
export function dueLabel(due: string): { text: string; days: number } | null {
  if (!due) return null;
  const day = new Date(`${due}T00:00`);
  if (Number.isNaN(day.getTime())) return null;
  const days = Math.round((day.getTime() - new Date(new Date().toDateString()).getTime()) / 86400000);
  const text = days < 0 ? `Overdue ${-days} d` : days === 0 ? "Today" : days === 1 ? "Tomorrow" : day.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return { text, days };
}

export const fmtDate = (iso: string | number): string => new Date(iso).toLocaleDateString();
export const fmtDateTime = (iso: string | number): string => new Date(iso).toLocaleString();
