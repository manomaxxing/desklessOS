// The composition root: every component built once, here, from the config. Nothing
// else reads the server's settings or wires parts together.
//
//   phone lines ─► telephony adapters ─► call host ─► call (session + memory scope)
//                  (Dial, Twilio, test)               │ saved as it goes, ended in one
//                                                     ▼ transaction with its job
//   Postgres ◄── memory, requests, outbound calls, job queue, voice clips, bus
//      ▲
//   background tick (inline timer, or POST /internal/tick): after-call jobs, notifications,
//   outbound calls, lost calls, embeddings
//
// createApp() → { server, start(), stop() }: start() listens; stop() drains (SIGTERM).

import http from "node:http";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.mjs";
import { createLogger } from "./log.mjs";
import { geminiEndpoint } from "./engine/gemini-endpoint.mjs";
import { warmModel, extractJsonResilient } from "./engine/gemini.mjs";
import { createFish } from "./engine/fish.mjs";
import { createTurnDetector } from "./engine/turn-detector.mjs";
import { openDb, openMemory } from "./memory/index.mjs";
import { createBus } from "./bus.mjs";
import { createQueue } from "./jobs/queue.mjs";
import { createBackground } from "./jobs/background.mjs";
import { createScheduler } from "./jobs/scheduler.mjs";
import { createAuth } from "./admin/auth.mjs";
import { createRequests } from "./admin/requests.mjs";
import { createNotifier } from "./notify.mjs";
import { createMonitor } from "./monitor.mjs";
import { loadSkill } from "./skills/index.mjs";
import { loadSkillFromTemplates } from "./skills/from-templates.mjs";
import { loadVoiceClips } from "./calls/voice.mjs";
import { createCallStarter } from "./calls/start.mjs";
import { createAfterCall } from "./calls/after-call.mjs";
import { createCallHost } from "./telephony/host.mjs";
import { dialAdapter } from "./telephony/dial.mjs";
import { twilioAdapter } from "./telephony/twilio.mjs";
import { fakeAdapter } from "./telephony/fake.mjs";
import { createApi } from "./http/api.mjs";

const RECONNECT_GRACE_MS = 20000; // Dial re-dials for ~15 s after a drop

