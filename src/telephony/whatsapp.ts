// WhatsApp calls through Meta's Cloud API (Calling): he calls the business number in
// WhatsApp, Toni answers; or Toni calls him (dialOut).
//   Signalling: Meta's webhook (POST /whatsapp/webhook, X-Hub-Signature-256 with the app
//             secret) brings the call with an SDP offer; we answer over the Graph API
//             (pre_accept, then accept with the same SDP) and hang up with terminate.
//   Toni calls: connect with our SDP offer; Meta's answer comes back in a connect webhook
//             right away (the media connects while it rings), then status webhooks: RINGING,
//             ACCEPTED (he picked up: the conversation starts) or REJECTED. Meta only lets a
//             business call someone who allowed it; calling the business number allows it for
//             7 days when the number's callback_permission_status is on.
//   Media:    WebRTC, Opus (src/telephony/webrtc-audio.ts), translated into the call
//             host's frames. Our audio flows only once accept has returned 200, as Meta asks.
//   Hosting:  the audio is UDP, not an HTTP request, so the instance needs its CPU between
//             requests: these calls run on a second Cloud Run service with CPU always on
//             and one instance at most (deploy/cloudrun.sh, WHATSAPP_SERVICE), so a call's
//             webhooks all land where its audio is.
// env: WHATSAPP_TOKEN (a system user's token), WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET,
//      WHATSAPP_VERIFY_TOKEN (the webhook's handshake; derived from SESSION_SECRET if unset),
//      WHATSAPP_GRAPH (v26.0), MAX_CALL_MIN (15), WHATSAPP_RING_S (45: how long Toni lets it ring).
// Shutting down hangs up every call here (closeAll waits for WhatsApp's answers, briefly). A call
// Toni placed whose connect got no answer (a timeout) may ring all the same: its webhooks say so,
// and it's hung up.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createAudioPeer } from "./webrtc-audio.ts";
import { isRecord } from "../shared/is-record.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AudioPeer, AudioPeerOptions } from "./webrtc-audio.ts";
import type { CallHost, HostConnection } from "./host.ts";
import type { CarrierStatus } from "../types/call.ts";
import type { FrameIn, Line } from "../types/call.ts";
import type { Log } from "../types/common.ts";

