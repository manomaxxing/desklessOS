// After a call: everything that doesn't have to happen while he's on the line, as one
// job (kind "after_call", queued in the same transaction that ends the call). Works from
// the call's row alone, so it runs on any instance, and again after a crash:
//   1. the final note: the extraction again if the last turns aren't in it yet
//   2. his note saved (one per call); if he confirmed it on a WhatsApp call and has note_whatsapp,
//      it goes into his chat (once; a failed send doesn't stop the rest)
//   3. the agenda's objectives recorded (each call counts once), their requests closed
//   4. an outbound call's outcome back to the scheduler (retry, call later, done)
//   5. long-term memory: customers, to-dos, research findings (once per call)
//   6. the call's summary for the dashboard (src/calls/recap.mjs), unless it has one
// Every step is idempotent, so the job can be retried from the top.

import { extractJsonResilient, FALLBACK_MODEL } from "../engine/gemini.mjs";
import { consolidateCall } from "../engine/consolidate.mjs";
import { geminiCost } from "../engine/cost.mjs";
import { locales } from "../locale/index.mjs";
import { hasFeature } from "../features.mjs";
import { noteMessage } from "./note-message.mjs";

export function createAfterCall({ memory, skill, endpoint, model, fallbackModel = FALLBACK_MODEL, writeRecap = null, whatsapp = null, requests = null, scheduler = null, monitor = null, log = () => {} }) {
  return async function afterCall({ callId }) {
    const state = await memory.afterCall(callId);
    if (!state) return { skipped: true }; // done already, still open, or an unknown caller
    const { call, user, objectives, discovery, scope } = state;
    const tag = `[${callId.slice(-6)}]`;
    let usd = 0;
    const onUsage = step => u => { usd += geminiCost(model, u, step).usd ?? 0; };
    const agenda = skill.createAgenda({ objectives, discovery, direction: call.direction, user });
    const { turns, lang } = call;
    const spoke = turns.some(t => t.role === "user" && !locales().unclear.test(t.text));
    const date = new Date(call.startedAt).toISOString().slice(0, 10);

    // 1. The final note. The call's last extraction may lag a turn or two behind.
    let extraction = call.extraction ?? {};
    agenda.update(extraction); // "so far", for the extraction prompt
    if (spoke && call.extractionTurns < turns.length) {
      extraction = await extractJsonResilient({
        endpoint, models: [model, fallbackModel], timeoutMs: 20000, retries429: 2,
        system: agenda.extractSystem(lang ?? undefined), prompt: agenda.extractPrompt({ turns, lang: lang ?? undefined }), schema: agenda.schema(), onUsage: onUsage("note"),
      });
      await state.saveExtraction(extraction, turns.length);
    }
    const { note } = agenda.update(extraction);

    // 2. His note.
    const saved = agenda.worthSaving(note) ? await scope.saveNote({ ...note, lang: lang ?? "" }) : null;
    let noteSent = null;
    if (saved && note.confirmed === true && whatsapp && call.source === "whatsapp" && call.from && !call.noteSentAt && hasFeature(user, "note_whatsapp")) {
      const text = noteMessage(note, lang ?? locales().defaultId);
      if (text) {
        try {
          const { messageId } = await whatsapp.sendText({ to: call.from, text });
          await state.noteSent(messageId);
          noteSent = messageId;
        } catch (err) {
          log(`${tag} note to WhatsApp not sent: ${err.message}`);
          monitor?.system(`call ${callId}: note to WhatsApp not sent: ${err.message}`, "warn");
        }
      }
    }

    // 3. What the agent brought: answers recorded, requests closed (and Max told).
    const changed = await scope.recordObjectives(agenda.results());
    for (const o of changed) monitor?.system(`objective ${o.id}: ${o.status}${o.result?.questions ? ` · ${o.result.questions.map(q => `${q.id} ${q.status}${q.answer ? `: ${q.answer}` : ""}`).join("; ")}` : ""}`);
    for (const r of (await requests?.objectivesChanged(changed)) ?? []) if (r.status !== "approved") monitor?.system(`request ${r.id}: ${r.status}`);

    // 4. A call we made: how it went decides the next try.
    if (call.direction === "outbound") await scheduler?.callEnded({ callId, reason: call.reason, outcome: agenda.callOutcome(), objectives: agenda.results() });

    // 5. Long-term memory.
    let memoryResult = null;
    if (spoke) {
      const { result, changed: c } = await consolidateCall({ endpoint, model, skill, memory: scope, turns, note, callId, noteId: saved?.id ?? null, lang, date, onUsage: onUsage("memory") });
      memoryResult = c.skipped ? null : { callType: result.call_type, summary: result.call_summary, customer: c.customer, added: c.added, completed: c.completed, updated: c.updated };
    }

    // 6. The summary for the dashboard.
    let recap = null;
    if (spoke && writeRecap && !call.recap) {
      recap = await writeRecap({ turns, name: call.rehearsalOf ?? user.name, lang, startedAt: call.startedAt, onUsage: onUsage("recap") }); // a rehearsal: who was played
      await state.saveRecap(recap);
    }

    const events = [...(saved ? [{ event: "saved", id: saved.id }] : []), ...(noteSent ? [{ event: "note_sent", messageId: noteSent }] : []), ...(memoryResult ? [{ event: "memory", ...memoryResult }] : []), ...(recap ? [{ event: "recap", title: recap.title }] : [])];
    await state.addEvents(events);
    for (const ev of events) monitor?.event(callId, ev);
    if (usd) await state.addCost(usd);
    await state.done();
    log(`${tag} after-call done: ${saved ? "note saved" : "no note"}${memoryResult ? `, memory: ${memoryResult.callType}, +${memoryResult.added.length} to-dos, ${memoryResult.completed.length} done` : ""}${changed.length ? `, ${changed.length} objective(s)` : ""}${recap ? ", summary written" : ""}${noteSent ? ", note sent to WhatsApp" : ""}`);
    return { noteId: saved?.id ?? null, objectives: changed.length, memory: Boolean(memoryResult) };
  };
}
