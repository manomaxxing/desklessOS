// What both engines keep of a call while it runs: the transcript, his note as the slow path last
// extracted it, and the checkpoints that save the call as it goes (src/memory/call-scope.ts), so
// an instance that dies loses nothing.
//
// Extractions read the transcript as it is when they start; a result is applied only if no newer
// one already was, so an older one never overwrites it. Background refreshes are chained (never in
// parallel); a tool that needs the draft now gets a fresh one that doesn't queue behind them.
// Checkpoints go one at a time, and the latest state wins.

import type { LangId, Turn } from "../types/common.ts";
import type { CallScope, CallSnapshot } from "../types/call.ts";
import type { Note } from "../types/note.ts";
import type { Schema } from "../types/gemini.ts";
import type { Agenda } from "../agenda/agenda.ts";

/** A JSON-schema extraction (src/engine/gemini.ts extractJsonResilient, with the call's models and meter). */
export type Extract = (req: { system: string; prompt: string; schema: Schema; hedgeMs: number; retries429: number }) => Promise<Record<string, unknown>>;

export interface CallRecordOptions {
  agenda: Pick<Agenda, "missing" | "update" | "extractSystem" | "extractPrompt" | "schema">;
  memory: Pick<CallScope, "checkpoint"> | null;
  /** The transcript so far: the record reads and saves it, the engine writes it. */
  turns: Turn[];
  lang: () => LangId;
  extract: Extract;
  debug: (event: string, data?: Record<string, unknown>) => void;
  fail: (where: string, err: unknown) => void;
}

export interface CallRecord {
  readonly turns: Turn[];
  readonly note: Note;
  readonly missing: string[];
  /** Background refresh after a turn (chained); never rejects. */
  refresh(): Promise<unknown>;
  /** The draft now, his latest words included (for a tool). Rejects rather than act on a stale draft. */
  fresh(): Promise<Note>;
  /** Saves the call so far (one write at a time; the latest state wins). Nothing once it's closed. */
  checkpoint(): void;
  /** The call as it is now: what a checkpoint saves, and what the end hands over. */
  snapshot(): CallSnapshot;
  /** No more checkpoints; resolves once the one under way is saved. */
  close(): Promise<void>;
}

export function createCallRecord({ agenda, memory, turns, lang, extract, debug, fail }: CallRecordOptions): CallRecord {
  let note: Note = {};
  let missing = agenda.missing(note);
  let extraction: Record<string, unknown> | null = null;
  let covers = 0; // how many turns the applied extraction read
  let seq = 0;
  let applied = 0;
  let chain: Promise<unknown> = Promise.resolve();
  let saving: Promise<void> | null = null;
  let saveAgain = false;
  let closed = false;

  const snapshot = (): CallSnapshot => ({ turns: turns.slice(), extraction, extractionTurns: covers, lang: lang() });

  function checkpoint(): void {
    if (!memory || closed) return;
    if (saving) { saveAgain = true; return; }
    saving = memory.checkpoint(snapshot())
      .catch(err => fail("checkpoint", err))
      .finally(() => {
        saving = null;
        if (saveAgain) { saveAgain = false; checkpoint(); }
      });
  }

  async function extractNote(hedgeMs: number, retries429: number): Promise<Note> {
    const mine = ++seq;
    const read = turns.slice();
    const l = lang();
    const updated = await extract({ system: agenda.extractSystem(l), prompt: agenda.extractPrompt({ turns: read, lang: l }), schema: agenda.schema(), hedgeMs, retries429 });
    if (mine < applied) return note; // a newer extraction is already in
    applied = mine;
    covers = read.length;
    extraction = updated;
    const u = agenda.update(updated); // his note, and which of the agent's own items got done (checked in code)
    note = u.note;
    missing = u.missing;
    debug("note", { note, missing });
    for (const c of u.changes) debug("objective", { ...c });
    checkpoint();
    return note;
  }

  return {
    turns,
    get note() { return note; },
    get missing() { return missing; },
    refresh() {
      chain = chain.then(() => extractNote(6000, 1)).catch(err => fail("extract", err));
      return chain;
    },
    // If the fresh extraction fails (Gemini slow), the background draft still serves when it already
    // covers every turn but his last one (the "yes" to the recap it was read from).
    async fresh() {
      try {
        return await extractNote(3500, 0);
      } catch (err) {
        if (note.mode && covers >= turns.length - 1) {
          debug("note", { note, missing, fallback: "the draft from before his yes" });
          return note;
        }
        throw err;
      }
    },
    checkpoint,
    snapshot,
    async close() {
      closed = true;
      await saving;
    },
  };
}
