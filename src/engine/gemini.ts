// Gemini 3.x ignores thinkingBudget: 0 and takes thinkingLevel instead (MINIMAL
// measured 1.4–1.7 s to first text vs 1.6–3.7 s with the budget setting).

import type { Turn } from "../types/common.ts";
import type { Content, Endpoint, FunctionCall, Part, Schema, StreamEvent, Usage } from "../types/gemini.ts";
import type { FunctionDeclaration } from "../types/tool.ts";
import { isRecord } from "../shared/is-record.ts";

// The backup model everywhere (hedged turns, notes, memory, summaries, the planner). Not 2.5
// Flash: Vertex retires gemini-2.5-flash and -flash-lite on 2026-10-20.
export const FALLBACK_MODEL = process.env.FALLBACK_MODEL || "gemini-3.5-flash-lite";

export type ThinkingConfig = { thinkingBudget: number } | { thinkingLevel: "LOW" | "MINIMAL" };
/** functionCallingConfig.mode: NONE declares the tools but lets no call through. */
export type ToolMode = "AUTO" | "ANY" | "NONE" | "VALIDATED";

// Gemini 3 takes a thinking level, older models a budget. From 3.6 on MINIMAL is gone (400
// "Thinking level is unsupported"): LOW is the lowest, and on a short turn it thinks 0 tokens.
export function thinkingConfig(model: string, budget = 0): ThinkingConfig {
  if (!/^gemini-3/.test(model)) return { thinkingBudget: budget };
  const minor = Number((/^gemini-3\.(\d+)/.exec(model) ?? [])[1] ?? 0);
  return { thinkingLevel: budget || minor >= 6 ? "LOW" : "MINIMAL" };
}

// The two Gemini calls.
//  Fast path: one streamed call per turn. The caller's audio goes in as-is, so
//  hearing and answering are the same call (no separate speech-to-text step).
//  Slow path: a JSON-schema call that keeps the structured note up to date.
//  It never sits between the caller and the next sound.

/** The caller's turn: his audio as WAV (or a text cue), and the line that goes with the audio. */
export interface UserInput {
  audio?: Buffer | null;
  text?: string | null;
  extra?: string;
}

/** The caller's turn as a Gemini content: his audio (or a text cue). */
export function userContent({ audio, text, extra }: UserInput): Content {
  const parts = audio
    ? [{ inline_data: { mime_type: "audio/wav", data: audio.toString("base64") } }, { text: extra ?? "(The caller is speaking in the audio above.)" }]
    : [{ text: text ?? "" }];
  return { role: "user", parts };
}
export const historyContents = (history: readonly Turn[]): Content[] => history.map(t => ({ role: t.role, parts: [{ text: t.text }] }));

// What generateContent answers, read defensively: the first candidate's parts as received
// (thought signatures included) and the usage counters.
function partsOf(body: unknown): Part[] {
  const candidate: unknown = isRecord(body) && Array.isArray(body.candidates) ? body.candidates[0] : null;
  const parts: unknown = isRecord(candidate) && isRecord(candidate.content) ? candidate.content.parts : null;
  return Array.isArray(parts) ? parts.filter(isRecord) : [];
}
function usageOf(body: unknown): Usage | null {
  // As Gemini sends it; geminiCost reads every count with a default, so a missing one costs nothing.
  return isRecord(body) && isRecord(body.usageMetadata) ? (body.usageMetadata as Usage) : null;
}
function callOf(part: Part): FunctionCall | null {
  const fc = part.functionCall;
  if (!isRecord(fc)) return null;
  return { id: typeof fc.id === "string" ? fc.id : null, name: String(fc.name ?? ""), args: isRecord(fc.args) ? fc.args : {} };
}
const textOf = (part: Part): string => (typeof part.text === "string" ? part.text : "");

