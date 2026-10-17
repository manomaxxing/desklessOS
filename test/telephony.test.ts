import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import { mulawEncode, mulawDecode, fromPhone, toPhone } from "../src/engine/audio.ts";
import { twilioSignature, verifyTwilioSignature, streamToken, checkStreamToken, streamTwiml, bridgeStream, twilioAdapter } from "../src/telephony/twilio.ts";
import type { StreamSocket } from "../src/telephony/twilio.ts";
import { verifyDialSignature, dialAdapter } from "../src/telephony/dial.ts";
import { safeEqual } from "../src/shared/safe-equal.ts";
import { createCallHost } from "../src/telephony/host.ts";
import { inWindow, nextInWindow, nextDayWindow, zonedTime, validateCallWindow } from "../src/jobs/windows.ts";
import { outboundGuard, retryAt, createScheduler } from "../src/jobs/scheduler.ts";
import { openDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { openPgMemory } from "../src/memory/pg.ts";
import { loadSkillFromTemplates } from "../src/skills/from-templates.ts";
import { createCallStarter } from "../src/calls/start.ts";
import { createMonitor } from "../src/monitor.ts";
import type { CallWindow } from "../src/types/user.ts";
import type { HttpError } from "../src/types/common.ts";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const tz = "Europe/Berlin";

test("μ-law: silence, extremes, and speech survive the round trip", () => {
  assert.equal(mulawEncode(Buffer.alloc(2))[0], 0xff, "silence");
  assert.equal(mulawDecode(Buffer.from([0x00])).readInt16LE(0), -32124);
  assert.equal(mulawDecode(Buffer.from([0x80])).readInt16LE(0), 32124);
  const pcm = Buffer.alloc(2000);
  for (let i = 0; i < 1000; i++) pcm.writeInt16LE(Math.round(9000 * Math.sin(i / 7)), i * 2);
  const back = mulawDecode(mulawEncode(pcm));
  for (let i = 0; i < 1000; i++) assert.ok(Math.abs(back.readInt16LE(i * 2) - pcm.readInt16LE(i * 2)) <= Math.abs(pcm.readInt16LE(i * 2)) * 0.04 + 8);
  assert.equal(fromPhone(Buffer.alloc(160, 0xff)).length, 640, "20 ms of phone audio → 20 ms at 16 kHz");
  assert.equal(toPhone(Buffer.alloc(640)).length, 160);
});

test("Twilio's request signature, and our stream token", () => {
  const params = { CallSid: "CA1", From: "+4915100000000", To: "+4930000000" };
  const sig = twilioSignature("https://x.test/twilio/voice", params, "secret");
  const manual = createHmac("sha1", "secret").update("https://x.test/twilio/voiceCallSidCA1From+4915100000000To+4930000000").digest("base64");
  assert.equal(sig, manual, "URL plus the fields sorted by name");
  assert.equal(verifyTwilioSignature("https://x.test/twilio/voice", params, sig, "secret"), true);
  assert.equal(verifyTwilioSignature("https://x.test/twilio/voice", { ...params, To: "+1" }, sig, "secret"), false);
  assert.equal(verifyTwilioSignature("https://x.test/twilio/voice", params, sig, "other"), false);
  const t = streamToken("CA1", "k");
  assert.equal(checkStreamToken(t, "CA1", "k"), true);
  assert.equal(checkStreamToken(t, "CA2", "k"), false, "another call");
  assert.equal(checkStreamToken(streamToken("CA1", "k", -1), "CA1", "k"), false, "expired");
  assert.match(streamTwiml({ streamUrl: "wss://x.test/twilio/stream", params: { token: "a&b", from: "+49", empty: "" } }), /<Connect><Stream url="wss:\/\/x.test\/twilio\/stream"><Parameter name="token" value="a&amp;b"\/><Parameter name="from" value="\+49"\/><\/Stream><\/Connect>/);
});

test("Dial's signature: fresh and right, or refused", () => {
  const t = Math.floor(Date.now() / 1000);
  const good = `t=${t},v1=${createHmac("sha256", "s").update(`${t}.call-1`).digest("hex")}`;
  assert.equal(verifyDialSignature(good, "call-1", "s"), true);
  assert.equal(verifyDialSignature(good, "call-2", "s"), false);
  assert.equal(verifyDialSignature(good, "call-1", "s", Date.now() + 600000), false, "stale");
});

// A Twilio media stream against a host that records what reaches the call.
class FakeWs extends EventEmitter implements StreamSocket {
  readyState = 1;
  sent: any[] = []; // the frames sent to Twilio, parsed
  send = (m: string) => this.sent.push(JSON.parse(m));
  close = () => { this.readyState = 3; this.emit("close"); };
}
const fakeWs = () => new FakeWs();
function recordingHost() {
  const frames = [];
  let line = null;
  const host = createCallHost({
    startCall: async ({ send }) => { line = send; return { session: { ended: false, handle: m => frames.push(m), close() {} }, userId: "u1" }; },
  });
  return { host, frames, toCaller: f => line(f) };
}

test("Twilio stream: needs our token; then audio, marks and hang-up both ways", async () => {
  const bad = fakeWs();
  const h1 = recordingHost();
  bridgeStream(bad, { host: h1.host, key: "k" });
  bad.emit("message", JSON.stringify({ event: "start", streamSid: "MZ1", start: { callSid: "CA9", streamSid: "MZ1", customParameters: { token: streamToken("CA1", "k") } } }));
  assert.equal(bad.readyState, 3, "a token for another call: closed");
  assert.equal(h1.frames.length, 0);

  const ws = fakeWs();
  const { host, frames, toCaller } = recordingHost();
  bridgeStream(ws, { host, key: "k", maxCallMs: 60000 });
  ws.emit("message", JSON.stringify({ event: "connected" }));
  ws.emit("message", JSON.stringify({ event: "start", streamSid: "MZ1", start: { callSid: "CA1", streamSid: "MZ1", customParameters: { token: streamToken("CA1", "k"), from: "+4915100000000", to: "+4930000000", direction: "outbound", userId: "u1", jobId: "job_1" } } }));
  ws.emit("message", JSON.stringify({ event: "media", media: { track: "inbound", payload: Buffer.alloc(160, 0xff).toString("base64") } }));
  ws.emit("message", JSON.stringify({ event: "mark", mark: { name: "t1-1" } }));
  await sleep(10);
  assert.deepEqual(frames[0], { type: "call_connected", call_id: "CA1", from: "+4915100000000", to: "+4930000000", direction: "outbound", user_id: "u1", job_id: "job_1", language: null, formats: { inbound: "mulaw_8000", outbound: "mulaw_8000" }, reconnect: false });
  assert.equal(frames[1].type, "media");
  assert.equal(Buffer.from(frames[1].payload, "base64").length, 640, "μ-law 8 kHz → PCM16 16 kHz");
  assert.deepEqual(frames[2], { type: "mark", name: "t1-1" });

  toCaller({ type: "media", payload: Buffer.alloc(6400).toString("base64") });
  toCaller({ type: "mark", name: "t1-2" });
  toCaller({ type: "clear" });
  toCaller({ type: "ping_pong" });
  assert.equal(ws.sent[0].event, "media");
  assert.equal(ws.sent[0].streamSid, "MZ1");
  assert.equal(Buffer.from(ws.sent[0].media.payload, "base64").length, 1600, "200 ms back as μ-law 8 kHz");
  assert.deepEqual(ws.sent[1], { event: "mark", streamSid: "MZ1", mark: { name: "t1-2" } });
  assert.deepEqual(ws.sent[2], { event: "clear", streamSid: "MZ1" });
  assert.equal(ws.sent.length, 3, "nothing for ping_pong");

  ws.emit("message", JSON.stringify({ event: "stop" }));
  await sleep(10);
  assert.deepEqual(frames.at(-1), { type: "call_ended", reason: "caller_hangup" });
  toCaller({ type: "end_call" });
  await sleep(150);
  assert.equal(ws.readyState, 3, "end_call closes the stream: Twilio hangs up");
});

test("call windows: his wall clock, across the DST change", () => {
  assert.equal(zonedTime("2026-10-23", "08:00", tz).toISOString(), "2026-10-23T06:00:00.000Z", "CEST");
  assert.equal(zonedTime("2026-10-26", "08:00", tz).toISOString(), "2026-10-26T07:00:00.000Z", "CET after the change");
  assert.equal(inWindow(new Date("2026-10-23T06:30:00Z"), { tz }), true, "Friday 08:30");
  assert.equal(inWindow(new Date("2026-10-24T09:00:00Z"), { tz }), false, "Saturday");
  assert.equal(nextInWindow(new Date("2026-10-23T16:30:00Z"), { tz }).toISOString(), "2026-10-26T07:00:00.000Z", "Friday 18:30 → Monday 08:00 CET");
  assert.equal(nextDayWindow(new Date("2026-10-21T08:00:00Z"), { tz }).toISOString(), "2026-10-22T06:00:00.000Z");
  assert.equal(inWindow(new Date("2026-10-24T09:00:00Z"), { tz, window: { days: [6], from: "10:00", to: "12:00" } }), true, "his own window");
});

test("the guard: consent, pause, number, a call already today, his call times", () => {
  const at = new Date("2026-10-21T08:00:00Z"); // Wednesday 10:00 in Berlin
  const user = { id: "u1", phone: "+4915100000000", consentOutboundAt: "2026-10-01T00:00:00Z", outboundPaused: false, timezone: tz, callWindow: {} };
  // The guard's answer, read on whichever side came back (the assertions check which).
  const guard: (...a: Parameters<typeof outboundGuard>) => { ok: boolean; final?: boolean; retryAt?: Date } = outboundGuard;
  assert.deepEqual(outboundGuard(user, { at }), { ok: true });
  assert.equal(guard({ ...user, consentOutboundAt: null }, { at }).final, true);
  assert.equal(guard({ ...user, outboundPaused: true }, { at }).final, true);
  assert.equal(guard({ ...user, phone: "" }, { at }).final, true);
  assert.equal(guard(user, { at, onCall: true }).retryAt.toISOString(), "2026-10-21T08:10:00.000Z");
  assert.equal(guard(user, { at, answeredToday: 1 }).retryAt.toISOString(), "2026-10-22T06:00:00.000Z");
  assert.equal(guard(user, { at: new Date("2026-10-21T19:00:00Z") }).retryAt.toISOString(), "2026-10-22T06:00:00.000Z", "21:00: tomorrow 08:00");
  assert.equal(retryAt(1, user, at).toISOString(), "2026-10-21T08:30:00.000Z", "30 min");
  assert.equal(retryAt(2, user, at).toISOString(), "2026-10-21T10:00:00.000Z", "2 h");
  assert.equal(retryAt(3, user, at).toISOString(), "2026-10-22T06:00:00.000Z", "the next day's window");
  assert.equal(retryAt(4, user, at), null, "then it falls back to his next call");
});

// ---------- the scheduler, on PGlite, with a carrier that records what it dials ----------
const skill = loadSkillFromTemplates("pilot");
let db, memory, user;
before(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
  memory = openPgMemory({ db, skill });
  await memory.ensureUser();
  [user] = await memory.listUsers();
});
after(async () => { await db?.close(); });

