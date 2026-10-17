// When a user may be called: their call window, in their own time zone.
//   window: { days: [1..7] (ISO weekdays, Monday = 1), from: "HH:MM", to: "HH:MM" }
// Times are wall-clock times there, so 08:00 stays 08:00 across a DST change. A window
// whose end is before its start runs overnight (20:00–02:00): it belongs to the day it opens.
// A stored window that makes no sense (no days, "8 Uhr", an unknown time zone) is no window:
// he isn't called, and nothing here throws (validateCallWindow keeps such windows out).

import { FORMAT_LOCALE } from "../locale/index.ts";
import { isRecord } from "../shared/is-record.ts";
import type { CallWindow } from "../types/user.ts";
import type { Day, HttpError } from "../types/common.ts";

export const DEFAULT_WINDOW: Required<CallWindow> = { days: [1, 2, 3, 4, 5], from: "08:00", to: "18:00" };
export const DEFAULT_TZ = "Europe/Berlin";
const MIN = 60000;
const DAY = 86400000;

/** A window and the time zone it's in (the user's). */
export interface WindowOptions {
  window?: CallWindow | null;
  tz?: string;
}

/** The wall clock in a time zone at one instant. */
export interface LocalParts {
  date: Day;
  /** ISO weekday: Monday 1 … Sunday 7. */
  weekday: number;
  /** Minute of the day, 0–1439. */
  minute: number;
  second: number;
}

/** A window as the code uses it: minutes of the day. */
interface Hours {
  days: number[];
  from: number;
  to: number;
}