export async function createApp(env = process.env) {
  const cfg = loadConfig(env);
  const log = createLogger({ format: cfg.logFormat });
  const endpoint = geminiEndpoint(env);
  if (!endpoint) throw new Error("no Gemini: set GOOGLE_CLOUD_PROJECT (Vertex) or GEMINI_API_KEY");
  const fish = createFish(env);
  if (!fish) throw new Error("no Fish: set FISH_AUDIO_API_KEY");

  // ---------- state: Postgres, and the bus between instances ----------
  const skill = await loadSkill();
  const adminSkill = cfg.adminPhones.length ? loadSkillFromTemplates("admin") : null;
  const db = await openDb(cfg.databaseUrl);
  const queue = createQueue({ db, log });
  const memory = await openMemory({ db, skill, queue, endpoint, log });
  const bus = await createBus({ db, log });
  const monitor = createMonitor({ bus, store: memory, record: cfg.recordCalls, audioRoot: `${cfg.dataDir}/calls` });

  // ---------- admin: login, requests, notifications ----------
  const auth = createAuth();
  const notifier = createNotifier();
  let scheduler = null;
  const requests = createRequests({
    memory, skill, auth, queue, notifier, publicUrl: cfg.publicUrl, log,
    onCancel: objectiveId => scheduler?.cancelFor(objectiveId),
    outbound: () => Boolean(scheduler),
    llm: args => extractJsonResilient({ endpoint, models: [cfg.plannerModel, cfg.model, "gemini-2.5-flash"], think: true, timeoutMs: 45000, retries429: 2, ...args }),
  });

  // ---------- calls ----------
  // Pre-recorded lines, from Postgres (synthesised once). Calls wait for them; the server listens at once.
  const clips = loadVoiceClips({ fish, store: memory.voiceClips, personas: [skill.PERSONA, ...(adminSkill ? [adminSkill.PERSONA] : [])], log });
  clips.catch(err => log("voice clips error", err.message));
  // Smart Turn v3 (TURN_DETECTOR=smart-turn): hears in his voice whether he's done.
  const turnDetector = cfg.turnDetector ? await createTurnDetector({ log }) : null;
  let background = null;
  const startCall = createCallStarter({ cfg, skill, adminSkill, memory, monitor, clips, endpoint, fish, turnDetector, requests, auth, background: { kick: () => background.kick() }, log });
  const host = createCallHost({ startCall, monitor, log, graceMs: RECONNECT_GRACE_MS });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  const devAllowed = token => (!cfg.devToken && !auth.enabled) || (cfg.devToken && token === cfg.devToken) || Boolean(auth.session(token));
  const onStatus = status => scheduler?.callStatus(status).catch(err => log("call status error", err.message));
  const twilio = twilioAdapter({ host, wss, bus, env, onStatus, monitor, log });
  const fake = cfg.outbound === "fake" ? fakeAdapter({ wss, devAllowed, onStatus, monitor, log }) : null;
  const adapters = [dialAdapter({ host, wss, secret: cfg.dialSecret, devAllowed, monitor, log }), twilio, fake].filter(Boolean);

  // Outbound calls: OUTBOUND=twilio (needs the Twilio settings), fake for tests, or off.
  const carrier = cfg.outbound === "fake" ? fake : cfg.outbound === "twilio" ? twilio : null;
  if (carrier) scheduler = createScheduler({ memory, carrier, requests, log, monitor });

  // ---------- background work ----------
  const afterCall = createAfterCall({ memory, skill, endpoint, model: cfg.model, requests, scheduler, monitor, log });
  background = createBackground({
    queue, memory, scheduler: () => scheduler, mode: cfg.background, publicUrl: cfg.publicUrl, token: cfg.tickToken, intervalMs: cfg.tickMs, log,
    handlers: { after_call: afterCall, notify: payload => requests.sendNotification(payload) },
  });

  // ---------- HTTP ----------
  const api = createApi({ cfg, skill, memory, queue, requests, auth, notifier, monitor, background, scheduler, host, clips, endpoint, fish, adapters, log });
  const server = http.createServer((req, res) => {
    api.handle(req, res).catch(err => { log("http error", req.url, err.message); if (!res.headersSent) res.writeHead(500).end(); });
  });
  server.on("upgrade", (req, socket, head) => api.upgrade(req, socket, head, wss));

  // Gemini auth before the first caller, and ahead of token expiry.
  const warmGemini = () => endpoint.warm().then(() => warmModel({ endpoint, model: cfg.model })).catch(err => log("gemini warm-up failed:", err.message));
  let stopBackground = () => {};
  let warmTimer = null;

  return {
    server, cfg, log, memory, background,
    async start() {
      warmGemini();
      warmTimer = setInterval(warmGemini, 5 * 60 * 1000);
      warmTimer.unref();
      stopBackground = background.start();
      await new Promise(resolve => server.listen(cfg.port, resolve));
      log(`DesklessOS on :${cfg.port} (gemini: ${endpoint.door} ${cfg.model}, fish: ${fish.model}, db: ${db.kind}, background: ${cfg.background}, outbound: ${carrier?.id ?? "off"}, dial signature: ${cfg.dialSecret ? "required" : "OFF"})`);
    },
    /** SIGTERM (a deploy, a scale-down): no new connections; calls here end and are saved; their after-call jobs wait in the queue. */
    async stop(reason = "server_shutdown") {
      stopBackground();
      clearInterval(warmTimer);
      server.close();
      await host.closeAll(reason);
      await db.close().catch(() => {});
    },
  };
}
