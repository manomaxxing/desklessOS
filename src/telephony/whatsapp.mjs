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
//   Media:    WebRTC, Opus (src/telephony/webrtc-audio.mjs), translated into the call
//             host's frames. Our audio flows only once accept has returned 200, as Meta asks.
//   Hosting:  the audio is UDP, not an HTTP request, so the instance needs its CPU between
//             requests: these calls run on a second Cloud Run service with CPU always on
//             and one instance at most (deploy/cloudrun.sh, WHATSAPP_SERVICE), so a call's
//             webhooks all land where its audio is.
// env: WHATSAPP_TOKEN (a system user's token), WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET,
//      WHATSAPP_VERIFY_TOKEN (the webhook's handshake; derived from SESSION_SECRET if unset),
//      WHATSAPP_GRAPH (v26.0), MAX_CALL_MIN (15), WHATSAPP_RING_S (45: how long Toni lets it ring).

import { createHmac, timingSafeEqual } from "node:crypto";
import { createAudioPeer } from "./webrtc-audio.mjs";

const GRAPH = "https://graph.facebook.com";

/** Meta's webhook signature: "sha256=" + hex HMAC-SHA256 of the raw body with the app secret. */
export function verifyMetaSignature(rawBody, header, appSecret) {
  if (!header || !appSecret) return false;
  const expected = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  return expected.length === header.length && timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

export const whatsappVerifyToken = env => env.WHATSAPP_VERIFY_TOKEN?.trim() || (env.SESSION_SECRET ? createHmac("sha256", env.SESSION_SECRET).update("whatsapp-webhook").digest("base64url").slice(0, 32) : "");

/** The call events in one webhook delivery: [{ call }] and [{ status }]. */
export function callEvents(body) {
  const out = [];
  for (const entry of body?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "calls" && change.field !== "messages") continue;
      const v = change.value ?? {};
      if (change.field === "calls") for (const call of v.calls ?? []) out.push({ call, phoneNumberId: v.metadata?.phone_number_id ?? null, number: v.metadata?.display_phone_number ?? null, contact: v.contacts?.[0] ?? null });
      // A call's RINGING / ACCEPTED / REJECTED (calls Toni makes); a message's statuses aren't ours.
      for (const status of v.statuses ?? []) if (change.field === "calls" || status.type === "call") out.push({ status });
    }
  }
  return out;
}

const plus = n => (n ? (String(n).startsWith("+") ? String(n) : `+${n}`) : null);
/** A call id for the logs: WhatsApp's ids all end alike ("…NxUCABUSAA=="); their start tells them apart. */
export const shortCallId = id => (String(id ?? "").startsWith("wacid.") ? String(id).slice(10, 22) : String(id ?? "").slice(-12));

/** One line about an SDP, for the logs: codecs, ICE-lite, DTLS role, candidates. */
export function sdpSummary(sdp = "") {
  const all = re => [...sdp.matchAll(re)].map(m => m[1]);
  const cands = all(/a=candidate:\S+ \d+ (\w+ \d+ \S+ \d+ typ \w+)/g).map(c => { const [proto, , ip, port, , typ] = c.split(" "); return `${typ} ${proto.toLowerCase()} ${ip}:${port}`; });
  return [
    `codecs ${all(/a=rtpmap:(\d+ [\w-]+\/\d+)/g).join(", ") || "-"}`,
    /a=ice-lite/.test(sdp) ? "ice-lite" : "full ice",
    `setup ${all(/a=setup:(\w+)/g)[0] ?? "-"}`,
    `fingerprint ${all(/a=fingerprint:(\S+)/g)[0] ?? "-"}`,
    `candidates ${cands.length ? cands.join("; ") : "none"}`,
  ].join(" · ");
}

/**
 * Messages from the business number (not calls): a text or a document into his chat. Free while his
 * chat window is open, and his call opens it (accepted or not), so a PDF sent during the call
 * costs nothing. Null without WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID.
 */
