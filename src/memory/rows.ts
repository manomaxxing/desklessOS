// Rows as Postgres returns them, the shapes the API, the pages and the prompts read, and the
// mappers between them. Plus the few helpers every memory module needs.

import type { Iso, Day, Turn } from "../types/common.ts";
import type { Note } from "../types/note.ts";
import type { Objective, ObjectiveMode, ObjectiveStatus } from "../types/agenda.ts";
import type { Request, RequestStatus, Card, Plan } from "../types/request.ts";
import type { User, UserRow } from "../types/user.ts";
import type { CallEvent, Direction } from "../types/call.ts";

export const isUuid = (s: unknown): s is string => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s ?? ""));
export const isDay = (s: unknown): s is Day => /^\d{4}-\d{2}-\d{2}$/.test(String(s ?? ""));
export const day = (d: Date | string): Day => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
const iso = (d: Date | string): Iso => new Date(d).toISOString();
/** A phone number as E.164 ("+4915112345678"), or null if it isn't one. */
export function e164(s: unknown): string | null {
  const d = String(s ?? "").replace(/[^\d+]/g, "");
  return /^\+?\d{6,15}$/.test(d) ? (d.startsWith("+") ? d : `+${d}`) : null;
}
/** A value for a json/jsonb parameter: encoded once here (the drivers take it as is). */
export const json = (v: unknown): string => JSON.stringify(v ?? null);
/** A 400 with a message the admin page shows as is. */
export const badRequest = (message: string): Error & { status: number } => Object.assign(new Error(message), { status: 400 });

// ---------- rows ----------
type When = Date | string;

export interface ContactRow {
  id: string; org_id: string; name: string; company: string | null; email: string | null; phone: string | null;
  address: string | null; place: string | null; summary: string | null; last_contact: When | null;
}
export interface TaskRow {
  id: string; org_id: string; user_id: string | null; contact_id: string | null; contact_name: string | null;
  text: string; due: When | null; status: "open" | "done"; created_at: When; done_at: When | null; source_call_id: string | null;
}
export interface NoteRow {
  id: string; org_id: string; user_id: string | null; call_id: string | null; contact_id: string | null;
  mode: string; lang: string | null; data: Note; summary: string; created_at: When; transcript?: Turn[];
}
export interface FactRow {
  id: string; kind: string; text: string; quote: string; tags: string[] | null; source_call_id: string | null; created_at: When;
}
export interface CallMeta {
  mode?: string; usd?: number; cost?: unknown; goal?: unknown[]; rehearsalOf?: { id: string; name: string };
  wishes?: Wish[]; noteSentAt?: Iso; noteMessageId?: string; [key: string]: unknown;
}
export interface CallRow {
  id: string; org_id: string; user_id: string | null; direction: Direction; source: string; from_e164: string | null; to_e164: string | null;
  lang: string | null; started_at: When; ended_at: When | null; ended_reason: string | null; summary: string | null; call_type: string | null;
  meta: CallMeta | null; transcript?: Turn[] | null; extraction?: Record<string, unknown> | null; extraction_turns?: number;
  timeline?: CallEvent[] | null; recap?: Recap | null; objective_ids?: string[] | null; after_call_at?: When | null;
  // joined in by the list and detail queries
  turns?: number | null; note_id?: string | null; note?: Note | null; user_name?: string | null; recap_title?: string | null;
}
export interface ObjectiveRow {
  id: string; org_id: string; user_id: string | null; template: string; version: number; params: Record<string, unknown>;
  mode: ObjectiveMode; status: ObjectiveStatus; priority: number; lang: string | null; created_at: When; created_by: string;
  not_before: Iso | null; deadline: Iso | null; attempts: number; max_attempts: number; calls: string[];
  result: Record<string, unknown> | null; updated_at: When;
}
export interface RequestRow {
  id: string; org_id: string | null; user_id: string | null; instruction: string; plan: Plan | null; plan_hash: string | null;
  card: Card | null; turns: unknown[] | null; status: RequestStatus; objective_id: string | null; result: Record<string, unknown> | null;
  created_by: string; created_at: When; approved_at: When | null; closed_at: When | null; notified_at: When | null;
  log: { at: Iso; text: string }[] | null; updated_at: When;
}

// ---------- what the API, the pages and the prompts read ----------
export interface Wish { what: string; why: string; quote: string }
export interface Recap { title?: string; [key: string]: unknown }
export interface Customer {
  id: string; name: string; company: string | null; email: string | null; phone: string | null; address: string | null;
  place: string | null; summary: string | null; lastContact: Day | ""; history: CustomerCall[];
}
export interface CustomerCall { date: Day; callId: string; type: string | null; summary: string | null }
export interface Task {
  id: string; text: string; due: Day | ""; status: "open" | "done"; customerId: string | null; customerName: string | null;
  createdAt: When; doneAt: When | null; sourceCallId: string | null;
}
export type SavedNote = Note & { id: string; lang: string; call_id: string | null; created_at: Iso; customerId?: string; transcript?: Turn[] };
export interface CallSummary {
  id: string; userId: string | null; direction: Direction; source: string; from: string | null; to: string | null; lang: string | null;
  startedAt: number; endedAt: number | null; endedReason: string | null; summary: string | null; callType: string | null;
  mode: string | null; usd: number | null; turns: number | null; savedNoteId: string | null; userName: string | null;
  title: string | null; goal: unknown[]; rehearsalOf: string | null; wishes: Wish[];
}
export interface CallDetail extends CallSummary {
  events: CallEvent[]; transcript: Turn[] | null | undefined; note: Note | Record<string, unknown> | null; cost: unknown; recap: Recap | null;
}