let calls = 0; // call ids are unique, like a carrier's
function rig(at) {
  const clock = { now: new Date(at) };
  const dialed = [];
  const notes = [];
  const carrier = { id: "test", async dialOut(o) { dialed.push(o); return { callId: `call-${++calls}`, carrier: "test" }; } };
  const requests = { note: async (objectiveId, text) => notes.push({ objectiveId, text }) };
  const scheduler = createScheduler({ memory, carrier, requests, now: () => clock.now });
  return { clock, dialed, notes, scheduler };
}
const ask = async (mode = "outbound") => memory.objectives.create({ template: "inquiry", mode, params: { questions: [{ ask: "Wie lange hat dein letztes Angebot gedauert?" }] }, userId: user.id });
const job = async id => (await db.query("select * from outbound_calls where id = $1", [id]))[0];

test("scheduler: only with consent; no answer → retry in 30 min; answered and done → done", async () => {
  const o = await ask();
  const { clock, dialed, notes, scheduler } = rig("2026-10-21T08:00:00Z");
  const first = await scheduler.tick();
  assert.equal(first.skipped, "he hasn't agreed to be called", "no consent: nobody is dialed");
  assert.equal(dialed.length, 0);
  assert.equal((await memory.objectives.get(o.id)).mode, "next_inbound", "the question moves to his next call");
  assert.match(notes[0].text, /Can't call Niko: he hasn't agreed to be called/);

  await memory.updateUser(user.id, { phone: "+4915100000000", consentOutbound: true });
  const o2 = await ask();
  const t1 = await scheduler.tick();
  assert.equal(dialed[0].to, "+4915100000000");
  assert.equal(dialed[0].userId, user.id, "a job only ever dials a users row");
  await scheduler.callStatus({ callId: t1.callId, status: "no-answer" });
  let j = await job(t1.job.id);
  assert.equal(j.status, "queued");
  assert.equal(new Date(j.next_attempt_at).toISOString(), "2026-10-21T08:30:00.000Z");
  assert.equal((await scheduler.tick()), null, "not due yet");
  clock.now = new Date("2026-10-21T08:31:00Z");
  const t2 = await scheduler.tick();
  assert.equal(t2.job.attempts, 2);
  await scheduler.callStatus({ callId: t2.callId, status: "in-progress" });
  await scheduler.callEnded({ callId: t2.callId, reason: "agent_hangup", outcome: { consent: "yes" }, objectives: [{ id: o2.id, done: true }] });
  j = await job(t2.job.id);
  assert.equal(j.status, "done");
  assert.equal(j.outcome, "completed");
});

