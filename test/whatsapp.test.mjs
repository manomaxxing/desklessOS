import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createHmac } from "node:crypto";
import { whatsappAdapter, verifyMetaSignature, whatsappVerifyToken, callEvents } from "../src/telephony/whatsapp.mjs";
import { createAudioPeer } from "../src/telephony/webrtc-audio.mjs";

const SECRET = "app-secret";
const ENV = { WHATSAPP_TOKEN: "tok", WHATSAPP_PHONE_NUMBER_ID: "123", WHATSAPP_APP_SECRET: SECRET, SESSION_SECRET: "s" };
const sign = raw => `sha256=${createHmac("sha256", SECRET).update(raw).digest("hex")}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(adapter, { method = "POST", path = "/whatsapp/webhook", body = null, signature } = {}) {
  const raw = body ? Buffer.from(JSON.stringify(body)) : Buffer.alloc(0);
  const req = Readable.from(raw.length ? [raw] : []);
  req.method = method;
  req.headers = { "x-hub-signature-256": signature ?? sign(raw) };
  const res = { status: null, body: "", writeHead(s) { this.status = s; return this; }, end(b = "") { this.body = String(b); return this; } };
  return adapter.http(req, res, new URL(`http://x${path}`)).then(handled => ({ handled, ...res }));
}

const callWebhook = call => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "calls", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550001111", phone_number_id: "123" }, calls: [call] } }] }],
});

const tone = ms => { const n = ms * 16, b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000)), i * 2); return b; };
const loudMs = chunks => chunks.filter(p => { let s = 0; for (let i = 0; i < p.length; i += 2) s += p.readInt16LE(i) ** 2; return Math.sqrt(s / (p.length / 2)) > 2000; }).reduce((n, p) => n + p.length / 32, 0);

test("Meta's webhook signature and handshake", async () => {
  assert.ok(verifyMetaSignature(Buffer.from("{}"), sign(Buffer.from("{}")), SECRET));
  assert.ok(!verifyMetaSignature(Buffer.from("{}"), sign(Buffer.from("{ }")), SECRET));
  assert.ok(!verifyMetaSignature(Buffer.from("{}"), undefined, SECRET));
  const a = whatsappAdapter({ host: null, env: ENV });
  const token = whatsappVerifyToken(ENV);
  const ok = await request(a, { method: "GET", path: `/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42` });
  assert.deepEqual([ok.status, ok.body], [200, "42"]);
  const bad = await request(a, { method: "GET", path: "/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42" });
  assert.equal(bad.status, 403);
  const forged = await request(a, { body: callWebhook({ id: "x", event: "terminate" }), signature: "sha256=00" });
  assert.equal(forged.status, 403);
  assert.equal((await request(a, { path: "/twilio/voice" })).handled, false);
  assert.equal(whatsappAdapter({ host: null, env: { WHATSAPP_TOKEN: "t" } }), null, "off without its settings");
});

test("callEvents reads calls and statuses out of a delivery", () => {
  const events = callEvents(callWebhook({ id: "wacid.1", event: "connect", from: "4917012345678" }));
  assert.equal(events.length, 1);
  assert.equal(events[0].call.id, "wacid.1");
  assert.equal(events[0].phoneNumberId, "123");
  assert.deepEqual(callEvents({ entry: [{ changes: [{ field: "messages", value: {} }] }] }), []);
});

