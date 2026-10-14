// The tools the agent has on a call (the model hangs up through NEXT: hangup, not a tool).
// ctx (from the engine): { callId, lang, signal, confirmed, latestNote(), memory (the call's
// memory scope), emit(event, data), log, hangup() }.

import { defineTool } from "./registry.mjs";

export function memorySearch({ memory }) {
  return defineTool({
    name: "memory_search",
    description: "Look up a customer, job or earlier note that MEMORY doesn't show in full (older customers are listed by name only). Pass the name, place or topic as he said it.",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING", description: "name, place or topic, e.g. \"Kowalski Radolfzell\"" } },
      required: ["query"],
    },
    timeoutMs: 3000,
    // Only when the prompt can't show everything; otherwise it would only add a round trip.
    available: () => memory.hidden > 0,
    run: async ({ query }) => {
      const results = await memory.search(String(query ?? ""));
      return { query, results, summary: results.length ? `found ${results.map(r => r.name ?? "a note").join(", ")}` : "nothing found" };
    },
  });
}

/**
 * The tools for one call. `allow`: the tool names the call's templates may use (agenda.tools()).
 */
export function callTools({ memory = null, allow = null, extra = [] }) {
  const ok = name => !allow || allow.includes(name);
  return [
    ...extra.filter(t => ok(t.name)), // e.g. the admin line's request tools (src/tools/admin.mjs)
    ...(memory?.search && ok("memory_search") ? [memorySearch({ memory })] : []),
  ];
}
