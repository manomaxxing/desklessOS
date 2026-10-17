// The MEMORY block of a call's prompt, built once when the call connects and
// kept within a token budget however big the memory gets. In order, until the
// budget is spent:
//   what we know about him (facts) → open to-dos (≤ 10) → the most relevant
//   customers with their latest notes (≤ 8: recent contact, open to-dos, due
//   soon) → the names of the next 40. Everything else is for memory_search.
// Input is plain data, so any backend can use it.

import type { Day } from "../types/common.ts";
import type { ContextStats } from "../types/call.ts";

export const DEFAULT_BUDGET = 2500; // tokens
const tokens = (text: string): number => Math.ceil(text.length / 3.5); // German runs ~3.5 characters per token
const DAY = 86400000;

export interface ContextContact {
  name: string;
  place?: string | null;
  address?: string | null;
  phone?: string | null;
  summary?: string | null;
  lastContact?: Day | null;
  openTasks?: number;
  nextDue?: Day | null;
  notes?: string[];
}
export interface ContextData {
  today: Day;
  facts?: { text: string }[];
  tasks?: { text: string; due: Day | ""; contactName: string | null }[];
  openTaskCount?: number;
  done?: { text: string; contactName: string | null }[];
  contacts?: ContextContact[];
  totalContacts?: number;
  looseNotes?: string[];
}
export interface ContextOptions { budget?: number; maxFacts?: number; maxTasks?: number; fullContacts?: number; nameIndex?: number; notesPerContact?: number }
export interface BuiltContext { text: string; hidden: number; stats: ContextStats }

function dueLabel(due: string, today: Day): string {
  if (!due) return "no due date";
  const days = Math.round((Date.parse(due) - Date.parse(today)) / DAY);
  return `due ${due}${days < 0 ? ` (OVERDUE by ${-days} d)` : days === 0 ? " (today)" : days === 1 ? " (tomorrow)" : ` (in ${days} d)`}`;
}

/** How relevant a customer is for this call: recent contact, open to-dos, something due soon. */
function contactScore(c: ContextContact, today: Day): number {
  const days = c.lastContact ? Math.max(0, (Date.parse(today) - Date.parse(c.lastContact)) / DAY) : 365;
  const dueSoon = c.nextDue && (Date.parse(c.nextDue) - Date.parse(today)) / DAY <= 7;
  return 10 / (1 + days / 7) + 2 * (c.openTasks ?? 0) + (dueSoon ? 3 : 0);
}

/**
 * data: { today: "YYYY-MM-DD", facts: [{ text }], tasks: [{ text, due, contactName }] (open, soonest first),
 *         done: [{ text, contactName }], contacts: [{ name, place, address, phone, summary, lastContact,
 *         openTasks, nextDue, notes: [line] }] (any order), looseNotes: [line], totalContacts }
 * → { text, hidden (customers not shown in full), stats }
 */
export function buildContext(data: ContextData, { budget = DEFAULT_BUDGET, maxFacts = 12, maxTasks = 10, fullContacts = 8, nameIndex = 40, notesPerContact = 3 }: ContextOptions = {}): BuiltContext {
  const today = data.today;
  const parts: string[] = [];
  let used = 0;
  const fits = (text: string): boolean => used + tokens(text) + 2 <= budget; // +2: the blank line before it
  const add = (text: string): void => { parts.push(text); used += tokens(text) + 1; };

  const facts = (data.facts ?? []).slice(0, maxFacts).map(f => `- ${f.text}`);
  if (facts.length) {
    const lines = ["WHAT WE KNOW ABOUT HIM:"];
    for (const f of facts) if (fits([...lines, f].join("\n"))) lines.push(f);
    if (lines.length > 1) add(lines.join("\n"));
  }

  const tasks = (data.tasks ?? []).slice(0, maxTasks);
  // The total in the header: "the three most urgent, and two more" needs no counting by the model.
  const openCount = data.openTaskCount ?? tasks.length;
  const taskLines = [`OPEN TO-DOS (${openCount} open; customer | task | due):`];
  for (const t of tasks) {
    const line = `- ${t.contactName || "?"} | ${t.text} | ${dueLabel(t.due, today)}`;
    if (fits([...taskLines, line].join("\n"))) taskLines.push(line);
  }
  const moreTasks = (data.openTaskCount ?? tasks.length) - (taskLines.length - 1);
  if (taskLines.length === 1) taskLines.push("- none");
  if (moreTasks > 0) taskLines.push(`(${moreTasks} more open to-dos)`);
  add(taskLines.join("\n"));
  if (data.done?.length) {
    const done = `RECENTLY DONE: ${data.done.slice(0, 5).map(a => `${a.contactName}: ${a.text}`).join("; ")}`;
    if (fits(done)) add(done);
  }

  const ranked = [...(data.contacts ?? [])].sort((a, b) => contactScore(b, today) - contactScore(a, today));
  const block = (c: ContextContact, n: number): string => [
    `- ${c.name}${c.place ? `, ${c.place}` : ""}${c.address ? ` (${c.address})` : ""}${c.phone ? ` tel ${c.phone}` : ""} | last contact ${c.lastContact ?? "?"} | ${c.summary || ""}`,
    ...(c.notes ?? []).slice(0, n).map(l => `    note ${l}`),
  ].join("\n");
  const total = data.totalContacts ?? ranked.length;
  const customersHeader = "CUSTOMERS (most relevant first; under each, their latest notes, newest first; a newer note overrides an older one):";
  const othersHeader = "OTHER CUSTOMERS (name only; memory_search has the details):";
  // Room kept for the names line when there are more customers than full blocks.
  const reserve = total > fullContacts ? tokens(`${othersHeader} and 99999 more`) + 2 : 0;
  const full = [];
  for (const c of ranked.slice(0, fullContacts)) {
    // fewer notes rather than one customer fewer
    let n = notesPerContact;
    while (n >= 0 && !fits([customersHeader, ...full, block(c, n)].join("\n") + " ".repeat(Math.ceil(reserve * 3.5)))) n--;
    if (n < 0) break;
    full.push(block(c, n));
  }
  add(`${customersHeader}\n${full.length ? full.join("\n") : "- none yet"}`);

  const names = [];
  for (const c of ranked.slice(full.length, full.length + nameIndex)) {
    const name = `${c.name}${c.place ? ` (${c.place})` : ""}`;
    if (!fits(`${othersHeader} ${[...names, name].join("; ")}; and 99999 more`)) break;
    names.push(name);
  }
  const unnamed = total - full.length - names.length;
  if (names.length || unnamed > 0) add(`${othersHeader} ${names.join("; ")}${unnamed > 0 ? `${names.length ? "; " : ""}and ${unnamed} more` : ""}`);

  const loose = (data.looseNotes ?? []).slice(0, 5).map(l => `- ${l}`);
  if (loose.length) {
    const text = `OTHER NOTES (not linked to a customer yet):\n${loose.join("\n")}`;
    if (fits(text)) add(text);
  }

  const text = parts.join("\n\n");
  return { text, hidden: Math.max(0, total - full.length), stats: { tokens: tokens(text), budget, customers: full.length, names: names.length, tasks: taskLines.length - 1, facts: facts.length } };
}
