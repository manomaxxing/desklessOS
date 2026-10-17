// The voice engine (src/engine/session.ts) end to end, offline and in fake time: a scripted
// caller (tone = speech, zeros = silence, in 20 ms frames), scripted Gemini answers (some of
// them stalling), a fake Fish and a fake clock, so 0.35 s pauses, 0.8 s ends of turn, 1.6 s
// hedges and 2.5 s "mhm"s run in milliseconds. It pins what the caller hears and when.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCallSession, type EngineMemory } from "../src/engine/session.ts";
import { defineTool, type CallTool } from "../src/tools/registry.ts";
import { loadSkillFromTemplates } from "../src/skills/from-templates.ts";

const skill = loadSkillFromTemplates("pilot");
const endpoint = { door: "test", url: (m, method) => `https://gemini.test/${m}:${method}`, headers: async () => ({ "content-type": "application/json" }) };
const PRIMARY = "gemini-3.5-flash";

// ---------- time ----------
const turnMacrotasks = () => new Promise(r => setImmediate(r));
async function settle() { for (let i = 0; i < 30; i++) await turnMacrotasks(); }
function fakeClock() {
  let t = 0;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms = 0) { const id = ++seq; timers.set(id, { at: t + Math.max(0, ms), fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    /** Moves time on by ms, running every timer that falls due, in order, letting promises settle between. */
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        await settle();
        let due = null;
        for (const [id, x] of timers) if (x.at <= end && (!due || x.at < due[1].at)) due = [id, x];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
      await settle();
    },
  };
}

// ---------- audio ----------
const FRAME_MS = 20;
function tone(ms) {
  const n = 16 * ms;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 200 * i) / 16000) * 0.2 * 32767), i * 2);
  return buf;
}
const pcm = ms => Buffer.alloc(32 * ms, 1); // a quiet clip for the agent's voice