export const customerOut = (c: ContactRow & { history?: CustomerCall[] }): Customer => ({
  id: c.id, name: c.name, company: c.company, email: c.email, phone: c.phone, address: c.address, place: c.place, summary: c.summary,
  lastContact: c.last_contact ? day(c.last_contact) : "", history: c.history ?? [],
});
export const taskOut = (t: TaskRow): Task => ({
  id: t.id, text: t.text, due: t.due ? day(t.due) : "", status: t.status, customerId: t.contact_id, customerName: t.contact_name,
  createdAt: t.created_at, doneAt: t.done_at, sourceCallId: t.source_call_id,
});
export const noteOut = (n: NoteRow): SavedNote => ({
  ...n.data, id: n.id, lang: n.lang || (typeof n.data?.lang === "string" ? n.data.lang : "") || "", call_id: n.call_id, created_at: iso(n.created_at),
  ...(n.contact_id ? { customerId: n.contact_id } : {}), ...(n.transcript ? { transcript: n.transcript } : {}),
});
export const userOut = (u: UserRow): User => ({
  id: u.id, orgId: u.org_id, name: u.name, phone: u.phone_e164 ?? "", lang: u.lang, role: u.role, timezone: u.timezone,
  callWindow: u.call_window ?? {}, consentOutboundAt: u.consent_outbound_at ? iso(u.consent_outbound_at) : null, outboundPaused: Boolean(u.outbound_paused),
  demo: Boolean(u.demo), business: u.profile?.business ?? {}, features: u.profile?.features ?? {}, lists: u.profile?.lists ?? {},
});
export const requestOut = (r: RequestRow): Request => ({
  id: r.id, userId: r.user_id, instruction: r.instruction, plan: r.plan, planHash: r.plan_hash, card: r.card, turns: r.turns ?? [], status: r.status,
  objectiveId: r.objective_id, result: r.result, createdBy: r.created_by, createdAt: iso(r.created_at),
  approvedAt: r.approved_at ? iso(r.approved_at) : null, closedAt: r.closed_at ? iso(r.closed_at) : null,
  notifiedAt: r.notified_at ? iso(r.notified_at) : null, log: r.log ?? [], updatedAt: iso(r.updated_at),
});
export const objectiveOut = (o: ObjectiveRow): Objective => ({
  id: o.id, template: o.template, version: o.version, params: o.params, mode: o.mode, status: o.status, priority: o.priority, lang: o.lang,
  createdAt: iso(o.created_at), createdBy: o.created_by, notBefore: o.not_before, deadline: o.deadline,
  attempts: o.attempts, maxAttempts: o.max_attempts, calls: o.calls, result: o.result, updatedAt: iso(o.updated_at), userId: o.user_id,
});
/** A call for the list: who, when, how it went. */
export function callOut(c: CallRow): CallSummary {
  return {
    id: c.id, userId: c.user_id, direction: c.direction, source: c.source, from: c.from_e164, to: c.to_e164, lang: c.lang,
    startedAt: new Date(c.started_at).getTime(), endedAt: c.ended_at ? new Date(c.ended_at).getTime() : null, endedReason: c.ended_reason,
    summary: c.summary, callType: c.call_type, mode: c.meta?.mode ?? null, usd: c.meta?.usd ?? null, turns: c.turns ?? null, savedNoteId: c.note_id ?? null,
    userName: c.user_name ?? null, title: c.recap?.title ?? c.recap_title ?? null, goal: c.meta?.goal ?? [], rehearsalOf: c.meta?.rehearsalOf?.name ?? null,
    wishes: c.meta?.wishes ?? [],
  };
}
/** One call in full: its timeline, transcript, note, cost and summary as well. */
export const callDetailOut = (c: CallRow): CallDetail => ({
  ...callOut(c), events: c.timeline ?? [], transcript: c.transcript, note: c.note ?? c.extraction ?? null, cost: c.meta?.cost ?? null, recap: c.recap ?? null,
});

// The text a note is found by (and embedded from).
export function noteText(n: Note): string {
  return [n.summary, n.customer_name, n.place, n.address, ...(n.work ?? []).map(w => [w.area, w.description, w.quantity, w.material].filter(Boolean).join(" "))]
    .filter(Boolean).join(". ");
}
