// Gemini Live against a fake Gemini socket: the call is saved as it goes, the model's
// end_call ends it with its last state, and a dropped connection hands it to the cascade.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createLiveSession } from "../src/engine/live-session.ts";
import { loadSkillFromTemplates } from "../src/skills/from-templates.ts";

const skill = loadSkillFromTemplates("pilot");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const endpoint = { door: "test", url: (m, method) => `https://gemini.test/${m}:${method}`, headers: async () => ({ authorization: "Bearer t", "content-type": "application/json" }) };

/** A Gemini Live socket the test drives: what the session sent, and events to emit at it. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  url = "";
  options: { headers: Record<string, string> } = { headers: {} };
  send(d: string) { this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; }
}
const fakeGemini = () => new FakeSocket();
function harness(extra = {}) {
  let sock = null;
  const frames = [];
  const checkpoints = [];
  const ends = [];
  const fatals = [];
  const session = createLiveSession({
    send: f => frames.push(f), skill, endpoint, extractModel: "gemini-2.5-flash", config: { liveModel: "vertex-eu:gemini-3.8-live" },
    memory: { context: "", hidden: 0, search: async () => [], checkpoint: async s => { checkpoints.push(s); } },
    onEnd: async (reason, final) => { ends.push({ reason, final }); },
    onFatal: f => fatals.push(f),
    openSocket: (url, options) => { sock = fakeGemini(); sock.url = url; sock.options = options; return sock; },
    ...extra,
  });
  return { session, frames, checkpoints, ends, fatals, sock: () => sock };
}
const say = text => ({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(9600).toString("base64") } }] }, outputTranscription: { text } } });

test("Live: setup over the EU door, turns saved as they happen, end_call ends the call with its last state", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => (String(url).startsWith("https://gemini.test/")
    ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ mode: "capture", customer_name: "Herr Huber", summary: "Küche Huber." }) }] } }] }))
    : original(url));
  try {
    const h = harness();
    h.session.handle({ type: "call_connected", call_id: "c1", from: "+4915100000000", to: "+4930000000", formats: {} });
    await sleep(10);
    const g = h.sock();
    assert.match(g.url, /aiplatform\.eu\.rep\.googleapis\.com/, "vertex-eu: audio stays in the EU");
    assert.equal(g.options.headers.Authorization, "Bearer t");
    g.emit("open");
    assert.match(g.sent[0].setup.systemInstruction.parts[0].text, /call end_call/);
    assert.deepEqual(g.sent[0].setup.tools[0].functionDeclarations.map(d => d.name), ["end_call"], "memory_search only when memory hides someone");
    g.emit("message", JSON.stringify({ setupComplete: {} }));
    assert.ok(g.sent.at(-1).realtimeInput.text, "asked to greet");

    g.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text: "Ich komm grad vom Herrn Huber, Küche neu." } } }));
    g.emit("message", JSON.stringify(say("Notiert, Küche Huber.")));
    g.emit("message", JSON.stringify({ serverContent: { turnComplete: true } }));
    await sleep(50);
    assert.ok(h.frames.some(f => f.type === "media"), "his answer is played");
    assert.deepEqual(h.checkpoints.at(-1).turns.map(t => t.role), ["user", "model"], "saved as it goes");
    assert.equal(h.checkpoints.at(-1).extraction.customer_name, "Herr Huber", "with the note so far");

    g.emit("message", JSON.stringify({ toolCall: { functionCalls: [{ id: "f1", name: "end_call", args: {} }] } }));
    await sleep(20);
    const bye = h.frames.find(f => f.type === "mark" && f.name.startsWith("bye"));
    assert.ok(bye, "a goodbye mark, then the hang-up once it's played");
    h.session.handle({ type: "mark", name: bye.name });
    await sleep(20);
    assert.ok(h.frames.some(f => f.type === "end_call"));
    assert.equal(h.ends.length, 1);
    assert.equal(h.ends[0].reason, "agent_hangup");
    assert.deepEqual(h.ends[0].final.turns.map(t => t.text), ["Ich komm grad vom Herrn Huber, Küche neu.", "Notiert, Küche Huber."]);
    assert.equal(h.ends[0].final.extractionTurns, 2);
    assert.equal(g.readyState, 3, "the Gemini socket is closed");
  } finally { globalThis.fetch = original; }
});

test("Live: a dropped Gemini connection hands the call to the cascade, without ending it", async () => {
  const h = harness();
  h.session.handle({ type: "call_connected", call_id: "c2", from: "+4915100000000", formats: {} });
  await sleep(10);
  h.sock().emit("close", 1011, Buffer.from("internal error"));
  assert.equal(h.fatals.length, 1);
  assert.match(h.fatals[0].reason, /closed 1011/);
  assert.equal(h.ends.length, 0, "the call goes on");
  h.session.abandon();
  assert.equal(h.ends.length, 0);
});
