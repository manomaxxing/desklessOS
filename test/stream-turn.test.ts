import { test } from "node:test";
import assert from "node:assert/strict";
import { streamTurn, extractJsonResilient, thinkingConfig, warmModel, transcribe } from "../src/engine/gemini.ts";
import { geminiEndpoint } from "../src/engine/gemini-endpoint.ts";
import type { Usage } from "../src/types/gemini.ts";

const original = globalThis.fetch;
const fakeFetch = (fn: (url: string, init: RequestInit) => Promise<Response>) => { globalThis.fetch = (url, init) => fn(String(url), init ?? {}); };
const restore = () => { globalThis.fetch = original; };
const endpointFor = (url = (model: string, method: string) => `https://gemini.test/${model}:${method}`) => ({ door: "test", url, headers: async () => ({ "content-type": "application/json" }) });
const bodyOf = (init: RequestInit) => JSON.parse(String(init.body));
const sse = (text: string) => new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode(text)); ctl.close(); } }), { status: 200 });

// What the tests read back from a request body.
interface Sent {
  tools?: unknown;
  toolConfig?: { functionCallingConfig: { mode: string } };
  contents: { role: string }[];
}

// A fake Gemini: answers every request with these SSE chunks and remembers the request body.
function fakeGemini(chunks: unknown[]) {
  const seen: { url: string; body: Sent }[] = [];
  fakeFetch(async (url, init) => {
    seen.push({ url, body: bodyOf(init) });
    return sse(chunks.map(c => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""));
  });
  return { endpoint: endpointFor(), seen };
}
const part = (p: Record<string, unknown>) => ({ candidates: [{ content: { role: "model", parts: [p] } }] });
const drain = async <T>(events: AsyncIterable<T>) => { const out: T[] = []; for await (const ev of events) out.push(ev); return out; };

test("text, tool call and end: thought text never comes out, the signature is kept", async () => {
  const g = fakeGemini([
    part({ text: "secret reasoning", thought: true }),
    part({ text: "HEARD: Yes.\nLANG: en\nNEXT: listen\n\nOn it." }),
    part({ functionCall: { id: "call_1", name: "order_execute", args: {} }, thoughtSignature: "SIG123" }),
    { ...part({ text: "" }), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
  ]);
  try {
    const usage: Usage[] = [];
    const events = await drain(streamTurn({ endpoint: g.endpoint, model: "gemini-3.5-flash", system: "s", history: [{ role: "user", text: "hi" }], text: "yes", tools: [{ name: "order_execute", description: "d", parameters: { type: "OBJECT", properties: {} } }], onUsage: u => usage.push(u) }));
    assert.deepEqual(events.slice(0, 2), [
      { type: "text", text: "HEARD: Yes.\nLANG: en\nNEXT: listen\n\nOn it." },
      { type: "call", call: { id: "call_1", name: "order_execute", args: {} } },
    ]);
    const end = events.at(-1);
    assert.ok(end?.type === "end");
    assert.equal(end.parts.find(p => p.functionCall)?.thoughtSignature, "SIG123", "the follow-up needs the raw part back");
    assert.equal(usage[0]?.promptTokenCount, 10);
    const body = g.seen[0].body;
    assert.deepEqual(body.tools, [{ functionDeclarations: [{ name: "order_execute", description: "d", parameters: { type: "OBJECT", properties: {} } }] }]);
    assert.equal(body.toolConfig?.functionCallingConfig.mode, "AUTO");
    assert.deepEqual(body.contents.map(c => c.role), ["user", "user"]);
  } finally { restore(); }
});

test("no tools: no tools in the request; contents replaces history and audio", async () => {
  const g = fakeGemini([part({ text: "Done." })]);
  try {
    const contents = [{ role: "user", parts: [{ text: "a" }] }, { role: "model", parts: [{ functionCall: { name: "x", args: {} }, thoughtSignature: "S" }] }, { role: "user", parts: [{ functionResponse: { name: "x", response: { ok: true } } }] }];
    const events = await drain(streamTurn({ endpoint: g.endpoint, model: "m", system: "s", contents, toolMode: "NONE" }));
    assert.deepEqual(events[0], { type: "text", text: "Done." });
    assert.equal(g.seen[0].body.tools, undefined);
    assert.deepEqual(g.seen[0].body.contents, contents);
  } finally { restore(); }
});

test("a follow-up with tools declared but calling switched off", async () => {
  const g = fakeGemini([part({ text: "ok" })]);
  try {
    await drain(streamTurn({ endpoint: g.endpoint, model: "m", system: "s", contents: [], tools: [{ name: "t", description: "d", parameters: { type: "OBJECT" } }], toolMode: "NONE" }));
    assert.equal(g.seen[0].body.toolConfig?.functionCallingConfig.mode, "NONE");
  } finally { restore(); }
});

test("a stream that ends without its last newline still gives its last part and the usage", async () => {
  fakeFetch(async () => sse(`data: ${JSON.stringify(part({ text: "Alles klar." }))}\r\n\r\ndata: ${JSON.stringify({ ...part({ text: " Bis dann." }), usageMetadata: { promptTokenCount: 7 } })}`));
  try {
    const usage: Usage[] = [];
    const events = await drain(streamTurn({ endpoint: endpointFor(), model: "m", system: "s", text: "x", onUsage: u => usage.push(u) }));
    assert.deepEqual(events.flatMap(e => (e.type === "text" ? [e.text] : [])), ["Alles klar.", " Bis dann."]);
    assert.equal(usage[0]?.promptTokenCount, 7);
  } finally { restore(); }
});

test("hedged extraction: a hung first model doesn't cost the whole timeout", async () => {
  const asked: string[] = [];
  fakeFetch(async (url, init) => {
    asked.push(url);
    if (url.includes("slow")) return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }] }), { status: 200 });
  });
  try {
    const t0 = performance.now();
    const out = await extractJsonResilient({ endpoint: endpointFor(m => `https://gemini.test/${m}`), models: ["slow", "fast"], hedgeMs: 50, timeoutMs: 5000, system: "s", prompt: "p", schema: { type: "OBJECT" } });
    assert.deepEqual(out, { ok: true });
    assert.ok(performance.now() - t0 < 1000, "answered by the hedge, not after the timeout");
    assert.equal(asked.length, 2);
  } finally { restore(); }
});

