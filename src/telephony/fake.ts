// A carrier without a phone network, for testing outbound calls end to end.
// A test phone (npm run fake-dial -- --answer +49…) connects to /fake/phone?number=…
// and waits. dialOut() to that number rings it ({ type: "ring", call_id, user_id,
// job_id }); the phone then joins the call like the browser test phone does
// (/dial/<call_id>?dev=1, direction "outbound"). Nobody listening on the number,
// or the phone saying { type: "reject", reason: "no-answer" | "busy" }, ends in
// that status, as a real carrier's callback would. On only with OUTBOUND=fake.

import { randomUUID } from "node:crypto";
import { isRecord } from "../shared/is-record.ts";
import type { WebSocket, WebSocketServer } from "ws";
import type { UpgradeAdapter } from "./dial.ts";
import type { Carrier, CarrierStatus } from "../types/call.ts";
import type { Log } from "../types/common.ts";

export function fakeAdapter({ wss, devAllowed = () => true, onStatus = () => {}, monitor = null, log = () => {}, ringMs = 25000 }: {
  wss: Pick<WebSocketServer, "handleUpgrade">;
  devAllowed?: (token: string | null) => boolean | Promise<boolean>;
  onStatus?: (s: CarrierStatus) => void;
  monitor?: { system(text: string, level?: string): void } | null;
  log?: Log;
  ringMs?: number;
}): UpgradeAdapter & Carrier & { number: string } {
  const phones = new Map<string, WebSocket>(); // number → ws
  const ringing = new Map<string, ReturnType<typeof setTimeout>>(); // call id → timer
  const number = "+10000000000";

  return {
    id: "fake",
    number,

    upgrade(req, socket, head, url) {
      if (url.pathname !== "/fake/phone") return false;
      const at = url.searchParams.get("number") ?? "";
      const listen = () => wss.handleUpgrade(req, socket, head, ws => {
        phones.set(at, ws);
        monitor?.system(`fake phone ${at} is waiting for calls`);
        ws.on("message", data => {
          let m: unknown;
          try { m = JSON.parse(String(data)); } catch { return; }
          if (!isRecord(m) || typeof m.call_id !== "string") return;
          const callId = m.call_id;
          const timer = ringing.get(callId);
          if (!timer) return;
          clearTimeout(timer);
          ringing.delete(callId);
          if (m.type === "answer") onStatus({ callId, status: "in-progress", carrier: "fake" });
          if (m.type === "reject") onStatus({ callId, status: m.reason === "busy" ? "busy" : "no-answer", carrier: "fake" });
        });
        ws.on("close", () => { if (phones.get(at) === ws) phones.delete(at); });
      });
      Promise.resolve(devAllowed(url.searchParams.get("token"))).then(ok => (ok ? listen() : socket.destroy()), () => socket.destroy());
      return true;
    },

    async dialOut({ to, userId, jobId }) {
      const callId = `fake-out-${randomUUID().slice(0, 8)}`;
      const ws = phones.get(to);
      const timeout = () => { ringing.delete(callId); onStatus({ callId, status: "no-answer", carrier: "fake" }); };
      ringing.set(callId, setTimeout(timeout, ws ? ringMs : 3000));
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "ring", call_id: callId, user_id: userId, job_id: jobId, from: number }));
      else log(`fake carrier: nobody on ${to}`);
      return { callId, carrier: "fake" };
    },
  };
}