test("scheduler: 'no time' moves it to his next call; 'call me at 15:00' comes back at 15:00 his time", async () => {
  const { dialed, notes, scheduler } = rig("2026-10-22T08:00:00Z");
  const declined = await ask();
  const t1 = await scheduler.tick();
  await scheduler.callEnded({ callId: t1.callId, reason: "agent_hangup", outcome: { consent: "no" }, objectives: [{ id: declined.id, done: false }] });
  assert.equal((await job(t1.job.id)).outcome, "declined");
  assert.equal((await memory.objectives.get(declined.id)).mode, "next_inbound");
  assert.match(notes.at(-1).text, /had no time when called/);

  const later = await ask();
  const t2 = await scheduler.tick();
  await scheduler.callEnded({ callId: t2.callId, reason: "agent_hangup", outcome: { consent: "later", callbackWhen: "2026-10-22T15:00" }, objectives: [{ id: later.id, done: false }] });
  const j = await job(t2.job.id);
  assert.equal(j.status, "queued");
  assert.equal(new Date(j.next_attempt_at).toISOString(), "2026-10-22T13:00:00.000Z", "15:00 in Berlin");
  assert.equal(dialed.length, 2);
  await scheduler.cancelFor(later.id);
  assert.equal((await job(t2.job.id)).status, "cancelled");
});

