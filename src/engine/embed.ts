// Text embeddings for memory search (notes and facts), 768 dimensions.
// Vertex: text-multilingual-embedding-002 answers in ~200 ms; gemini-embedding-001
// took 11 s on a cold call, so it's not the default (EMBED_MODEL overrides).
// Embeddings are optional: on any failure the caller gets nulls and search
// falls back to name similarity.

import type { Endpoint } from "../types/gemini.ts";
import { isRecord } from "../shared/is-record.ts";

export const EMBED_DIM = 768;
const BATCH = 50;

export type EmbedTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";
export type Vector = number[];

export interface Embedder {
  model: string;
  /** Vectors for `texts` (null where a text is empty or the call failed). */
  embed(texts: readonly (string | null | undefined)[], opts?: { task?: EmbedTask }): Promise<(Vector | null)[]>;
}

// One answer's vector: a list of numbers, else null (a malformed item costs that text its vector, not the batch).
const isVector = (values: unknown): values is Vector => Array.isArray(values) && values.every((n: unknown) => typeof n === "number");
const vectorOf = (values: unknown): Vector | null => (isVector(values) ? values : null);

export function createEmbedder({ endpoint, model = process.env.EMBED_MODEL || (endpoint?.door === "studio" ? "gemini-embedding-001" : "text-multilingual-embedding-002"), timeoutMs = 4000, onError = () => {} }: { endpoint?: Endpoint | null; model?: string; timeoutMs?: number; onError?: (err: unknown) => void } = {}): Embedder | null {
  if (!endpoint) return null;
  const batch = async (texts: string[], task: EmbedTask): Promise<(Vector | null)[]> => {
    if (endpoint.door === "studio") {
      const res = await fetch(endpoint.url(model, "batchEmbedContents"), {
        method: "POST", headers: await endpoint.headers(), signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ requests: texts.map(text => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType: task, outputDimensionality: EMBED_DIM })) }),
      });
      if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const body = await res.json();
      if (!isRecord(body) || !Array.isArray(body.embeddings)) throw new Error("embed: no embeddings in the answer");
      return body.embeddings.map((e: unknown) => vectorOf(isRecord(e) ? e.values : null));
    }
    const res = await fetch(endpoint.url(model, "predict"), {
      method: "POST", headers: await endpoint.headers(), signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ instances: texts.map(content => ({ content, task_type: task })), parameters: { outputDimensionality: EMBED_DIM } }),
    });
    if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const body = await res.json();
    if (!isRecord(body) || !Array.isArray(body.predictions)) throw new Error("embed: no predictions in the answer");
    return body.predictions.map((p: unknown) => vectorOf(isRecord(p) && isRecord(p.embeddings) ? p.embeddings.values : null));
  };
  return {
    model,
    async embed(texts, { task = "RETRIEVAL_DOCUMENT" }: { task?: EmbedTask } = {}) {
      const out: (Vector | null)[] = texts.map(() => null);
      const todo = texts.map((t, i) => ({ text: String(t ?? "").trim().slice(0, 4000), i })).filter(({ text }) => text);
      for (let k = 0; k < todo.length; k += BATCH) {
        const part = todo.slice(k, k + BATCH);
        try {
          const vectors = await batch(part.map(({ text }) => text), task);
          part.forEach(({ i }, j) => { out[i] = vectors[j] ?? null; });
        } catch (err) { onError(err); }
      }
      return out;
    },
  };
}

/** pgvector's text form: "[0.1,0.2,…]". */
export const toVector = (v: readonly number[] | null | undefined): string | null => (v ? `[${v.join(",")}]` : null);
