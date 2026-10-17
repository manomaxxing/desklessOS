// After a call: everything that doesn't have to happen while he's on the line, as one
// job (kind "after_call", queued in the same transaction that ends the call). Works from
// the call's row alone, so it runs on any instance, and again after a crash:
//   1. the final note: the extraction again if the last turns aren't in it yet
//   2. his note saved (one per call); if he confirmed it on a WhatsApp call and has note_whatsapp,
//      it goes into his chat (once; a failed send doesn't stop the rest)
//   3. the agenda's objectives recorded (each call counts once); their requests follow them as
//      they stand now, so a run that stopped halfway still closes them (and Max is told) the next time
//   4. an outbound call's outcome back to the scheduler (retry, call later, done)
//   5. long-term memory: customers, to-dos, research findings (once per call); what he asked
//      for that Toni can't do yet is kept on the call, and Max is told (he builds it)
//   6. the call's summary for the dashboard (src/calls/recap.ts), unless it has one
// Every step is idempotent, so the job can be retried from the top.

import { extractJsonResilient, FALLBACK_MODEL } from "../engine/gemini.ts";
import { consolidateCall } from "../engine/consolidate.ts";
import { geminiCost } from "../engine/cost.ts";
import { locales } from "../locale/index.ts";
import { hasFeature } from "../features.ts";
import { noteMessage } from "./note-message.ts";
import { isRecord } from "../shared/is-record.ts";
import type { MemorySkill, MemoryStep } from "../engine/consolidate.ts";
import type { Agenda, CallOutcome } from "../agenda/agenda.ts";
import type { WriteRecap, Recap } from "./recap.ts";
import type { ObjectiveState } from "../admin/requests.ts";
import type { JobPayload } from "../jobs/queue.ts";
import type { Notifier } from "../notify.ts";
import type { CallEvent, Direction } from "../types/call.ts";
import type { Objective, ObjectiveInput, ObjectiveResult } from "../types/agenda.ts";
import type { Endpoint, Usage } from "../types/gemini.ts";
import type { Note } from "../types/note.ts";
import type { User, Profile } from "../types/user.ts";
import type { Iso, LangId, Log, Turn } from "../types/common.ts";

const clean = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What he asked for that Toni can't do yet. */
export interface Wish {
  what: string;
  why: string;
  quote: string;
}

/** What the memory step changed (src/memory: customers and to-dos), as far as this step reports it. */
interface MemoryChanges {
  skipped?: boolean;
  customer: unknown;
  added: unknown[];
  completed: unknown[];
  updated: unknown[];
}

/** A finished call, and the steps bound to it (memory.afterCall in src/memory). */
export interface AfterCallState {
  call: {
    id: string;
    direction: Direction;
    source: string;
    from: string | null;
    lang: LangId | null;
    reason: string | null;
    turns: Turn[];
    extraction: Record<string, unknown> | null;
    extractionTurns: number;
    startedAt: Date | Iso;
    recap: unknown;
    noteSentAt: string | null;
    rehearsalOf: string | null;
    wishes: unknown[] | null;
  };
  user: User & { profile: Profile };
  objectives: Objective[];
  discovery: unknown;
  scope: MemoryStep<unknown, MemoryChanges> & {
    saveNote(note: Note): Promise<{ id: string }>;
    recordObjectives(results: readonly ObjectiveResult[]): Promise<Objective[]>;
  };
  saveExtraction(extraction: unknown, extractionTurns: number): Promise<unknown>;
  addEvents(events: CallEvent[]): Promise<unknown> | null;
  saveRecap(recap: Recap): Promise<unknown>;
  saveWishes(wishes: Wish[]): Promise<unknown>;
  noteSent(messageId: string | null): Promise<unknown>;
  addCost(usd: number): Promise<unknown>;
  done(): Promise<unknown>;
}

export interface AfterCallMemory {
  afterCall(callId: string): Promise<AfterCallState | null>;
  objectives: { byIds(ids: string[]): Promise<ObjectiveState[]> };
}