// ---------- Gemini, scripted ----------
// Each streamGenerateContent call takes the next script: { text, stallMs, status, stallAfterFirst }
// (stallMs: fake time before its first byte; status: an HTTP error; stallAfterFirst: the first chunk,
// then nothing until it's aborted). Extraction calls (generateContent) answer with `note`.
/** One scripted answer: its text, or a stall, an HTTP error, a stream that stops after its first chunk. */
interface Script { text?: string; stallMs?: number; status?: number; stallAfterFirst?: boolean; call?: { name: string; args?: Record<string, unknown> } }
function scriptedGemini(clock, { replies = [], note = { mode: "unclear" } }: { replies?: Script[]; note?: object } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.startsWith("https://gemini.test/")) return original(url, init);
    const [model, method] = u.slice("https://gemini.test/".length).split("?")[0].split(":");
    if (method === "generateContent") {
      const body = JSON.parse(String(init.body ?? "{}"));
      const extraction = Boolean(body.generationConfig?.responseSchema);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: extraction ? JSON.stringify(note) : "ok" }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }));
    }
    const script: Script = replies[calls.length] ?? { text: "HEARD: \nLANG: de\nNEXT: listen\n\nOkay." };
    const body = JSON.parse(String(init.body));
    calls.push({ model, script, audioBytes: (body.contents.at(-1).parts.find(p => p.inline_data)?.inline_data.data.length ?? 0) * 0.75, at: clock.now() });
    if (script.status) return new Response("{\"error\":{\"message\":\"scripted failure\"}}", { status: script.status });
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const aborted = new Promise(r => init.signal?.addEventListener("abort", r, { once: true }));
        if (script.stallMs) await Promise.race([new Promise(r => clock.setTimeout(r, script.stallMs)), aborted]);
        if (init.signal?.aborted) { controller.error(new Error("aborted")); return; }
        const parts = [{ text: script.text }, ...(script.call ? [{ functionCall: { name: script.call.name, args: script.call.args ?? {} } }] : [])];
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ candidates: [{ content: { parts } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 10 } })}\n\n`));
        if (script.stallAfterFirst) { await aborted; controller.error(new Error("aborted")); return; }
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const fish = { model: "s2.1-pro-free", stream: Object.assign(async function* (text) { yield pcm(Math.min(2000, 40 * text.length)); }, { lastFirstByteMs: 5 }) };
const assets = { de: { greeting: pcm(300), oops: [pcm(200)], backchannel: pcm(150), fillers: [pcm(150)], working: pcm(200), looking: pcm(200), wrapUp: pcm(200), outboundGreeting: pcm(200), firstGreeting: pcm(300) } };

/** A call on the engine: frames out, events, and the caller's side (speak, be quiet, hear marks played back). */
function call({ replies = [], note = undefined, ackMarks = true, assets: assetsOver = {}, tools = [], memory = null }: { replies?: Script[]; note?: object; ackMarks?: boolean; assets?: object; tools?: CallTool[]; memory?: EngineMemory | null } = {}) {
  const clock = fakeClock();
  const gemini = scriptedGemini(clock, { replies, note });
  const frames = [];
  const events = [];
  const ends = [];
  let session = null;
  // The phone plays what it gets, in order, and hands each mark back once the audio before it
  // has played (like Dial); "clear" drops what's queued.
  let playUntil = 0;
  const queued = new Set();
  const send = f => {
    frames.push({ ...f, at: clock.now() });
    if (f.type === "media") playUntil = Math.max(playUntil, clock.now()) + Buffer.from(f.payload, "base64").length / 32;
    if (f.type === "clear") { playUntil = clock.now(); for (const id of queued) clock.clearTimeout(id); queued.clear(); }
    if (f.type === "mark" && ackMarks) {
      const id = clock.setTimeout(() => { queued.delete(id); session?.handle({ type: "mark", name: f.name }); }, Math.max(0, playUntil - clock.now()) + 10);
      queued.add(id);
    }
  };
  session = createCallSession({
    send, skill, endpoint, model: PRIMARY, fish, assets: { de: { ...assets.de, ...assetsOver } }, clock, config: { mask: "none" }, tools, memory,
    onEvent: e => events.push({ ...e, at: clock.now() }), onEnd: async (reason, final) => { ends.push({ reason, final }); },
  });
  const feed = async (buf) => {
    for (let i = 0; i < buf.length; i += 32 * FRAME_MS) {
      session.handle({ type: "media", payload: buf.subarray(i, i + 32 * FRAME_MS).toString("base64") });
      await clock.advance(FRAME_MS);
    }
  };
  return {
    clock, gemini, frames, events, ends, session,
    connect: async () => { session.handle({ type: "call_connected", call_id: "c-test", from: "+4915100000000", to: "+4930000000", formats: {} }); await clock.advance(500); },
    speak: ms => feed(tone(ms)),
    quiet: ms => feed(Buffer.alloc(32 * ms)),
    wait: ms => clock.advance(ms),
    said: () => events.filter(e => e.event === "say" && !e.note).map(e => e.text),
    kinds: () => events.map(e => e.event),
    done: async () => { await session.close("test"); gemini.restore(); },
  };
}
const reply = (heard, next, text, extra = {}) => ({ text: `HEARD: ${heard}\nLANG: de\nNEXT: ${next}\n\n${text}`, ...extra });

test("a plain turn: thought about at his pause, played when the pause ends his turn", async () => {
  const c = call({ replies: [reply("Ich komm grad vom Huber.", "listen", "Okay, erzähl.")] });
  try {
    await c.connect();
    await c.speak(1200);
    await c.quiet(1200);
    await c.wait(500);
    assert.deepEqual(c.said(), ["Okay, erzähl."]);
    const spec = c.events.find(e => e.event === "speculate");
    const used = c.events.find(e => e.event === "speculation_used");
    assert.ok(spec && used, "started at the pause, used at the end of his turn");
    assert.ok(used.at - spec.at >= 400 && used.at - spec.at <= 500, `the pause (0.35 s) to the end of turn (0.8 s): ${used.at - spec.at} ms`);
    assert.equal(c.gemini.calls.length, 1, "one model call");
    const lat = c.events.find(e => e.event === "latency");
    assert.equal(lat.speculative, true);
    assert.ok(c.frames.some(f => f.type === "media" && f.at >= used.at), "his answer's audio goes out after the end of his turn, not before");
    assert.ok(!c.frames.some(f => f.type === "media" && f.at > spec.at && f.at < used.at), "nothing is heard while he pauses");
  } finally { await c.done(); }
});

test("he goes on after a pause: what was prepared is dropped unheard, and both parts are answered as one", async () => {
  const c = call({ replies: [reply("Ich komm grad", "listen", "Erste Antwort."), reply("Ich komm grad vom Huber, Bad neu.", "listen", "Bad beim Huber, okay.")] });
  try {
    await c.connect();
    await c.speak(1000);
    await c.quiet(500); // a pause inside the sentence: thought about…
    await c.speak(1000); // …and he goes on
    await c.quiet(1200);
    await c.wait(500);
    assert.deepEqual(c.events.filter(e => e.event.startsWith("specul")).map(e => e.event), ["speculate", "speculation_dropped", "speculate", "speculation_used"]);
    assert.deepEqual(c.said(), ["Bad beim Huber, okay."], "the dropped answer is never heard");
    assert.equal(c.gemini.calls.length, 2);
    assert.ok(c.gemini.calls[1].audioBytes > c.gemini.calls[0].audioBytes * 1.5, "the second request has all of his speech");
  } finally { await c.done(); }
});

test("he stops mid-thought: NEXT wait keeps quiet, a soft mhm after 2.5 s, the prepared answer at 5 s", async () => {
  const c = call({ replies: [reply("Und dann", "wait", ""), reply("Und dann", "listen", "Alles klar.")] });
  try {
    await c.connect();
    await c.speak(1000);
    const lastVoice = c.clock.now();
    await c.quiet(1000);
    await c.wait(6000);
    const mhm = c.events.find(e => e.event === "backchannel");
    const done = c.events.find(e => e.event === "nudge" && e.kind === "dictation_done");
    assert.ok(mhm && Math.abs(mhm.at - lastVoice - 2500) <= 60, `mhm 2.5 s after his last word: ${mhm && mhm.at - lastVoice}`);
    assert.ok(done && Math.abs(done.at - lastVoice - 5000) <= 60, `the answer at 5 s: ${done && done.at - lastVoice}`);
    assert.deepEqual(c.said(), ["Alles klar."]);
  } finally { await c.done(); }
});

test("Gemini stalls: the same model again after 1.6 s answers; the stalled one is cancelled", async () => {
  const c = call({ replies: [reply("Hallo", "listen", "Stalled.", { stallMs: 10000 }), reply("Hallo", "listen", "Da bin ich.")] });
  try {
    await c.connect();
    await c.speak(800);
    await c.quiet(1000);
    await c.wait(3000);
    const retry = c.events.find(e => e.event === "retry");
    assert.ok(retry, "a second request");
    assert.equal(retry.next, PRIMARY, "the same model first, not the fallback");
    assert.equal(c.gemini.calls[1].at - c.gemini.calls[0].at, 1600, "after 1.6 s");
    assert.deepEqual(c.said(), ["Da bin ich."]);
    assert.equal(c.events.find(e => e.event === "recovered")?.attempt, 2);
  } finally { await c.done(); }
});

test("a goodbye to garbage (\"00:00\"): no hang-up, a short \"say that again?\" instead", async () => {
  // At his pause the held answer is misheard: dropped quietly, his turn heard again the usual way;
  // misheard again, he hears "say that again?".
  const c = call({ replies: [reply("00:00", "hangup", "Tschüss!"), reply("00:00", "hangup", "Tschüss!")] });
  try {
    await c.connect();
    await c.speak(600);
    await c.quiet(1000);
    await c.wait(1500);
    assert.ok(!c.frames.some(f => f.type === "end_call"), "the call goes on");
    assert.equal(c.gemini.calls.length, 2, "the held one dropped, his turn heard again");
    assert.ok(c.events.some(e => e.event === "say" && /not spoken: a goodbye to words nobody understood/.test(e.note ?? "")));
    assert.ok(c.frames.some(f => f.type === "mark" && f.name.startsWith("oops-")), "the oops clip plays");
    assert.deepEqual(c.said(), []);
  } finally { await c.done(); }
});

test("a real goodbye hangs up once the goodbye has played", async () => {
  const c = call({ replies: [reply("Tschüss!", "hangup", "Tschüss, bis bald!")] });
  try {
    await c.connect();
    await c.speak(600);
    await c.quiet(1000);
    await c.wait(1500);
    assert.deepEqual(c.said(), ["Tschüss, bis bald!"]);
    assert.ok(c.frames.some(f => f.type === "end_call"), "hung up after the bye mark came back");
    assert.equal(c.ends[0]?.reason, "agent_hangup");
  } finally { await c.done(); }
});

test("a false start: he talks again right after the agent started, so both parts are answered together", async () => {
  const c = call({ replies: [reply("Familie Huber", "listen", "Huber, okay. Was soll gemacht werden?"), reply("Familie Huber in Allensbach", "listen", "Huber in Allensbach, okay.")] });
  try {
    await c.connect();
    await c.speak(800);
    await c.quiet(900); // his turn ends, the agent starts…
    await c.speak(600); // …and he goes on within 1.5 s
    await c.quiet(1200);
    await c.wait(800);
    assert.ok(c.events.some(e => e.event === "barge_in" && e.falseStart), "a false start");
    assert.ok(c.events.some(e => e.event === "false_start"));
    assert.equal(c.said().at(-1), "Huber in Allensbach, okay.");
    assert.ok(c.frames.some(f => f.type === "clear"), "the first answer is cut off");
  } finally { await c.done(); }
});

test("a held answer that fails at his pause is never heard: undone quietly, his turn answered the usual way", async () => {
  const fail = { status: 500 };
  const c = call({ replies: [fail, fail, fail, fail, reply("Hallo Toni", "listen", "Hallo, was gibt's?")] });
  try {
    await c.connect();
    await c.speak(1000);
    await c.quiet(1200);
    await c.wait(800);
    assert.ok(!c.frames.some(f => f.type === "mark" && f.name.startsWith("oops-")), "no sorry over his own sentence");
    assert.deepEqual(c.said(), ["Hallo, was gibt's?"]);
  } finally { await c.done(); }
});

test("Gemini stalls mid-answer: after 4 s the said part stays, he hears a sorry; no 30 s of dead air", async () => {
  const c = call({ replies: [reply("Erzähl", "listen", "Erster Satz ist schon da. Und dann", { stallAfterFirst: true })] });
  try {
    await c.connect();
    await c.speak(800);
    await c.quiet(1000);
    await c.wait(6000);
    assert.ok(c.events.some(e => e.event === "error" && /stalled/.test(e.message)), "the stall is an error");
    assert.ok(c.said().includes("Erster Satz ist schon da."), "the finished sentence was spoken");
    assert.ok(c.frames.some(f => f.type === "mark" && f.name.startsWith("oops-")), "then the sorry");
    const stall = c.events.find(e => e.event === "error");
    const sorry = c.frames.find(f => f.type === "mark" && f.name.startsWith("oops-"));
    assert.ok(sorry.at - stall.at < 3000, "the sorry comes promptly, not after the 30 s fetch timeout");
  } finally { await c.done(); }
});

test("a reconnect: the old line's marks are gone, so a short answer is heard again (not a strict, deaf line)", async () => {
  const c = call({ ackMarks: false, replies: [reply("Ja.", "listen", "Gut.")] });
  try {
    await c.connect(); // the greeting's mark never comes back on the old line
    c.session.handle({ type: "call_connected", call_id: "c-test", from: "+4915100000000", reconnect: true });
    await c.speak(350); // a short "Ja"
    await c.quiet(1000);
    await c.wait(500);
    assert.ok(c.events.some(e => e.event === "turn_start"), "his short answer started a turn");
  } finally { await c.done(); }
});

test("the time limit: the running answer stops, the wrap-up plays, and the call ends even if he talks over it", async () => {
  const c = call({ assets: { wrapUp: pcm(3000) }, replies: [reply("Und dann", "listen", "Eine lange Antwort, die noch läuft.")] });
  try {
    await c.connect();
    c.session.handle({ type: "duration_warning" });
    await c.speak(700); // he talks over the wrap-up: a barge-in clears the marks, the bye mark with them
    await c.quiet(500);
    await c.wait(5500); // the 3 s wrap-up, then 3 s more at most
    assert.ok(c.frames.some(f => f.type === "end_call"), "hung up all the same");
    assert.equal(c.ends[0]?.reason, "time_limit");
  } finally { await c.done(); }
});

test("hanging up mid-answer: the transcript keeps what he heard of it", async () => {
  const c = call({ replies: [reply("Erzähl", "listen", "Das ist der erste Satz, den er hört. Und hier kommt noch ein zweiter, langer Satz.")] });
  try {
    await c.connect();
    await c.speak(800);
    await c.quiet(1000);
    await c.wait(1500); // the first sentence has played
    await c.session.close("caller_hangup");
    const last = c.ends[0].final.turns.at(-1);
    assert.equal(last.role, "model", "his last answer is in the saved transcript");
    assert.match(last.text, /Das ist der erste Satz, den er hört\./);
  } finally { await c.done(); }
});

test("a tool that changes something: run once his turn can't be taken back, and kept in the call's audit trail", async () => {
  const runs = [];
  const audited = [];
  const send = defineTool({ name: "quote_send", description: "send the quote", effect: "write", run: async args => { runs.push(args); return { summary: "sent" }; } });
  const memory: EngineMemory = { context: "", hidden: 0, search: async () => [], checkpoint: async () => {}, recordToolRun: async o => { audited.push(o); } };
  const c = call({ tools: [send], memory, replies: [{ ...reply("Schick es raus.", "listen", ""), call: { name: "quote_send", args: { items: 2 } } }, reply("", "listen", "Ist raus.")] });
  try {
    await c.connect();
    await c.speak(900);
    await c.quiet(1000);
    await c.wait(3000); // the preface plays; the write waits out the false-start window, then runs
    assert.deepEqual(runs, [{ items: 2 }]);
    assert.equal(audited.length, 1);
    assert.equal(audited[0].name, "quote_send");
    assert.equal(audited[0].status, "ok");
    assert.match(audited[0].key, /^c-test:quote_send:/, "keyed per call and input: written once");
    assert.ok(c.said().some(t => /Ist raus/.test(t)), "and the answer after it");
  } finally { await c.done(); }
});
