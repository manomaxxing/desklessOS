// Tools the agent can call in the middle of a call (Gemini function calling),
// shared by both engines. A tool:
//   name, description, parameters   what the model sees (Gemini schema)
//   effect                          "read" looks something up, "write" changes something
//                                   outside the call (a request, an email), "call" steers the call
//   requiresConfirm                 only right after he said yes to a recap (ctx.confirmed: a boolean,
//                                   or a function(tool) → Promise<boolean>, asked only when such a tool is called)
//   confirmAbout?                   "send": the yes must be to sending (the question he answered, or his
//                                   own words, are about sending: the locale's send words)
//   timeoutMs                       how long to wait for it
//   available?(ctx)                 offered on this call at all?
//   prepare?(args, ctx) → input     no side effects, may be abandoned (e.g. wait for the latest draft)
//   key?(input)                     what makes two writes "the same" (default: the whole input)
//   secretArgs?                     args never shown: masked in the outcome (the monitor, tool_runs), e.g. a PIN
//   run(input, ctx) → result        a plain object for the model; its `summary` (one line)
//                                   also goes into the call's history
//
// Writes are safe against hedged requests, false starts and the model asking
// twice: a write runs only once ctx.mayWrite() says the turn still stands (the
// false-start window has passed), at most once per call and key, and is never
// aborted once it started.

import { createHash } from "node:crypto";
import { isRecord } from "../shared/is-record.ts";
import type { FunctionDeclaration, Tool, ToolCall, ToolContext, ToolEffect, ToolOutcome, ToolResult, ToolSpec, ToolStatus } from "../types/tool.ts";

/** A tool's spec, with the args to keep out of logs. */
export type Spec = ToolSpec;
/** A defined tool (frozen, defaults filled in). Input: the model's args, as they came (no tool here has `prepare`). */
export type CallTool = Tool;

const EFFECTS: ReadonlySet<unknown> = new Set<ToolEffect>(["read", "write", "call"]);
const isEffect = (v: unknown): v is ToolEffect => EFFECTS.has(v);

export function defineTool(spec: Spec): CallTool {
  for (const k of ["name", "description", "run"] as const) if (!spec[k]) throw new Error(`tool ${spec.name ?? "?"}: ${k} missing`);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(spec.name)) throw new Error(`tool ${spec.name}: name must be lowercase letters, digits and _`);
  const tool = { effect: "read", requiresConfirm: false, timeoutMs: 8000, parameters: { type: "OBJECT", properties: {} }, ...spec } satisfies Partial<CallTool>;
  if (!isEffect(tool.effect)) throw new Error(`tool ${spec.name}: effect must be one of ${[...EFFECTS].join(", ")}`);
  return Object.freeze({ ...tool, effect: tool.effect });
}

export const declaration = ({ name, description, parameters }: CallTool): FunctionDeclaration => ({ name, description, parameters });

const stable = (v: unknown): unknown => (Array.isArray(v) ? v.map(stable) : isRecord(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v);
/** Short hash of a value, independent of key order. */
export const hashValue = (v: unknown): string => createHash("sha256").update(JSON.stringify(stable(v ?? {}))).digest("hex").slice(0, 16);

/** The args as the monitor and tool_runs may see them: a tool's secret ones masked. */
const argsForLog = (tool: CallTool | undefined, args: Record<string, unknown>): Record<string, unknown> =>
  (tool?.secretArgs?.some(k => k in args) ? { ...args, ...Object.fromEntries(tool.secretArgs.filter(k => k in args).map(k => [k, "***"])) } : args);

class Timeout extends Error {}
const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout(`no result after ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
};
// Stop waiting when the turn is taken back (the work itself may finish in the background).
const unlessAborted = <T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> => (signal
  ? Promise.race([promise, new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  })])
  : promise);

export interface ToolRunner {
  tools: readonly CallTool[];
  get(name: string): CallTool | null;
  /** Declarations for the tools offered on this call. */
  declarations(ctx?: Partial<ToolContext>): FunctionDeclaration[];
  run(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome>;
}

/**
 * One runner per call. `run(call, ctx)` → outcome { id, name, args, status, result, summary, ms }:
 *   ok | repeated (a write with the same key already ran: its result, already_done) |
 *   rejected (needs his yes first) | skipped (the turn was taken back before a write) |
 *   aborted | error | unknown.
 * The outcome's args are for logs: secret ones masked (the tool itself got them as they came).
 * ctx: { callId, signal, confirmed, mayWrite?() → Promise<bool>, onWrite?(tool), … whatever the tools use }.
 */
export function createToolRunner({ tools, onRun = () => {} }: { tools: readonly CallTool[]; onRun?: (outcome: ToolOutcome) => void }): ToolRunner {
  const byName = new Map(tools.map(t => [t.name, t]));
  const writes = new Map<string, Promise<ToolResult>>(); // idempotency key "callId:name:hash" → promise of the result

  async function run(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
    const started = performance.now();
    const tool = byName.get(call.name);
    const args = call.args ?? {};
    let key: string | null = null;
    const finish = (status: ToolStatus, result: ToolResult): ToolOutcome => {
      const outcome = { id: call.id ?? null, name: call.name, args: argsForLog(tool, args), status, result, summary: String(result.summary ?? result.error ?? "").slice(0, 300), ms: Math.round(performance.now() - started), key };
      onRun(outcome);
      return outcome;
    };
    if (!tool) return finish("unknown", { error: `there is no tool called ${call.name}` });
    if (tool.requiresConfirm && !(typeof ctx.confirmed === "function" ? await ctx.confirmed(tool) : ctx.confirmed)) {
      return finish("rejected", { done: false, error: "NOT DONE: nothing was sent or changed, because he hasn't clearly said yes. Do not say it was done. Ask him once, briefly, whether you should go ahead (NEXT: confirm); call this again only after a plain yes." });
    }
    try {
      const input = tool.prepare ? await unlessAborted(withTimeout(Promise.resolve(tool.prepare(args, ctx)), tool.timeoutMs), ctx.signal) : args;
      if (tool.effect !== "write") {
        const result = await unlessAborted(withTimeout(Promise.resolve(tool.run(input, ctx)), tool.timeoutMs), ctx.signal);
        return finish("ok", asObject(result));
      }
      const writeKey = `${ctx.callId}:${tool.name}:${hashValue(tool.key ? tool.key(input) : input)}`;
      key = writeKey;
      const earlier = writes.get(writeKey);
      if (earlier) return finish("repeated", { ...asObject(await earlier), already_done: true });
      if (ctx.mayWrite && !(await ctx.mayWrite(tool))) return finish("skipped", { error: "the turn was taken back before this ran" });
      const meanwhile = writes.get(writeKey);
      if (meanwhile) return finish("repeated", { ...asObject(await meanwhile), already_done: true });
      ctx.onWrite?.(tool);
      const pending = Promise.resolve().then(() => tool.run(input, ctx));
      writes.set(writeKey, pending);
      pending.catch(() => writes.delete(writeKey)); // a failed write may be tried again
      return finish("ok", asObject(await withTimeout(pending, tool.timeoutMs)));
    } catch (err) {
      if (ctx.signal?.aborted && !(err instanceof Timeout)) return finish("aborted", { error: "the turn was taken back" });
      return finish("error", { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    tools,
    get: name => byName.get(name) ?? null,
    declarations: (ctx = {}) => tools.filter(t => !t.available || t.available(ctx)).map(declaration),
    run,
  };
}

const asObject = (v: unknown): ToolResult => (isRecord(v) ? v : { result: v ?? null });
