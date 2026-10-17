// The composition root: every component built once, here, from the config. Nothing
// else reads the server's settings or wires parts together.
//
//   phone lines ─► telephony adapters ─► call host ─► call (session + memory scope)
//                  (Dial, Twilio, WhatsApp, test)     │ saved as it goes, ended in one
//                                                     ▼ transaction with its job
//   Postgres ◄── memory, requests, outbound calls, job queue, voice clips, bus
//      ▲
//   background tick (inline timer, or POST /internal/tick): after-call jobs, notifications,
//   outbound calls, lost calls, embeddings
//
// createApp() → { server, start(), stop() }: start() listens; stop() drains (SIGTERM).

import http from "node:http";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";
import { geminiEndpoint } from "./engine/gemini-endpoint.ts";
import { warmModel, extractJsonResilient, FALLBACK_MODEL } from "./engine/gemini.ts";
import { createFish } from "./engine/fish.ts";
import { createTurnDetector } from "./engine/turn-detector.ts";
import { openDb, openMemory } from "./memory/index.ts";
import { createBus } from "./bus.ts";
import { createQueue } from "./jobs/queue.ts";
import { createBackground } from "./jobs/background.ts";
import { createScheduler } from "./jobs/scheduler.ts";
import { createAuth } from "./admin/auth.ts";
import { createTeam } from "./admin/team.ts";
import { createRequests } from "./admin/requests.ts";
import { createNotifier } from "./notify.ts";
import { createMonitor } from "./monitor.ts";
import { loadSkill } from "./skills/index.ts";
import { loadSkillFromTemplates } from "./skills/from-templates.ts";
import { loadVoiceClips } from "./calls/voice.ts";
import { createCallStarter } from "./calls/start.ts";
import { createAfterCall } from "./calls/after-call.ts";
import { createRecapWriter } from "./calls/recap.ts";
import { createCallHost } from "./telephony/host.ts";
import { dialAdapter } from "./telephony/dial.ts";
import { twilioAdapter } from "./telephony/twilio.ts";
import { fakeAdapter } from "./telephony/fake.ts";
import { whatsappAdapter, whatsappSender } from "./telephony/whatsapp.ts";
import { createQuoteStore } from "./quotes/store.ts";
import { createApi } from "./http/api.ts";
import type { ApiDeps } from "./http/deps.ts";
import { safeEqual } from "./shared/safe-equal.ts";

const RECONNECT_GRACE_MS = 20000; // Dial re-dials for ~15 s after a drop

