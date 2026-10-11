// Gemini 3.x ignores thinkingBudget: 0 and takes thinkingLevel instead (MINIMAL
// measured 1.4–1.7 s to first text vs 1.6–3.7 s with the budget setting).
export function thinkingConfig(model, budget = 0) {
  return /^gemini-3/.test(model) ? { thinkingLevel: budget ? "LOW" : "MINIMAL" } : { thinkingBudget: budget };
}

// The two Gemini calls.
//  Fast path: one streamed call per turn. The caller's audio goes in as-is, so
//  hearing and answering are the same call (no separate speech-to-text step).
//  Slow path: a JSON-schema call that keeps the structured note up to date.
//  It never sits between the caller and the next sound.

export async function* streamTurn({ endpoint, model, system, history, audio, text, extra, signal, thinkingBudget = 0, onUsage = () => {} }) {
  const current = audio
    ? [{ inline_data: { mime_type: "audio/wav", data: audio.toString("base64") } }, { text: extra ?? "(The caller is speaking in the audio above.)" }]
    : [{ text: text ?? "" }];
  const response = await fetch(endpoint.url(model, "streamGenerateContent"), {
    method: "POST",
    headers: await endpoint.headers(),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [...history.map(t => ({ role: t.role, parts: [{ text: t.text }] })), { role: "user", parts: current }],
      generationConfig: { temperature: 0.6, maxOutputTokens: 1200, thinkingConfig: thinkingConfig(model, thinkingBudget) },
    }),
  });
  if (!response.ok) throw new Error(`gemini ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const decoder = new TextDecoder();
  let buf = "";
  let usage = null;
  for await (const chunk of response.body) {
    buf += decoder.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payload = JSON.parse(line.slice(5));
      if (payload?.usageMetadata) usage = payload.usageMetadata;
      const piece = payload?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") ?? "";
      if (piece) yield piece;
    }
  }
  if (usage) onUsage(usage);
}

// A one-token request so the model's first real turn isn't the cold one.
export function warmModel({ endpoint, model }) {
  return endpoint.headers()
    .then(headers => fetch(endpoint.url(model, "generateContent"), {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "ok" }] }], generationConfig: { maxOutputTokens: 1, thinkingConfig: thinkingConfig(model) } }),
    }))
    .then(res => res.arrayBuffer())
    .catch(() => {});
}

// Background JSON calls: try each model with a timeout before giving up.
export async function extractJsonResilient({ models, timeoutMs = 15000, ...args }) {
  let last;
  for (const model of [...new Set(models.filter(Boolean))]) {
    try { return await extractJson({ ...args, model, timeoutMs }); } catch (err) { last = err; }
  }
  throw last;
}

export async function extractJson({ endpoint, model, system, prompt, schema, signal, timeoutMs = 30000, onUsage = () => {} }) {
  const response = await fetch(endpoint.url(model, "generateContent"), {
    method: "POST",
    headers: await endpoint.headers(),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 2000,
        responseMimeType: "application/json",
        responseSchema: schema,
        thinkingConfig: thinkingConfig(model),
      },
    }),
  });
  if (!response.ok) throw new Error(`gemini extract ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const body = await response.json();
  if (body?.usageMetadata) onUsage(body.usageMetadata);
  const text = body?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") ?? "";
  return JSON.parse(text);
}