test("extraction with no model to ask says so, hedged or not (it threw undefined, or hung)", async () => {
  fakeFetch(async () => { throw new Error("nothing should be asked"); });
  try {
    const args = { endpoint: endpointFor(), system: "s", prompt: "p", schema: { type: "OBJECT" as const } };
    await assert.rejects(extractJsonResilient({ ...args, models: [undefined, ""] }), /no model/);
    await assert.rejects(extractJsonResilient({ ...args, models: [null], hedgeMs: 50, retries429: 1 }), /no model/);
  } finally { restore(); }
});

test("warm-up and the transcript check never fail, whatever the endpoint does", async () => {
  fakeFetch(async () => { throw new TypeError("fetch failed"); });
  try {
    const broken = { ...endpointFor(), headers: () => { throw new Error("no credentials"); } };
    assert.equal(await warmModel({ endpoint: broken, model: "m" }), undefined, "a headers() that throws at once");
    assert.equal(await warmModel({ endpoint: endpointFor(), model: "m" }), undefined, "the network down");
    assert.equal(await transcribe({ endpoint: endpointFor(), model: "m", audio: Buffer.alloc(10) }), "");
    fakeFetch(async () => new Response("{not json", { status: 200 }));
    assert.equal(await transcribe({ endpoint: endpointFor(), model: "m", audio: Buffer.alloc(10) }), "");
  } finally { restore(); }
});

test("a Cloud Run token without expires_in is reused, not fetched again for every request", async () => {
  let fetched = 0;
  fakeFetch(async url => { fetched++; assert.match(url, /metadata\.google\.internal/); return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 }); });
  try {
    const endpoint = geminiEndpoint({ GOOGLE_CLOUD_PROJECT: "p", K_SERVICE: "svc" });
    assert.ok(endpoint);
    assert.equal((await endpoint.headers()).authorization, "Bearer tok");
    await endpoint.headers();
    assert.equal(fetched, 1);
  } finally { restore(); }
});

test("thinking: MINIMAL up to Gemini 3.5, LOW from 3.6 (MINIMAL is refused there), a budget before 3", () => {
  assert.deepEqual(thinkingConfig("gemini-3.5-flash"), { thinkingLevel: "MINIMAL" });
  assert.deepEqual(thinkingConfig("gemini-3.8-flash"), { thinkingLevel: "LOW" });
  assert.deepEqual(thinkingConfig("gemini-3.5-flash", 512), { thinkingLevel: "LOW" });
  assert.deepEqual(thinkingConfig("gemini-2.5-flash"), { thinkingBudget: 0 });
});
