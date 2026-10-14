// Twilio with several instances: webhooks and the call's stream may land on different ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { twilioSignature, streamToken, twilioAdapter } from "../src/telephony/twilio.mjs";
import { createCallHost } from "../src/telephony/host.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
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
  const host = createCallHost({ startCall: async () => ({ session: { ended: false, handle: m => frames.push(m), close() {} } }) });
  return { host, frames };
}
test("Twilio, two instances: the machine verdict reaches the instance that has the stream", async () => {
  const subscribers = [];
  const bus = { publish: m => subscribers.forEach(fn => fn(m)), subscribe: fn => subscribers.push(fn) };
  const env = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", PUBLIC_URL: "https://deskless.test", SESSION_SECRET: "k" };
  const ws = fakeWs();
  const wss = { handleUpgrade: (req, socket, head, cb) => cb(ws) };
  const b = recordingHost();
  const onB = twilioAdapter({ host: b.host, wss, bus, env });
  const onA = twilioAdapter({ host: recordingHost().host, wss, bus, env });
  onB.upgrade({}, {}, null, new URL("https://x/twilio/stream"));
  ws.emit("message", JSON.stringify({ event: "start", streamSid: "MZ1", start: { callSid: "CA7", streamSid: "MZ1", customParameters: { token: streamToken("CA7", "k"), direction: "outbound" } } }));
  ws.emit("message", JSON.stringify({ event: "media", media: { payload: Buffer.alloc(160, 0xff).toString("base64") } })); // the stream is known once it talks
  await sleep(10);
  // Twilio's async AMD callback lands on instance A.
  const params = { CallSid: "CA7", AnsweredBy: "machine_start" };
  const req = new EventEmitter();
  req.method = "POST";
  req.headers = { "x-twilio-signature": twilioSignature("https://deskless.test/twilio/amd", params, "tok") };
  let status = null;
  const res = { writeHead: s => { status = s; return res; }, end: () => {} };
  const handled = onA.http(req, res, new URL("https://deskless.test/twilio/amd"));
  req.emit("data", new URLSearchParams(params).toString());
  req.emit("end");
  assert.equal(await handled, true);
  assert.equal(status, 204);
  assert.deepEqual(b.frames.at(-1), { type: "answered_by", answered_by: "machine_start" }, "delivered on instance B");
  ws.close(); // ends the call: its timers stop
});

