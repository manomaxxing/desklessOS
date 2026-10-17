// Who said what in a call: from the saved transcript (an ended call), or from the monitor's
// events so far (a live one).

import type { CallDetail, CallSummary, StoredCallSummary } from "./types.ts";

export interface Turn { role: "user" | "agent" | "hint"; text: string; cut?: boolean; turn?: number }

/** The call log's fields (user, title, goal…), when the call has them: a live one doesn't. */
export const isStored = <T extends CallSummary | CallDetail>(c: T): c is Extract<T, StoredCallSummary> => "userName" in c;

/** What was said aloud: without the stage notes the transcript keeps ([did …], [interrupted …]). */
export const spoken = (text: string | null | undefined): string => String(text ?? "").replace(/\s*\[(?:did|called|interrupted)[^\]]*\]/g, "").trim();

/**
 * One agent turn arrives as several `say` events: whole sentences (joined with a space) or,
 * from Gemini Live, pieces of a transcription (delta: joined as they are). A `say` can come
 * without text (a line that wasn't spoken, with only a note).
 */
export function mergeSay(prev: string, text: string | null | undefined, delta = false): string {
  const t = text ?? "";
  if (!prev) return t.trimStart();
  if (!t) return prev;
  return delta ? prev + t : `${prev} ${t}`;
}

export function turnsOf(c: CallDetail): Turn[] {
  const transcript = "transcript" in c ? c.transcript : null;
  if (transcript?.length) {
    return transcript
      .map((t): Turn => ({ role: t.role === "user" ? "user" : "agent", text: spoken(t.text), cut: /\[interrupted/.test(t.text) }))
      .filter(t => t.text && !(t.role === "user" && /^\((?:You called him|System:|The caller is speaking)/.test(t.text)))
      .map(t => (t.role === "user" && /^\(Silence/.test(t.text) ? { role: "hint", text: "(silence)" } : t));
  }
  const out: Turn[] = [];
  for (const e of c.events ?? []) {
    if (e.trimmed) continue;
    if (e.event === "heard" && e.text) out.push({ role: "user", text: e.text, turn: e.turn });
    if (e.event === "say" && e.text) {
      const last = out.at(-1);
      if (last?.role === "agent" && last.turn === e.turn) last.text = mergeSay(last.text, e.text, e.delta);
      else out.push({ role: "agent", text: mergeSay("", e.text), turn: e.turn });
    }
  }
  return out;
}

/** The name over a turn: him (or who Max plays in a rehearsal), or the agent. */
export function speaker(c: CallDetail, t: Turn, agent: string): string {
  if (t.role === "hint") return "";
  if (t.role === "agent") return agent;
  if (!isStored(c)) return "Caller";
  return c.rehearsalOf ? `${c.rehearsalOf} (played)` : c.userName || "Caller";
}
