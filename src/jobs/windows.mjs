// When a user may be called: their call window, in their own time zone.
//   window: { days: [1..7] (ISO weekdays, Monday = 1), from: "HH:MM", to: "HH:MM" }
// Times are wall-clock times there, so 08:00 stays 08:00 across a DST change.

import { FORMAT_LOCALE } from "../locale/index.mjs";

export const DEFAULT_WINDOW = { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00" };
const MIN = 60000;
const DAY = 86400000;
const minutes = hhmm => { const [h, m] = String(hhmm).split(":").map(Number); return h * 60 + (m || 0); };

const formatters = new Map();
function fmt(tz) {
  if (!formatters.has(tz)) formatters.set(tz, new Intl.DateTimeFormat(FORMAT_LOCALE, { timeZone: tz, hourCycle: "h23", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }));
  return formatters.get(tz);
}

/** The wall clock in `tz` at instant `at`: { date: "YYYY-MM-DD", weekday 1–7, minute of the day }. */
export function localParts(at, tz) {
  const p = Object.fromEntries(fmt(tz).formatToParts(at).map(x => [x.type, x.value]));
  const weekday = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay() || 7; // ISO: Monday 1 … Sunday 7
  return { date: `${p.year}-${p.month}-${p.day}`, weekday, minute: Number(p.hour) * 60 + Number(p.minute), second: Number(p.second) };
}

// How far `tz` is ahead of UTC at instant `t`, in ms.
function offset(t, tz) {
  const p = localParts(new Date(t), tz);
  const [y, mo, d] = p.date.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, Math.floor(p.minute / 60), p.minute % 60, p.second) - Math.floor(t / 1000) * 1000;
}

/** The instant when it's `hhmm` on local `date` in `tz` (DST-safe). */
export function zonedTime(date, hhmm, tz) {
  const [y, mo, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, mo - 1, d) + minutes(hhmm) * MIN;
  let t = wall - offset(wall, tz);
  t = wall - offset(t, tz); // second pass: the offset at the result, not at the guess
  return new Date(t);
}

const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

export function inWindow(at, { window = DEFAULT_WINDOW, tz = "Europe/Berlin" } = {}) {
  const w = { ...DEFAULT_WINDOW, ...window };
  const p = localParts(at, tz);
  return w.days.includes(p.weekday) && p.minute >= minutes(w.from) && p.minute < minutes(w.to);
}

/** `after` itself if it's inside the window, else when the window next opens. */
export function nextInWindow(after, { window = DEFAULT_WINDOW, tz = "Europe/Berlin" } = {}) {
  const w = { ...DEFAULT_WINDOW, ...window };
  if (inWindow(after, { window: w, tz })) return after;
  const today = localParts(after, tz);
  for (let i = 0; i < 8; i++) {
    const date = addDays(today.date, i);
    const weekday = localParts(zonedTime(date, "12:00", tz), tz).weekday;
    if (!w.days.includes(weekday)) continue;
    const open = zonedTime(date, w.from, tz);
    if (open > after) return open;
  }
  throw new Error("call window has no days");
}

/** The next window opening on a later local day than `at` (after a call today, or the last retry). */
export function nextDayWindow(at, { window = DEFAULT_WINDOW, tz = "Europe/Berlin" } = {}) {
  const tomorrow = zonedTime(addDays(localParts(at, tz).date, 1), "00:00", tz);
  return nextInWindow(tomorrow, { window, tz });
}
