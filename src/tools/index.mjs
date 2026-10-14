// The tools the agent has on a call. Both engines declare the same ones; the cascade hangs
// up through its header (NEXT: hangup), so end_call is Gemini Live's own.
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

export const endCall = defineTool({
  name: "end_call",
  description: "Hang up the phone. Call this only right after you have said goodbye and the conversation is finished.",
  effect: "call",
  run: (_args, ctx) => { ctx.hangup(); return { ok: true }; },
});

/**
 * The tools for one call. `engine`: "cascade" | "live". `allow`: the tool names the call's
 * templates may use (agenda.tools()); end_call is Live's own.
 */
export function callTools({ engine = "cascade", memory = null, allow = null, extra = [] }) {
  const ok = name => !allow || allow.includes(name);
  return [
    ...extra.filter(t => ok(t.name)), // e.g. the admin line's request tools (src/tools/admin.mjs)
    ...(memory?.search && ok("memory_search") ? [memorySearch({ memory })] : []),
    ...(engine === "live" ? [endCall] : []),
  ];
}