/** The skill as this step uses it: the call's agenda, and the memory step's prompt. */
export interface AfterCallSkill extends MemorySkill<unknown> {
  persona: { agentLabel?: string };
  createAgenda(o: { objectives?: ObjectiveInput[]; discovery?: unknown; direction?: Direction; user?: AfterCallState["user"] | null }): Agenda;
}

export type AfterCallResult = { skipped: true } | { noteId: string | null; objectives: number; memory: boolean };

export function createAfterCall({ memory, skill, endpoint, model, fallbackModel = FALLBACK_MODEL, writeRecap = null, whatsapp = null, requests = null, scheduler = null, monitor = null, notifier = null, log = () => {} }: {
  memory: AfterCallMemory;
  skill: AfterCallSkill;
  endpoint: Endpoint;
  model: string;
  fallbackModel?: string;
  writeRecap?: WriteRecap | null;
  /** Messages into his WhatsApp chat (src/telephony/whatsapp.ts whatsappSender). */
  whatsapp?: { sendText(m: { to: string; text: string }): Promise<{ messageId: string | null }> } | null;
  requests?: { objectivesChanged(objectives: ObjectiveState[]): Promise<{ id: string; status: string }[]> } | null;
  scheduler?: { callEnded(o: { callId: string; reason: string | null; outcome: CallOutcome | null; objectives: ObjectiveResult[] }): Promise<void> } | null;
  monitor?: { system(text: string, level?: string): void; event(id: string, ev: CallEvent): void } | null;
  notifier?: Pick<Notifier, "send"> | null;
  log?: Log;
}): (payload: JobPayload) => Promise<AfterCallResult> {
  return async function afterCall({ callId }) {
    if (typeof callId !== "string" || !callId) throw new Error("after_call job without a callId");
    const state = await memory.afterCall(callId);
    if (!state) return { skipped: true }; // done already, still open, or an unknown caller
    const { call, user, objectives, discovery, scope } = state;
    const tag = `[${callId.slice(-6)}]`;
    let usd = 0;
    const onUsage = (step: string) => (u: Usage) => { usd += geminiCost(model, u, step).usd ?? 0; };
    const agenda = skill.createAgenda({ objectives, discovery, direction: call.direction, user });
    const { turns, lang } = call;
    const spoke = turns.some(t => t.role === "user" && !locales().unclear.test(t.text));
    const date = new Date(call.startedAt).toISOString().slice(0, 10);

    // 1. The final note. The call's last extraction may lag a turn or two behind.
    let extraction: Record<string, unknown> = call.extraction ?? {};
    agenda.update(extraction); // "so far", for the extraction prompt
    if (spoke && call.extractionTurns < turns.length) {
      extraction = await extractJsonResilient<Record<string, unknown>>({
        endpoint, models: [model, fallbackModel], timeoutMs: 20000, retries429: 2,
        system: agenda.extractSystem(lang ?? undefined), prompt: agenda.extractPrompt({ turns, lang: lang ?? undefined }), schema: agenda.schema(), onUsage: onUsage("note"),
      });
      await state.saveExtraction(extraction, turns.length);
    }
    const { note } = agenda.update(extraction);

    // 2. His note.
    const saved = agenda.worthSaving(note) ? await scope.saveNote({ ...note, lang: lang ?? "" }) : null;
    let noteSent: string | null = null;
    if (saved && note.confirmed === true && whatsapp && call.source === "whatsapp" && call.from && !call.noteSentAt && hasFeature(user, "note_whatsapp")) {
      const text = noteMessage(note, lang ?? locales().defaultId);
      if (text) {
        try {
          const { messageId } = await whatsapp.sendText({ to: call.from, text });
          await state.noteSent(messageId);
          noteSent = messageId;
        } catch (err) {
          log(`${tag} note to WhatsApp not sent: ${errText(err)}`);
          monitor?.system(`call ${callId}: note to WhatsApp not sent: ${errText(err)}`, "warn");
        }
      }
    }

    // 3. What the agent brought: answers recorded; the requests follow their objectives as they are now (and Max is told).
    const changed = await scope.recordObjectives(agenda.results());
    for (const o of changed) monitor?.system(`objective ${o.id}: ${o.status}${questionsLine(o.result)}`);
    const current = objectives.length ? await memory.objectives.byIds(objectives.map(o => o.id)) : [];
    for (const r of (await requests?.objectivesChanged(current)) ?? []) if (r.status !== "approved") monitor?.system(`request ${r.id}: ${r.status}`);

    // 4. A call we made: how it went decides the next try.
    if (call.direction === "outbound") await scheduler?.callEnded({ callId, reason: call.reason, outcome: agenda.callOutcome(), objectives: agenda.results() });

    // 5. Long-term memory.
    let memoryResult: { callType: string | undefined; summary: string | undefined; customer: unknown; added: unknown[]; completed: unknown[]; updated: unknown[] } | null = null;
    let wishes: Wish[] = [];
    if (spoke) {
      const { result, changed: c } = await consolidateCall({ endpoint, model, skill, memory: scope, turns, note, callId, noteId: saved?.id ?? null, lang, date, onUsage: onUsage("memory") });
      memoryResult = c.skipped ? null : { callType: result.call_type, summary: result.call_summary, customer: c.customer, added: c.added, completed: c.completed, updated: c.updated };
      wishes = (result.wishes ?? []).map(w => ({ what: clean(w?.what), why: clean(w?.why), quote: clean(w?.quote) })).filter(w => w.what);
    }
    // What he asked for that Toni can't do yet: once per call, on the call's page, and to Max.
    if (wishes.length && !call.wishes) {
      await state.saveWishes(wishes);
      const who = call.rehearsalOf ?? user.name;
      const lines = wishes.map(w => `- ${w.what}${w.why ? ` (for: ${w.why})` : ""}${w.quote ? `: "${w.quote}"` : ""}`).join("\n");
      await notifier?.send({ subject: `${who} asked ${skill.persona.agentLabel} for something she can't do yet: ${wishes[0].what}`, text: `${who} asked for:\n${lines}\n\nCall ${callId}`, payload: { type: "wish", callId, who, wishes } })
        .catch((err: unknown) => log(`${tag} wish not sent to Max: ${errText(err)}`));
    } else wishes = [];

    // 6. The summary for the dashboard.
    let recap: Recap | null = null;
    if (spoke && writeRecap && !call.recap) {
      recap = await writeRecap({ turns, name: call.rehearsalOf ?? user.name, lang, startedAt: call.startedAt, onUsage: onUsage("recap") }); // a rehearsal: who was played
      await state.saveRecap(recap);
    }

    const events: CallEvent[] = [...(saved ? [{ event: "saved", id: saved.id }] : []), ...(noteSent ? [{ event: "note_sent", messageId: noteSent }] : []), ...wishes.map(w => ({ event: "wish", what: w.what })), ...(memoryResult ? [{ event: "memory", ...memoryResult }] : []), ...(recap ? [{ event: "recap", title: recap.title }] : [])];
    await state.addEvents(events);
    for (const ev of events) monitor?.event(callId, ev);
    if (usd) await state.addCost(usd);
    await state.done();
    log(`${tag} after-call done: ${saved ? "note saved" : "no note"}${memoryResult ? `, memory: ${memoryResult.callType}, +${memoryResult.added.length} to-dos, ${memoryResult.completed.length} done` : ""}${changed.length ? `, ${changed.length} objective(s)` : ""}${recap ? ", summary written" : ""}${noteSent ? ", note sent to WhatsApp" : ""}`);
    return { noteId: saved?.id ?? null, objectives: changed.length, memory: Boolean(memoryResult) };
  };
}

// " · q1 answered: …; q2 not_asked" for the monitor, from an objective's result.
function questionsLine(result: Record<string, unknown> | null): string {
  if (!Array.isArray(result?.questions)) return "";
  return ` · ${result.questions.map((q: unknown) => (isRecord(q) ? `${String(q.id ?? "")} ${String(q.status ?? "")}${q.answer ? `: ${String(q.answer)}` : ""}` : "")).join("; ")}`;
}
