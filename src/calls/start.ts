// One call's wiring, whichever line it came in on (src/telephony/host.ts calls this):
// who's calling (memory, read once within a budget), what the call is about (its
// agenda), the engine, and its end: the call's row closed with its timeline, and the
// after-call job kicked off (src/calls/after-call.ts).
// Engines: "cascade" (src/engine/session.ts: Gemini hears, Fish speaks) or "live"
// (src/engine/live-session.ts: Gemini Live). If Live fails mid-call, the cascade takes
// the call over. Calls we make and Max's own line always run on the cascade.
// Max on his own line (ADMIN_PHONE) gets the admin persona instead, and keeps nothing.
// A rehearsal (msg.rehearsal_of: a user id) is a call to Max's own phone that plays one to
// that person: his memory and objectives, read only; the call is kept under the demo user.
// A WhatsApp call can send him a quote PDF into his chat (quote_send, once his "quotes"
// feature is on); the online test phone saves it for the dashboard only; other lines don't offer it.

import { createCallSession } from "../engine/session.ts";
import { createLiveSession } from "../engine/live-session.ts";
import { adminTools } from "../tools/admin.ts";
import { quoteSend } from "../tools/quote.ts";
import { parseLists } from "../quotes/lists.ts";
import { hasFeature } from "../features.ts";
import { emptyScope, e164 } from "../memory/pg.ts";
import { shortCallId } from "../telephony/whatsapp.ts";
import { isRecord } from "../shared/is-record.ts";
import type { Skill } from "../skills/from-templates.ts";
import type { Monitor } from "../monitor.ts";
import type { VoiceAssets } from "./voice.ts";
import type { CallSession, StartCall } from "../telephony/host.ts";
import type { AdminRequests, AdminAuth } from "../tools/admin.ts";
import type { DocumentSender } from "../tools/quote.ts";
import type { QuoteStore } from "../quotes/store.ts";
import type { Fish } from "../engine/fish.ts";
import type { TurnDetector } from "../engine/turn-detector.ts";
import type { Engine, Mask } from "../config.ts";
import type { CallFinal } from "../engine/session.ts";
import type { CallEvent, CallScope, FrameOut } from "../types/call.ts";
import type { Endpoint } from "../types/gemini.ts";
import type { LangId, Log, Turn } from "../types/common.ts";

/** How a call is run: the engine, its models, what he hears while it thinks. */
export type PhoneConfig = {
  engine: Engine;
  model: string;
  mask: Mask;
  liveModel: string;
  liveVoice: string;
};

export const describeMode = (c: PhoneConfig): string => (c.engine === "live" ? `Gemini Live · ${c.liveModel} · ${c.liveVoice}` : `${c.model} + Fish · ${c.mask}`);

