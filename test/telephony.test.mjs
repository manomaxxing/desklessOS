import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import { mulawEncode, mulawDecode, fromPhone, toPhone } from "../src/engine/audio.mjs";
import { twilioSignature, verifyTwilioSignature, streamToken, checkStreamToken, streamTwiml, bridgeStream, twilioAdapter } from "../src/telephony/twilio.mjs";
import { verifyDialSignature } from "../src/telephony/dial.mjs";
import { createCallHost } from "../src/telephony/host.mjs";
import { inWindow, nextInWindow, nextDayWindow, zonedTime } from "../src/jobs/windows.mjs";
import { outboundGuard, retryAt, createScheduler } from "../src/jobs/scheduler.mjs";
import { openDb } from "../src/db/client.mjs";
import { migrate } from "../src/db/migrate.mjs";
import { openPgMemory } from "../src/memory/pg.mjs";
import { loadSkillFromTemplates } from "../src/skills/from-templates.mjs";

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
function fakeWs() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.send = m => ws.sent.push(JSON.parse(m));
  ws.close = () => { ws.readyState = 3; ws.emit("close"); };
  return ws;
}
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
  assert.deepEqual(outboundGuard(user, { at }), { ok: true });
  assert.equal(outboundGuard({ ...user, consentOutboundAt: null }, { at }).final, true);
  assert.equal(outboundGuard({ ...user, outboundPaused: true }, { at }).final, true);
  assert.equal(outboundGuard({ ...user, phone: "" }, { at }).final, true);
  assert.equal(outboundGuard(user, { at, onCall: true }).retryAt.toISOString(), "2026-10-21T08:10:00.000Z");
  assert.equal(outboundGuard(user, { at, answeredToday: 1 }).retryAt.toISOString(), "2026-10-22T06:00:00.000Z");
  assert.equal(outboundGuard(user, { at: new Date("2026-10-21T19:00:00Z") }).retryAt.toISOString(), "2026-10-22T06:00:00.000Z", "21:00: tomorrow 08:00");
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
