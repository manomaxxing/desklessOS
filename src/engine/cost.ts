// Token spend and cost per call. USD list prices: Gemini per 1M tokens, Fish
// per 1M UTF-8 bytes of text, Dial per call minute. Estimates for comparing
// turns and calls; the billing consoles are the truth.
//   Gemini 2.5: ai.google.dev/gemini-api/docs/pricing (via buddy-lab, 2026-09-25)
//   Gemini 3.5 Flash: third-party aggregators, 2026-10-11 (not yet on Google's page we checked)
//   Fish: docs.fish.audio pricing; s2.1-pro-free bills $0 but we show what s2.1-pro would cost
//   Dial: set DIAL_USD_PER_MIN (no public per-minute rate checked)

import type { Usage } from "../types/gemini.ts";

/** USD per 1M tokens; audio in (and out, for Live) priced apart. */
interface GeminiPrice {
  input: number;
  audioInput: number;
  output: number;
  audioOutput?: number;
}

export const PRICES: { asOf: string; gemini: Record<string, GeminiPrice>; fish: Record<string, number>; fishPaidReference: number } = {
  asOf: "2026-10-11",
  gemini: {
    "gemini-3.5-flash": { input: 1.5, audioInput: 1.5, output: 9.0 },
    "gemini-3.5-flash-lite": { input: 0.3, audioInput: 0.3, output: 2.5 }, // ai.google.dev/gemini-api/docs/pricing, 2026-10-15
    // Live (native audio): audio is 25 tokens/s; every turn re-bills the context (ai.google.dev pricing, 2026-10-11)
    "gemini-3.8-live": { input: 0.75, audioInput: 3.0, output: 4.5, audioOutput: 12.0 },
    "gemini-live-2.5-flash-native-audio": { input: 0.5, audioInput: 3.0, output: 2.0, audioOutput: 12.0 },
    "gemini-2.5-flash": { input: 0.3, audioInput: 1.0, output: 2.5 },
    "gemini-2.5-flash-lite": { input: 0.1, audioInput: 0.3, output: 0.4 },
  },
  fish: { "s2.1-pro-free": 0, "s2.1-pro": 15, "s2-pro": 15, s1: 15 },
  fishPaidReference: 15,
};

const M = 1e6;

/** One Gemini request's spend; usd null when the model has no list price. */
export interface LlmCost {
  kind: "llm";
  step: string;
  model: string;
  inputTokens: number;
  audioTokens: number;
  outputTokens: number;
  audioOutputTokens: number;
  usd: number | null;
}
/** One TTS request's spend; paidUsd is what the paid Fish tier would have cost. */
export interface TtsCost {
  kind: "tts";
  model: string;
  bytes: number;
  usd: number | null;
  paidUsd: number;
}
export type CostEntry = LlmCost | TtsCost;

interface StepTotals {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  bytes: number;
  usd: number;
}
export interface CostTotals {
  llmCalls: number;
  inputTokens: number;
  audioTokens: number;
  outputTokens: number;
  llmUsd: number;
  ttsCalls: number;
  ttsBytes: number;
  ttsUsd: number;
  ttsPaidUsd: number;
  phoneMinutes: number;
  phoneUsd: number | null;
  unpriced: number;
  usd: number;
  byStep: Record<string, StepTotals>;
  pricesAsOf: string;
}
export interface Meter {
  add(entry: CostEntry): void;
  /** The call's length; priced when DIAL_USD_PER_MIN is set. */
  phone(ms: number): void;
  totals(): CostTotals;
}

/** A Gemini usageMetadata → tokens and dollars (output includes thinking). */
export function geminiCost(model: string, usage: Usage = {}, step = "turn"): LlmCost {
  const audioOf = (list: Usage["promptTokensDetails"]) => (list ?? []).filter(d => d.modality === "AUDIO").reduce((n, d) => n + (d.tokenCount ?? 0), 0);
  const audio = audioOf(usage.promptTokensDetails);
  const input = usage.promptTokenCount ?? 0;
  // Live sends responseTokenCount (AI Studio) or candidatesTokenCount (Vertex wire name)
  const output = (usage.candidatesTokenCount ?? usage.responseTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0);
  const audioOut = audioOf(usage.candidatesTokensDetails ?? usage.responseTokensDetails);
  const price = PRICES.gemini[String(model).split(":").at(-1) ?? ""] ?? PRICES.gemini[process.env.PRICE_AS_MODEL ?? ""];
  const usd = price
    ? ((input - audio) * price.input + audio * price.audioInput + (output - audioOut) * price.output + audioOut * (price.audioOutput ?? price.output)) / M
    : null;
  return { kind: "llm", step, model, inputTokens: input, audioTokens: audio, outputTokens: output, audioOutputTokens: audioOut, usd };
}

/** One TTS request: Fish bills the UTF-8 bytes of the text. */
export function ttsCost(model: string, text: string): TtsCost {
  const bytes = Buffer.byteLength(text, "utf8");
  const rate = PRICES.fish[model];
  return { kind: "tts", model, bytes, usd: rate === undefined ? null : (bytes * rate) / M, paidUsd: (bytes * PRICES.fishPaidReference) / M };
}

export function createMeter(): Meter {
  const t: Omit<CostTotals, "usd" | "byStep" | "pricesAsOf"> = { llmCalls: 0, inputTokens: 0, audioTokens: 0, outputTokens: 0, llmUsd: 0, ttsCalls: 0, ttsBytes: 0, ttsUsd: 0, ttsPaidUsd: 0, phoneMinutes: 0, phoneUsd: null, unpriced: 0 };
  const byStep: Record<string, StepTotals> = {};
  return {
    add(e) {
      const step = e.kind === "tts" ? "tts" : e.step;
      const row = (byStep[step] ??= { calls: 0, inputTokens: 0, outputTokens: 0, bytes: 0, usd: 0 });
      row.calls += 1;
      row.usd += e.usd ?? 0;
      if (e.kind === "llm") {
        row.inputTokens += e.inputTokens;
        row.outputTokens += e.outputTokens;
        t.llmCalls += 1; t.inputTokens += e.inputTokens; t.audioTokens += e.audioTokens; t.outputTokens += e.outputTokens; t.llmUsd += e.usd ?? 0;
      } else {
        row.bytes += e.bytes;
        t.ttsCalls += 1; t.ttsBytes += e.bytes; t.ttsUsd += e.usd ?? 0; t.ttsPaidUsd += e.paidUsd;
      }
      if (e.usd === null) t.unpriced += 1;
    },
    phone(ms) {
      t.phoneMinutes = ms / 60000;
      const rate = Number(process.env.DIAL_USD_PER_MIN);
      t.phoneUsd = Number.isFinite(rate) && rate > 0 ? Math.ceil(t.phoneMinutes) * rate : null;
    },
    totals() {
      return { ...t, usd: t.llmUsd + t.ttsUsd + (t.phoneUsd ?? 0), byStep: structuredClone(byStep), pricesAsOf: PRICES.asOf };
    },
  };
}
