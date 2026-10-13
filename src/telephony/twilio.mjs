// Twilio Programmable Voice with Media Streams (the German number, region IE1).
//   Inbound:  the number's voice webhook → POST /twilio/voice → TwiML <Connect><Stream>
//             to wss://…/twilio/stream, with a signed token as a stream parameter.
//   Media:    μ-law 8 kHz both ways (audio.mjs fromPhone/toPhone), translated into the
//             call host's frames; marks, clear and hang-up map one to one.
//   Outbound: dialOut() creates the call over REST (Url = /twilio/voice?direction=outbound…),
//             with async answering-machine detection (/twilio/amd) and status callbacks
//             (/twilio/status: busy, no-answer, failed before anyone picked up).
//   Security: every webhook carries X-Twilio-Signature (HMAC-SHA1 with the auth token over
//             the URL and the sorted form fields); the stream's first message must carry our
//             token (HMAC over the call sid and an expiry).
// env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER (E.164), PUBLIC_URL (https://…),
//      TWILIO_REGION (ie1) + TWILIO_EDGE (dublin) for the EU REST endpoint,
//      TWILIO_API_KEY + TWILIO_API_SECRET instead of the auth token for REST (optional),
//      MAX_CALL_MIN (15): the call is wrapped up before that.

import { createHmac, timingSafeEqual } from "node:crypto";
import { fromPhone, toPhone } from "../engine/audio.mjs";

const xml = s => String(s ?? "").replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** Twilio's request signature: base64 HMAC-SHA1 of the full URL + each form field's name and value, sorted by name. */
export function twilioSignature(url, params, authToken) {
  const data = url + Object.keys(params ?? {}).sort().map(k => `${k}${params[k]}`).join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}
export const verifyTwilioSignature = (url, params, signature, authToken) => Boolean(signature && authToken) && same(String(signature), twilioSignature(url, params, authToken));

/** The stream's token: which call it's for, until when, signed with our key. */
export function streamToken(callSid, key, ttlMs = 5 * 60 * 1000, now = Date.now()) {
  const exp = now + ttlMs;
  return `${exp}.${createHmac("sha256", key).update(`twilio-stream:${callSid}:${exp}`).digest("base64url")}`;
}
export function checkStreamToken(token, callSid, key, now = Date.now()) {
  const [exp, sig] = String(token ?? "").split(".");
  if (!exp || !sig || Number(exp) < now) return false;
  return same(sig, createHmac("sha256", key).update(`twilio-stream:${callSid}:${exp}`).digest("base64url"));
}

export function streamTwiml({ streamUrl, params }) {
  const p = Object.entries(params).filter(([, v]) => v != null && v !== "").map(([k, v]) => `<Parameter name="${xml(k)}" value="${xml(v)}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(streamUrl)}">${p}</Stream></Connect></Response>`;
}

/**
 * One Twilio media stream ↔ one line of the call host. `ws`: anything with send(),
 * close() and on("message" | "close"). Frames in Dial's protocol go to `conn`.
 */
export function bridgeStream(ws, { host, key, maxCallMs = 15 * 60 * 1000, answeredBy = new Map(), log = () => {} }) {
  let streamSid = null;
  let callSid = null;
  let conn = null;
  let timers = [];
  const toTwilio = m => { if (ws.readyState === undefined || ws.readyState === 1) ws.send(JSON.stringify(m)); };
  const line = {
    send(frame) {
      if (!streamSid) return;
      if (frame.type === "media") toTwilio({ event: "media", streamSid, media: { payload: toPhone(Buffer.from(frame.payload, "base64")).toString("base64") } });
      else if (frame.type === "mark") toTwilio({ event: "mark", streamSid, mark: { name: frame.name } });
      else if (frame.type === "clear") toTwilio({ event: "clear", streamSid });
      else if (frame.type === "end_call") setTimeout(() => ws.close(), 100); // no TwiML after <Connect>: closing the stream hangs up
    },
    close: () => ws.close(),
  };

  ws.on("message", data => {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.event === "start") {
      const p = m.start?.customParameters ?? {};
      callSid = m.start?.callSid ?? null;
      if (!callSid || !checkStreamToken(p.token, callSid, key)) { log(`twilio: stream without a valid token (${callSid ?? "?"}), closed`); ws.close(); return; }
      streamSid = m.start.streamSid ?? m.streamSid;
      conn = host.connect(line, { callId: callSid, reconnects: false, source: "twilio" });
      conn.receive({
        type: "call_connected", call_id: callSid, from: p.from ?? null, to: p.to ?? null, direction: p.direction === "outbound" ? "outbound" : "inbound",
        user_id: p.userId || null, job_id: p.jobId || null, language: null, formats: { inbound: "mulaw_8000", outbound: "mulaw_8000" }, reconnect: false,
      }).catch(err => log("twilio call error", err.message));
      if (answeredBy.has(callSid)) conn.receive({ type: "answered_by", answered_by: answeredBy.get(callSid) });
      timers.push(setTimeout(() => conn?.receive({ type: "duration_warning" }), Math.max(0, maxCallMs - 30000)));
      timers.push(setTimeout(() => ws.close(), maxCallMs));
      return;
    }
    if (!conn) return;
    if (m.event === "media" && (!m.media?.track || m.media.track === "inbound")) conn.receive({ type: "media", payload: fromPhone(Buffer.from(m.media.payload, "base64")).toString("base64") });
    else if (m.event === "mark") conn.receive({ type: "mark", name: m.mark?.name });
    else if (m.event === "stop") conn.receive({ type: "call_ended", reason: "caller_hangup" });
  });
  ws.on("close", () => {
    for (const t of timers) clearTimeout(t);
    timers = [];
    if (conn && !conn.entry?.session.ended) conn.receive({ type: "call_ended", reason: "line_closed" }).catch(() => {});
    conn?.closed();
  });
  return { get callSid() { return callSid; }, deliver: frame => conn?.receive(frame) };
}

