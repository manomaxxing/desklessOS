// Folds one finished call into long-term memory (customers, to-dos, summary,
// the pilot's research findings). `memory` is the call's memory scope (or a
// past call's, when the server retries): snapshot() to match against, apply()
// to store the result.

import type { Day, LangId, Turn } from "../types/common.ts";
import type { Endpoint, Schema, Usage } from "../types/gemini.ts";
import type { Note } from "../types/note.ts";
import type { MemoryResult } from "../types/memory.ts";

export type { MemoryResult };
import { extractJsonResilient, FALLBACK_MODEL } from "./gemini.ts";

/** The skill's memory step: its prompt sees what `snapshot()` found (S). */
export interface MemorySkill<S> {
  MEMORY_SYSTEM: string;
  MEMORY_SCHEMA: Schema;
  memoryPrompt(input: { turns: readonly Turn[]; note: Note; snapshot: S }): string;
}

/** A call's memory scope, as far as this step uses it: what to match against (S), and storing the result (C: what changed). */
export interface MemoryStep<S, C> {
  snapshot(input: { note: Note }): Promise<S>;
  apply(result: MemoryResult, ctx: { callId: string; noteId: string | null; lang?: LangId | null; date?: Day }): Promise<C>;
}

export async function consolidateCall<S, C>({ endpoint, model, skill, memory, turns, note, callId, noteId, lang, date, onUsage }: {
  endpoint: Endpoint;
  model: string;
  skill: MemorySkill<S>;
  memory: MemoryStep<S, C>;
  turns: readonly Turn[];
  note: Note;
  callId: string;
  noteId: string | null;
  lang?: LangId | null;
  /** The call's day (YYYY-MM-DD); else apply() takes today. */
  date?: Day;
  onUsage?: (usage: Usage) => void;
}): Promise<{ result: MemoryResult; changed: C }> {
  const snapshot = await memory.snapshot({ note });
  const result = await extractJsonResilient<MemoryResult>({
    models: [model, FALLBACK_MODEL], timeoutMs: 20000,
    endpoint, system: skill.MEMORY_SYSTEM, schema: skill.MEMORY_SCHEMA,
    prompt: skill.memoryPrompt({ turns, note, snapshot }),
    onUsage,
  });
  const changed = await memory.apply(result, { callId, noteId, lang, ...(date ? { date } : {}) });
  return { result, changed };
}
