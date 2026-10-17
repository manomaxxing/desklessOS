// One log line per call of log(...). Locally: "HH:MM:SS message". On Cloud Run: one JSON
// object per line, which Cloud Logging parses (severity, message) and makes searchable.

import type { Log } from "./types/common.ts";

/** Anything as log text: an error's stack, a string as it is, the rest as JSON (never throws). */
export function logText(a: unknown): string {
  if (a instanceof Error) return a.stack ?? a.message;
  if (typeof a === "string") return a;
  try { return JSON.stringify(a) ?? String(a); } catch { return String(a); } // a circular object, a BigInt
}

export function createLogger({ format = "text" }: { format?: string } = {}): Log {
  if (format !== "json") return (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
  return (...args) => {
    const message = args.map(logText).join(" ");
    const severity = /\berror\b/i.test(message) ? "ERROR" : /\b(failed|refused|lost|warning)\b/i.test(message) ? "WARNING" : "INFO";
    process.stdout.write(`${JSON.stringify({ severity, message })}\n`);
  };
}