export async function createApp(env: NodeJS.ProcessEnv = process.env) {
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

  // ---------- admin: login (the owner's code, the team's own), requests, notifications ----------
  const auth = createAuth();
  const team = createTeam({ db, auth });
  const notifier = createNotifier();
  let scheduler: ReturnType<typeof createScheduler> | null = null;
  const requests = createRequests({
    memory, skill, auth, queue, notifier, publicUrl: cfg.publicUrl, log,
    onCancel: async (objectiveId: string) => { await scheduler?.cancelFor(objectiveId); },
    outbound: () => Boolean(scheduler),
    llm: (args: Omit<Parameters<typeof extractJsonResilient>[0], "endpoint" | "models">) => extractJsonResilient({ endpoint, models: [cfg.plannerModel, cfg.model, FALLBACK_MODEL], think: true, timeoutMs: 45000, retries429: 2, ...args }),
  });

  // ---------- calls ----------
  // Pre-recorded lines, from Postgres (synthesised once), loaded before the server listens.
  const clips = loadVoiceClips({ fish, store: memory.voiceClips, personas: [skill.PERSONA, ...(adminSkill ? [adminSkill.PERSONA] : [])], log });
  clips.catch((err: Error) => log("voice clips error", err.message));
  // Smart Turn v3 (TURN_DETECTOR=smart-turn): hears in his voice whether he's done.
  const turnDetector = cfg.turnDetector ? await createTurnDetector({ log }) : null;
  let background: ReturnType<typeof createBackground> | null = null;
  // Quotes made in a call (quote_send), sent as a PDF into his WhatsApp chat.
  const quotes = createQuoteStore({ db });
  const whatsappOut = whatsappSender({ env }); // messages into his chat: quotes, the note after a call
  const startCall = createCallStarter({ cfg, skill, adminSkill, memory, monitor, clips, endpoint, fish, turnDetector, requests, auth, quotes, whatsapp: whatsappOut, background: { kick: () => background?.kick() }, log });
  const host = createCallHost({ startCall, monitor, log, graceMs: RECONNECT_GRACE_MS });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  // The test phone and scripted calls (DEV_TOKEN, or an admin session) may connect with ?dev=1.
  // A team member's session counts while they're still on the team (as for the API).
  const devAllowed = async (token: string | null): Promise<boolean> => {
    if (!cfg.devToken && !auth.enabled) return true;
    if (cfg.devToken && safeEqual(token, cfg.devToken)) return true;
    return Boolean(token && (await team.check(auth.session(token))));
  };
  const onStatus = (status: Parameters<NonNullable<typeof scheduler>["callStatus"]>[0]) => { scheduler?.callStatus(status).catch((err: Error) => log("call status error", err.message)); };
  const twilio = twilioAdapter({ host, wss, bus, env, onStatus, monitor, log });
  const fake = cfg.outbound === "fake" ? fakeAdapter({ wss, devAllowed, onStatus, monitor, log }) : null;
  const whatsapp = whatsappAdapter({ host, env, onStatus, monitor, log });
  const adapters = [dialAdapter({ host, wss, secret: cfg.dialSecret, requireSignature: cfg.cloudRun, devAllowed, monitor, log }), twilio, whatsapp, fake].filter(a => a !== null);

  // Outbound calls: OUTBOUND=twilio (needs the Twilio settings), fake for tests, or off.
  const carrier = cfg.outbound === "fake" ? fake : cfg.outbound === "twilio" ? twilio : null;
  if (carrier) scheduler = createScheduler({ memory, carrier, requests, log, monitor });

  // ---------- background work ----------
  const writeRecap = createRecapWriter({ endpoint, model: cfg.model, agent: skill.persona.agentLabel });
  const afterCall = createAfterCall({ memory, skill, endpoint, model: cfg.model, writeRecap, whatsapp: whatsappOut, requests, scheduler, monitor, notifier, log });
  background = createBackground({
    queue, memory, scheduler: () => scheduler, mode: cfg.background, publicUrl: cfg.publicUrl, token: cfg.tickToken, intervalMs: cfg.tickMs, log,
    handlers: { after_call: afterCall, notify: payload => requests.sendNotification(payload) },
  });

  // ---------- HTTP ----------
  // The parts as the API sees them (src/http/deps.ts: only what it calls).
  const deps = { cfg, skill, memory, queue, requests, auth, team, notifier, monitor, background, scheduler, host, clips, endpoint, fish, adapters, writeRecap, quotes, whatsappOut, log } satisfies ApiDeps;
  const api = createApi(deps);
  // Logged by path only: a query string can carry a token.
  const pathOf = (url: string | undefined) => (url ?? "").split("?")[0];
  const server = http.createServer((req, res) => {
    api.handle(req, res).catch((err: Error) => { log("http error", pathOf(req.url), err.message); if (!res.headersSent) res.writeHead(500).end(); });
  });
  // An upgrade is anyone's: a malformed one (a bad URL or encoding) mustn't take the instance and its calls down.
  server.on("upgrade", (req, socket, head) => {
    socket.on("error", () => socket.destroy());
    try { api.upgrade(req, socket, head, wss); } catch (err) { log("upgrade refused:", err instanceof Error ? err.message : String(err)); socket.destroy(); }
  });

  // Gemini auth before the first caller, and ahead of token expiry.
  const warmGemini = () => Promise.resolve(endpoint.warm?.()).then(() => warmModel({ endpoint, model: cfg.model })).catch((err: Error) => log("gemini warm-up failed:", err.message));
  let stopBackground: () => void = () => {};
  let warmTimer: ReturnType<typeof setInterval> | undefined;

  return {
    server, cfg, log, memory, background,
    async start() {
      warmGemini();
      warmTimer = setInterval(warmGemini, 5 * 60 * 1000);
      warmTimer.unref();
      stopBackground = background?.start() ?? (() => {});
      // The clips before listening: startup is when Cloud Run gives full CPU (after the first
      // boot they're one query), and the first call doesn't wait for them.
      await clips.catch(() => {});
      await new Promise<void>(resolve => server.listen(cfg.port, resolve));
      log(`DesklessOS on :${cfg.port} (gemini: ${endpoint.door} ${cfg.model}, fish: ${fish.model}, db: ${db.kind}, background: ${cfg.background}, outbound: ${carrier?.id ?? "off"}, whatsapp: ${whatsapp ? "on" : "off"}, dial signature: ${cfg.dialSecret ? "required" : "OFF"})`);
    },
    /** SIGTERM (a deploy, a scale-down): no new connections; calls here end and are saved; their after-call jobs wait in the queue. */
    async stop(reason = "server_shutdown") {
      stopBackground();
      clearInterval(warmTimer);
      server.close();
      await host.closeAll(reason);
      await whatsapp?.closeAll(); // his phone is hung up, not left ringing on a dead line
      await db.close().catch(() => {});
    },
  };
}
