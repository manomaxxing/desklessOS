// What the API sends the pages: src/http/routes/, and the `*Out` mappers in src/memory/rows.ts
// (users, requests, calls), src/monitor.ts (live calls and their events), src/admin/team.ts,
// src/quotes/store.ts and src/engine/cost.ts. Types only: nothing here reaches the browser.

// ---------- who's logged in ----------
export type Role = "owner" | "member";
export interface Me {
  admin: boolean;
  login: boolean;
  twoFactor: boolean;
  notify: string[];
  me: { id: string; name: string; email: string; role: Role } | null;
  team: boolean;
  agent: string | null;
}
export interface Member {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  invitedBy: string | null;
  status: "active" | "invited";
  inviteExpiresAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}
export interface InviteOut { member: Member; token: string }
export interface InviteInfo { email: string; name?: string | null; existing?: boolean }
export interface LoginOut { ok?: true; needTotp?: true }

// ---------- people ----------
/** What Toni does for someone beyond notes, briefings and to-dos (src/features.ts). */
export type FeatureId = "note_whatsapp" | "quotes";
export interface CallWindow { days: number[]; from: string; to: string }
export interface Business { name: string; address: string; phone: string; email: string; taxId: string; currency: string; vatRate: number }
export interface Lists { jobs: string; site: string; levels: string; siteMax: number | null }
export interface User {
  id: string;
  orgId: string;
  name: string;
  phone: string;
  lang: string;
  role: string;
  timezone: string;
  callWindow: Partial<CallWindow>;
  consentOutboundAt: string | null;
  outboundPaused: boolean;
  demo: boolean;
  business: Partial<Business>;
  /** A feature that's on: since when (ISO). */
  features: Partial<Record<FeatureId, string>>;
  lists: Partial<Lists>;
}
/** POST /api/users/:id. Text fields as typed; the server checks and converts them. */
export interface UserPatch {
  phone: string;
  timezone: string;
  callWindow: CallWindow;
  /** Left out when it didn't change, so the date he agreed stays. */
  consentOutbound?: boolean;
  outboundPaused: boolean;
  business: Record<keyof Business, string>;
  features: Record<FeatureId, boolean>;
  lists: { jobs: string; site: string; siteMax: string; levels: string };
}
export interface UsersOut { users: User[]; outbound: boolean }
/** May Toni call him on WhatsApp (his permission in WhatsApp). */
export type WaPermission =
  | { available: false; why: string }
  | { available: true; status: "permanent" | "temporary" | "no_permission"; until: number | null; canCall?: boolean; canAsk?: boolean; error?: undefined }
  | { available: true; status: "unknown"; error: string };

// ---------- requests ----------
export type RequestStatus = "draft" | "approved" | "done" | "expired" | "cancelled";
export interface Question { ask: string; probe?: string; required?: boolean }
export interface Card {
  title: string;
  summary: string;
  who: string;
  when: string;
  purpose: string;
  questions: Question[];
  clarifications: string[];
  warnings: string[];
  blocked: string[];
}
export interface Answer { ask: string; status: "answered" | "vague" | "not_asked" | (string & {}); answer?: string; quote?: string }
export interface Request {
  id: string;
  userId: string | null;
  instruction: string;
  card: Card;
  status: RequestStatus;
  objectiveId: string | null;
  result: { questions?: Answer[]; calls?: string[] } | null;
  createdBy: string;
  createdAt: string;
  approvedAt: string | null;
  closedAt: string | null;
  notifiedAt: string | null;
  log: { at: string; text: string }[];
  updatedAt: string;
}
/** A request as the page shows it: a draft comes with the token that approves exactly this plan. */
export interface RequestView { request: Request; confirmToken: string | null }

// ---------- background work ----------
/** A call Toni makes from a request (outbound_calls). */
export interface OutboundCallRow {
  id: string;
  user_id: string;
  user_name: string;
  status: "queued" | "dialing" | "in_call" | "done" | "failed" | "cancelled";
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  call_id: string | null;
  outcome: string | null;
  log: { at?: string; text: string }[];
}
export interface QueueRow {
  id: number | string;
  kind: string;
  key: string;
  status: "queued" | "running" | "done" | "dead";
  attempts: number;
  max_attempts: number;
  run_at: string;
  last_error: string | null;
}
export interface JobsOut { jobs: OutboundCallRow[]; outbound: boolean; queue: QueueRow[] }

