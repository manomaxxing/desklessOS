// Folds one finished call into long-term memory (customers, to-dos, summary,
// the pilot's research findings). `memory` is the call's memory scope (or a
// past call's, when the server retries): snapshot() to match against, apply()
// to store the result.

import { extractJsonResilient, FALLBACK_MODEL } from "./gemini.mjs";

export async function consolidateCall({ endpoint, model, skill, memory, turns, note, callId, noteId, lang, date, onUsage }) {
  const snapshot = await memory.snapshot({ note });
  const result = await extractJsonResilient({
    models: [model, FALLBACK_MODEL], timeoutMs: 20000,
    endpoint, system: skill.MEMORY_SYSTEM, schema: skill.MEMORY_SCHEMA,
    prompt: skill.memoryPrompt({ turns, note, snapshot }),
    onUsage,
  });
  const changed = await memory.apply(result, { callId, noteId, lang, ...(date ? { date } : {}) });
  return { result, changed };
}
