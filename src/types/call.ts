// A call: the frames on the line (Dial's protocol, which every adapter speaks), what the engine
// reports about it, what it saves as it goes, and what it knows from memory.
import type { Iso, LangId, Turn } from "./common.ts";
import type { CallUser } from "./user.ts";
import type { Objective } from "./agenda.ts";

export type Direction = "inbound" | "outbound";

/** Frames into a call (from the phone line). */
export type FrameIn =
  | {
    type: "call_connected"; call_id?: string; from?: string | null; to?: string | null; direction?: Direction;
    user_id?: string | null; job_id?: string | null; language?: string | null; formats?: Record<string, string>;
    reconnect?: boolean; config?: Record<string, unknown>; objectives?: { template: string; params?: Record<string, unknown>; lang?: LangId }[];
    rehearsal_of?: string | null;
  }
  | { type: "media"; payload: string }
  | { type: "mark"; name?: string }
  | { type: "call_ended"; reason?: string }
  | { type: "duration_warning" }
  | { type: "ping_pong"; [key: string]: unknown }
  | { type: "answered_by"; answered_by?: string };

/** Frames out of a call (to the phone line). */
export type FrameOut =
  | { type: "media"; payload: string }
  | { type: "mark"; name: string }
  | { type: "clear" }
  | { type: "end_call" }
  | { type: "debug"; event: string; t: number; [key: string]: unknown }
  | { type: "ping_pong"; [key: string]: unknown };

export interface Line {
  send(frame: FrameOut): void;
  close?(): void;
}

/** What the engine reports (the monitor's timeline; dev callers get them inline). */
export interface CallEvent {
  event: string;
  turn?: number | null;
  [key: string]: unknown;
}

/** The call as saved after every turn, and as it ends. */
export interface CallSnapshot {
  turns: Turn[];
  extraction: Record<string, unknown> | null;
  extractionTurns: number;
  lang: LangId | null;
  usd?: number;
}
export interface CallEnd extends Partial<CallSnapshot> {
  reason?: string;
  timeline?: CallEvent[];
  meta?: Record<string, unknown>;
}

export interface ContextStats {
  tokens: number;
  budget: number;
  customers: number;
  names: number;
  tasks: number;
  facts: number;
  ms?: number;
}

/** What memory_search finds: customers with their latest notes and to-dos, or loose notes. */
export interface FoundCustomer {
  name: string; place: string | null; address: string | null; phone: string | null; last_contact: string; summary: string | null;
  history: string[]; notes: string[]; open_todos: string[];
}
export type SearchResult = FoundCustomer | { note: string };

/** What one call knows from memory (read once when it connects) and how it saves itself. */
export interface CallScope {
  user: CallUser | null;
  rehearsal?: { of: string } | null;
  context: string;
  hidden: number;
  firstCall?: boolean;
  stats: ContextStats | null;
  discovery: unknown;
  objectives: Objective[];
  search(query: string): Promise<SearchResult[]>;
  setAgenda(objectiveIds: string[], goal?: unknown[]): Promise<void>;
  checkpoint(snapshot: CallSnapshot): Promise<void>;
  endCall(end: CallEnd): Promise<boolean>;
  recordToolRun(outcome: { key: string | null; name: string; args: unknown; status: string; result: unknown }): Promise<void>;
}

/** A pre-rendered clip in one language (PCM16 16 kHz mono). */
export interface LangClips {
  greeting?: Buffer;
  firstGreeting?: Buffer;
  outboundGreeting?: Buffer;
  wrapUp?: Buffer;
  backchannel?: Buffer;
  working?: Buffer;
  looking?: Buffer;
  oops?: Buffer[];
  fillers?: Buffer[];
}

/** A phone network that can ring him (src/telephony/twilio.ts, whatsapp.ts, fake.ts). */
export interface Carrier {
  id: string;
  dialOut(o: { to: string; userId: string; jobId: string }): Promise<{ callId: string; carrier: string }>;
}
/** A carrier's word on a call it placed. */
export interface CarrierStatus {
  callId: string;
  status: string;
  carrier?: string;
  answeredBy?: string | null;
  duration?: number;
}