export function twilioAdapter({ host, wss, env = process.env, onStatus = () => {}, monitor = null, log = () => {}, fetchImpl = fetch }) {
  const sid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const number = env.TWILIO_NUMBER?.trim();
  const publicUrl = env.PUBLIC_URL?.trim().replace(/\/$/, "");
  if (!sid || !authToken || !publicUrl) return null;
  const key = env.SESSION_SECRET?.trim() || authToken;
  const region = env.TWILIO_REGION?.trim();
  const edge = env.TWILIO_EDGE?.trim();
  const api = region && region !== "us1" ? `https://api.${edge || "dublin"}.${region}.twilio.com` : "https://api.twilio.com";
  const restAuth = `Basic ${Buffer.from(`${env.TWILIO_API_KEY?.trim() || sid}:${env.TWILIO_API_SECRET?.trim() || authToken}`).toString("base64")}`;
  const maxCallMs = Number(env.MAX_CALL_MIN || 15) * 60000;
  const streamUrl = `${publicUrl.replace(/^http/, "ws")}/twilio/stream`;
  const answeredBy = new Map(); // call sid → AnsweredBy, when it comes before the stream
  const streams = new Map(); // call sid → bridge

  const readForm = req => new Promise((resolve, reject) => {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on("error", reject);
  });
  const signed = (req, url, params) => verifyTwilioSignature(`${publicUrl}${url.pathname}${url.search}`, params, req.headers["x-twilio-signature"], authToken);

  return {
    id: "twilio",
    number,

    async http(req, res, url) {
      if (!url.pathname.startsWith("/twilio/") || url.pathname === "/twilio/stream") return false;
      const params = req.method === "POST" ? await readForm(req) : {};
      if (!signed(req, url, params)) {
        log(`twilio: refused ${url.pathname} (bad signature)`);
        res.writeHead(403).end();
        return true;
      }
      if (url.pathname === "/twilio/voice") {
        const outbound = url.searchParams.get("direction") === "outbound";
        const twiml = streamTwiml({
          streamUrl,
          params: {
            token: streamToken(params.CallSid, key), callId: params.CallSid, direction: outbound ? "outbound" : "inbound",
            from: params.From, to: params.To, userId: url.searchParams.get("user"), jobId: url.searchParams.get("job"),
          },
        });
        res.writeHead(200, { "content-type": "text/xml" });
        res.end(twiml);
        monitor?.system(`Twilio ${outbound ? "outbound" : "inbound"} call ${params.CallSid} ${params.From ?? "?"} → ${params.To ?? "?"}`);
        return true;
      }
      if (url.pathname === "/twilio/amd") {
        // Async answering-machine detection: a machine gets no message, we hang up and retry later.
        const value = params.AnsweredBy ?? "unknown";
        answeredBy.set(params.CallSid, value);
        streams.get(params.CallSid)?.deliver({ type: "answered_by", answered_by: value });
        res.writeHead(204).end();
        return true;
      }
      if (url.pathname === "/twilio/status") {
        onStatus({ callId: params.CallSid, status: params.CallStatus, answeredBy: params.AnsweredBy ?? answeredBy.get(params.CallSid) ?? null, duration: Number(params.CallDuration || 0), carrier: "twilio" });
        if (["completed", "busy", "no-answer", "failed", "canceled"].includes(params.CallStatus)) answeredBy.delete(params.CallSid);
        res.writeHead(204).end();
        return true;
      }
      res.writeHead(404).end();
      return true;
    },

    upgrade(req, socket, head, url) {
      if (url.pathname !== "/twilio/stream") return false;
      wss.handleUpgrade(req, socket, head, ws => {
        const bridge = bridgeStream(ws, { host, key, maxCallMs, answeredBy, log });
        ws.on("message", () => { if (bridge.callSid && !streams.has(bridge.callSid)) streams.set(bridge.callSid, bridge); });
        ws.on("close", () => streams.delete(bridge.callSid));
      });
      return true;
    },

    /** Rings `to` from our number. Returns { callId } (Twilio's call sid); the call itself arrives through /twilio/voice. */
    async dialOut({ to, userId, jobId }) {
      if (!number) throw new Error("no TWILIO_NUMBER to call from");
      const back = path => `${publicUrl}${path}`;
      const form = new URLSearchParams({
        To: to, From: number, Method: "POST", Timeout: "25",
        Url: back(`/twilio/voice?direction=outbound&user=${encodeURIComponent(userId)}&job=${encodeURIComponent(jobId)}`),
        StatusCallback: back("/twilio/status"), StatusCallbackMethod: "POST",
        MachineDetection: "Enable", AsyncAmd: "true", AsyncAmdStatusCallback: back("/twilio/amd"), AsyncAmdStatusCallbackMethod: "POST",
      });
      for (const e of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", e);
      const res = await fetchImpl(`${api}/2010-04-01/Accounts/${sid}/Calls.json`, {
        method: "POST", headers: { authorization: restAuth, "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`twilio ${res.status}: ${body.message ?? "call not created"}`);
      return { callId: body.sid, carrier: "twilio" };
    },
  };
}