test("a WhatsApp call: answered over the Graph API, audio both ways, marks, hang-up", { timeout: 20000 }, async () => {
  // WhatsApp's side: an ICE-lite WebRTC peer that offers, and hears what we send.
  const heardByCaller = [];
  const caller = createAudioPeer({ stun: [], rtc: { iceLite: true }, onAudio: p => heardByCaller.push(p) });
  const offer = await caller.offer();

  const graphCalls = [];
  const fetchImpl = async (url, { body }) => {
    const b = JSON.parse(body);
    graphCalls.push(b.action);
    assert.match(url, /\/v26\.0\/123\/calls$/);
    if (b.action === "pre_accept") await caller.accept(b.session.sdp);
    return { ok: true, json: async () => ({ messaging_product: "whatsapp", success: true }) };
  };

  // The call host: records what the call receives, and speaks when connected.
  const received = [];
  let line = null;
  const host = {
    connect(l, opts) {
      line = l;
      assert.equal(opts.source, "whatsapp");
      return { receive: async m => { received.push(m); }, closed() {}, entry: null };
    },
  };
  const a = whatsappAdapter({ host, env: { ...ENV, MAX_CALL_MIN: 1 }, fetchImpl, peerFactory: o => createAudioPeer({ ...o, stun: [] }) });
  const res = await request(a, { body: callWebhook({ id: "wacid.1", from: "4917012345678", to: "15550001111", event: "connect", direction: "USER_INITIATED", session: { sdp_type: "offer", sdp: offer } }) });
  assert.equal(res.status, 200);

  for (let i = 0; i < 50 && !graphCalls.includes("accept"); i++) await sleep(100);
  assert.deepEqual(graphCalls, ["pre_accept", "accept"]);
  const connected = received.find(m => m.type === "call_connected");
  assert.equal(connected.from, "+4917012345678");
  assert.equal(connected.direction, "inbound");

  caller.start();
  caller.play(tone(600));
  line.send({ type: "media", payload: tone(800).toString("base64") });
  line.send({ type: "mark", name: "t1-1" });
  await sleep(2000);
  assert.ok(loudMs(heardByCaller) >= 700, `the caller hears us (${loudMs(heardByCaller)} ms)`);
  const heardByUs = received.filter(m => m.type === "media").map(m => Buffer.from(m.payload, "base64"));
  assert.ok(loudMs(heardByUs) >= 500, `we hear the caller (${loudMs(heardByUs)} ms)`);
  assert.ok(received.some(m => m.type === "mark" && m.name === "t1-1"), "the mark comes back once its audio went out");

  // Barge-in: queued audio is dropped, its mark never comes back.
  line.send({ type: "media", payload: tone(3000).toString("base64") });
  line.send({ type: "mark", name: "t2-1" });
  line.send({ type: "clear" });
  await sleep(300);
  assert.ok(!received.some(m => m.name === "t2-1"));

  await request(a, { body: callWebhook({ id: "wacid.1", event: "terminate", status: "COMPLETED" }) });
  assert.deepEqual(received.at(-1), { type: "call_ended", reason: "caller_hangup" });
  assert.equal(a.calls, 0);
  assert.ok(!graphCalls.includes("terminate"), "he hung up: no terminate from us");
  await caller.close();
});

test("Toni hangs up: terminate goes to WhatsApp", { timeout: 20000 }, async () => {
  const caller = createAudioPeer({ stun: [] });
  const offer = await caller.offer();
  const graphCalls = [];
  const fetchImpl = async (url, { body }) => {
    const b = JSON.parse(body);
    graphCalls.push(b.action);
    if (b.action === "pre_accept") await caller.accept(b.session.sdp);
    return { ok: true, json: async () => ({ success: true }) };
  };
  let line = null;
  const received = [];
  const host = { connect(l) { line = l; return { receive: async m => { received.push(m); }, closed() {}, entry: null }; } };
  const a = whatsappAdapter({ host, env: ENV, fetchImpl, peerFactory: o => createAudioPeer({ ...o, stun: [] }) });
  await request(a, { body: callWebhook({ id: "wacid.2", from: "4917012345678", event: "connect", direction: "USER_INITIATED", session: { sdp_type: "offer", sdp: offer } }) });
  for (let i = 0; i < 50 && !graphCalls.includes("accept"); i++) await sleep(100);
  line.send({ type: "end_call" });
  await sleep(500);
  assert.deepEqual(graphCalls, ["pre_accept", "accept", "terminate"]);
  assert.equal(a.calls, 0);
  await caller.close();
});

