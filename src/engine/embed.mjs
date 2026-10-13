// Text embeddings for memory search (notes and facts), 768 dimensions.
// Vertex: text-multilingual-embedding-002 answers in ~200 ms; gemini-embedding-001
// took 11 s on a cold call, so it's not the default (EMBED_MODEL overrides).
// Embeddings are optional: on any failure the caller gets nulls and search
// falls back to name similarity.

export const EMBED_DIM = 768;
const BATCH = 50;

export function createEmbedder({ endpoint, model = process.env.EMBED_MODEL || (endpoint?.door === "studio" ? "gemini-embedding-001" : "text-multilingual-embedding-002"), timeoutMs = 4000, onError = () => {} } = {}) {
  if (!endpoint) return null;
  async function batch(texts, task) {
    if (endpoint.door === "studio") {
      const res = await fetch(endpoint.url(model, "batchEmbedContents"), {
        method: "POST", headers: await endpoint.headers(), signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ requests: texts.map(text => ({ model: `models/${model}`, content: { parts: [{ text }] }, taskType: task, outputDimensionality: EMBED_DIM })) }),
      });
      if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 160)}`);
      return (await res.json()).embeddings.map(e => e.values);
    }
    const res = await fetch(endpoint.url(model, "predict"), {
      method: "POST", headers: await endpoint.headers(), signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ instances: texts.map(content => ({ content, task_type: task })), parameters: { outputDimensionality: EMBED_DIM } }),
    });
    if (!res.ok) throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return (await res.json()).predictions.map(p => p.embeddings.values);
  }
  return {
    model,
    /** Vectors for `texts` (null where a text is empty or the call failed). task: "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY". */
    async embed(texts, { task = "RETRIEVAL_DOCUMENT" } = {}) {
      const out = texts.map(() => null);
      const todo = texts.map((t, i) => [String(t ?? "").trim().slice(0, 4000), i]).filter(([t]) => t);
      for (let k = 0; k < todo.length; k += BATCH) {
        const part = todo.slice(k, k + BATCH);
        try {
          const vectors = await batch(part.map(([t]) => t), task);
          part.forEach(([, i], j) => { out[i] = vectors[j] ?? null; });
        } catch (err) { onError(err); }
      }
      return out;
    },
  };
}

/** pgvector's text form: "[0.1,0.2,…]". */
export const toVector = v => (v ? `[${v.join(",")}]` : null);
