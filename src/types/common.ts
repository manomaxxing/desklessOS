// Types used everywhere: identifiers, time, the conversation's turns, logging, time sources.

/** A locale pack id (the file name of locales/<id>.json). */
export type LangId = string;
/** An ISO 8601 timestamp. */
export type Iso = string;
/** A calendar day, YYYY-MM-DD. */
export type Day = string;

/** What the agent expects after its reply (the header's NEXT). */
export type Next = "listen" | "wait" | "ask" | "confirm" | "hangup";
export const NEXT_VALUES: readonly Next[] = ["listen", "wait", "ask", "confirm", "hangup"];

/** One line of a conversation. "admin": Max on his own line. */
export interface Turn {
  role: "user" | "model" | "admin";
  text: string;
}

export type Log = (...parts: unknown[]) => void;

/** JSON as it goes into and out of Postgres jsonb columns and HTTP bodies. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** An error that carries the HTTP status to answer with. */
export interface HttpError extends Error {
  status: number;
}

/** A timer handle from a Clock: Node's Timeout, or a fake clock's number. */
export type TimerHandle = ReturnType<typeof setTimeout> | number;
/** Time, injectable: the engine runs on a fake clock in tests. `now()` in ms, like performance.now(). */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(id: TimerHandle | null | undefined): void;
}
