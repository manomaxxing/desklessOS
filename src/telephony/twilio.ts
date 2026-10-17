// Twilio Programmable Voice with Media Streams (the German number, region IE1).
//   Inbound:  the number's voice webhook → POST /twilio/voice → TwiML <Connect><Stream>
//             to wss://…/twilio/stream, with a signed token as a stream parameter.
//   Media:    μ-law 8 kHz both ways (audio.ts fromPhone/toPhone), translated into the
//             call host's frames; marks, clear and hang-up map one to one.
//   Outbound: dialOut() creates the call over REST (Url = /twilio/voice?direction=outbound…),
//             with async answering-machine detection (/twilio/amd) and status callbacks
//             (/twilio/status: busy, no-answer, failed before anyone picked up).
//   Security: every webhook carries X-Twilio-Signature (HMAC-SHA1 with the auth token over
//             the URL and the sorted form fields); the stream's first message must carry our
//             token (HMAC over the call sid and an expiry).
//   Several instances: Twilio's webhooks and the call's stream may land on different ones,
//             so the answering-machine verdict goes out on the bus (src/bus.ts) to whichever
//             instance has the stream.
// env: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER (E.164), PUBLIC_URL (https://…),
//      TWILIO_REGION (ie1) + TWILIO_EDGE (dublin) for the EU REST endpoint,
//      TWILIO_API_KEY + TWILIO_API_SECRET instead of the auth token for REST (optional),
//      MAX_CALL_MIN (15): the call is wrapped up before that.

import { createHmac } from "node:crypto";
import { safeEqual as same } from "../shared/safe-equal.ts";
import { isRecord } from "../shared/is-record.ts";
import { fromPhone, toPhone } from "../engine/audio.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RawData, WebSocketServer } from "ws";
import type { CallHost, HostConnection } from "./host.ts";
import type { UpgradeAdapter } from "./dial.ts";
import type { Bus } from "../bus.ts";
import type { CarrierStatus } from "../types/call.ts";
import type { FrameIn, Line } from "../types/call.ts";
import type { Log } from "../types/common.ts";

type Env = Record<string, string | undefined>;
const xml = (s: unknown): string => String(s ?? "").replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] ?? c);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Twilio's request signature: base64 HMAC-SHA1 of the full URL + each form field's name and value, sorted by name. */
export function twilioSignature(url: string, params: Record<string, string> | null | undefined, authToken: string): string {
  const p = params ?? {};
  const data = url + Object.keys(p).sort().map(k => `${k}${p[k]}`).join("");
  return createHmac("sha1", authToken).update(data).digest("base64");
}
export const verifyTwilioSignature = (url: string, params: Record<string, string>, signature: unknown, authToken: string): boolean => Boolean(signature && authToken) && same(String(signature), twilioSignature(url, params, authToken));

/** The stream's token: which call it's for, until when, signed with our key. */
export function streamToken(callSid: string, key: string, ttlMs = 5 * 60 * 1000, now = Date.now()): string {
  const exp = now + ttlMs;
  return `${exp}.${createHmac("sha256", key).update(`twilio-stream:${callSid}:${exp}`).digest("base64url")}`;
}
export function checkStreamToken(token: unknown, callSid: string, key: string, now = Date.now()): boolean {
  const [exp, sig] = String(token ?? "").split(".");
  if (!exp || !sig || Number(exp) < now) return false;
  return same(sig, createHmac("sha256", key).update(`twilio-stream:${callSid}:${exp}`).digest("base64url"));
}