test("a call WhatsApp can't connect is hung up, not left ringing", { timeout: 20000 }, async () => {
  const caller = createAudioPeer({ stun: [] });
  const offer = await caller.offer();
  const graphCalls = [];
  const fetchImpl = async (url, { body }) => {
    const b = JSON.parse(body);
    graphCalls.push(b.action);
    if (b.action === "accept") return { ok: false, status: 400, json: async () => ({ error: { message: "SDP mismatch" } }) };
    return { ok: true, json: async () => ({ success: true }) };
  };
  const received = [];
  const host = { connect() { return { receive: async m => { received.push(m); }, closed() {}, entry: null }; } };
  const a = whatsappAdapter({ host, env: ENV, fetchImpl, peerFactory: o => createAudioPeer({ ...o, stun: [] }) });
  await request(a, { body: callWebhook({ id: "wacid.3", from: "4917012345678", event: "connect", direction: "USER_INITIATED", session: { sdp_type: "offer", sdp: offer } }) });
  for (let i = 0; i < 50 && !graphCalls.includes("terminate"); i++) await sleep(100);
  assert.deepEqual(graphCalls, ["pre_accept", "accept", "terminate"]);
  assert.equal(received.at(-1).type, "call_ended");
  assert.equal(a.calls, 0);
  await caller.close();
});

test("he hangs up while it's ringing: no call is started", { timeout: 20000 }, async () => {
  const caller = createAudioPeer({ stun: [], rtc: { iceLite: true } });
  const offer = await caller.offer();
  let a = null;
  const graphCalls = [];
  const fetchImpl = async (url, { body }) => {
    const b = JSON.parse(body);
    graphCalls.push(b.action);
    if (b.action === "pre_accept") await request(a, { body: callWebhook({ id: "wacid.4", event: "terminate", status: "FAILED" }) });
    return { ok: true, json: async () => ({ success: true }) };
  };
  let connected = false;
  const host = { connect() { connected = true; return { receive: async () => {}, closed() {}, entry: null }; } };
  a = whatsappAdapter({ host, env: ENV, fetchImpl, peerFactory: o => createAudioPeer({ ...o, stun: [] }) });
  await request(a, { body: callWebhook({ id: "wacid.4", from: "4917012345678", event: "connect", direction: "USER_INITIATED", session: { sdp_type: "offer", sdp: offer } }) });
  await sleep(500);
  assert.deepEqual(graphCalls, ["pre_accept"]);
  assert.equal(connected, false);
  assert.equal(a.calls, 0);
  await caller.close();
});

const statusWebhook = (id, status) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba", changes: [{ field: "calls", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "15550001111", phone_number_id: "123" }, statuses: [{ id, type: "call", status, timestamp: "1", recipient_id: "4917012345678" }] } }] }],
});

/** WhatsApp's side of a call Toni makes: Graph's connect answers with a call id, the answer SDP comes by webhook. */
function placing({ heard = [] } = {}) {
  const callee = createAudioPeer({ stun: [], rtc: { iceLite: true }, onAudio: p => heard.push(p) });
  const graphCalls = [];
  let answer = null;
  const fetchImpl = async (url, { body }) => {
    const b = JSON.parse(body);
    graphCalls.push(b);
    if (b.action === "connect") answer = await callee.answer(b.session.sdp);
    return { ok: true, json: async () => (b.action === "connect" ? { messaging_product: "whatsapp", calls: [{ id: "wacid.out1" }] } : { success: true }) };
  };
  return { callee, graphCalls, fetchImpl, answer: () => answer };
}