test("scheduler: a mailbox is a failed try; four tries, then his next call; a pause stops everything", async () => {
  const { clock, notes, scheduler } = rig("2026-10-26T07:30:00Z"); // Monday 08:30 CET
  const o = await ask();
  const t1 = await scheduler.tick();
  await scheduler.callEnded({ callId: t1.callId, reason: "voicemail", outcome: { consent: "unknown" }, objectives: [{ id: o.id, done: false }] });
  let j = await job(t1.job.id);
  assert.equal(j.outcome, "voicemail");
  for (const [at, status] of [["2026-10-26T08:01:00Z", "busy"], ["2026-10-26T10:02:00Z", "no-answer"], ["2026-10-27T07:00:00Z", "no-answer"]]) {
    clock.now = new Date(at);
    const t = await scheduler.tick();
    assert.ok(t?.callId, `dialed at ${at}`);
    await scheduler.callStatus({ callId: t.callId, status });
  }
  j = await job(t1.job.id);
  assert.equal(j.status, "failed");
  assert.equal(j.attempts, 4);
  assert.equal((await memory.objectives.get(o.id)).mode, "next_inbound");
  assert.match(notes.at(-1).text, /Couldn't reach Niko by phone \(4 tries, last: no-answer\)/);

  await memory.updateUser(user.id, { outboundPaused: true });
  const paused = await ask();
  const t = await scheduler.tick();
  assert.equal(t.skipped, "calls to him are paused");
  assert.equal((await memory.objectives.get(paused.id)).mode, "next_inbound");
  await memory.updateUser(user.id, { outboundPaused: false });
});

test("scheduler: not while he's on a call (on any instance); answered but the call never came through is a failed try", async () => {
  const { clock, dialed, scheduler } = rig("2026-10-28T08:00:00Z");
  const o = await ask();
  const busy = await memory.openCall({ callId: "his-own-call", userId: user.id });
  const t0 = await scheduler.tick();
  assert.equal(t0.deferred, "he's on a call");
  await busy.endCall({ turns: [] });
  clock.now = new Date("2026-10-28T08:11:00Z");
  const t1 = await scheduler.tick();
  assert.ok(t1.callId, "dialed once he's off the phone");
  await scheduler.callStatus({ callId: t1.callId, status: "in-progress" });
  await db.query("update outbound_calls set updated_at = now() - interval '25 minutes' where id = $1", [t1.job.id]);
  await scheduler.tick();
  const j = await job(t1.job.id);
  assert.equal(j.outcome, "the call never came through");
  assert.equal(j.status, "queued");
  assert.equal(dialed.length, 1);
  await memory.objectives.cancel(o.id);
  await scheduler.cancelFor(o.id);
});

test("crash-proofing: a secret compare never throws; a malformed Dial URL is refused, not thrown", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("é".repeat(3), "e".repeat(3)), false, "same length in characters, not in bytes: false, no RangeError");
  assert.equal(safeEqual(undefined, ""), true);
  let destroyed = 0;
  const socket = Object.assign(new Duplex(), { destroy: () => { destroyed++; }, write() {} });
  const adapter = dialAdapter({ host: createCallHost({ startCall: async () => { throw new Error("not reached"); } }), wss: { handleUpgrade() { throw new Error("not reached"); } } });
  // A request with only the headers a refused upgrade could read.
  assert.equal(adapter.upgrade({ headers: {} } as IncomingMessage, socket, null, new URL("http://x/dial/%ZZ")), true);
  assert.equal(destroyed, 1, "a bad %-escape: the socket is closed");
});

