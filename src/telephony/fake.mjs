// A carrier without a phone network, for testing outbound calls end to end.
// A test phone (npm run fake-dial -- --answer +49…) connects to /fake/phone?number=…
// and waits. dialOut() to that number rings it ({ type: "ring", call_id, user_id,
// job_id }); the phone then joins the call like the browser test phone does
// (/dial/<call_id>?dev=1, direction "outbound"). Nobody listening on the number,
// or the phone saying { type: "reject", reason: "no-answer" | "busy" }, ends in
// that status, as a real carrier's callback would. On only with OUTBOUND=fake.

import { randomUUID } from "node:crypto";

export function fakeAdapter({ wss, devAllowed = () => true, onStatus = () => {}, monitor = null, log = () => {}, ringMs = 25000 }) {
  const phones = new Map(); // number → ws
  const ringing = new Map(); // call id → timer

  return {
    id: "fake",
    number: "+10000000000",

    upgrade(req, socket, head, url) {
      if (url.pathname !== "/fake/phone") return false;
      if (!devAllowed(url.searchParams.get("token"))) { socket.destroy(); return true; }
      const number = url.searchParams.get("number");
      wss.handleUpgrade(req, socket, head, ws => {
        phones.set(number, ws);
        monitor?.system(`fake phone ${number} is waiting for calls`);
        ws.on("message", data => {
          let m;
          try { m = JSON.parse(data); } catch { return; }
          if (!ringing.has(m.call_id)) return;
          clearTimeout(ringing.get(m.call_id));
          ringing.delete(m.call_id);
          if (m.type === "answer") onStatus({ callId: m.call_id, status: "in-progress", carrier: "fake" });
          if (m.type === "reject") onStatus({ callId: m.call_id, status: m.reason === "busy" ? "busy" : "no-answer", carrier: "fake" });
        });
        ws.on("close", () => { if (phones.get(number) === ws) phones.delete(number); });
      });
      return true;
    },

    async dialOut({ to, userId, jobId }) {
      const callId = `fake-out-${randomUUID().slice(0, 8)}`;
      const ws = phones.get(to);
      const timeout = () => { ringing.delete(callId); onStatus({ callId, status: "no-answer", carrier: "fake" }); };
      ringing.set(callId, setTimeout(timeout, ws ? ringMs : 3000));
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: "ring", call_id: callId, user_id: userId, job_id: jobId, from: this.number }));
      else log(`fake carrier: nobody on ${to}`);
      return { callId, carrier: "fake" };
    },
  };
}