// "8", "08", "8:00", "08:00" → minutes of the day; anything else → null. "24:00" only as an end.
function parseTime(hhmm: unknown, { end = false } = {}): number | null {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(String(hhmm ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  if (min > 59 || h > 24 || (h === 24 && (min > 0 || !end))) return null;
  return h * 60 + min;
}
const hhmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const isWeekday = (d: unknown): d is number => Number.isInteger(d) && Number(d) >= 1 && Number(d) <= 7;

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat(FORMAT_LOCALE, { timeZone: tz, hourCycle: "h23", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    formatters.set(tz, f);
  }
  return f;
}
const knownZone = (tz: string): boolean => { try { fmt(tz); return true; } catch { return false; } };

/** The wall clock in `tz` at instant `at`: { date: "YYYY-MM-DD", weekday 1–7, minute of the day }. */
export function localParts(at: Date, tz: string): LocalParts {
  const p = Object.fromEntries(fmt(tz).formatToParts(at).map(x => [x.type, x.value]));
  const weekday = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay() || 7; // ISO: Monday 1 … Sunday 7
  return { date: `${p.year}-${p.month}-${p.day}`, weekday, minute: Number(p.hour) * 60 + Number(p.minute), second: Number(p.second) };
}

// How far `tz` is ahead of UTC at instant `t`, in ms.
function offset(t: number, tz: string): number {
  const p = localParts(new Date(t), tz);
  const [y, mo, d] = p.date.split("-").map(Number);
  return Date.UTC(y, mo - 1, d, Math.floor(p.minute / 60), p.minute % 60, p.second) - Math.floor(t / 1000) * 1000;
}

/** The instant when it's `time` ("HH:MM") on local `date` in `tz` (DST-safe). */
export function zonedTime(date: Day, time: string, tz: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, mo - 1, d) + (parseTime(time, { end: true }) ?? 0) * MIN;
  let t = wall - offset(wall, tz);
  t = wall - offset(t, tz); // second pass: the offset at the result, not at the guess
  return new Date(t);
}

const addDays = (date: Day, n: number): Day => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * Checks a call window from the People card and returns it tidied (days sorted, times as "HH:MM").
 * Missing fields keep the default's. Throws a 400 with a plain message when it can't be used.
 */
export function validateCallWindow(w: unknown): CallWindow {
  const bad = (message: string): HttpError => Object.assign(new Error(message), { status: 400 });
  if (w == null) return {};
  if (!isRecord(w)) throw bad("call times: days, from and to");
  const out: CallWindow = {};
  if (w.days != null) {
    if (!Array.isArray(w.days) || !w.days.length) throw bad("call days: at least one day");
    if (!w.days.every(isWeekday)) throw bad("call days: weekdays 1 (Monday) to 7 (Sunday)");
    out.days = [...new Set<number>(w.days)].sort((a, b) => a - b);
  }
  for (const key of ["from", "to"] as const) {
    const value = w[key];
    if (value == null || value === "") continue;
    const minutes = parseTime(value, { end: key === "to" });
    if (minutes === null) throw bad(`call times: "${String(value).slice(0, 20)}" isn't a time; write it as HH:MM, like 08:00`);
    out[key] = hhmm(minutes);
  }
  if (parseTime(out.from ?? DEFAULT_WINDOW.from) === parseTime(out.to ?? DEFAULT_WINDOW.to, { end: true })) throw bad("call times: from and to can't be the same time");
  return out;
}

// A stored window with the default's gaps filled, as minutes; null when it can't be used.
function hoursOf(window: CallWindow | null | undefined, tz: string): Hours | null {
  const days = window?.days ?? DEFAULT_WINDOW.days;
  const from = parseTime(window?.from ?? DEFAULT_WINDOW.from);
  const to = parseTime(window?.to ?? DEFAULT_WINDOW.to, { end: true });
  if (!Array.isArray(days) || !days.length || !days.every(isWeekday) || from === null || to === null || from === to || !knownZone(tz)) return null;
  return { days, from, to };
}

/** Can this window be used at all? (Bad stored data: he isn't called, and Max hears why.) */
export const usableWindow = ({ window = DEFAULT_WINDOW, tz = DEFAULT_TZ }: WindowOptions = {}): boolean => hoursOf(window, tz) !== null;

function inside(at: Date, h: Hours, tz: string): boolean {
  const p = localParts(at, tz);
  if (h.from < h.to) return h.days.includes(p.weekday) && p.minute >= h.from && p.minute < h.to;
  // Overnight: the evening of a listed day, or the small hours after one.
  const yesterday = p.weekday === 1 ? 7 : p.weekday - 1;
  return (h.days.includes(p.weekday) && p.minute >= h.from) || (h.days.includes(yesterday) && p.minute < h.to);
}

export function inWindow(at: Date, { window = DEFAULT_WINDOW, tz = DEFAULT_TZ }: WindowOptions = {}): boolean {
  const h = hoursOf(window, tz);
  return h !== null && inside(at, h, tz);
}

/** `after` itself if it's inside the window, else when the window next opens; null when the window can't be used. */
export function nextInWindow(after: Date, { window = DEFAULT_WINDOW, tz = DEFAULT_TZ }: WindowOptions = {}): Date | null {
  const h = hoursOf(window, tz);
  if (!h) return null;
  if (inside(after, h, tz)) return after;
  const today = localParts(after, tz);
  for (let i = 0; i < 8; i++) {
    const date = addDays(today.date, i);
    const weekday = localParts(zonedTime(date, "12:00", tz), tz).weekday;
    if (!h.days.includes(weekday)) continue;
    const open = zonedTime(date, hhmm(h.from), tz);
    if (open > after) return open;
  }
  return null; // not reached: a usable window opens within a week
}

/** The next window opening on a later local day than `at` (after a call today, or the last retry); null when the window can't be used. */
export function nextDayWindow(at: Date, { window = DEFAULT_WINDOW, tz = DEFAULT_TZ }: WindowOptions = {}): Date | null {
  if (!hoursOf(window, tz)) return null;
  const tomorrow = zonedTime(addDays(localParts(at, tz).date, 1), "00:00", tz);
  return nextInWindow(tomorrow, { window, tz });
}
