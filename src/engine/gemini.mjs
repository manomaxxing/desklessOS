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

/** The caller's turn as a Gemini content: his audio (or a text cue). */
export function userContent({ audio, text, extra }) {
  const parts = audio
    ? [{ inline_data: { mime_type: "audio/wav", data: audio.toString("base64") } }, { text: extra ?? "(The caller is speaking in the audio above.)" }]
    : [{ text: text ?? "" }];
  return { role: "user", parts };
}
export const historyContents = history => history.map(t => ({ role: t.role, parts: [{ text: t.text }] }));

// Yields, as the answer streams:
//   { type: "text", text }                     reply text (thought parts are never yielded)
//   { type: "call", call: { id, name, args } } a native tool call (`tools` = function declarations)
//   { type: "end", parts }                     every part as received, thoughtSignature included:
//                                              Gemini 3 rejects the tool follow-up without it
// `contents` (raw Gemini contents) replaces history + audio/text: the follow-up after a tool.
export async function* streamTurn({ endpoint, model, system, history = [], audio, text, extra, contents, tools, toolMode = "AUTO", signal, thinkingBudget = 0, onUsage = () => {} }) {
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
  const decoder = new TextDecoder();
  const parts = [];
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
      for (const part of payload?.candidates?.[0]?.content?.parts ?? []) {
        parts.push(part);
        if (part.functionCall) yield { type: "call", call: { id: part.functionCall.id ?? null, name: part.functionCall.name, args: part.functionCall.args ?? {} } };
        else if (part.text && !part.thought) yield { type: "text", text: part.text };
      }
    }
  }
  if (usage) onUsage(usage);
  yield { type: "end", parts };
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
// `hedgeMs`: if the first model hasn't answered by then, the next one races it
// (a hung request then costs seconds, not the whole timeout); the first answer wins.
// `retries429`: when every model answered 429 (quota), wait and go again (1.5 s, 4 s, …);
// only for work that can wait (the admin's planner, background notes), never a live turn.
export async function extractJsonResilient({ retries429 = 0, ...args }) {
  for (let attempt = 0; ; attempt++) {
    try { return await extractOnce(args); } catch (err) {
      if (attempt >= retries429 || !/\b429\b/.test(err.message)) throw err;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1) ** 1.5));
    }
  }
}

async function extractOnce({ models, timeoutMs = 15000, hedgeMs = 0, ...args }) {
  const list = [...new Set(models.filter(Boolean))];
  if (!hedgeMs) {
    let last;
    for (const model of list) {
      try { return await extractJson({ ...args, model, timeoutMs }); } catch (err) { last = err; }
    }
    throw last;
  }
  return new Promise((resolve, reject) => {
    const ctls = [];
    let started = 0;
    let failed = 0;
    let settled = false;
    let timer = null;
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

// `think`: let the model think first (offline work like the admin's planner, where seconds don't matter).
export async function extractJson({ endpoint, model, system, prompt, schema, signal, timeoutMs = 30000, think = false, onUsage = () => {} }) {
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
  const body = await response.json();
  if (body?.usageMetadata) onUsage(body.usageMetadata);
  const text = body?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") ?? "";
  return JSON.parse(text);
}
