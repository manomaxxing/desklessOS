// Health, the background tick (Cloud Scheduler, every minute), and a WhatsApp call placed on
// this instance (the main service relays "Call now" here: this service holds the call's audio).
import type { ApiDeps } from "../deps.ts";
import type { Route } from "../router.ts";
import type { CallNow } from "../../calls/call-now.ts";

export function healthRoutes({ cfg, memory, clips, endpoint, fish, host, background }: ApiDeps, placeHere: (body: CallNow) => Promise<unknown>): Route[] {
  const ready = (p: Promise<unknown>, ms: number) => Promise.race([p.then(() => true, () => false), new Promise<boolean>(r => setTimeout(() => r(false), ms))]);
  return [
    ["GET", "/healthz", "public", () => ({ ok: true })],
    ["GET", "/api/health", "public", async () => {
      const db = await memory.db.query("select 1").then(() => true, () => false);
      return { ok: db, db, clips: await ready(clips, 10), gemini: endpoint.door, model: cfg.model, fishModel: fish.model, dialSigned: Boolean(cfg.dialSecret), calls: host.calls.size, background: background.mode };
    }],
    ["POST", "/internal/tick", "tick", () => background.tick()],
    // { to: one of our users' numbers, rehearsalOf?: a user id, objectives?: [{ template, params }] } → { callId }
    ["POST", "/internal/whatsapp/call", "tick", ({ body }) => placeHere(body)],
  ];
}
