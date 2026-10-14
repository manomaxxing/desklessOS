// Calls in progress, whichever line they came in on. A line is one connection
// carrying one call in Dial's frames (in: call_connected, media, mark, call_ended,
// duration_warning, ping_pong, answered_by; out: media, mark, clear, end_call).
// Adapters (src/telephony/dial.mjs, twilio.mjs, fake.mjs) translate their
// carrier's protocol into these. A line that drops can come back for the same call
// within the grace period (Dial re-dials for ~15 s).
//
// startCall({ id, msg, send, dev, source }) → { session } (src/calls/start.mjs): memory,
// agenda and engine for one call. The host only knows this instance's calls.

export function createCallHost({ startCall, monitor = null, log = () => {}, graceMs = 20000 }) {
  const calls = new Map(); // call id → { id, session, out, graceTimer, startedAt }

  function connect(line, { callId = null, dev = false, reconnects = !dev, source = "dial" } = {}) {
    const out = { line };
    const send = frame => out.line.send(frame);
    let entry = null;
    let starting = null;

    async function receive(msg) {
      if (msg.type === "call_connected") {
        const id = msg.call_id || callId || `dev-${Date.now()}`;
        const existing = calls.get(id);
        if (existing && msg.reconnect) {
          clearTimeout(existing.graceTimer);
          existing.out.line = line; // same call, new connection
          entry = existing;
          monitor?.system(`reconnect: ${id}`, "warn");
        } else {
          starting = startCall({ id, msg, send, dev, source });
          const { session } = await starting;
          entry = { id, session, out, startedAt: Date.now() };
          calls.set(id, entry);
        }
      } else if (starting && !entry) {
        await starting; // frames that arrive while the call is being set up wait for it
      }
      entry?.session.handle(msg);
      if (msg.type === "call_ended") calls.delete(entry?.id);
    }

    function closed() {
      if (!entry || entry.session.ended) { if (entry) calls.delete(entry.id); return; }
      if (!reconnects) { entry.session.close(dev ? "dev_hangup" : "line_closed"); calls.delete(entry.id); return; }
      monitor?.system(`line dropped: ${entry.id}, waiting ${graceMs / 1000}s for a reconnect`, "warn");
      entry.graceTimer = setTimeout(() => { entry.session.close("socket_lost"); calls.delete(entry.id); }, graceMs);
    }

    return { receive, closed, get entry() { return entry; } };
  }

  return {
    connect,
    calls,
    get(id) { return calls.get(id) ?? null; },
    /** Shutting down: end every call here (each is saved, and its after-call job queued). */
    closeAll: reason => Promise.all([...calls.values()].map(c => c.session.close(reason))),
  };
}