test("Toni calls him: connect with our offer, the conversation starts when he picks up", { timeout: 20000 }, async () => {
  const heardByCallee = [];
  const w = placing({ heard: heardByCallee });
  const received = [];
  let line = null;
  const host = { connect(l) { line = l; return { receive: async m => { received.push(m); }, closed() {}, entry: null }; } };
  const statuses = [];
  const a = whatsappAdapter({ host, env: ENV, fetchImpl: w.fetchImpl, peerFactory: o => createAudioPeer({ ...o, stun: [] }), onStatus: s => statuses.push(s.status) });

  const placed = await a.dialOut({ to: "+4917012345678", userId: "u1", extra: { rehearsal_of: "u2", objectives: [{ template: "discovery.day", params: {} }] } });
  assert.deepEqual(placed, { callId: "wacid.out1", carrier: "whatsapp" });
  const connect = w.graphCalls[0];
  assert.equal(connect.to, "4917012345678");
  assert.equal(connect.session.sdp_type, "offer");

  // Meta's answer comes right away, while it rings: no conversation yet.
  await request(a, { body: callWebhook({ id: "wacid.out1", event: "connect", direction: "BUSINESS_INITIATED", to: "4917012345678", session: { sdp_type: "answer", sdp: w.answer() } }) });
  await request(a, { body: statusWebhook("wacid.out1", "RINGING") });
  await sleep(500);
  assert.ok(!received.some(m => m.type === "call_connected"), "not before he picks up");

  await request(a, { body: statusWebhook("wacid.out1", "ACCEPTED") });
  for (let i = 0; i < 30 && !received.some(m => m.type === "call_connected"); i++) await sleep(100);
  const connected = received.find(m => m.type === "call_connected");
  assert.equal(connected.direction, "outbound");
  assert.equal(connected.to, "+4917012345678");
  assert.equal(connected.from, "+15550001111");
  assert.equal(connected.user_id, "u1");
  assert.equal(connected.rehearsal_of, "u2");
  assert.deepEqual(statuses, ["answered"]);

  w.callee.start();
  w.callee.play(tone(600));
  line.send({ type: "media", payload: tone(800).toString("base64") });
  await sleep(2000);
  assert.ok(loudMs(heardByCallee) >= 700, `he hears Toni (${loudMs(heardByCallee)} ms)`);
  assert.ok(loudMs(received.filter(m => m.type === "media").map(m => Buffer.from(m.payload, "base64"))) >= 400, "Toni hears him");

  line.send({ type: "end_call" });
  await sleep(500);
  assert.equal(w.graphCalls.at(-1).action, "terminate");
  assert.equal(a.calls, 0);
  await w.callee.close();
});

test("Toni calls him: he declines, or doesn't pick up", { timeout: 20000 }, async () => {
  for (const outcome of ["REJECTED", "nothing"]) {
    const w = placing();
    const received = [];
    const host = { connect() { return { receive: async m => { received.push(m); }, closed() {}, entry: null }; } };
    const statuses = [];
    const a = whatsappAdapter({ host, env: { ...ENV, WHATSAPP_RING_S: 1 }, fetchImpl: w.fetchImpl, peerFactory: o => createAudioPeer({ ...o, stun: [] }), onStatus: s => statuses.push(s.status) });
    await a.dialOut({ to: "+4917012345678" });
    await request(a, { body: callWebhook({ id: "wacid.out1", event: "connect", direction: "BUSINESS_INITIATED", session: { sdp_type: "answer", sdp: w.answer() } }) });
    if (outcome === "REJECTED") await request(a, { body: statusWebhook("wacid.out1", "REJECTED") });
    else await sleep(1300);
    await request(a, { body: callWebhook({ id: "wacid.out1", event: "terminate", status: "COMPLETED" }) });
    assert.deepEqual(statuses, [outcome === "REJECTED" ? "busy" : "no-answer"], outcome);
    assert.ok(!received.some(m => m.type === "call_connected"), `${outcome}: no conversation`);
    assert.equal(a.calls, 0);
    assert.equal(w.graphCalls.filter(b => b.action === "terminate").length, outcome === "REJECTED" ? 0 : 1, `${outcome}: terminate only when we gave up`);
    await w.callee.close();
  }
});

test("callEvents: a call's status can come in the messages field; a message's can't", () => {
  const delivery = field => ({ entry: [{ changes: [{ field, value: { statuses: [{ id: "wacid.9", type: "call", status: "ACCEPTED" }, { id: "wamid.1", status: "delivered" }] } }] }] });
  assert.deepEqual(callEvents(delivery("messages")).map(e => e.status.id), ["wacid.9"]);
  assert.equal(callEvents(delivery("calls")).length, 2);
});
