// Dial's self-hosted audio protocol (the engine's own frames): wss://…/dial/<call_id>.
// Real calls carry X-Dial-Signature (t=<unix>,v1=<hex HMAC-SHA256 of "t.call_id">,
// DIAL_SIGNING_SECRET); the browser test phone and scripted callers come in with
// ?dev=1 and ?token= (DEV_TOKEN or an admin session; `devAllowed` decides). Dial is
// inbound only: no dialOut. A Dial line that drops reconnects to the instance that
// has the call only if Cloud Run's routing sends it there (best effort): otherwise the
// call ends and is saved as it stood.

import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyDialSignature(header, callId, secret, now = Date.now()) {
  const m = /t=(\d+),v1=([0-9a-f]+)/i.exec(header ?? "");
  if (!m) return false;
  if (Math.abs(now / 1000 - Number(m[1])) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${m[1]}.${callId}`).digest();
  const given = Buffer.from(m[2], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** `requireSignature`: a public server (Cloud Run) refuses real Dial calls when it has no DIAL_SIGNING_SECRET. */
export function dialAdapter({ host, wss, secret = "", requireSignature = false, devAllowed = () => true, monitor = null, log = () => {} }) {
  return {
    id: "dial",
    upgrade(req, socket, head, url) {
      if (!url.pathname.startsWith("/dial")) return false;
      const callId = decodeURIComponent(url.pathname.split("/").filter(Boolean).slice(1).join("/") || "");
      const dev = url.searchParams.get("dev") === "1";
      if (dev) {
        if (!devAllowed(url.searchParams.get("token"))) { socket.destroy(); return true; }
      } else if (secret) {
        if (!verifyDialSignature(req.headers["x-dial-signature"], callId, secret)) {
          log("rejected unsigned/invalid Dial connection for", callId || "(no call id)");
          monitor?.system(`rejected connection ${callId || "(no call id)"}: ${req.headers["x-dial-signature"] ? "bad or stale signature" : "no X-Dial-Signature header"}`, "error");
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
      monitor?.system(`${dev ? "test phone" : secret ? "Dial (signed)" : "unsigned caller"} connected: ${callId || "(no call id)"}`);
      wss.handleUpgrade(req, socket, head, ws => {
        const line = { send: frame => { if (ws.readyState === 1) ws.send(JSON.stringify(frame)); }, close: () => ws.close() };
        const conn = host.connect(line, { callId, dev, source: dev ? "dev" : "dial" });
        ws.on("message", data => {
          let msg;
          try { msg = JSON.parse(data); } catch { return; }
          conn.receive(msg).catch(err => log("call error", err.message));
        });
        ws.on("close", () => conn.closed());
      });
      return true;
    },
  };
}
