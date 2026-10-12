import { test } from "node:test";
import assert from "node:assert/strict";
import { streamTurn } from "../src/engine/gemini.mjs";

// A fake Gemini: answers every request with these SSE chunks and remembers the request body.
function fakeGemini(chunks) {
  const seen = [];
  const endpoint = { url: (model, method) => `https://gemini.test/${model}:${method}`, headers: async () => ({ "content-type": "application/json" }) };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    const text = chunks.map(c => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");
    return new Response(new ReadableStream({ start(ctl) { ctl.enqueue(new TextEncoder().encode(text)); ctl.close(); } }), { status: 200 });
  };
  return { endpoint, seen, restore: () => { globalThis.fetch = original; } };
}
const part = p => ({ candidates: [{ content: { role: "model", parts: [p] } }] });

test("text, tool call and end: thought text never comes out, the signature is kept", async () => {
  const g = fakeGemini([
    part({ text: "secret reasoning", thought: true }),
    part({ text: "HEARD: Yes.\nLANG: en\nNEXT: listen\n\nOn it." }),
    part({ functionCall: { id: "call_1", name: "order_execute", args: {} }, thoughtSignature: "SIG123" }),
    { ...part({ text: "" }), usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } },
  ]);
  try {
    const events = [];
    let usage = null;
    for await (const ev of streamTurn({ endpoint: g.endpoint, model: "gemini-3.5-flash", system: "s", history: [{ role: "user", text: "hi" }], text: "yes", tools: [{ name: "order_execute", description: "d", parameters: { type: "OBJECT", properties: {} } }], onUsage: u => { usage = u; } })) events.push(ev);
    assert.deepEqual(events.slice(0, 2), [
      { type: "text", text: "HEARD: Yes.\nLANG: en\nNEXT: listen\n\nOn it." },
      { type: "call", call: { id: "call_1", name: "order_execute", args: {} } },
    ]);
    const end = events.at(-1);
    assert.equal(end.type, "end");
    assert.equal(end.parts.find(p => p.functionCall).thoughtSignature, "SIG123", "the follow-up needs the raw part back");
    assert.equal(usage.promptTokenCount, 10);
    const body = g.seen[0].body;
    assert.deepEqual(body.tools, [{ functionDeclarations: [{ name: "order_execute", description: "d", parameters: { type: "OBJECT", properties: {} } }] }]);
    assert.equal(body.toolConfig.functionCallingConfig.mode, "AUTO");
    assert.deepEqual(body.contents.map(c => c.role), ["user", "user"]);
  } finally { g.restore(); }
});

test("no tools: no tools in the request; contents replaces history and audio", async () => {
  const g = fakeGemini([part({ text: "Done." })]);
  try {
    const contents = [{ role: "user", parts: [{ text: "a" }] }, { role: "model", parts: [{ functionCall: { name: "x", args: {} }, thoughtSignature: "S" }] }, { role: "user", parts: [{ functionResponse: { name: "x", response: { ok: true } } }] }];
    const events = [];
    for await (const ev of streamTurn({ endpoint: g.endpoint, model: "m", system: "s", contents, toolMode: "NONE" })) events.push(ev);
    assert.equal(events[0].text, "Done.");
    assert.equal(g.seen[0].body.tools, undefined);
    assert.deepEqual(g.seen[0].body.contents, contents);
  } finally { g.restore(); }
});

test("a follow-up with tools declared but calling switched off", async () => {
  const g = fakeGemini([part({ text: "ok" })]);
  try {
    for await (const _ of streamTurn({ endpoint: g.endpoint, model: "m", system: "s", contents: [], tools: [{ name: "t", description: "d" }], toolMode: "NONE" })) { /* drain */ }
    assert.equal(g.seen[0].body.toolConfig.functionCallingConfig.mode, "NONE");
  } finally { g.restore(); }
});

test("hedged extraction: a hung first model doesn't cost the whole timeout", async () => {
  const { extractJsonResilient } = await import("../src/engine/gemini.mjs");
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push(url);
    if (url.includes("slow")) return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }] }), { status: 200 });
  };
  try {
    const endpoint = { url: m => `https://gemini.test/${m}`, headers: async () => ({}) };
    const t0 = performance.now();
    const out = await extractJsonResilient({ endpoint, models: ["slow", "fast"], hedgeMs: 50, timeoutMs: 5000, system: "s", prompt: "p", schema: {} });
    assert.deepEqual(out, { ok: true });
    assert.ok(performance.now() - t0 < 1000, "answered by the hedge, not after the timeout");
    assert.equal(asked.length, 2);
  } finally { globalThis.fetch = original; }
});