// ---------- calls ----------
/** A call while it runs (src/monitor.ts summary()): no user, no title yet. */
export interface LiveCallSummary {
  id: string;
  from: string | null;
  to: string | null;
  lang: string | null;
  source: string | null;
  startedAt: number;
  endedAt: number | null;
  endedReason: string | null;
  turns: number;
  savedNoteId: string | null;
  summary: string;
  usd: number | null;
  mode: string | null;
}
export interface Goal { template: string; title: string; description?: string; focus?: string; questions?: string[]; stored?: boolean }
export interface Wish { what: string; why?: string; quote?: string }
/** A call from the call log (Postgres). */
export interface StoredCallSummary extends Omit<LiveCallSummary, "turns" | "summary"> {
  userId: string | null;
  direction: "inbound" | "outbound" | null;
  callType: string | null;
  userName: string | null;
  title: string | null;
  goal: Goal[];
  rehearsalOf: string | null;
  wishes: Wish[];
  turns: number | null;
  summary: string | null;
}
export type CallSummary = LiveCallSummary | StoredCallSummary;
export interface CallsOut { calls: CallSummary[]; system: SystemEntry[]; recording: boolean }

export interface Recap {
  title: string;
  overview: string;
  topics: { heading: string; points: string[] }[];
  actions: { text: string; owner?: string; due?: string }[];
  open_questions: string[];
  writtenAt?: string;
}
export interface QuoteCalc {
  quality: { name: string; factor: number } | null;
  site: { factor: number; unfavourable: string[] };
  factor: number;
  fromList: number;
}
export interface QuoteSummary {
  id: string;
  number: string;
  lang: string;
  callId: string | null;
  userId: string;
  status: "saved" | "sent" | "failed" | (string & {});
  sentTo: string | null;
  error: string | null;
  createdAt: string;
  draft: boolean;
  gross: number | null;
  net: number | null;
  currency: string;
  customer: string;
  items: number;
  calc: QuoteCalc | null;
}
export interface Note {
  mode?: string;
  customer_name?: string;
  address?: string;
  place?: string;
  work?: { area?: string; quantity?: string; material?: string; description?: string }[];
  next_steps?: { what: string; due?: string }[];
  timeframe?: string;
  budget?: string;
  open_questions?: string[];
  summary?: string;
}
/** One call with its timeline: GET /api/calls/:id. A live one is the monitor's record; an ended one the call's row. */
export interface LiveCallDetail extends Omit<LiveCallSummary, "turns" | "summary" | "usd" | "savedNoteId"> {
  events: TimelineEvent[];
  note: Note | null;
  cost?: CostTotals | null;
  savedNoteId?: string | null;
  quotes: QuoteSummary[];
}
export interface StoredCallDetail extends StoredCallSummary {
  events: TimelineEvent[];
  transcript: { role: "user" | "model" | (string & {}); text: string }[] | null;
  note: Note | null;
  cost: CostTotals | null;
  recap: Recap | null;
  quotes: QuoteSummary[];
}
export type CallDetail = LiveCallDetail | StoredCallDetail;

// ---------- cost (src/engine/cost.ts) ----------
export interface StepCost { calls: number; inputTokens: number; outputTokens: number; bytes: number; usd: number }
export interface CostTotals {
  llmCalls: number;
  inputTokens: number;
  audioTokens: number;
  outputTokens: number;
  llmUsd: number;
  ttsCalls: number;
  ttsBytes: number;
  ttsUsd: number;
  ttsPaidUsd: number;
  phoneMinutes: number;
  phoneUsd: number | null;
  unpriced: number;
  usd: number;
  byStep: Partial<Record<"turn" | "note" | "memory" | (string & {}), StepCost>>;
  pricesAsOf: string;
}