export function streamTwiml({ streamUrl, params }: { streamUrl: string; params: Record<string, string | null | undefined> }): string {
  const p = Object.entries(params).filter(([, v]) => v != null && v !== "").map(([k, v]) => `<Parameter name="${xml(k)}" value="${xml(v)}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="${xml(streamUrl)}">${p}</Stream></Connect></Response>`;
}

/** Twilio's media stream as the bridge uses it: a ws WebSocket, or a test's stand-in. */
export interface StreamSocket {
  readonly readyState?: number;
  send(data: string): void;
  close(): void;
  on(event: "message", fn: (data: RawData) => void): unknown;
  on(event: "close", fn: () => void): unknown;
}

export interface StreamBridge {
  readonly callSid: string | null;
  deliver(frame: FrameIn): void;
}

/**
 * One Twilio media stream ↔ one line of the call host. `ws`: anything with send(),
 * close() and on("message" | "close"). Frames in Dial's protocol go to `conn`.
 */
export function bridgeStream(ws: StreamSocket, { host, key, maxCallMs = 15 * 60 * 1000, answeredBy = new Map(), log = () => {} }: {
  host: Pick<CallHost, "connect">;
  key: string;
  maxCallMs?: number;
  answeredBy?: Map<string, string>;
  log?: Log;
}): StreamBridge {
  let streamSid: string | null = null;
  let callSid: string | null = null;
  let conn: HostConnection | null = null;
  let timers: ReturnType<typeof setTimeout>[] = [];
  const toTwilio = (m: Record<string, unknown>) => { if (ws.readyState === undefined || ws.readyState === 1) ws.send(JSON.stringify(m)); };
  // Into the call (the host's receive doesn't reject; a stray error is logged, never unhandled).
  const deliver = (frame: FrameIn) => { conn?.receive(frame).catch((err: unknown) => log("twilio call error", errText(err))); };
  const line: Line = {
    send(frame) {
      if (!streamSid) return;
      if (frame.type === "media") toTwilio({ event: "media", streamSid, media: { payload: toPhone(Buffer.from(frame.payload, "base64")).toString("base64") } });
      else if (frame.type === "mark") toTwilio({ event: "mark", streamSid, mark: { name: frame.name } });
      else if (frame.type === "clear") toTwilio({ event: "clear", streamSid });
      else if (frame.type === "end_call") timers.push(setTimeout(() => ws.close(), 100)); // no TwiML after <Connect>: closing the stream hangs up
    },
    close: () => ws.close(),
  };

  // A stream must start with Twilio's signed "start" within a few seconds; anything else is closed
  // (an idle socket would hold a billed request slot open).
  const startTimer = setTimeout(() => { if (!conn) { log("twilio: stream never started, closed"); ws.close(); } }, 5000);
  startTimer.unref?.();
  ws.on("message", data => {
    let m: unknown;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (!isRecord(m)) return;
    if (m.event === "start") {
      clearTimeout(startTimer);
      const start = isRecord(m.start) ? m.start : {};
      const p = isRecord(start.customParameters) ? start.customParameters : {};
      callSid = text(start.callSid);
      if (!callSid || !checkStreamToken(p.token, callSid, key)) { log(`twilio: stream without a valid token (${callSid ?? "?"}), closed`); ws.close(); return; }
      streamSid = text(start.streamSid) ?? text(m.streamSid);
      conn = host.connect(line, { callId: callSid, reconnects: false, source: "twilio" });
      deliver({
        type: "call_connected", call_id: callSid, from: text(p.from), to: text(p.to), direction: p.direction === "outbound" ? "outbound" : "inbound",
        user_id: text(p.userId) || null, job_id: text(p.jobId) || null, language: null, formats: { inbound: "mulaw_8000", outbound: "mulaw_8000" }, reconnect: false,
      });
      const verdict = answeredBy.get(callSid);
      if (verdict) deliver({ type: "answered_by", answered_by: verdict });
      timers.push(setTimeout(() => deliver({ type: "duration_warning" }), Math.max(0, maxCallMs - 30000)));
      timers.push(setTimeout(() => ws.close(), maxCallMs));
      return;
    }
    if (!conn) return;
    const media = isRecord(m.media) ? m.media : null;
    if (m.event === "media" && media && typeof media.payload === "string" && (!media.track || media.track === "inbound")) deliver({ type: "media", payload: fromPhone(Buffer.from(media.payload, "base64")).toString("base64") });
    else if (m.event === "mark") deliver({ type: "mark", name: isRecord(m.mark) ? text(m.mark.name) ?? undefined : undefined });
    else if (m.event === "stop") deliver({ type: "call_ended", reason: "caller_hangup" });
  });
  ws.on("close", () => {
    clearTimeout(startTimer);
    for (const t of timers) clearTimeout(t);
    timers = [];
    if (conn && !conn.entry?.session.ended) deliver({ type: "call_ended", reason: "line_closed" });
    conn?.closed();
  });
  return { get callSid() { return callSid; }, deliver };
}

/** Twilio's webhooks and media streams, and calls out. Null without its settings. */
export interface TwilioAdapter extends UpgradeAdapter {
  number: string | undefined;
  http(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  dialOut(o: { to: string; userId: string | null; jobId: string | null }): Promise<{ callId: string; carrier: string }>;
}

export function twilioAdapter({ host, wss, bus = null, env = process.env, onStatus = () => {}, monitor = null, log = () => {}, fetchImpl = fetch }: {
  host: Pick<CallHost, "connect">;
  wss: Pick<WebSocketServer, "handleUpgrade">;
  bus?: Pick<Bus, "publish" | "subscribe"> | null;
  env?: Env;
  onStatus?: (s: CarrierStatus) => void;
  monitor?: { system(text: string, level?: string): void } | null;
  log?: Log;
  fetchImpl?: typeof fetch;
}): TwilioAdapter | null {
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
  const answeredBy = new Map<string, string>(); // call sid → AnsweredBy, when it comes before the stream
  const streams = new Map<string, StreamBridge>(); // call sid → bridge (the streams on this instance)
  const verdict = ({ callId, value }: { callId: string; value: string }) => {
    if (answeredBy.size > 1000) { const oldest = answeredBy.keys().next().value; if (oldest !== undefined) answeredBy.delete(oldest); } // a call is long over by then
    answeredBy.set(callId, value);
    streams.get(callId)?.deliver({ type: "answered_by", answered_by: value });
  };
  bus?.subscribe(m => { if (m.type === "answered_by" && typeof m.callId === "string") verdict({ callId: m.callId, value: String(m.value ?? "unknown") }); });

  const readForm = (req: IncomingMessage) => new Promise<Record<string, string>>((resolve, reject) => {
    let body = "";
    req.on("data", (c: Buffer | string) => { body += c; if (body.length > 1e5) req.destroy(); });
    req.on("end", () => resolve(Object.fromEntries(new URLSearchParams(body))));
    req.on("error", reject);
  });
  const signed = (req: IncomingMessage, url: URL, params: Record<string, string>) => verifyTwilioSignature(`${publicUrl}${url.pathname}${url.search}`, params, req.headers["x-twilio-signature"], authToken);

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
            token: streamToken(params.CallSid ?? "", key), callId: params.CallSid, direction: outbound ? "outbound" : "inbound",
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
        const msg = { callId: params.CallSid ?? "", value: params.AnsweredBy ?? "unknown" };
        if (bus) bus.publish({ type: "answered_by", ...msg }); // every instance, this one too
        else verdict(msg);
        res.writeHead(204).end();
        return true;
      }
      if (url.pathname === "/twilio/status") {
        const callId = params.CallSid ?? "";
        onStatus({ callId, status: params.CallStatus ?? "", answeredBy: params.AnsweredBy ?? answeredBy.get(callId) ?? null, duration: Number(params.CallDuration || 0), carrier: "twilio" });
        if (["completed", "busy", "no-answer", "failed", "canceled"].includes(params.CallStatus ?? "")) answeredBy.delete(callId);
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
        ws.on("close", () => { if (bridge.callSid) streams.delete(bridge.callSid); });
      });
      return true;
    },

    /** Rings `to` from our number. Returns { callId } (Twilio's call sid); the call itself arrives through /twilio/voice. */
    async dialOut({ to, userId, jobId }) {
      if (!number) throw new Error("no TWILIO_NUMBER to call from");
      const back = (path: string) => `${publicUrl}${path}`;
      const form = new URLSearchParams({
        To: to, From: number, Method: "POST", Timeout: "25",
        Url: back(`/twilio/voice?direction=outbound&user=${encodeURIComponent(userId ?? "")}&job=${encodeURIComponent(jobId ?? "")}`),
        StatusCallback: back("/twilio/status"), StatusCallbackMethod: "POST",
        MachineDetection: "Enable", AsyncAmd: "true", AsyncAmdStatusCallback: back("/twilio/amd"), AsyncAmdStatusCallbackMethod: "POST",
      });
      for (const e of ["initiated", "ringing", "answered", "completed"]) form.append("StatusCallbackEvent", e);
      const res = await fetchImpl(`${api}/2010-04-01/Accounts/${sid}/Calls.json`, {
        method: "POST", headers: { authorization: restAuth, "content-type": "application/x-www-form-urlencoded" }, body: form, signal: AbortSignal.timeout(15000),
      });
      const body: unknown = await res.json().catch(() => ({}));
      const out = isRecord(body) ? body : {};
      if (!res.ok) throw new Error(`twilio ${res.status}: ${text(out.message) ?? "call not created"}`);
      if (typeof out.sid !== "string") throw new Error("twilio: no call sid came back");
      return { callId: out.sid, carrier: "twilio" };
    },
  };
}