// The streamed body as text, ending with a newline: a last line sent without one still counts.
async function* textPieces(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  for await (const chunk of body) yield decoder.decode(chunk, { stream: true });
  yield `${decoder.decode()}\n`;
}

/** One streamed turn. `contents` (raw Gemini contents) replaces history + audio/text: the follow-up after a tool. */
export interface StreamTurnArgs extends UserInput {
  endpoint: Endpoint;
  model: string;
  system: string;
  history?: readonly Turn[];
  contents?: Content[];
  tools?: readonly FunctionDeclaration[] | null;
  toolMode?: ToolMode;
  signal?: AbortSignal;
  thinkingBudget?: number;
  onUsage?: (usage: Usage) => void;
}

// Yields, as the answer streams:
//   { type: "text", text }                     reply text (thought parts are never yielded)
//   { type: "call", call: { id, name, args } } a native tool call (`tools` = function declarations)
//   { type: "end", parts }                     every part as received, thoughtSignature included:
//                                              Gemini 3 rejects the tool follow-up without it
export async function* streamTurn({ endpoint, model, system, history = [], audio, text, extra, contents, tools, toolMode = "AUTO", signal, thinkingBudget = 0, onUsage = () => {} }: StreamTurnArgs): AsyncGenerator<StreamEvent, void, undefined> {
  const response = await fetch(endpoint.url(model, "streamGenerateContent"), {
    method: "POST",
    headers: await endpoint.headers(),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: contents ?? [...historyContents(history), userContent({ audio, text, extra })],
      ...(tools?.length ? { tools: [{ functionDeclarations: tools }], toolConfig: { functionCallingConfig: { mode: toolMode } } } : {}),
      generationConfig: { temperature: 0.6, maxOutputTokens: 1200, thinkingConfig: thinkingConfig(model, thinkingBudget) },
    }),
  });
  if (!response.ok) throw new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 200)}`);
  if (!response.body) throw new Error("gemini: an answer without a body");
  const parts: Part[] = [];
  let buf = "";
  let usage: Usage | null = null;
  for await (const piece of textPieces(response.body)) {
    buf += piece;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload: unknown = JSON.parse(line.slice(5));
      usage = usageOf(payload) ?? usage;
      for (const part of partsOf(payload)) {
        parts.push(part);
        const call = callOf(part);
        if (call) yield { type: "call", call };
        else if (textOf(part) && !part.thought) yield { type: "text", text: textOf(part) };
      }
    }
  }
  if (usage) onUsage(usage);
  yield { type: "end", parts };
}

/**
 * His words, written down from the audio and nothing else: an independent check when the
 * turn's own transcript came back empty (Gemini sometimes answers a turn with only a tool
 * call). Resolves to "" when it can't.
 */
export async function transcribe({ endpoint, model, audio, signal, timeoutMs = 3000 }: { endpoint: Endpoint; model: string; audio: Uint8Array; signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
  try {
    const response = await fetch(endpoint.url(model, "generateContent"), {
      method: "POST",
      headers: await endpoint.headers(),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: Buffer.from(audio).toString("base64") } }, { text: "Write down exactly what is said in this audio, word for word, in the language spoken. Only the words; nothing if nothing is said." }] }],
        generationConfig: { maxOutputTokens: 200, thinkingConfig: thinkingConfig(model) },
      }),
    });
    if (!response.ok) return "";
    return partsOf(await response.json()).map(p => (p.thought ? "" : textOf(p))).join("").trim();
  } catch { return ""; }
}

// A one-token request so the model's first real turn isn't the cold one. Never fails: a cold
// first turn is all a failed warm-up costs, and that turn reports its own errors.
export async function warmModel({ endpoint, model }: { endpoint: Endpoint; model: string }): Promise<void> {
  try {
    const res = await fetch(endpoint.url(model, "generateContent"), {
      method: "POST",
      headers: await endpoint.headers(),
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ok" }] }], generationConfig: { maxOutputTokens: 1, thinkingConfig: thinkingConfig(model) } }),
    });
    await res.arrayBuffer();
  } catch { /* see above */ }
}

/** A JSON-schema call: the answer keeps to `schema`. `think`: let the model think first. */
export interface ExtractArgs {
  endpoint: Endpoint;
  system: string;
  prompt: string;
  schema: Schema;
  signal?: AbortSignal;
  think?: boolean;
  onUsage?: (usage: Usage) => void;
}
/** Models are tried in order (null and repeats skipped); `timeoutMs` is per model. */
export interface ResilientExtractArgs extends ExtractArgs {
  models: readonly (string | null | undefined)[];
  timeoutMs?: number;
  hedgeMs?: number;
  retries429?: number;
}

// Background JSON calls: try each model with a timeout before giving up.
// `hedgeMs`: if the first model hasn't answered by then, the next one races it
// (a hung request then costs seconds, not the whole timeout); the first answer wins.
// `retries429`: when every model answered 429 (quota), wait and go again (1.5 s, 4 s, …);
// only for work that can wait (the admin's planner, background notes), never a live turn.
// T: the shape `schema` describes. Gemini keeps to it; it isn't checked again here.
export async function extractJsonResilient<T = unknown>({ retries429 = 0, ...args }: ResilientExtractArgs): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await extractOnce(args)) as T; // see T above: the schema is the contract
    } catch (err) {
      if (attempt >= retries429 || !/\b429\b/.test(err instanceof Error ? err.message : String(err))) throw err;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1) ** 1.5));
    }
  }
}

async function extractOnce({ models, timeoutMs = 15000, hedgeMs = 0, ...args }: Omit<ResilientExtractArgs, "retries429">): Promise<unknown> {
  const list = [...new Set(models.filter((m): m is string => Boolean(m)))];
  // No model to ask: say so (an empty list used to throw `undefined`, or hang when hedged).
  if (!list.length) throw new Error("gemini extract: no model given");
  if (!hedgeMs) {
    let last: unknown;
    for (const model of list) {
      try { return await extractJson({ ...args, model, timeoutMs }); } catch (err) { last = err; }
    }
    throw last;
  }
  return new Promise((resolve, reject) => {
    const ctls: AbortController[] = [];
    let started = 0;
    let failed = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const launch = () => {
      if (settled || started >= list.length) return;
      const ctl = new AbortController();
      ctls.push(ctl);
      started++;
      extractJson({ ...args, model: list[started - 1], timeoutMs, signal: args.signal ? AbortSignal.any([args.signal, ctl.signal]) : ctl.signal })
        .then(result => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          for (const c of ctls) if (c !== ctl) c.abort();
          resolve(result);
        })
        .catch(err => {
          if (settled) return;
          failed++;
          if (failed === list.length) { settled = true; clearTimeout(timer); reject(err); }
          else if (failed === started) launch(); // everyone running has failed: don't wait for the hedge
        });
      if (started < list.length) { clearTimeout(timer); timer = setTimeout(launch, hedgeMs); }
    };
    launch();
  });
}

async function extractJson({ endpoint, model, system, prompt, schema, signal, timeoutMs = 30000, think = false, onUsage = () => {} }: ExtractArgs & { model: string; timeoutMs?: number }): Promise<unknown> {
  const response = await fetch(endpoint.url(model, "generateContent"), {
    method: "POST",
    headers: await endpoint.headers(),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: think ? 6000 : 2000, // thinking counts against it
        responseMimeType: "application/json",
        responseSchema: schema,
        thinkingConfig: thinkingConfig(model, think ? 2048 : 0),
      },
    }),
  });
  if (!response.ok) throw new Error(`gemini extract ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body: unknown = await response.json();
  const usage = usageOf(body);
  if (usage) onUsage(usage);
  const parsed: unknown = JSON.parse(partsOf(body).map(textOf).join(""));
  return parsed;
}
