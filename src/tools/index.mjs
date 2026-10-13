// The tools the agent has on a call. Both engines declare the same ones; the
// cascade hangs up through NEXT: hangup, so end_call is for Live only.
// ctx (from the engine): { callId, lang, signal, confirmed, latestNote(), emit(event, data), log, hangup() }.

import { defineTool } from "./registry.mjs";
import { slug } from "../store/files.mjs";

export function orderExecute(office) {
  return defineTool({
    name: "order_execute",
    description: "Book the calendar entry, create the to-dos, build the quote and email it to the customer, from everything said in this call. Call this only right after he confirmed your recap.",
    effect: "write",
    requiresConfirm: true,
    timeoutMs: 20000,
    // The order is the slow path's draft (the whole transcript, his "yes" included), not tool arguments.
    prepare: (_args, ctx) => ctx.latestNote(),
    // The same customer, items and date is the same order, however the summary is worded.
    key: d => ({
      customer: slug(d.customer_name ?? ""),
      email: String(d.customer_email ?? "").toLowerCase(),
      date: d.appointment?.date || d.needed_by || "",
      items: (d.items ?? []).map(i => [i.catalog_id || slug(i.description ?? ""), Number(i.quantity) || 0, i.unit_price ?? null]),
    }),
    run: (draft, ctx) => {
      ctx.emit("workflow_start"); // the phone page shows "office is on it"
      const result = office.execute({ draft, lang: ctx.lang, callId: ctx.callId });
      ctx.emit("workflow", { result });
      ctx.log?.(`workflow: ${result.summary}`);
      return { status: "done", summary: result.summary };
    },
  });
}

export function memorySearch({ memory, store }) {
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
    available: () => memory.hidden({ notes: store.list() }) > 0,
    run: ({ query }) => {
      const results = memory.search(String(query ?? ""), { notes: store.list() });
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
 * The tools for one call. `engine`: "cascade" | "live". `allow`: the tool names the
 * call's templates may use (agenda.tools()); end_call is the Live engine's own.
 */
export function callTools({ engine, office = null, memory = null, store = null, allow = null }) {
  const ok = name => !allow || allow.includes(name);
  return [
    ...(office && ok("order_execute") ? [orderExecute(office)] : []),
    ...(memory?.search && store && ok("memory_search") ? [memorySearch({ memory, store })] : []),
    ...(engine === "live" ? [endCall] : []),
  ];
}
