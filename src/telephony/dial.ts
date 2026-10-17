// Dial's self-hosted audio protocol (the engine's own frames): wss://…/dial/<call_id>.
// Real calls carry X-Dial-Signature (t=<unix>,v1=<hex HMAC-SHA256 of "t.call_id">,
// DIAL_SIGNING_SECRET); the browser test phone and scripted callers come in with
// ?dev=1 and ?token= (DEV_TOKEN or an admin session; `devAllowed` decides). Dial is
// inbound only: no dialOut. A Dial line that drops reconnects to the instance that
// has the call only if Cloud Run's routing sends it there (best effort): otherwise the
// call ends and is saved as it stood.

import { createHmac, timingSafeEqual } from "node:crypto";
import { isFrame } from "./host.ts";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";
import type { CallHost } from "./host.ts";
import type { Line } from "../types/call.ts";
import type { Log } from "../types/common.ts";

export function verifyDialSignature(header: unknown, callId: string, secret: string, now = Date.now()): boolean {
  const m = /t=(\d+),v1=([0-9a-f]+)/i.exec(typeof header === "string" ? header : "");
  if (!m) return false;
  if (Math.abs(now / 1000 - Number(m[1])) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${m[1]}.${callId}`).digest();
  const given = Buffer.from(m[2], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** A phone line's way in: the WebSocket upgrades it takes (true: handled). */
export interface UpgradeAdapter {
  id: string;
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): boolean;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `requireSignature`: a public server (Cloud Run) refuses real Dial calls when it has no DIAL_SIGNING_SECRET. */
export function dialAdapter({ host, wss, secret = "", requireSignature = false, devAllowed = () => true, monitor = null, log = () => {} }: {
  host: Pick<CallHost, "connect">;
  wss: Pick<WebSocketServer, "handleUpgrade">;
  secret?: string;
  requireSignature?: boolean;
  /** May this token use the test phone? (async: a team member's session is checked against the team.) */
  devAllowed?: (token: string | null) => boolean | Promise<boolean>;
  monitor?: { system(text: string, level?: string): void } | null;
  log?: Log;
}): UpgradeAdapter {
  return {
    id: "dial",
    upgrade(req, socket, head, url) {
      if (!url.pathname.startsWith("/dial")) return false;
      let callId: string;
      try { callId = decodeURIComponent(url.pathname.split("/").filter(Boolean).slice(1).join("/") || ""); } catch { socket.destroy(); return true; }
      const dev = url.searchParams.get("dev") === "1";
      const signature = req.headers["x-dial-signature"];
      const accept = () => {
        monitor?.system(`${dev ? "test phone" : secret ? "Dial (signed)" : "unsigned caller"} connected: ${callId || "(no call id)"}`);
        wss.handleUpgrade(req, socket, head, ws => {
          const line: Line = { send: frame => { if (ws.readyState === 1) ws.send(JSON.stringify(frame)); }, close: () => ws.close() };
          const conn = host.connect(line, { callId, dev, source: dev ? "dev" : "dial" });
          ws.on("message", data => {
            let msg: unknown;
            try { msg = JSON.parse(String(data)); } catch { return; }
            if (isFrame(msg)) conn.receive(msg).catch((err: unknown) => log("call error", errText(err)));
          });
          ws.on("close", () => conn.closed());
        });
      };
      if (dev) {
        Promise.resolve(devAllowed(url.searchParams.get("token")))
          .then(ok => (ok ? accept() : socket.destroy()), (err: unknown) => { log("test phone check failed:", errText(err)); socket.destroy(); });
        return true;
      }
      if (secret) {
        if (!verifyDialSignature(signature, callId, secret)) {
          log("rejected unsigned/invalid Dial connection for", callId || "(no call id)");
          monitor?.system(`rejected connection ${callId || "(no call id)"}: ${signature ? "bad or stale signature" : "no X-Dial-Signature header"}`, "error");
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return true;
        }
      } else if (requireSignature) {
        log("refused a Dial connection: no DIAL_SIGNING_SECRET on this server");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return true;
      } else {
        log("warning: accepting unsigned connection (set DIAL_SIGNING_SECRET for real calls)");
      }
      accept();
      return true;
    },
  };
}