type Env = Record<string, string | undefined>;
const GRAPH = "https://graph.facebook.com";
const CLOSE_MS = 3000; // shutting down: how long the hang-ups may take (Cloud Run gives 10 s after SIGTERM)
const STRAY_MS = 60000; // after a connect that got no answer: how long its call's webhooks are watched for
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Meta's webhook signature: "sha256=" + hex HMAC-SHA256 of the raw body with the app secret. */
export function verifyMetaSignature(rawBody: Buffer, header: unknown, appSecret: string): boolean {
  if (typeof header !== "string" || !header || !appSecret) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return expected.length === header.length && timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

export const whatsappVerifyToken = (env: Env): string => env.WHATSAPP_VERIFY_TOKEN?.trim() || (env.SESSION_SECRET ? createHmac("sha256", env.SESSION_SECRET).update("whatsapp-webhook").digest("base64url").slice(0, 32) : "");

/** A call in a webhook (Meta's fields, as far as we read them). */
export interface WaCall {
  id: string;
  event?: string;
  direction?: string;
  from?: string;
  to?: string;
  session?: { sdp_type?: string; sdp?: string };
  status?: string;
  duration?: unknown;
  errors?: unknown;
}
/** A call's status in a webhook: RINGING, ACCEPTED, REJECTED. */
export interface WaStatus {
  id: string;
  status?: string;
  type?: string;
  recipient_id?: string;
}
export type WaEvent =
  | { call: WaCall; status?: undefined; phoneNumberId: string | null; number: string | null; contact: unknown }
  | { status: WaStatus; call?: undefined };

function readCall(v: unknown): WaCall | null {
  if (!isRecord(v) || typeof v.id !== "string") return null;
  const session = isRecord(v.session) ? { sdp_type: str(v.session.sdp_type), sdp: str(v.session.sdp) } : undefined;
  return { id: v.id, event: str(v.event), direction: str(v.direction), from: str(v.from), to: str(v.to), session, status: str(v.status), duration: v.duration, errors: v.errors };
}
function readStatus(v: unknown): WaStatus | null {
  if (!isRecord(v) || typeof v.id !== "string") return null;
  return { id: v.id, status: str(v.status), type: str(v.type), recipient_id: str(v.recipient_id) };
}
const records = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** The call events in one webhook delivery: [{ call }] and [{ status }]. */
export function callEvents(body: unknown): WaEvent[] {
  const out: WaEvent[] = [];
  for (const entry of records(isRecord(body) ? body.entry : null)) {
    for (const change of records(entry.changes)) {
      if (change.field !== "calls" && change.field !== "messages") continue;
      const v = isRecord(change.value) ? change.value : {};
      const metadata = isRecord(v.metadata) ? v.metadata : {};
      if (change.field === "calls") {
        for (const raw of Array.isArray(v.calls) ? v.calls : []) {
          const call = readCall(raw);
          if (call) out.push({ call, phoneNumberId: str(metadata.phone_number_id) ?? null, number: str(metadata.display_phone_number) ?? null, contact: Array.isArray(v.contacts) ? v.contacts[0] ?? null : null });
        }
      }
      // A call's RINGING / ACCEPTED / REJECTED (calls Toni makes); a message's statuses aren't ours.
      for (const raw of Array.isArray(v.statuses) ? v.statuses : []) {
        const status = readStatus(raw);
        if (status && (change.field === "calls" || status.type === "call")) out.push({ status });
      }
    }
  }
  return out;
}

const plus = (n: unknown): string | null => (n ? (String(n).startsWith("+") ? String(n) : `+${n}`) : null);
const digits = (n: unknown): string => String(n ?? "").replace(/\D/g, "");
/** A call id for the logs: WhatsApp's ids all end alike ("…NxUCABUSAA=="); their start tells them apart. */
export const shortCallId = (id: unknown): string => (String(id ?? "").startsWith("wacid.") ? String(id).slice(10, 22) : String(id ?? "").slice(-12));

/** One line about an SDP, for the logs: codecs, ICE-lite, DTLS role, candidates. */
export function sdpSummary(sdp = ""): string {
  const all = (re: RegExp) => [...sdp.matchAll(re)].map(m => m[1]);
  const cands = all(/a=candidate:\S+ \d+ (\w+ \d+ \S+ \d+ typ \w+)/g).map(c => { const [proto, , ip, port, , typ] = c.split(" "); return `${typ} ${proto.toLowerCase()} ${ip}:${port}`; });
  return [
    `codecs ${all(/a=rtpmap:(\d+ [\w-]+\/\d+)/g).join(", ") || "-"}`,
    /a=ice-lite/.test(sdp) ? "ice-lite" : "full ice",
    `setup ${all(/a=setup:(\w+)/g)[0] ?? "-"}`,
    `fingerprint ${all(/a=fingerprint:(\S+)/g)[0] ?? "-"}`,
    `candidates ${cands.length ? cands.join("; ") : "none"}`,
  ].join(" · ");
}

/** Graph answered with an error (an HTTP status): nothing was done. Anything else (a timeout) leaves it open. */
class GraphError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
async function graphReply(res: Response, what: string): Promise<Record<string, unknown>> {
  const body: unknown = await res.json().catch(() => ({}));
  const out = isRecord(body) ? body : {};
  if (!res.ok) {
    const error = isRecord(out.error) ? out.error : {};
    const details = isRecord(error.error_data) ? str(error.error_data.details) : undefined;
    throw new GraphError(`whatsapp ${what} ${res.status}: ${str(error.message) ?? "failed"}${details ? ` (${details})` : ""}`, res.status);
  }
  return out;
}

/** Whether Toni may call him (WhatsApp's call permission). */
export type CallPermission = { status: string; until: number | null; canCall: boolean; canAsk: boolean };

export interface WhatsAppSender {
  callPermission(to: string): Promise<CallPermission>;
  requestCallPermission(o: { to: string; text: string }): Promise<{ messageId: string | null }>;
  sendText(o: { to: string; text: string }): Promise<{ messageId: string | null }>;
  sendDocument(o: { to: string; bytes: Uint8Array; filename: string; caption?: string; type?: string }): Promise<{ messageId: string | null }>;
}

/**
 * Messages from the business number (not calls): a text or a document into his chat. Free while his
 * chat window is open, and his call opens it (accepted or not), so a PDF sent during the call
 * costs nothing. Null without WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID.
 */
export function whatsappSender({ env = process.env, fetchImpl = fetch }: { env?: Env; fetchImpl?: typeof fetch } = {}): WhatsAppSender | null {
  const token = env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) return null;
  const base = `${GRAPH}/${env.WHATSAPP_GRAPH?.trim() || "v26.0"}/${phoneNumberId}`;
  async function graph(path: string, init: RequestInit & { headers?: Record<string, string> }): Promise<Record<string, unknown>> {
    const res = await fetchImpl(`${base}/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(10000) });
    return graphReply(res, path);
  }
  const send = async (to: string, message: Record<string, unknown>) => {
    const sent = await graph("messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: digits(to), ...message }),
    });
    const first = Array.isArray(sent.messages) && isRecord(sent.messages[0]) ? sent.messages[0] : {};
    return { messageId: str(first.id) ?? null };
  };
  return {
    /** Whether Toni may call him: { status: no_permission | temporary | permanent, until (ms) | null, canCall, canAsk }. */
    async callPermission(to) {
      const out = await graph(`call_permissions?user_wa_id=${digits(to)}`, { method: "GET" });
      const can = (name: string) => Boolean(records(out.actions).find(a => a.action_name === name)?.can_perform_action);
      const permission = isRecord(out.permission) ? out.permission : {};
      const until = Number(permission.expiration_time ?? permission.expiration ?? 0) || null;
      return { status: str(permission.status) ?? "no_permission", until: until ? until * 1000 : null, canCall: can("start_call"), canAsk: can("send_call_permission_request") };
    },
    /** Asks him in his chat to allow Toni's calls (a button). Only while his chat is open: he called or wrote in the last 24 h. */
    requestCallPermission: ({ to, text }) => send(to, { type: "interactive", interactive: { type: "call_permission_request", action: { name: "call_permission_request" }, body: { text } } }),
    /** sendText({ to: "+49…", text }) → { messageId } */
    sendText: ({ to, text }) => send(to, { type: "text", text: { body: text, preview_url: false } }),
    /** sendDocument({ to: "+49…", bytes, filename, caption }) → { messageId } */
    async sendDocument({ to, bytes, filename, caption = "", type = "application/pdf" }) {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", type);
      form.append("file", new Blob([new Uint8Array(bytes)], { type }), filename);
      const media = await graph("media", { method: "POST", body: form });
      const id = str(media.id);
      if (!id) throw new Error("whatsapp media: no id came back");
      return send(to, { type: "document", document: { id, filename, caption } });
    },
  };
}

/** A call Toni makes, as it goes: his number, ours, and how far it got. */
interface Outgoing {
  to: string | null;
  userId: string | null;
  jobId: string | null;
  extra: Record<string, unknown>;
  number: string | null;
  sdp: boolean;
  ready: boolean;
  answered: boolean;
  begun: boolean;
  loud: number;
}
/** One WhatsApp call on this instance: its WebRTC leg, its line into the call host, its timers. */
interface WaLine {
  id: string | null;
  peer: AudioPeer;
  line: Line;
  conn: HostConnection | null;
  timers: ReturnType<typeof setTimeout>[];
  ended: boolean;
  out: Outgoing | null;
  at(): string;
}

export interface WhatsAppAdapter {
  id: "whatsapp";
  readonly calls: number;
  http(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /**
   * Toni calls him: { to: "+49…", userId?, jobId?, extra? (more call_connected fields) } → { callId, carrier }.
   * Throws when WhatsApp won't place it (no permission from him: error 138006).
   */
  dialOut(o: { to: string; userId?: string | null; jobId?: string | null; extra?: Record<string, unknown> }): Promise<{ callId: string; carrier: "whatsapp" }>;
  /** SIGTERM: hang up the calls on this instance (they're saved by the host); resolves once WhatsApp has answered, or after a few seconds. */
  closeAll(): Promise<void>;
}

export function whatsappAdapter({ host, env = process.env, monitor = null, log = () => {}, fetchImpl = fetch, peerFactory = createAudioPeer, onStatus = () => {} }: {
  host: Pick<CallHost, "connect">;
  env?: Env;
  monitor?: { system(text: string, level?: string): void } | null;
  log?: Log;
  fetchImpl?: typeof fetch;
  peerFactory?: (o: AudioPeerOptions) => AudioPeer;
  onStatus?: (s: CarrierStatus) => void;
}): WhatsAppAdapter | null {
  const token = env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const appSecret = env.WHATSAPP_APP_SECRET?.trim();
  if (!token || !phoneNumberId || !appSecret) return null;
  const verifyToken = whatsappVerifyToken(env);
  const version = env.WHATSAPP_GRAPH?.trim() || "v26.0";
  const maxCallMs = Number(env.MAX_CALL_MIN || 15) * 60000;
  const ringMs = Number(env.WHATSAPP_RING_S || 45) * 1000;
  const debug = env.WHATSAPP_DEBUG === "1"; // the full SDPs in the log (they're good for one call only)
  const calls = new Map<string, WaLine>(); // WhatsApp call id → { id, peer, conn, timers, ended, out? (a call Toni makes) }
  let placing = 0; // calls Toni is placing whose id hasn't come back yet
  const early = new Map<string, WaEvent[]>(); // their webhooks, if Meta was quicker than its own response
  const unanswered = new Map<string, number>(); // his number (digits) → until when: a connect to it got no answer, its call may ring all the same
  const strays = new Set<string>(); // calls hung up for that

  async function graph(body: Record<string, unknown> & { action: string }): Promise<Record<string, unknown>> {
    const t0 = Date.now();
    const res = await fetchImpl(`${GRAPH}/${version}/${phoneNumberId}/calls`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }), signal: AbortSignal.timeout(10000),
    });
    const out = await graphReply(res, body.action);
    log(`whatsapp: ${body.action} ok (${Date.now() - t0} ms)`);
    return out;
  }
  const terminate = (callId: string): Promise<void> => graph({ call_id: callId, action: "terminate" }).then(() => {}, (err: unknown) => log(errText(err)));
  const status = (c: WaLine, s: string) => { try { onStatus({ callId: c.id ?? "", status: s, carrier: "whatsapp" }); } catch (err) { log("whatsapp status error", errText(err)); } };
  // Into the call (the host's receive doesn't reject; a stray error is logged, never unhandled).
  const deliver = (c: WaLine, frame: FrameIn) => { c.conn?.receive(frame).catch((err: unknown) => log("whatsapp call error", errText(err))); };

  /** Ends the call here; with `hangUp`, WhatsApp is told too (the promise of that). */
  function end(callId: string | null, reason: string, { hangUp = false } = {}): Promise<void> | null {
    const c = callId ? calls.get(callId) : undefined;
    if (!callId || !c || c.ended) return null;
    c.ended = true;
    for (const t of c.timers) clearTimeout(t);
    const hungUp = hangUp ? terminate(callId) : null;
    if (c.conn && !c.conn.entry?.session.ended) deliver(c, { type: "call_ended", reason });
    c.conn?.closed();
    c.peer.close().catch(() => {});
    calls.delete(callId);
    return hungUp;
  }

  /** A call's WebRTC leg, and the line the call host speaks into (each needs the other: made together). */
  function newCall(id: string | null, out: Outgoing | null = null): WaLine {
    const t0 = Date.now();
    let self: WaLine | null = null; // the peer's callbacks come after it's made
    const peer = peerFactory({
      onAudio: pcm => { if (!self) return; if (self.conn) deliver(self, { type: "media", payload: pcm.toString("base64") }); else if (self.out) heardFirst(self, self.out, pcm); },
      onMark: name => { if (self) deliver(self, { type: "mark", name }); },
      onState: state => {
        const c = self;
        if (!c) return;
        log(`whatsapp: call ${c.id ? shortCallId(c.id) : "(placing)"} media ${state} ${c.at()}`);
        if (c.id && !c.ended && (state === "failed" || state === "closed")) {
          if (c.out && !c.conn) status(c, "failed");
          end(c.id, state === "failed" ? "media_failed" : "line_closed", { hangUp: state === "failed" });
        }
      },
      log,
    });
    const line: Line = {
      send(frame) {
        const c = self;
        if (!c) return;
        if (frame.type === "media") c.peer.play(Buffer.from(frame.payload, "base64"));
        else if (frame.type === "mark") c.peer.mark(frame.name);
        else if (frame.type === "clear") c.peer.clear();
        else if (frame.type === "end_call") setTimeout(() => end(c.id, "agent_hangup", { hangUp: true }), 300);
      },
      close: () => { if (self) end(self.id, "line_closed", { hangUp: true }); },
    };
    self = { id, peer, line, conn: null, timers: [], ended: false, out, at: () => `+${Date.now() - t0} ms` };
    return self;
  }

  /** The conversation starts: the call host gets call_connected (memory, agenda, greeting), and the call's time limit runs. */
  function begin(c: WaLine, id: string, connected: Partial<Extract<FrameIn, { type: "call_connected" }>> & Record<string, unknown>): void {
    c.conn = host.connect(c.line, { callId: id, reconnects: false, source: "whatsapp" });
    deliver(c, { type: "call_connected", call_id: id, user_id: null, job_id: null, language: null, formats: { inbound: "l16_16000", outbound: "l16_16000" }, reconnect: false, ...connected });
    c.timers.push(setTimeout(() => deliver(c, { type: "duration_warning" }), Math.max(0, maxCallMs - 30000)));
    c.timers.push(setTimeout(() => end(id, "max_duration", { hangUp: true }), maxCallMs));
  }

  async function incoming({ call, number }: { call: WaCall; number: string | null }): Promise<void> {
    const callId = call.id;
    const offer = call.session?.sdp ?? "";
    if (calls.has(callId)) return; // a webhook delivered twice
    const c = newCall(callId);
    calls.set(callId, c);
    log(`whatsapp: call ${shortCallId(callId)} from ${plus(call.from)}: offer ${sdpSummary(offer)}`);
    if (debug) log(`whatsapp: offer sdp ${offer.replace(/\r?\n/g, " | ")}`);
    try {
      const sdp = await c.peer.answer(offer);
      log(`whatsapp: call ${shortCallId(callId)} answer ${sdpSummary(sdp)} ${c.at()}`);
      if (debug) log(`whatsapp: answer sdp ${sdp.replace(/\r?\n/g, " | ")}`);
      await graph({ call_id: callId, action: "pre_accept", session: { sdp_type: "answer", sdp } });
      if (c.ended) return; // he hung up while it was ringing
      // The call starts (memory, agenda, greeting queued) while WhatsApp connects it.
      begin(c, callId, { from: plus(call.from), to: plus(call.to ?? number), direction: "inbound" });
      await graph({ call_id: callId, action: "accept", session: { sdp_type: "answer", sdp } });
      if (c.ended) return;
      c.peer.start();
      log(`whatsapp: call ${shortCallId(callId)} accepted ${c.at()}, media ${c.peer.state}`);
      monitor?.system(`WhatsApp call ${shortCallId(callId)} from ${plus(call.from) ?? "?"}`);
    } catch (err) {
      if (c.ended) return;
      log(`whatsapp: call ${callId} not answered: ${errText(err)}`);
      monitor?.system(`WhatsApp call from ${plus(call.from) ?? "?"} failed: ${errText(err)}`, "error");
      end(callId, "setup_failed", { hangUp: true });
    }
  }

  // ---------- calls Toni makes ----------
  /** He picked up (ACCEPTED), and Meta's answer is applied: our audio may flow, the conversation starts. */
  function go(c: WaLine, o: Outgoing): void {
    if (o.begun || c.ended || !o.answered || !o.ready || !c.id) return;
    o.begun = true;
    c.peer.start();
    log(`whatsapp: call ${shortCallId(c.id)} to ${o.to} answered ${c.at()}, media ${c.peer.state}`);
    monitor?.system(`WhatsApp call ${shortCallId(c.id)} to ${o.to}: answered`);
    begin(c, c.id, { from: o.number, to: o.to, direction: "outbound", user_id: o.userId, job_id: o.jobId, ...o.extra });
  }
  /** No ACCEPTED, but he's talking ("Hallo?"): he picked up. */
  function heardFirst(c: WaLine, o: Outgoing, pcm: Buffer): void {
    let sum = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
    if (Math.sqrt(sum / (pcm.length / 2)) < 1000 || ++o.loud < 10) return; // 10 loud frames, 200 ms
    if (!o.answered && o.ready) { log(`whatsapp: call ${shortCallId(c.id)}: he's talking, no ACCEPTED yet: taking it as answered`); answered(c, o); }
  }
  function answered(c: WaLine, o: Outgoing): void {
    if (o.answered) return;
    o.answered = true;
    status(c, "answered");
    go(c, o);
  }
  async function outgoingConnect({ call, number }: { call: WaCall; number: string | null }): Promise<void> {
    const c = calls.get(call.id);
    const o = c?.out;
    if (!c || !o || o.sdp) return;
    o.sdp = true;
    o.number ??= plus(number);
    log(`whatsapp: call ${shortCallId(call.id)} to ${o.to}: answer ${sdpSummary(call.session?.sdp)} ${c.at()}`);
    if (debug) log(`whatsapp: answer sdp ${(call.session?.sdp ?? "").replace(/\r?\n/g, " | ")}`);
    try {
      await c.peer.accept(call.session?.sdp ?? "");
      o.ready = true;
      go(c, o);
    } catch (err) {
      log(`whatsapp: call ${call.id} to ${o.to}: answer refused: ${errText(err)}`);
      status(c, "failed");
      end(c.id, "setup_failed", { hangUp: true });
    }
  }
  function callStatus(s: WaStatus): void {
    const c = calls.get(s.id);
    log(`whatsapp: call ${shortCallId(s.id)} status ${s.status}${c ? ` ${c.at()}` : ""}`);
    if (!c?.out) return;
    if (s.status === "ACCEPTED") answered(c, c.out);
    else if (s.status === "REJECTED") { status(c, "busy"); end(c.id, "rejected"); }
  }

  // A connect that got no answer: Meta may have placed the call all the same. Its webhooks (some
  // may be here already) name it: hung up, so his phone doesn't ring for nothing.
  const placedTo = (e: WaEvent): string => digits(e.call ? (e.call.event === "connect" && e.call.direction === "BUSINESS_INITIATED" ? e.call.to : "") : e.status?.recipient_id);
  function hangUpStray(id: string, to: string): void {
    if (strays.has(id)) return;
    strays.add(id);
    setTimeout(() => strays.delete(id), STRAY_MS).unref?.();
    log(`whatsapp: call ${shortCallId(id)} to +${to} rings though its connect failed: hanging up`);
    terminate(id);
  }
  function unansweredConnect(to: string): void {
    unanswered.set(to, Date.now() + STRAY_MS);
    setTimeout(() => { if ((unanswered.get(to) ?? 0) <= Date.now()) unanswered.delete(to); }, STRAY_MS + 100).unref?.();
    for (const [id, events] of early) if (events.some(e => placedTo(e) === to)) { early.delete(id); hangUpStray(id, to); }
  }

  async function dialOut({ to, userId = null, jobId = null, extra = {} }: { to: string; userId?: string | null; jobId?: string | null; extra?: Record<string, unknown> }): Promise<{ callId: string; carrier: "whatsapp" }> {
    const c = newCall(null, { to: plus(to), userId, jobId, extra, number: env.WHATSAPP_NUMBER?.trim() || null, sdp: false, ready: false, answered: false, begun: false, loud: 0 });
    unanswered.delete(digits(to)); // a new call to him: its webhooks are its own
    placing++;
    let callId: string;
    try {
      const sdp = await c.peer.offer();
      if (debug) log(`whatsapp: offer sdp ${sdp.replace(/\r?\n/g, " | ")}`);
      const out = await graph({ to: digits(to), action: "connect", session: { sdp_type: "offer", sdp }, ...(jobId ? { biz_opaque_callback_data: String(jobId) } : {}) });
      const placed = Array.isArray(out.calls) && isRecord(out.calls[0]) ? str(out.calls[0].id) : undefined;
      if (!placed) throw new Error("whatsapp connect: no call id came back");
      callId = placed;
    } catch (err) {
      c.peer.close().catch(() => {});
      if (!(err instanceof GraphError)) unansweredConnect(digits(to)); // no answer from Graph: it may ring all the same
      throw err;
    } finally {
      placing--;
    }
    c.id = callId;
    const o = c.out;
    calls.set(callId, c);
    log(`whatsapp: calling ${o?.to}: ${shortCallId(callId)} ${c.at()}`);
    monitor?.system(`WhatsApp: calling ${o?.to}`);
    c.timers.push(setTimeout(() => {
      if (o?.answered) return;
      log(`whatsapp: call ${shortCallId(callId)} to ${o?.to}: no answer after ${ringMs / 1000} s`);
      status(c, "no-answer");
      end(callId, "no_answer", { hangUp: true });
    }, ringMs));
    for (const e of early.get(callId) ?? []) handle(e);
    early.delete(callId);
    return { callId, carrier: "whatsapp" };
  }

  function handle(event: WaEvent): void {
    const id = event.call?.id ?? event.status?.id;
    if (id && !calls.has(id) && event.call?.direction !== "USER_INITIATED") {
      const to = placedTo(event);
      if (to && (unanswered.get(to) ?? 0) > Date.now()) { hangUpStray(id, to); return; }
      if (placing) {
        // A call we're placing, ahead of its own id: keep it for a moment.
        early.set(id, [...(early.get(id) ?? []), event]);
        setTimeout(() => early.delete(id), 30000).unref?.();
        return;
      }
    }
    if (!("number" in event)) { callStatus(event.status); return; } // ("in" narrows the union in the tests' looser checking too)
    const call = event.call;
    if (call.event === "connect" && call.direction === "USER_INITIATED" && call.session?.sdp) incoming(event).catch((err: unknown) => log("whatsapp call error", errText(err)));
    else if (call.event === "connect" && call.direction === "BUSINESS_INITIATED") outgoingConnect(event).catch((err: unknown) => log("whatsapp call error", errText(err)));
    else if (call.event === "terminate") {
      log(`whatsapp: call ${shortCallId(call.id)} terminated: ${JSON.stringify({ status: call.status, duration: call.duration, errors: call.errors })}`);
      const c = calls.get(call.id);
      if (c?.out && !c.out.answered) status(c, call.status === "FAILED" ? "failed" : "no-answer");
      end(call.id, c?.out && !c.out.begun ? "no_answer" : "caller_hangup");
    } else log(`whatsapp: call event ${call.event} ${call.direction ?? ""}`);
  }

  const readRaw = (req: IncomingMessage) => new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });

  return {
    id: "whatsapp",
    get calls() { return calls.size; },

    async http(req, res, url) {
      if (url.pathname !== "/whatsapp/webhook") return false;
      if (req.method === "GET") {
        // Meta's handshake when the webhook is registered.
        const ok = url.searchParams.get("hub.mode") === "subscribe" && Boolean(verifyToken) && url.searchParams.get("hub.verify_token") === verifyToken;
        res.writeHead(ok ? 200 : 403, { "content-type": "text/plain" }).end(ok ? url.searchParams.get("hub.challenge") ?? "" : "");
        return true;
      }
      if (req.method !== "POST") { res.writeHead(405).end(); return true; }
      const raw = await readRaw(req);
      if (!verifyMetaSignature(raw, req.headers["x-hub-signature-256"], appSecret)) {
        log("whatsapp: refused a webhook (bad signature)");
        res.writeHead(403).end();
        return true;
      }
      res.writeHead(200).end(); // Meta wants the 200 fast; the call is set up after it
      let body: unknown;
      try { body = JSON.parse(raw.toString("utf8")); } catch { return true; }
      for (const event of callEvents(body)) handle(event);
      return true;
    },

    dialOut,

    async closeAll() {
      const hangUps = [...calls.keys()].map(id => end(id, "server_shutdown", { hangUp: true })).filter(p => p !== null);
      if (!hangUps.length) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled(hangUps), new Promise(r => { timer = setTimeout(r, CLOSE_MS); timer.unref?.(); })]);
      clearTimeout(timer);
    },
  };
}
