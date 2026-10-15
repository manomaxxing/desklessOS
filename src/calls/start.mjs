// One call's wiring, whichever line it came in on (src/telephony/host.mjs calls this):
// who's calling (memory, read once within a budget), what the call is about (its
// agenda), the engine, and its end: the call's row closed with its timeline, and the
// after-call job kicked off (src/calls/after-call.mjs).
// Engines: "cascade" (src/engine/session.mjs: Gemini hears, Fish speaks) or "live"
// (src/engine/live-session.mjs: Gemini Live). If Live fails mid-call, the cascade takes
// the call over. Calls we make and Max's own line always run on the cascade.
// Max on his own line (ADMIN_PHONE) gets the admin persona instead, and keeps nothing.
// A WhatsApp call can send him a quote PDF into his chat (quote_send, once his "quotes"
// feature is on); the online test phone saves it for the dashboard only; other lines don't offer it.

import { createCallSession } from "../engine/session.mjs";
import { createLiveSession } from "../engine/live-session.mjs";
import { adminTools } from "../tools/admin.mjs";
import { quoteSend } from "../tools/quote.mjs";
import { hasFeature } from "../features.mjs";
import { emptyScope, e164 } from "../memory/pg.mjs";

export const describeMode = c => (c.engine === "live" ? `Gemini Live · ${c.liveModel} · ${c.liveVoice}` : `${c.model} + Fish · ${c.mask}`);

export function createCallStarter({ cfg, skill, adminSkill = null, memory, monitor, clips, endpoint, fish, turnDetector = null, requests, auth, background, quotes = null, whatsapp = null, log }) {
  const adminPhones = new Set(cfg.adminPhones.map(e164).filter(Boolean));
  const phoneConfig = { engine: cfg.engine, model: cfg.model, mask: cfg.mask, liveModel: cfg.liveModel, liveVoice: cfg.liveVoice };
  const callLog = id => (...a) => log(`[${id.slice(-6)}]`, ...a);
  const recordDir = cfg.recordCalls ? callId => monitor.audioDir(callId) : null;

  function startAdminCall({ id, send, dev, config, assets }) {
    monitor.system(`call ${id}: Max on the admin line`);
    const session = createCallSession({
      send, dev, skill: adminSkill, agenda: adminSkill.createAgenda(), endpoint, model: cfg.model, extractModel: cfg.model, memory: emptyScope(), config: { ...config, engine: "cascade" },
      fish, assets, turnDetector, tools: adminTools({ requests, auth }), log: callLog(id), recordDir,
      onEvent: ev => monitor.event(id, ev), onEnd: reason => { monitor.end(id, reason); },
    });
    return { session, userId: null };
  }

  return async function startCall({ id, msg, send, dev, source }) {
    const assets = await clips;
    const outbound = msg.direction === "outbound";
    // The browser test phone and scripted callers pick their own engine, model, mask and Live voice.
    const config = { ...phoneConfig, ...(dev && msg.config ? Object.fromEntries(Object.entries(msg.config).filter(([k]) => k in phoneConfig)) : {}) };
    if (!outbound && adminSkill && adminPhones.has(e164(msg.from))) {
      monitor.start({ id, from: msg.from, to: msg.to, lang: null, mode: "admin line", source });
      return startAdminCall({ id, send, dev, config, assets: assets[adminSkill.PERSONA] });
    }
    const shownSource = source === "dev" ? (/-browser$/.test(msg.from ?? "") ? "browser" : "script") : source;
    monitor.start({ id, from: msg.from, to: msg.to, lang: null, mode: describeMode(config), source: shownSource });
    // Memory down? The call still happens, only without what we know about him (and nothing is kept).
    const scope = await memory.openCall({ callId: id, from: outbound ? msg.to : msg.from, to: outbound ? msg.from : msg.to, userId: msg.user_id ?? null, direction: outbound ? "outbound" : "inbound", source: shownSource })
      .catch(err => { log(`call ${id}: memory error, going on without it: ${err.message}`); monitor.system(`call ${id}: memory unavailable (${err.message})`, "error"); return emptyScope(); });
    if (scope.stats) monitor.event(id, { event: "context", ...scope.stats });
    if (!scope.user) monitor.system(`call ${id}: unknown caller ${msg.from ?? "?"}: empty memory, nothing saved`, "warn");
    const agenda = skill.createAgenda({ objectives: scope.objectives, discovery: scope.discovery, direction: outbound ? "outbound" : "inbound", user: scope.user });
    const stored = agenda.objectives.filter(o => o.stored).map(o => o.id);
    if (stored.length) await scope.setAgenda(stored);
    if (agenda.objectives.length) monitor.system(`call ${id}: agenda ${agenda.objectives.map(o => (o.stored ? `${o.template.id} ${o.id}` : o.template.id)).join(", ")}`);

    const viaWhatsApp = source === "whatsapp" && Boolean(whatsapp) && Boolean(msg.from);
    const tools = quotes && scope.user && !outbound && (viaWhatsApp || dev) && hasFeature(scope.user, "quotes")
      ? [quoteSend({ memory: scope, quotes, sender: viaWhatsApp ? whatsapp : null, to: viaWhatsApp ? msg.from : null, agent: skill.persona.agentLabel, log: callLog(id) })]
      : [];
    const common = {
      send, dev, skill, agenda, endpoint, extractModel: cfg.model, memory: scope, assets: assets[skill.PERSONA], recordDir, log: callLog(id), tools,
      firstCall: !outbound && scope.firstCall !== false,
      onEvent: ev => monitor.event(id, ev),
      async onEnd(reason, final) {
        const record = monitor.end(id, reason);
        const ended = await scope.endCall({ ...final, reason, timeline: record?.events ?? [], meta: { mode: describeMode(config), usd: record?.cost?.usd ?? final.usd ?? null, cost: record?.cost ?? null } });
        if (ended) background.kick();
      },
    };
    const cascade = (extra = {}) => createCallSession({ ...common, model: cfg.model, fish, turnDetector, ...extra, config: { ...config, engine: "cascade" } });
    // A call we made speaks his language from the start (our own number says nothing about him).
    if (config.engine !== "live" || outbound) return { session: cascade(outbound && scope.user?.lang ? { initialLang: scope.user.lang } : {}) };

    // Gemini Live; if it fails (setup refused, socket drop), the call goes on with the cascade.
    const session = {
      current: null,
      handle: m => session.current.handle(m),
      close: r => session.current.close(r),
      get ended() { return session.current.ended; },
    };
    const live = createLiveSession({
      ...common,
      config,
      onFatal({ reason, turns, lang, greeted }) {
        monitor.system(`Live failed on ${id}: ${reason} → continuing on ${cfg.model} + Fish`, "warn");
        live.abandon();
        const next = cascade({ initialTurns: turns, initialLang: lang });
        next.handle({ ...msg, reconnect: greeted });
        session.current = next;
      },
    });
    session.current = live;
    return { session };
  };
}
