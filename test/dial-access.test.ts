// The test phone's line (src/telephony/dial.ts, ?dev=1): who may connect is decided before the
// WebSocket opens, and the decision may take a database lookup (a team member still on the team).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { dialAdapter } from "../src/telephony/dial.ts";

async function withDial(devAllowed: (token: string | null) => Promise<boolean>, fn: (base: string, connected: string[]) => Promise<void>) {
  const connected: string[] = [];
  const wss = new WebSocketServer({ noServer: true });
  const host = { connect: (_line: unknown, o: { callId: string }) => { connected.push(o.callId); return { receive: async () => {}, closed: () => {}, entry: null }; } };
  const dial = dialAdapter({ host, wss, devAllowed });
  const server = http.createServer();
  server.on("upgrade", (req, socket, head) => { if (!dial.upgrade(req, socket, head, new URL(req.url ?? "/", "http://x"))) socket.destroy(); });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  try { await fn(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`, connected); } finally { server.close(); wss.close(); }
}
const opens = (url: string) => new Promise<boolean>(resolve => {
  const ws = new WebSocket(url);
  ws.on("open", () => { ws.close(); resolve(true); });
  ws.on("error", () => resolve(false));
});

test("test phone: a token the (slow) check accepts connects; one it refuses, or a check that fails, doesn't", async () => {
  const check = async (token: string | null) => { await new Promise(r => setTimeout(r, 20)); if (token === "boom") throw new Error("db down"); return token === "good"; };
  await withDial(check, async (base, connected) => {
    assert.equal(await opens(`${base}/dial/c1?dev=1&token=good`), true);
    assert.equal(await opens(`${base}/dial/c2?dev=1&token=removed-member`), false);
    assert.equal(await opens(`${base}/dial/c3?dev=1&token=boom`), false);
    assert.equal(await opens(`${base}/dial/c4?dev=1`), false);
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(connected, ["c1"]);
  });
});
