// What we know and the calls: memory, notes, research, to-dos, the call log and one call,
// its quotes, its summary written again, its recorded audio; and what the test phone can pick.
import type { ApiDeps } from "../deps.ts";
import type { Route } from "../router.ts";
import { renderQuotePdf, quoteFileName } from "../../quotes/pdf.ts";
import { fail, param } from "../router.ts";

export function callRoutes({ cfg, memory, monitor, quotes, writeRecap, skill }: ApiDeps): Route[] {
  return [
    ["GET", "/api/memory", "user", () => memory.memoryOverview()],
    ["GET", "/api/notes", "user", async () => (await memory.listNotes()).map(({ transcript, ...n }) => ({ ...n, turns: transcript?.length ?? 0 }))],
    ["GET", "/api/discovery", "user", async () => {
      const overview = await memory.discoveryOverview();
      if (!overview) throw fail(404, "no research framework");
      return overview;
    }],
    ["POST", /^\/api\/actions\/([^/]+)$/, "user", async ctx => {
      const status = ctx.url.searchParams.get("status") ?? "open";
      const a = await memory.setTaskStatus(param(ctx), status);
      if (!a) throw fail(404, "unknown action");
      monitor.system(`to-do ${status === "done" ? "ticked off" : "reopened"} in the UI: ${a.customerName}: ${a.text}`);
      return a;
    }],
    // What phone calls use (ENGINE, GEMINI_MODEL, MASK, LIVE_MODEL, LIVE_VOICE), and what the test phone can pick.
    ["GET", "/api/config", "user", () => ({
      phone: { engine: cfg.engine, model: cfg.model, mask: cfg.mask, liveModel: cfg.liveModel, liveVoice: cfg.liveVoice },
      modes: {
        engines: ["cascade", "live"],
        models: ["gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.8-flash"],
        masks: ["typing", "filler", "none"],
        // Probed 2026-10-11 (npm run live-probe): vertex-eu keeps audio in the EU and runs on the Vertex credits.
        liveModels: [...new Set([cfg.liveModel, "vertex-eu:gemini-3.8-live", "vertex@us-central1:gemini-3.8-live", "vertex@europe-west4:gemini-live-2.5-flash-native-audio"])],
        liveVoices: ["Kore", "Aoede", "Leda", "Zephyr", "Callirrhoe", "Puck", "Charon", "Fenrir", "Orus", "Achird"],
      },
    })],
    ["GET", "/api/calls", "user", async () => ({ calls: await monitor.list(), system: monitor.systemLog(), recording: monitor.record })],
    ["GET", /^\/api\/calls\/([^/]+)$/, "user", async ctx => {
      const call = await monitor.get(param(ctx));
      if (!call) throw fail(404, "unknown call");
      return { ...call, quotes: quotes ? await quotes.forCall(param(ctx)) : [] };
    }],
    // A quote's PDF, made again from its data (nothing is stored as a file).
    ["GET", /^\/api\/quotes\/([\w-]+)\/pdf$/, "user", async ctx => {
      const q = quotes && (await quotes.get(param(ctx)));
      if (!q) throw fail(404, "no such quote");
      return { bytes: await renderQuotePdf(q.data, { agent: skill.persona?.agentLabel ?? "Toni" }), type: "application/pdf", filename: quoteFileName(q.data) };
    }],
    // The call's summary, written now: for a call that ended without one, or again.
    ["POST", /^\/api\/calls\/([^/]+)\/recap$/, "admin", async ctx => {
      if (!writeRecap) throw fail(503, "no summaries here");
      const call = await memory.getCall(param(ctx));
      if (!call) throw fail(404, "unknown call");
      if (!call.endedAt) throw fail(409, "the summary is written when the call has ended");
      const transcript = "transcript" in call ? call.transcript ?? [] : [];
      if (!transcript.some(t => t.role === "user")) throw fail(409, "nothing was said in this call");
      const recap = await writeRecap({ turns: transcript, name: call.rehearsalOf ?? call.userName, lang: call.lang, startedAt: call.startedAt });
      await memory.saveRecap(param(ctx), recap);
      return { recap };
    }],
    ["GET", /^\/api\/calls\/([^/]+)\/audio\/([^/]+)$/, "user", ctx => {
      const file = monitor.audioFile(param(ctx), param(ctx, 1));
      if (!file) throw fail(404, "no audio");
      return { file, type: "audio/wav" };
    }],
  ];
}