/** What a call needs from memory (src/memory: openCall). */
export interface StarterMemory {
  openCall(o: { callId: string; from: string | null; to: string | null; userId: string | null; direction: "inbound" | "outbound"; source: string; rehearsalOf: string | null }): Promise<CallScope>;
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
// A dev caller's own engine settings (the browser test phone, scripted callers): only the known keys, with values they can take.
function ownConfig(given: Record<string, unknown>): Partial<PhoneConfig> {
  const out: Partial<PhoneConfig> = {};
  if (given.engine === "cascade" || given.engine === "live") out.engine = given.engine;
  if (given.mask === "typing" || given.mask === "filler" || given.mask === "none") out.mask = given.mask;
  for (const key of ["model", "liveModel", "liveVoice"] as const) { const v = given[key]; if (typeof v === "string") out[key] = v; }
  return out;
}

export function createCallStarter({ cfg, skill, adminSkill = null, memory, monitor, clips, endpoint, fish, turnDetector = null, requests, auth, background, quotes = null, whatsapp = null, log }: {
  cfg: PhoneConfig & { adminPhones: string[]; recordCalls: boolean };
  skill: Skill;
  /** Max's own line (ADMIN_PHONE): the admin persona. */
  adminSkill?: Skill | null;
  memory: StarterMemory;
  monitor: Monitor;
  /** The pre-recorded lines per persona (src/calls/voice.ts), loading. */
  clips: Promise<Record<string, VoiceAssets>>;
  endpoint: Endpoint;
  fish: Fish;
  /** Smart Turn (src/engine/turn-detector.ts): hears in his voice whether he's done. */
  turnDetector?: Pick<TurnDetector, "predict"> | null;
  requests: AdminRequests;
  auth: AdminAuth;
  background: { kick(): void };
  quotes?: QuoteStore | null;
  /** Documents into his WhatsApp chat (quotes). */
  whatsapp?: DocumentSender | null;
  log: Log;
}): StartCall {
  const adminPhones = new Set(cfg.adminPhones.map(e164).filter(Boolean));
  const phoneConfig: PhoneConfig = { engine: cfg.engine, model: cfg.model, mask: cfg.mask, liveModel: cfg.liveModel, liveVoice: cfg.liveVoice };
  const callLog = (id: string): Log => (...a) => log(`[${shortCallId(id)}]`, ...a);
  const recordDir = cfg.recordCalls ? (callId: string) => monitor.audioDir(callId) : null;

  function startAdminCall({ id, send, dev, config, assets, admin }: { id: string; send: (frame: FrameOut) => void; dev: boolean; config: PhoneConfig; assets: VoiceAssets | undefined; admin: Skill }): { session: CallSession; userId: null } {
    monitor.system(`call ${id}: Max on the admin line`);
    const session: CallSession = createCallSession({
      send, dev, skill: admin, agenda: admin.createAgenda(), endpoint, model: cfg.model, extractModel: cfg.model, memory: emptyScope(), config: { ...config, engine: "cascade" },
      fish, assets: assets ?? {}, turnDetector, tools: adminTools({ requests, auth }), log: callLog(id), recordDir,
      onEvent: (ev: CallEvent) => monitor.event(id, ev), onEnd: (reason: string) => { monitor.end(id, reason); },
    });
    return { session, userId: null };
  }

  return async function startCall({ id, msg, send, dev, source }) {
    const assets = await clips;
    const outbound = msg.direction === "outbound";
    // The browser test phone and scripted callers pick their own engine, model, mask and Live voice.
    const config: PhoneConfig = { ...phoneConfig, ...(dev && msg.config ? ownConfig(msg.config) : {}) };
    const from = msg.from ?? null;
    const to = msg.to ?? null;
    if (!outbound && adminSkill && adminPhones.has(e164(from))) {
      monitor.start({ id, from, to, lang: null, mode: "admin line", source });
      return startAdminCall({ id, send, dev, config, assets: assets[adminSkill.PERSONA], admin: adminSkill });
    }
    const shownSource = source === "dev" ? (/-browser$/.test(from ?? "") ? "browser" : "script") : source;
    monitor.start({ id, from, to, lang: null, mode: describeMode(config), source: shownSource });
    // Memory down? The call still happens, only without what we know about him (and nothing is kept).
    const scope = await memory.openCall({ callId: id, from: outbound ? to : from, to: outbound ? from : to, userId: msg.user_id ?? null, direction: outbound ? "outbound" : "inbound", source: shownSource, rehearsalOf: msg.rehearsal_of ?? null })
      .catch((err: unknown) => { log(`call ${id}: memory error, going on without it: ${errText(err)}`); monitor.system(`call ${id}: memory unavailable (${errText(err)})`, "error"); return emptyScope(); });
    if (scope.stats) monitor.event(id, { event: "context", ...scope.stats });
    if (!scope.user) monitor.system(`call ${id}: unknown caller ${from ?? "?"}: empty memory, nothing saved`, "warn");
    if (scope.rehearsal) monitor.system(`call ${id}: a rehearsal of a call to ${scope.rehearsal.of} (his memory, read only)`);
    // A call Toni makes can bring its errand along (a rehearsal's: not stored, so nothing is written back).
    const errands = (msg.objectives ?? []).map((o, i) => ({ id: `errand_${i + 1}`, template: o.template, params: skill.objectiveParams(o.template, o.params ?? {}), stored: false, lang: o.lang ?? null }));
    // His lists (People card), parsed once: for the agenda's checklist, and for pricing a quote.
    const lists = scope.user?.profile?.lists ? parseLists(scope.user.profile.lists) : null;
    const agenda = skill.createAgenda({ objectives: [...errands, ...scope.objectives], discovery: scope.discovery, direction: outbound ? "outbound" : "inbound", user: scope.user, lists });
    const stored = agenda.objectives.filter(o => o.stored).map(o => o.id);
    // What the call is for, as the dashboard shows it: each item's title and what it was given.
    const goal = agenda.objectives.map(o => ({
      template: o.template.id, title: o.template.title, description: o.template.description ?? "", focus: typeof o.params.focus === "string" ? o.params.focus : "",
      questions: (Array.isArray(o.params.questions) ? o.params.questions : []).map((q: unknown) => (isRecord(q) ? q.ask : undefined)), stored: Boolean(o.stored),
    }));
    // Only for the dashboard and the after-call step: a database blip here doesn't stop the call.
    if (goal.length) await scope.setAgenda(stored, goal).catch((err: unknown) => { log(`call ${id}: agenda not saved, going on: ${errText(err)}`); monitor.system(`call ${id}: agenda not saved (${errText(err)})`, "warn"); });
    if (agenda.objectives.length) monitor.system(`call ${id}: agenda ${agenda.objectives.map(o => (o.stored ? `${o.template.id} ${o.id}` : o.template.id)).join(", ")}`);

    const viaWhatsApp = source === "whatsapp" && Boolean(whatsapp) && Boolean(from);
    const tools = quotes && scope.user && !outbound && (viaWhatsApp || dev) && hasFeature(scope.user, "quotes")
      ? [quoteSend({ memory: scope, quotes, sender: viaWhatsApp ? whatsapp : null, to: viaWhatsApp ? from : null, agent: skill.persona.agentLabel, lists, log: callLog(id) })]
      : [];
    const common = {
      send, dev, skill, agenda, endpoint, extractModel: cfg.model, memory: scope, assets: assets[skill.PERSONA] ?? {}, recordDir, log: callLog(id), tools,
      firstCall: !outbound && scope.firstCall !== false,
      onEvent: (ev: CallEvent) => monitor.event(id, ev),
      async onEnd(reason: string, final: CallFinal) {
        const record = monitor.end(id, reason);
        const ended = await scope.endCall({ ...final, reason, timeline: record?.events ?? [], meta: { mode: describeMode(config), usd: record?.cost?.usd ?? final.usd ?? null, cost: record?.cost ?? null } });
        if (ended) background.kick();
      },
    };
    const cascade = (extra: { initialTurns?: Turn[]; initialLang?: LangId | null } = {}): CallSession => createCallSession({ ...common, model: cfg.model, fish, turnDetector, ...extra, config: { ...config, engine: "cascade" } });
    // A call we made speaks his language from the start (our own number says nothing about him).
    if (config.engine !== "live" || outbound) return { session: cascade(outbound && scope.user?.lang ? { initialLang: scope.user.lang } : {}) };

    // Gemini Live; if it fails (setup refused, socket drop), the call goes on with the cascade.
    let current: CallSession | null = null;
    const session: CallSession = {
      handle: m => current?.handle(m),
      close: r => current?.close(r),
      get ended() { return current?.ended ?? false; },
    };
    const live = createLiveSession({
      ...common,
      config,
      onFatal({ reason, turns, lang, greeted }: { reason: string; turns: Turn[]; lang: LangId | null; greeted: boolean }) {
        monitor.system(`Live failed on ${id}: ${reason} → continuing on ${cfg.model} + Fish`, "warn");
        live.abandon();
        const next = cascade({ initialTurns: turns, initialLang: lang });
        next.handle({ ...msg, reconnect: greeted });
        current = next;
      },
    });
    current = live;
    return { session };
  };
}