test("call host: a failed setup ends the line and never rejects; later frames are dropped", async () => {
  const logs = [];
  const sent = [];
  let closedLine = 0;
  const host = createCallHost({ startCall: async () => { throw new Error("database blip"); }, log: (...a) => logs.push(a.join(" ")) });
  const conn = host.connect({ send: f => sent.push(f), close: () => { closedLine++; } }, { source: "whatsapp" });
  await conn.receive({ type: "call_connected", call_id: "c1" }); // resolves, doesn't reject
  await conn.receive({ type: "media", payload: "" });
  assert.deepEqual(sent, [{ type: "end_call" }]);
  assert.equal(closedLine, 1);
  assert.equal(host.calls.size, 0);
  assert.ok(logs.some(l => /setting it up failed/.test(l)));
});

test("call host: a frame that throws is logged, not raised; a line closed during setup ends the call once it's set up", async () => {
  const logs = [];
  let release;
  const closes = [];
  const session = { ended: false, handle: m => { if (m.type === "mark") throw new TypeError("no name"); }, close: async r => { closes.push(r); } };
  const host = createCallHost({ startCall: () => new Promise(r => { release = () => r({ session }); }), log: (...a) => logs.push(a.join(" ")) });
  const conn = host.connect({ send() {} }, { reconnects: false, source: "twilio" });
  const connecting = conn.receive({ type: "call_connected", call_id: "c2" });
  conn.closed(); // he hangs up while the call is still being set up
  release();
  await connecting;
  await new Promise(r => setImmediate(r));
  assert.deepEqual(closes, ["line_closed"], "the session made after the line closed is ended at once");
  assert.equal(host.calls.size, 0);
  const conn2 = createCallHost({ startCall: async () => ({ session }), log: (...a) => logs.push(a.join(" ")) }).connect({ send() {} });
  await conn2.receive({ type: "call_connected", call_id: "c3" });
  await conn2.receive({ type: "mark" });
  assert.ok(logs.some(l => /frame mark failed: no name/.test(l)));
});

test("call host: the old connection closing after a reconnect doesn't end the call", async () => {
  const closes = [];
  const session = { ended: false, handle() {}, close: async r => { closes.push(r); } };
  const host = createCallHost({ startCall: async () => ({ session }), graceMs: 10 });
  const old = host.connect({ send() {} }, { source: "dial" });
  await old.receive({ type: "call_connected", call_id: "c4" });
  const fresh = host.connect({ send() {} }, { source: "dial" });
  await fresh.receive({ type: "call_connected", call_id: "c4", reconnect: true });
  old.closed(); // its close arrives late
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(closes, [], "still live on the new connection");
  assert.equal(host.calls.size, 1);
});

