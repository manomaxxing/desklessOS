// WhatsApp calls through Meta's Cloud API (Calling): he calls the business number in
// WhatsApp, Toni answers.
//   Signalling: Meta's webhook (POST /whatsapp/webhook, X-Hub-Signature-256 with the app
//             secret) brings the call with an SDP offer; we answer over the Graph API
//             (pre_accept, then accept with the same SDP) and hang up with terminate.
//   Media:    WebRTC, Opus (src/telephony/webrtc-audio.mjs), translated into the call
//             host's frames. Our audio flows only once accept has returned 200, as Meta asks.
//   Hosting:  the audio is UDP, not an HTTP request, so the instance needs its CPU between
//             requests: these calls run on a second Cloud Run service with CPU always on
//             and one instance at most (deploy/cloudrun.sh, WHATSAPP_SERVICE), so a call's
//             webhooks all land where its audio is.
// env: WHATSAPP_TOKEN (a system user's token), WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET,
//      WHATSAPP_VERIFY_TOKEN (the webhook's handshake; derived from SESSION_SECRET if unset),
//      WHATSAPP_GRAPH (v26.0), MAX_CALL_MIN (15).

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
      if (change.field !== "calls") continue;
      const v = change.value ?? {};
      for (const call of v.calls ?? []) out.push({ call, phoneNumberId: v.metadata?.phone_number_id ?? null, number: v.metadata?.display_phone_number ?? null, contact: v.contacts?.[0] ?? null });
      for (const status of v.statuses ?? []) out.push({ status });
    }
  }
  return out;
}

const plus = n => (n ? (String(n).startsWith("+") ? String(n) : `+${n}`) : null);

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


export function whatsappAdapter({ host, env = process.env, monitor = null, log = () => {}, fetchImpl = fetch, peerFactory = createAudioPeer }) {
  const token = env.WHATSAPP_TOKEN?.trim();
  const phoneNumberId = env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const appSecret = env.WHATSAPP_APP_SECRET?.trim();
  if (!token || !phoneNumberId || !appSecret) return null;
  const verifyToken = whatsappVerifyToken(env);
  const version = env.WHATSAPP_GRAPH?.trim() || "v26.0";
  const maxCallMs = Number(env.MAX_CALL_MIN || 15) * 60000;
  const debug = env.WHATSAPP_DEBUG === "1"; // the full SDPs in the log (they're good for one call only)
  const calls = new Map(); // WhatsApp call id → { peer, conn, timers, ended }

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

  async function incoming({ call, number }) {
    const callId = call.id;
    if (calls.has(callId)) return; // a webhook delivered twice
    const c = { peer: null, conn: null, timers: [], ended: false };
    calls.set(callId, c);
    const t0 = Date.now();
    const at = () => `+${Date.now() - t0} ms`;
    log(`whatsapp: call ${callId.slice(-12)} from ${plus(call.from)}: offer ${sdpSummary(call.session.sdp)}`);
    if (debug) log(`whatsapp: offer sdp ${call.session.sdp.replace(/\r?\n/g, " | ")}`);
    const line = {
      send(frame) {
        if (frame.type === "media") c.peer.play(Buffer.from(frame.payload, "base64"));
        else if (frame.type === "mark") c.peer.mark(frame.name);
        else if (frame.type === "clear") c.peer.clear();
        else if (frame.type === "end_call") setTimeout(() => end(callId, "agent_hangup", { hangUp: true }), 300);
      },
      close: () => end(callId, "line_closed", { hangUp: true }),
    };
    c.peer = peerFactory({
      onAudio: pcm => c.conn?.receive({ type: "media", payload: pcm.toString("base64") }),
      onMark: name => c.conn?.receive({ type: "mark", name }),
      onState: state => {
        log(`whatsapp: call ${callId.slice(-12)} media ${state} ${at()}`);
        if (state === "failed" || state === "closed") end(callId, state === "failed" ? "media_failed" : "line_closed", { hangUp: state === "failed" });
      },
      log,
    });
    try {
      const sdp = await c.peer.answer(call.session.sdp);
      log(`whatsapp: call ${callId.slice(-12)} answer ${sdpSummary(sdp)} ${at()}`);
      if (debug) log(`whatsapp: answer sdp ${sdp.replace(/\r?\n/g, " | ")}`);
      await graph({ call_id: callId, action: "pre_accept", session: { sdp_type: "answer", sdp } });
      if (c.ended) return; // he hung up while it was ringing
      // The call starts (memory, agenda, greeting queued) while WhatsApp connects it.
      c.conn = host.connect(line, { callId, reconnects: false, source: "whatsapp" });
      c.conn.receive({
        type: "call_connected", call_id: callId, from: plus(call.from), to: plus(call.to ?? number), direction: "inbound",
        user_id: null, job_id: null, language: null, formats: { inbound: "l16_16000", outbound: "l16_16000" }, reconnect: false,
      }).catch(err => log("whatsapp call error", err.message));
      await graph({ call_id: callId, action: "accept", session: { sdp_type: "answer", sdp } });
      if (c.ended) return;
      c.peer.start();
      log(`whatsapp: call ${callId.slice(-12)} accepted ${at()}, media ${c.peer.state}`);
      c.timers.push(setTimeout(() => c.conn?.receive({ type: "duration_warning" }), Math.max(0, maxCallMs - 30000)));
      c.timers.push(setTimeout(() => end(callId, "max_duration", { hangUp: true }), maxCallMs));
      monitor?.system(`WhatsApp call ${callId.slice(-8)} from ${plus(call.from) ?? "?"}`);
    } catch (err) {
      if (c.ended) return;
      log(`whatsapp: call ${callId} not answered: ${err.message}`);
      monitor?.system(`WhatsApp call from ${plus(call.from) ?? "?"} failed: ${err.message}`, "error");
      end(callId, "setup_failed", { hangUp: true });
    }
  }

  function handle(event) {
    const { call } = event;
    if (!call) { log(`whatsapp: status ${JSON.stringify(event.status)}`); return; } // calls we make (not yet)
    if (call.event === "connect" && call.direction === "USER_INITIATED" && call.session?.sdp) incoming(event);
    else if (call.event === "terminate") {
      log(`whatsapp: call ${call.id.slice(-12)} terminated: ${JSON.stringify({ status: call.status, duration: call.duration, errors: call.errors })}`);
      end(call.id, "caller_hangup");
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

    /** SIGTERM: hang up the calls on this instance (they're saved by the host). */
    closeAll: () => { for (const id of [...calls.keys()]) end(id, "server_shutdown", { hangUp: true }); },
  };
}
