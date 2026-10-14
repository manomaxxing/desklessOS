// Tools the agent can call in the middle of a call (Gemini function calling),
// shared by both engines. A tool:
//   name, description, parameters   what the model sees (Gemini schema)
//   effect                          "read" looks something up, "write" changes something
//                                   outside the call (a request, an email), "call" steers the call
//   requiresConfirm                 only right after he said yes to a recap (ctx.confirmed)
//   timeoutMs                       how long to wait for it
//   available?(ctx)                 offered on this call at all?
//   prepare?(args, ctx) → input     no side effects, may be abandoned (e.g. wait for the latest draft)
//   key?(input)                     what makes two writes "the same" (default: the whole input)
//   run(input, ctx) → result        a plain object for the model; its `summary` (one line)
//                                   also goes into the call's history
//
// Writes are safe against hedged requests, false starts and the model asking
// twice: a write runs only once ctx.mayWrite() says the turn still stands (the
// false-start window has passed), at most once per call and key, and is never
// aborted once it started.

import { createHash } from "node:crypto";

const EFFECTS = new Set(["read", "write", "call"]);

export function defineTool(spec) {
  for (const k of ["name", "description", "run"]) if (!spec[k]) throw new Error(`tool ${spec.name ?? "?"}: ${k} missing`);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(spec.name)) throw new Error(`tool ${spec.name}: name must be lowercase letters, digits and _`);
  const tool = { effect: "read", requiresConfirm: false, timeoutMs: 8000, parameters: { type: "OBJECT", properties: {} }, ...spec };
  if (!EFFECTS.has(tool.effect)) throw new Error(`tool ${spec.name}: effect must be one of ${[...EFFECTS].join(", ")}`);
  return Object.freeze(tool);
}

export const declaration = ({ name, description, parameters }) => ({ name, description, parameters });

const stable = v => (Array.isArray(v) ? v.map(stable) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v);
/** Short hash of a value, independent of key order. */
export const hashValue = v => createHash("sha256").update(JSON.stringify(stable(v ?? {}))).digest("hex").slice(0, 16);

class Timeout extends Error {}
const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Timeout(`no result after ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};
// Stop waiting when the turn is taken back (the work itself may finish in the background).
const unlessAborted = (promise, signal) => (signal
  ? Promise.race([promise, new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  })])
  : promise);

/**
 * One runner per call. `run(call, ctx)` → outcome { id, name, args, status, result, summary, ms }:
 *   ok | repeated (a write with the same key already ran: its result, already_done) |
 *   rejected (needs his yes first) | skipped (the turn was taken back before a write) |
 *   aborted | error | unknown.
 * ctx: { callId, signal, confirmed, mayWrite?() → Promise<bool>, onWrite?(tool), … whatever the tools use }.
 */
export function createToolRunner({ tools, onRun = () => {} }) {
  const byName = new Map(tools.map(t => [t.name, t]));
  const writes = new Map(); // idempotency key "callId:name:hash" → promise of the result

  async function run(call, ctx) {
    const started = performance.now();
    const tool = byName.get(call.name);
    let key = null;
    const finish = (status, result) => {
      const outcome = { id: call.id ?? null, name: call.name, args: call.args ?? {}, status, result, summary: String(result?.summary ?? result?.error ?? "").slice(0, 300), ms: Math.round(performance.now() - started), key };
      onRun(outcome);
      return outcome;
    };
    if (!tool) return finish("unknown", { error: `there is no tool called ${call.name}` });
    if (tool.requiresConfirm && !ctx.confirmed) {
      return finish("rejected", { error: "He hasn't confirmed a recap yet. Give him one short recap and ask whether to go ahead (NEXT: confirm); call this only after he says yes." });
    }
    try {
      const input = tool.prepare ? await unlessAborted(withTimeout(Promise.resolve(tool.prepare(call.args ?? {}, ctx)), tool.timeoutMs), ctx.signal) : call.args ?? {};
      if (tool.effect !== "write") {
        const result = await unlessAborted(withTimeout(Promise.resolve(tool.run(input, ctx)), tool.timeoutMs), ctx.signal);
        return finish("ok", asObject(result));
      }
      key = `${ctx.callId}:${tool.name}:${hashValue(tool.key ? tool.key(input) : input)}`;
      if (writes.has(key)) return finish("repeated", { ...asObject(await writes.get(key)), already_done: true });
      if (ctx.mayWrite && !(await ctx.mayWrite(tool))) return finish("skipped", { error: "the turn was taken back before this ran" });
      if (writes.has(key)) return finish("repeated", { ...asObject(await writes.get(key)), already_done: true });
      ctx.onWrite?.(tool);
      const pending = Promise.resolve().then(() => tool.run(input, ctx));
      writes.set(key, pending);
      pending.catch(() => writes.delete(key)); // a failed write may be tried again
      return finish("ok", asObject(await withTimeout(pending, tool.timeoutMs)));
    } catch (err) {
      if (ctx.signal?.aborted && !(err instanceof Timeout)) return finish("aborted", { error: "the turn was taken back" });
      return finish("error", { error: err.message });
    }
  }

  return {
    tools,
    get: name => byName.get(name) ?? null,
    /** Declarations for the tools offered on this call. */
    declarations: (ctx = {}) => tools.filter(t => !t.available || t.available(ctx)).map(declaration),
    run,
  };
}

const asObject = v => (v && typeof v === "object" && !Array.isArray(v) ? v : { result: v ?? null });