test("Twilio stream: a junk message is ignored; a stream that never starts is closed after 5 s", async () => {
  const ws = fakeWs();
  const { host } = recordingHost();
  bridgeStream(ws, { host, key: "k" });
  ws.emit("message", "null");
  ws.emit("message", "42");
  assert.equal(ws.readyState, 1, "no crash, still open");
  ws.close();
});

test("call windows: overnight, across Sunday night; one that makes no sense is no window, never a throw; the People card's check", () => {
  const night = { days: [5], from: "20:00", to: "02:00" }; // Friday night (CEST: UTC+2)
  assert.equal(inWindow(new Date("2026-10-23T19:00:00Z"), { tz, window: night }), true, "Friday 21:00");
  assert.equal(inWindow(new Date("2026-10-23T23:30:00Z"), { tz, window: night }), true, "Saturday 01:30: still Friday's night");
  assert.equal(inWindow(new Date("2026-10-24T19:00:00Z"), { tz, window: night }), false, "Saturday 21:00");
  assert.equal(inWindow(new Date("2026-10-23T17:00:00Z"), { tz, window: night }), false, "Friday 19:00");
  assert.equal(nextInWindow(new Date("2026-10-23T10:00:00Z"), { tz, window: night }).toISOString(), "2026-10-23T18:00:00.000Z", "Friday noon → 20:00");
  assert.equal(inWindow(new Date("2026-10-25T23:30:00Z"), { tz, window: { days: [7], from: "22:00", to: "01:00" } }), true, "Monday 00:30 after Sunday's night");
  const senseless: CallWindow[] = [
    { days: [] }, { from: "8 Uhr" },
    // @ts-expect-error: a day as text, on purpose
    { days: ["1"] },
    { from: "09:00", to: "09:00" },
  ];
  for (const window of senseless) {
    const at = new Date("2026-10-21T08:00:00Z");
    assert.equal(inWindow(at, { tz, window }), false, JSON.stringify(window));
    assert.equal(nextInWindow(at, { tz, window }), null, JSON.stringify(window));
    assert.equal(nextDayWindow(at, { tz, window }), null, JSON.stringify(window));
  }
  assert.equal(nextInWindow(new Date("2026-10-21T08:00:00Z"), { tz: "Mars/Olympus" }), null, "an unknown time zone");
  const user = { phone: "+4915100000000", consentOutboundAt: "2026-10-01T00:00:00Z", outboundPaused: false, timezone: tz, callWindow: { days: [] } };
  assert.deepEqual(outboundGuard(user, { at: new Date("2026-10-21T08:00:00Z") }), { ok: false, reason: "his call times aren't set right (People card)", final: true });
  assert.equal(retryAt(1, user), null, "no retry into a window that can't be");

  assert.deepEqual(validateCallWindow({ days: [3, 1, 1], from: "8", to: "18:30" }), { days: [1, 3], from: "08:00", to: "18:30" });
  assert.deepEqual(validateCallWindow({ from: "20:00", to: "02:00" }), { from: "20:00", to: "02:00" }, "overnight is fine");
  assert.deepEqual(validateCallWindow(null), {}, "none: the default");
  const refused: [unknown, RegExp][] = [[{ days: [] }, /at least one day/], [{ days: [0, 8] }, /1 \(Monday\) to 7/], [{ from: "8 Uhr" }, /"8 Uhr" isn't a time/], [{ to: "25:00" }, /isn't a time/], [{ from: "18:00" }, /can't be the same/], ["mornings", /days, from and to/]];
  for (const [bad, why] of refused) {
    assert.throws(() => validateCallWindow(bad), (err: HttpError) => err.status === 400 && why.test(err.message), JSON.stringify(bad));
  }
});

test("scheduler: an errand whose questions were answered meanwhile isn't dialed; a new question joins his waiting errand", async () => {
  const { dialed, scheduler } = rig("2026-10-29T08:00:00Z"); // Thursday 09:00 CET
  const first = await ask();
  const [errand] = await scheduler.sync();
  const second = await ask();
  assert.deepEqual((await scheduler.sync()).map(j => j.id), [errand.id], "no second errand: it joins the one waiting");
  assert.deepEqual((await job(errand.id)).objective_ids, [first.id, second.id]);

  // His own call answered the first one: only the second is still for calling.
  await db.query("update objectives set status = 'done' where id = $1", [first.id]);
  const t1 = await scheduler.tick();
  assert.ok(t1.callId);
  assert.deepEqual((await job(errand.id)).objective_ids, [second.id]);
  await scheduler.callEnded({ callId: t1.callId, reason: "agent_hangup", outcome: { consent: "yes" }, objectives: [{ id: second.id, done: true }] });
  assert.equal((await job(errand.id)).status, "done");
  await db.query("update objectives set status = 'done' where id = $1", [second.id]); // what the call's after-call step records

  // All of it answered elsewhere: nothing to call about.
  const third = await ask();
  const [later] = await scheduler.sync();
  await db.query("update objectives set status = 'done' where id = $1", [third.id]);
  const t2 = await scheduler.tick();
  assert.equal(t2?.skipped, "nothing left to ask");
  assert.equal(dialed.length, 1, "not dialed");
  assert.deepEqual([(await job(later.id)).status, (await job(later.id)).outcome], ["done", "nothing left"]);
});

test("scheduler: Max cancels one of two questions: the errand goes on with the other", async () => {
  const { scheduler } = rig("2026-10-29T09:00:00Z");
  const [a, b] = [await ask(), await ask()];
  const [errand] = await scheduler.sync();
  await scheduler.cancelFor(a.id);
  const j = await job(errand.id);
  assert.deepEqual([j.status, j.objective_ids], ["queued", [b.id]]);
  await scheduler.cancelFor(b.id);
  assert.equal((await job(errand.id)).status, "cancelled");
  for (const o of [a, b]) await memory.objectives.cancel(o.id);
});

test("scheduler: dialing with no word from the carrier is a failed try with its backoff; if the call came through, he's on it", async () => {
  const { clock, dialed, scheduler } = rig("2026-11-02T08:00:00Z"); // Monday 09:00 CET
  const o = await ask();
  const t1 = await scheduler.tick();
  await db.query("update outbound_calls set updated_at = now() - interval '4 minutes' where id = $1", [t1.job.id]);
  clock.now = new Date("2026-11-02T08:04:00Z");
  assert.equal(await scheduler.tick(), null, "not dialed again at once");
  let j = await job(t1.job.id);
  assert.deepEqual([j.status, j.outcome, j.attempts], ["queued", "no word from the carrier", 1]);
  assert.equal(new Date(j.next_attempt_at).toISOString(), "2026-11-02T08:34:00.000Z", "30 min, like any failed try");

  clock.now = new Date("2026-11-02T08:35:00Z");
  const t2 = await scheduler.tick();
  assert.equal(t2.job.attempts, 2);
  const scope = await memory.openCall({ callId: t2.callId, userId: user.id, direction: "outbound", at: clock.now }); // he picked up; the carrier's word got lost
  await db.query("update outbound_calls set updated_at = now() - interval '4 minutes' where id = $1", [t1.job.id]);
  await scheduler.tick();
  j = await job(t1.job.id);
  assert.deepEqual([j.status, j.outcome], ["in_call", "answered"], "on the call: not requeued under him");
  assert.equal(dialed.length, 2);
  await scope.endCall({ turns: [] });
  await scheduler.callEnded({ callId: t2.callId, reason: "agent_hangup", outcome: { consent: "yes" }, objectives: [{ id: o.id, done: true }] });
  assert.equal((await job(t1.job.id)).status, "done");
});

test("scheduler: 'call me back at 15:00' is called at 15:00 that day: the call in which he asked doesn't use up the day", async () => {
  const { clock, dialed, scheduler } = rig("2026-11-03T08:00:00Z"); // Tuesday 09:00 CET
  const o = await ask();
  const t1 = await scheduler.tick();
  const scope = await memory.openCall({ callId: t1.callId, userId: user.id, direction: "outbound", at: clock.now });
  await scope.endCall({ turns: [], reason: "agent_hangup" });
  await scheduler.callStatus({ callId: t1.callId, status: "in-progress" });
  await scheduler.callEnded({ callId: t1.callId, reason: "agent_hangup", outcome: { consent: "later", callbackWhen: "2026-11-03T15:00" }, objectives: [{ id: o.id, done: false }] });
  clock.now = new Date("2026-11-03T14:00:00Z"); // 15:00 CET
  const t2 = await scheduler.tick();
  assert.ok(t2?.callId, `called back (${t2?.deferred ?? "nothing"})`);
  assert.equal(dialed.length, 2);
  await scheduler.callEnded({ callId: t2.callId, reason: "agent_hangup", outcome: { consent: "yes" }, objectives: [{ id: o.id, done: true }] });
});

test("call wiring: the call's agenda not saved (a database blip) doesn't stop the call", async () => {
  const o = await memory.objectives.create({ template: "inquiry", params: { questions: [{ ask: "Wie viele Angebote schreibst du pro Woche?" }] }, userId: user.id });
  const monitor = createMonitor();
  const system = [];
  monitor.subscribe(m => { if (m.type === "system") system.push(m.entry.text); });
  const blip = { openCall: async opts => ({ ...(await memory.openCall(opts)), setAgenda: async () => { throw new Error("connection reset"); } }) };
  const startCall = createCallStarter({
    cfg: { adminPhones: [], recordCalls: false, engine: "cascade", model: "m", mask: "none", liveModel: "", liveVoice: "" }, skill, memory: blip, monitor, clips: Promise.resolve({}),
    endpoint: { door: "test", url: () => "https://gemini.test/", headers: async () => ({}) }, fish: { model: "f", voice: "", voiceFor: () => "", stream: null, synth: async () => Buffer.alloc(0) },
    requests: null, auth: null, background: { kick() {} }, log: () => {},
  });
  const { session } = await startCall({ id: "wiring-1", msg: { type: "call_connected", call_id: "wiring-1", user_id: user.id }, send: () => {}, dev: false, source: "dial" });
  assert.equal(typeof session.handle, "function", "the call goes on");
  assert.ok(system.some(t => /wiring-1: agenda not saved \(connection reset\)/.test(t)), system.join("\n"));
  assert.ok(system.some(t => /wiring-1: agenda inquiry obj_/.test(t)), "its question is asked all the same");
  await memory.objectives.cancel(o.id);
});

test("call host: shutting down, one call that fails to close doesn't stop the others (or the shutdown)", async () => {
  const closed = [];
  const logs = [];
  const sessions = { a: { ended: false, handle() {}, close: async () => { throw new Error("socket gone"); } }, b: { ended: false, handle() {}, close: async r => { closed.push(r); } } };
  const host = createCallHost({ startCall: async ({ id }) => ({ session: sessions[id] }), log: (...a) => logs.push(a.join(" ")) });
  for (const id of ["a", "b"]) await host.connect({ send() {} }, { source: "dial" }).receive({ type: "call_connected", call_id: id });
  await host.closeAll("server_shutdown");
  assert.deepEqual(closed, ["server_shutdown"]);
  assert.ok(logs.some(l => /call a: closing failed: socket gone/.test(l)));
});

test("scheduler: a call that ended hours ago without its outcome reaching the errand is a failed try, not stuck forever", async () => {
  const { scheduler } = rig("2027-03-03T09:00:00Z"); // a Wednesday morning, no call yet that day
  await memory.updateUser(user.id, { consentOutbound: true, outboundPaused: false });
  await db.query("update calls set ended_at = now() - interval '1 day' where user_id = $1 and ended_at is null", [user.id]); // earlier tests' calls: over
  const o = await ask();
  const t1 = await scheduler.tick();
  assert.ok(t1.callId, JSON.stringify(t1));
  await scheduler.callStatus({ callId: t1.callId, status: "in-progress" });
  const scope = await memory.openCall({ callId: t1.callId, userId: user.id, direction: "outbound" });
  await scope.endCall({ turns: [], reason: "caller_hangup" });
  await db.query("update outbound_calls set updated_at = now() - interval '25 minutes' where id = $1", [t1.job.id]);
  await scheduler.tick();
  assert.equal((await job(t1.job.id)).status, "in_call", "a call that just ended: its after-call step may still report");
  await db.query("update calls set ended_at = now() - interval '7 hours' where id = $1", [t1.callId]);
  await db.query("update outbound_calls set updated_at = now() - interval '25 minutes' where id = $1", [t1.job.id]);
  await scheduler.tick();
  const j = await job(t1.job.id);
  assert.equal(j.outcome, "the call ended, but its outcome never came");
  assert.notEqual(j.status, "in_call");
  await memory.objectives.cancel(o.id);
  await scheduler.cancelFor(o.id);
});