export function whatsappSender({ env = process.env, fetchImpl = fetch } = {}) {
  const token = env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  if (!token || !phoneNumberId) return null;
  const base = `${GRAPH}/${env.WHATSAPP_GRAPH?.trim() || "v26.0"}/${phoneNumberId}`;
  async function graph(path, init) {
    const res = await fetchImpl(`${base}/${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(10000) });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`whatsapp ${path} ${res.status}: ${out.error?.message ?? "failed"}${out.error?.error_data?.details ? ` (${out.error.error_data.details})` : ""}`);
    return out;
  }
  const send = async (to, message) => {
    const sent = await graph("messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: String(to).replace(/\D/g, ""), ...message }),
    });
    return { messageId: sent.messages?.[0]?.id ?? null };
  };
  return {
    /** sendText({ to: "+49…", text }) → { messageId } */
    sendText: ({ to, text }) => send(to, { type: "text", text: { body: text, preview_url: false } }),
    /** sendDocument({ to: "+49…", bytes, filename, caption }) → { messageId } */
    async sendDocument({ to, bytes, filename, caption = "", type = "application/pdf" }) {
      const form = new FormData();
      form.append("messaging_product", "whatsapp");
      form.append("type", type);
      form.append("file", new Blob([bytes], { type }), filename);
      const { id } = await graph("media", { method: "POST", body: form });
      return send(to, { type: "document", document: { id, filename, caption } });
    },
  };
}

export function whatsappAdapter({ host, env = process.env, monitor = null, log = () => {}, fetchImpl = fetch, peerFactory = createAudioPeer, onStatus = () => {} }) {
  const token = env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const appSecret = env.WHATSAPP_APP_SECRET?.trim();
  if (!token || !phoneNumberId || !appSecret) return null;
  const verifyToken = whatsappVerifyToken(env);
  const version = env.WHATSAPP_GRAPH?.trim() || "v26.0";
  const maxCallMs = Number(env.MAX_CALL_MIN || 15) * 60000;
  const ringMs = Number(env.WHATSAPP_RING_S || 45) * 1000;
  const debug = env.WHATSAPP_DEBUG === "1"; // the full SDPs in the log (they're good for one call only)
  const calls = new Map(); // WhatsApp call id → { id, peer, conn, timers, ended, out? (a call Toni makes) }
  let placing = 0; // calls Toni is placing whose id hasn't come back yet
  const early = new Map(); // their webhooks, if Meta was quicker than its own response

  async function graph(body) {
    const t0 = Date.now();
    const res = await fetchImpl(`${GRAPH}/${version}/${phoneNumberId}/calls`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }), signal: AbortSignal.timeout(10000),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`whatsapp ${body.action} ${res.status}: ${out.error?.message ?? "failed"}${out.error?.error_data?.details ? ` (${out.error.error_data.details})` : ""}`);
    log(`whatsapp: ${body.action} ok (${Date.now() - t0} ms)`);
    return out;
  }
  const terminate = callId => graph({ call_id: callId, action: "terminate" }).catch(err => log(err.message));
  const status = (c, s) => { try { onStatus({ callId: c.id, status: s, carrier: "whatsapp" }); } catch (err) { log("whatsapp status error", err.message); } };

  function end(callId, reason, { hangUp = false } = {}) {
    const c = calls.get(callId);
    if (!c || c.ended) return;
    c.ended = true;
    for (const t of c.timers) clearTimeout(t);
    if (hangUp) terminate(callId);
    if (c.conn && !c.conn.entry?.session.ended) c.conn.receive({ type: "call_ended", reason }).catch(() => {});
    c.conn?.closed();
    c.peer.close();
    calls.delete(callId);
  }

  /** The call's WebRTC leg, and the line the call host speaks into. */
  function wire(c) {
    c.peer = peerFactory({
      onAudio: pcm => (c.conn ? c.conn.receive({ type: "media", payload: pcm.toString("base64") }) : c.out && heardFirst(c, pcm)),
      onMark: name => c.conn?.receive({ type: "mark", name }),
      onState: state => {
        log(`whatsapp: call ${c.id ? shortCallId(c.id) : "(placing)"} media ${state} ${c.at()}`);
        if (c.id && !c.ended && (state === "failed" || state === "closed")) {
          if (c.out && !c.conn) status(c, "failed");
          end(c.id, state === "failed" ? "media_failed" : "line_closed", { hangUp: state === "failed" });
        }
      },
      log,
    });
    c.line = {
      send(frame) {
        if (frame.type === "media") c.peer.play(Buffer.from(frame.payload, "base64"));
        else if (frame.type === "mark") c.peer.mark(frame.name);
        else if (frame.type === "clear") c.peer.clear();
        else if (frame.type === "end_call") setTimeout(() => end(c.id, "agent_hangup", { hangUp: true }), 300);
      },
      close: () => end(c.id, "line_closed", { hangUp: true }),
    };
  }
  const newCall = (id, out = null) => { const t0 = Date.now(); return { id, peer: null, conn: null, timers: [], ended: false, out, at: () => `+${Date.now() - t0} ms` }; };

  /** The conversation starts: the call host gets call_connected (memory, agenda, greeting), and the call's time limit runs. */
  function begin(c, connected) {
    c.conn = host.connect(c.line, { callId: c.id, reconnects: false, source: "whatsapp" });
    c.conn.receive({ type: "call_connected", call_id: c.id, user_id: null, job_id: null, language: null, formats: { inbound: "l16_16000", outbound: "l16_16000" }, reconnect: false, ...connected })
      .catch(err => log("whatsapp call error", err.message));
    c.timers.push(setTimeout(() => c.conn?.receive({ type: "duration_warning" }), Math.max(0, maxCallMs - 30000)));
    c.timers.push(setTimeout(() => end(c.id, "max_duration", { hangUp: true }), maxCallMs));
  }

  async function incoming({ call, number }) {
    const callId = call.id;
    if (calls.has(callId)) return; // a webhook delivered twice
    const c = newCall(callId);
    calls.set(callId, c);
    wire(c);
    log(`whatsapp: call ${shortCallId(callId)} from ${plus(call.from)}: offer ${sdpSummary(call.session.sdp)}`);
    if (debug) log(`whatsapp: offer sdp ${call.session.sdp.replace(/\r?\n/g, " | ")}`);
    try {
      const sdp = await c.peer.answer(call.session.sdp);
      log(`whatsapp: call ${shortCallId(callId)} answer ${sdpSummary(sdp)} ${c.at()}`);
      if (debug) log(`whatsapp: answer sdp ${sdp.replace(/\r?\n/g, " | ")}`);
      await graph({ call_id: callId, action: "pre_accept", session: { sdp_type: "answer", sdp } });
      if (c.ended) return; // he hung up while it was ringing
      // The call starts (memory, agenda, greeting queued) while WhatsApp connects it.
      begin(c, { from: plus(call.from), to: plus(call.to ?? number), direction: "inbound" });
      await graph({ call_id: callId, action: "accept", session: { sdp_type: "answer", sdp } });
      if (c.ended) return;
      c.peer.start();
      log(`whatsapp: call ${shortCallId(callId)} accepted ${c.at()}, media ${c.peer.state}`);
      monitor?.system(`WhatsApp call ${shortCallId(callId)} from ${plus(call.from) ?? "?"}`);
    } catch (err) {
      if (c.ended) return;
      log(`whatsapp: call ${callId} not answered: ${err.message}`);
      monitor?.system(`WhatsApp call from ${plus(call.from) ?? "?"} failed: ${err.message}`, "error");
      end(callId, "setup_failed", { hangUp: true });
    }
  }

  // ---------- calls Toni makes ----------
  /** He picked up (ACCEPTED), and Meta's answer is applied: our audio may flow, the conversation starts. */
  function go(c) {
    const o = c.out;
    if (o.begun || c.ended || !o.answered || !o.ready) return;
    o.begun = true;
    c.peer.start();
    log(`whatsapp: call ${shortCallId(c.id)} to ${o.to} answered ${c.at()}, media ${c.peer.state}`);
    monitor?.system(`WhatsApp call ${shortCallId(c.id)} to ${o.to}: answered`);
    begin(c, { from: o.number, to: o.to, direction: "outbound", user_id: o.userId, job_id: o.jobId, ...o.extra });
  }
  /** No ACCEPTED, but he's talking ("Hallo?"): he picked up. */
  function heardFirst(c, pcm) {
    let sum = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
    if (Math.sqrt(sum / (pcm.length / 2)) < 1000 || ++c.out.loud < 10) return; // 10 loud frames, 200 ms
    if (!c.out.answered && c.out.ready) { log(`whatsapp: call ${shortCallId(c.id)}: he's talking, no ACCEPTED yet: taking it as answered`); answered(c); }
  }
  function answered(c) {
    if (c.out.answered) return;
    c.out.answered = true;
    status(c, "answered");
    go(c);
  }
  async function outgoingConnect({ call, number }) {
    const c = calls.get(call.id);
    if (!c?.out || c.out.sdp) return;
    c.out.sdp = true;
    c.out.number ??= plus(number);
    log(`whatsapp: call ${shortCallId(call.id)} to ${c.out.to}: answer ${sdpSummary(call.session?.sdp)} ${c.at()}`);
    if (debug) log(`whatsapp: answer sdp ${(call.session?.sdp ?? "").replace(/\r?\n/g, " | ")}`);
    try {
      await c.peer.accept(call.session.sdp);
      c.out.ready = true;
      go(c);
    } catch (err) {
      log(`whatsapp: call ${call.id} to ${c.out.to}: answer refused: ${err.message}`);
      status(c, "failed");
      end(c.id, "setup_failed", { hangUp: true });
    }
  }
  function callStatus(s) {
    const c = calls.get(s.id);
    log(`whatsapp: call ${shortCallId(String(s.id))} status ${s.status}${c ? ` ${c.at()}` : ""}`);
    if (!c?.out) return;
    if (s.status === "ACCEPTED") answered(c);
    else if (s.status === "REJECTED") { status(c, "busy"); end(c.id, "rejected"); }
  }

  /**
   * Toni calls him: { to: "+49…", userId?, jobId?, extra? (more call_connected fields) } → { callId, carrier }.
   * Throws when WhatsApp won't place it (no permission from him: error 138006).
   */
  async function dialOut({ to, userId = null, jobId = null, extra = {} }) {
    const c = newCall(null, { to: plus(to), userId, jobId, extra, number: env.WHATSAPP_NUMBER?.trim() || null, sdp: false, ready: false, answered: false, begun: false, loud: 0 });
    wire(c);
    placing++;
    try {
      const sdp = await c.peer.offer();
      if (debug) log(`whatsapp: offer sdp ${sdp.replace(/\r?\n/g, " | ")}`);
      const out = await graph({ to: String(to).replace(/\D/g, ""), action: "connect", session: { sdp_type: "offer", sdp }, ...(jobId ? { biz_opaque_callback_data: String(jobId) } : {}) });
      c.id = out.calls?.[0]?.id ?? null;
      if (!c.id) throw new Error("whatsapp connect: no call id came back");
    } catch (err) {
      c.peer.close();
      throw err;
    } finally {
      placing--;
    }
    calls.set(c.id, c);
    log(`whatsapp: calling ${c.out.to}: ${shortCallId(c.id)} ${c.at()}`);
    monitor?.system(`WhatsApp: calling ${c.out.to}`);
    c.timers.push(setTimeout(() => {
      if (c.out.answered) return;
      log(`whatsapp: call ${shortCallId(c.id)} to ${c.out.to}: no answer after ${ringMs / 1000} s`);
      status(c, "no-answer");
      end(c.id, "no_answer", { hangUp: true });
    }, ringMs));
    for (const e of early.get(c.id) ?? []) handle(e);
    early.delete(c.id);
    return { callId: c.id, carrier: "whatsapp" };
  }

  function handle(event) {
    const id = event.call?.id ?? event.status?.id;
    if (id && !calls.has(id) && placing && !(event.call?.direction === "USER_INITIATED")) {
      // A call we're placing, ahead of its own id: keep it for a moment.
      early.set(id, [...(early.get(id) ?? []), event]);
      setTimeout(() => early.delete(id), 30000).unref?.();
      return;
    }
    const { call } = event;
    if (!call) return callStatus(event.status);
    if (call.event === "connect" && call.direction === "USER_INITIATED" && call.session?.sdp) incoming(event);
    else if (call.event === "connect" && call.direction === "BUSINESS_INITIATED") outgoingConnect(event);
    else if (call.event === "terminate") {
      log(`whatsapp: call ${shortCallId(call.id)} terminated: ${JSON.stringify({ status: call.status, duration: call.duration, errors: call.errors })}`);
      const c = calls.get(call.id);
      if (c?.out && !c.out.answered) status(c, call.status === "FAILED" ? "failed" : "no-answer");
      end(call.id, c?.out && !c.out.begun ? "no_answer" : "caller_hangup");
    } else log(`whatsapp: call event ${call.event} ${call.direction ?? ""}`);
  }

  const readRaw = req => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => { size += c.length; if (size > 1e6) req.destroy(); else chunks.push(c); });
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
        const ok = url.searchParams.get("hub.mode") === "subscribe" && verifyToken && url.searchParams.get("hub.verify_token") === verifyToken;
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
      let body;
      try { body = JSON.parse(raw); } catch { return true; }
      for (const event of callEvents(body)) handle(event);
      return true;
    },

    dialOut,

    /** SIGTERM: hang up the calls on this instance (they're saved by the host). */
    closeAll: () => { for (const id of [...calls.keys()]) end(id, "server_shutdown", { hangUp: true }); },
  };
}
