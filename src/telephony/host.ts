// Calls in progress, whichever line they came in on. A line is one connection
// carrying one call in Dial's frames (in: call_connected, media, mark, call_ended,
// duration_warning, ping_pong, answered_by; out: media, mark, clear, end_call).
// Adapters (src/telephony/dial.ts, twilio.ts, fake.ts) translate their
// carrier's protocol into these. A line that drops can come back for the same call
// within the grace period (Dial re-dials for ~15 s).
//
// startCall({ id, msg, send, dev, source }) → { session } (src/calls/start.ts): memory,
// agenda and engine for one call. The host only knows this instance's calls.

import type { FrameIn, FrameOut, Line } from "../types/call.ts";
import type { Log } from "../types/common.ts";

export type ConnectedFrame = Extract<FrameIn, { type: "call_connected" }>;

/** One call's engine (src/engine/session.ts or live-session.ts): it takes the line's frames and ends with close(). */
export interface CallSession {
  handle(msg: FrameIn): void;
  close(reason: string): unknown;
  readonly ended: boolean;
}

export type StartCall = (o: { id: string; msg: ConnectedFrame; send: (frame: FrameOut) => void; dev: boolean; source: string }) => Promise<{ session: CallSession; userId?: string | null }>;

/** A call on this instance: its session, and the line it's on now (a reconnect moves it). */
export interface HostedCall {
  id: string;
  session: CallSession;
  out: { line: Line };
  graceTimer?: ReturnType<typeof setTimeout>;
  startedAt: number;
}

/** One line's connection to the host: frames in, and the line's end. */
export interface HostConnection {
  /** Never rejects: an error here must not reach the process. */
  receive(msg: FrameIn): Promise<void>;
  closed(): void;
  readonly entry: HostedCall | null;
}

export interface CallHost {
  connect(line: Line, options?: { callId?: string | null; dev?: boolean; reconnects?: boolean; source?: string }): HostConnection;
  calls: Map<string, HostedCall>;
  get(id: string): HostedCall | null;
  /** Shutting down: end every call here (each is saved, and its after-call job queued). */
  closeAll(reason: string): Promise<unknown[]>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A parsed message that looks like one of Dial's frames (its `type` is a string); the session ignores types it doesn't know. */
export const isFrame = (msg: unknown): msg is FrameIn => typeof msg === "object" && msg !== null && "type" in msg && typeof msg.type === "string";

export function createCallHost({ startCall, monitor = null, log = () => {}, graceMs = 20000 }: {
  startCall: StartCall;
  monitor?: { system(text: string, level?: string): void } | null;
  log?: Log;
  graceMs?: number;
}): CallHost {
  const calls = new Map<string, HostedCall>(); // call id → { id, session, out, graceTimer, startedAt }

  function connect(line: Line, { callId = null, dev = false, reconnects = !dev, source = "dial" }: { callId?: string | null; dev?: boolean; reconnects?: boolean; source?: string } = {}): HostConnection {
    const out = { line };
    const send = (frame: FrameOut) => out.line.send(frame);
    let entry: HostedCall | null = null;
    let starting: Promise<unknown> | null = null;
    let failed = false; // setting the call up failed: the line is ended, later frames are dropped
    let lineClosed = false; // the line closed while the call was still being set up

    // Never rejects: an error here must not reach the process (an unhandled rejection ends it,
    // and every call on the instance with it).
    async function receive(msg: FrameIn): Promise<void> {
      if (failed) return;
      try {
        if (msg?.type === "call_connected") {
          const id = msg.call_id || callId || `dev-${Date.now()}`;
          const existing = calls.get(id);
          if (existing && msg.reconnect) {
            clearTimeout(existing.graceTimer);
            existing.out.line = line; // same call, new connection
            entry = existing;
            monitor?.system(`reconnect: ${id}`, "warn");
          } else {
            const started = startCall({ id, msg, send, dev, source });
            starting = started;
            let session: CallSession;
            try { ({ session } = await started); } catch (err) { return giveUp(id, err); }
            entry = { id, session, out, startedAt: Date.now() };
            calls.set(id, entry);
            if (lineClosed) { closeSession(entry, dev ? "dev_hangup" : "line_closed"); return; }
          }
        } else if (starting && !entry) {
          await starting.catch(() => {}); // frames that arrive while the call is being set up wait for it
          if (!entry) return;
        }
        entry?.session.handle(msg);
        if (msg?.type === "call_ended" && entry) calls.delete(entry.id);
      } catch (err) {
        log(`call ${entry?.id ?? callId ?? "?"}: frame ${msg?.type ?? "?"} failed: ${errText(err)}`);
      }
    }

    function giveUp(id: string, err: unknown): void {
      failed = true;
      log(`call ${id}: setting it up failed, ending the line: ${errText(err)}`);
      monitor?.system(`call ${id}: setup failed (${errText(err)}), line ended`, "error");
      try { line.send({ type: "end_call" }); } catch {}
      try { line.close?.(); } catch {}
    }

    function closeSession(e: HostedCall, reason: string): void {
      calls.delete(e.id);
      Promise.resolve().then(() => e.session.close(reason)).catch((err: unknown) => log(`call ${e.id}: closing failed: ${errText(err)}`));
    }

    function closed(): void {
      if (!entry) { lineClosed = true; return; } // still being set up: closed when that's done
      if (entry.out.line !== line) return; // an old connection closing after the call moved to a new one
      if (entry.session.ended) { calls.delete(entry.id); return; }
      if (!reconnects) { closeSession(entry, dev ? "dev_hangup" : "line_closed"); return; }
      monitor?.system(`line dropped: ${entry.id}, waiting ${graceMs / 1000}s for a reconnect`, "warn");
      const e = entry;
      e.graceTimer = setTimeout(() => closeSession(e, "socket_lost"), graceMs);
    }

    return { receive, closed, get entry() { return entry; } };
  }

  return {
    connect,
    calls,
    get(id) { return calls.get(id) ?? null; },
    // One call that fails to close doesn't stop the others, or the shutdown after them.
    closeAll: reason => Promise.all([...calls.values()].map(c => Promise.resolve().then(() => c.session.close(reason)).catch((err: unknown) => log(`call ${c.id}: closing failed: ${errText(err)}`)))),
  };
}
