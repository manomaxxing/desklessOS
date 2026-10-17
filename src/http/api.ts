// The HTTP API and pages (src/http/routes/*: one module per area; who may call what:
// src/http/access.ts), the phone lines' webhooks (their adapters, each with its own signature)
// and the WebSocket upgrades (the monitor's live feed, the phone lines).

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocketServer } from "ws";
import type { ApiDeps } from "./deps.ts";
import { createAccess } from "./access.ts";
import { createRouter } from "./router.ts";
import { healthRoutes } from "./routes/health.ts";
import { adminRoutes } from "./routes/admin.ts";
import { peopleRoutes } from "./routes/people.ts";
import { requestRoutes } from "./routes/requests.ts";
import { callRoutes } from "./routes/calls.ts";
import { pageRoutes, serveStatic } from "./static.ts";
import { createCallNow } from "../calls/call-now.ts";

export function createApi(deps: ApiDeps) {
  const { cfg, auth, team, memory, adapters, skill, monitor, log } = deps;
  const access = createAccess({ cfg, auth, team });
  const callNow = createCallNow({ memory, adapters, objectiveParams: skill.objectiveParams, callsUrl: cfg.whatsappCallsUrl, tickToken: cfg.tickToken, log });
  const route = createRouter({
    routes: [
      ...healthRoutes(deps, callNow.placeHere),
      ...pageRoutes,
      ...adminRoutes(deps, access),
      ...peopleRoutes(deps, callNow.place),
      ...requestRoutes(deps),
      ...callRoutes(deps),
    ],
    identify: access.identify,
    allowed: access.allowed,
    log,
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    for (const a of adapters) if (a.http && (await a.http(req, res, url))) return; // Twilio's and WhatsApp's webhooks carry their own signature
    if (await route(req, res, url)) return;
    serveStatic(req, res, url);
  }

  /** WebSocket upgrades: the monitor's live feed, then the phone lines (Dial, Twilio, the test phone). */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, wss: WebSocketServer): void {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/monitor-ws") {
      access.identify(req, url).then(who => {
        if (!access.isUser(who)) { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => {
          const unsubscribe = monitor.subscribe(msg => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); });
          ws.on("close", unsubscribe);
        });
      }, () => socket.destroy());
      return;
    }
    for (const a of adapters) if (a.upgrade?.(req, socket, head, url)) return;
    socket.destroy();
  }

  return { handle, upgrade, isAdmin: access.isAdmin };
}
export type Api = ReturnType<typeof createApi>;
