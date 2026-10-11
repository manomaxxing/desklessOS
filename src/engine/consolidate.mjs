// Folds one finished call into long-term memory (customers, to-dos, summary).
// Shared by the live session, the pending-retry loop and the rebuild script.

import { extractJsonResilient } from "./gemini.mjs";

export async function consolidateCall({ endpoint, model, skill, memory, store, turns, note, callId, noteId, lang, date, onUsage }) {
  const result = await extractJsonResilient({
    models: [model, process.env.FALLBACK_MODEL || "gemini-2.5-flash"], timeoutMs: 20000,
    endpoint, system: skill.MEMORY_SYSTEM, schema: skill.MEMORY_SCHEMA,
    prompt: skill.memoryPrompt({ turns, note, snapshot: memory.snapshot() }),
    onUsage,
  });
  const changed = memory.apply(result, { callId, noteId, lang, ...(date ? { date } : {}) });
  // Link the saved note to its customer, so the customer's memory entry carries the note's details.
  if (noteId && changed.customer && store?.update) store.update(noteId, { customerId: changed.customer.id });
  return { result, changed };
}