// ---------- the monitor's events (src/engine/session.ts debug(), src/calls/*) ----------
interface Ev { t: number; trimmed?: undefined }
export interface Task { id: string; text: string; due?: string }
export type MonitorEvent =
  | (Ev & { event: "connected"; lang?: string | null; formats?: { inbound?: string; outbound?: string }; config?: Record<string, string> })
  | (Ev & { event: "heard"; turn: number; text: string; next?: string; lang?: string | null; audio?: string | null })
  | (Ev & { event: "say"; turn?: number; text?: string; delta?: boolean; note?: string })
  | (Ev & { event: "agent_audio"; turn: number; audio: string; interrupted?: boolean })
  | (Ev & { event: "turn_start"; turn: number; text?: string; utteranceMs?: number; merged?: number; force?: boolean })
  | (Ev & { event: "latency"; turn: number; firstAudioMs: number; sinceSpeechMs?: number | null; firstTokenMs: number; fishFirstByteMs?: number | null; prepared?: boolean; speculative?: boolean })
  | (Ev & { event: "heard_check" | "heard_late" | "dangling"; turn: number; text: string; by?: string })
  | (Ev & { event: "retry"; turn: number; reason: string; next?: string })
  | (Ev & { event: "recovered"; turn: number; model: string; attempt: number })
  | (Ev & { event: "fallback"; what: string; from: string; to: string; reason?: string })
  | (Ev & { event: "mask"; kind: string; for?: string })
  | (Ev & { event: "tool"; turn: number; name?: string; args?: unknown; status?: string; ms?: number; summary?: string; ignored?: string[]; reason?: string })
  | (Ev & { event: "context"; tokens: number; budget: number; customers: number; names: number; tasks: number; facts?: number; ms: number })
  | (Ev & { event: "turn"; turn: number; probability: number; complete: boolean; ms: number })
  | (Ev & { event: "objective"; id: string; template: string; done: boolean; status: string })
  | (Ev & { event: "tool_latency"; turn: number; hopMs: number; totalMs: number })
  | (Ev & { event: "live"; text: string; level?: string })
  | (Ev & { event: "barge_in"; falseStart?: boolean })
  | (Ev & { event: "nudge"; kind: string })
  | (Ev & { event: "note"; note: Note | null; missing?: string[]; fallback?: string })
  | (Ev & { event: "saved"; id: string })
  | (Ev & { event: "note_sent"; messageId?: string })
  | (Ev & { event: "memory"; callType: string; summary: string; customer: { id: string; name: string } | null; added?: Task[]; completed?: Task[]; updated?: Task[] })
  | (Ev & { event: "recap"; title?: string })
  | (Ev & { event: "wish"; what: string })
  | (Ev & { event: "error"; where: string; message: string })
  | (Ev & { event: "hangup"; by: string; reason?: string })
  | (Ev & { event: "ended"; reason: string })
  | (Ev & { event: "vad"; speaking: boolean; ms?: number })
  | (Ev & { event: "cost"; turn: number | null; step: string; usd: number | null; inputTokens?: number; audioTokens?: number; outputTokens?: number; totals?: CostTotals })
  | (Ev & { event: "voicemail"; why?: string })
  | (Ev & { event: "outbound"; user?: string | null })
  | (Ev & { event: "answered_by"; value?: string })
  | (Ev & { event: "prepared_dropped" | "false_start" | "speculation_used" | "speculation_dropped" | "speculate"; turn?: number; why?: string; ms?: number })
  | (Ev & { event: "filler" | "backchannel" | "duration_warning" });
export type EventName = MonitorEvent["event"];
/** Too big for the bus between instances (a long note): the event without its body. */
export interface TrimmedEvent { t: number; event: EventName | (string & {}); turn?: number; trimmed: true }
export type TimelineEvent = MonitorEvent | TrimmedEvent;

export interface SystemEntry { t: number; text: string; level: "info" | "warn" | "error" | (string & {}) }
/** What /monitor-ws sends. */
export type MonitorMsg =
  | { type: "call"; call: LiveCallSummary }
  | { type: "event"; id: string; ev: TimelineEvent }
  | { type: "system"; entry: SystemEntry };

// ---------- the test phone ----------
export interface Mode { engine: "cascade" | "live" | (string & {}); model: string; mask: string; liveModel: string; liveVoice: string }
export interface ConfigOut {
  phone: Mode;
  modes: { engines: string[]; models: string[]; masks: string[]; liveModels: string[]; liveVoices: string[] };
}
export interface Customer { id: string; name: string; place?: string; summary?: string; lastContact?: string; history?: unknown[] }
export interface Action { id: string; text: string; due: string; status: "open" | "done"; customerName?: string | null; doneAt?: string | null }
export interface MemoryOut { customers: Customer[]; actions: Action[] }
