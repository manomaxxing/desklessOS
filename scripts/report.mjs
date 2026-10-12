// The pilot week's report: what he did (calls, times, notes), what we learned
// per framework area, and the evidence for and against each hypothesis.
//   npm run report                   → data/discovery/report.md
//   npm run report -- --synthesize   adds an executive summary written by Gemini
//   npm run report -- --from +49170… only calls from his number (skips test calls)

import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createDiscovery } from "../src/store/discovery.mjs";
import { dataDir, readJson } from "../src/store/files.mjs";

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const discovery = createDiscovery();
const fw = discovery.framework;
const callsDir = dataDir("calls", "CALLS_DIR");
const records = Object.fromEntries(readdirSync(callsDir).filter(f => f.endsWith(".json")).map(f => { const c = readJson(path.join(callsDir, f), {}); return [c.id, c]; }));
const from = arg("--from");
const log = discovery.calls().filter(c => !from || records[c.callId]?.from === from);
const ids = new Set(log.map(c => c.callId));
const findings = discovery.findings().filter(f => ids.has(f.callId));
const state = discovery.questions();

const tz = { timeZone: "Europe/Berlin" };
const hour = ms => Number(new Date(ms).toLocaleString("en-GB", { ...tz, hour: "2-digit", hour12: false }));
const weekday = date => new Date(date).toLocaleDateString("en-GB", { weekday: "short" });
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const line = f => `- ${f.kind ? `[${f.kind}] ` : ""}${f.text}${f.quote ? ` "${f.quote}"` : ""} (${f.date})`;

// ---------- usage: behaviour, not opinions ----------
const timed = log.map(c => records[c.callId]).filter(r => r?.startedAt && r?.endedAt);
const byDay = Object.entries(Object.groupBy(log, c => c.date)).map(([d, cs]) => `${weekday(d)} ${d}: ${cs.length}`);
const slots = [[5, 9], [9, 12], [12, 14], [14, 17], [17, 20], [20, 24]];
const bySlot = slots.map(([a, b]) => `${String(a).padStart(2, "0")}–${b}h: ${timed.filter(r => hour(r.startedAt) >= a && hour(r.startedAt) < b).length}`);
const notes = timed.filter(r => r.savedNoteId).length;
const asked = log.filter(c => c.asked.length).length;
const declined = log.filter(c => c.declined.length).length;

// Turn-taking: how often he paused mid-thought and how often the agent cut in too early.
const events = log.flatMap(c => records[c.callId]?.events ?? []);
const count = test => events.filter(test).length;
const turnTaking = `- Turn-taking: ${count(e => e.event === "heard" && e.next === "wait")} pauses where the agent kept listening, ${count(e => e.event === "backchannel")} "mhm"s, ${count(e => e.event === "nudge" && e.kind === "hold_done")} "Moment"s; ${count(e => e.event === "barge_in" && e.falseStart)} false starts (he went on talking within 1.5 s of the agent starting), ${count(e => e.event === "barge_in" && !e.falseStart)} other interruptions`;

const usage = [
  `- Calls: ${log.length} on ${byDay.length} days (${byDay.join("; ") || "none"})`,
  `- When he calls (Konstanz time): ${bySlot.join(", ")}`,
  `- Median call: ${(median(timed.map(r => (r.endedAt - r.startedAt) / 60000)) || 0).toFixed(1)} min; calls that saved a note: ${notes}`,
  turnTaking,
  `- Research questions: asked in ${asked} calls, declined in ${declined}; ${Object.values(state).filter(q => q.answered).length} of ${fw.areas.flatMap(a => a.questions).length} framework questions answered`,
];

// ---------- hypotheses: evidence for and against ----------
const verdict = (pro, con) => (pro.length >= 2 && pro.length > con.length * 2 ? "leaning supported" : con.length >= 2 && con.length > pro.length * 2 ? "leaning contradicted" : "open");
const hypotheses = fw.hypotheses.map(h => {
  const pro = findings.filter(f => f.hypothesis === h.id && f.stance === "supports");
  const con = findings.filter(f => f.hypothesis === h.id && f.stance === "contradicts");
  return [`### ${h.id}: ${h.text}`, `Status: **${verdict(pro, con)}** (${pro.length} for, ${con.length} against)`,
    ...(pro.length ? ["", "For:", ...pro.map(line)] : []), ...(con.length ? ["", "Against:", ...con.map(line)] : [])].join("\n");
});

// ---------- findings by area ----------
const areas = fw.areas.map(a => {
  const own = findings.filter(f => f.area === a.id);
  const open = a.questions.filter(q => !state[q.id]?.answered);
  return [`### ${a.title}`, `*Goal:* ${a.goal} *Done when:* ${a.doneWhen}`, "",
    ...(own.length ? own.map(line) : ["- (nothing yet)"]),
    ...(open.length ? ["", `Not answered yet: ${open.map(q => `${q.id} "${q.ask}"`).join("; ")}`] : [])].join("\n");
});

// ---------- optional: executive summary ----------
let summary = "";
if (process.argv.includes("--synthesize")) {
  const { geminiEndpoint } = await import("../src/engine/gemini-endpoint.mjs");
  const { extractJsonResilient } = await import("../src/engine/gemini.mjs");
  const S = { type: "STRING" };
  const result = await extractJsonResilient({
    endpoint: geminiEndpoint(), models: [process.env.GEMINI_MODEL || "gemini-3.5-flash", "gemini-2.5-flash"], timeoutMs: 60000,
    system: `You are a management consultant writing the executive summary of a one-week field study with one
tradesperson. Use only the evidence given; say so where it is thin. Behaviour (usage) outweighs opinions.
Call a hypothesis supported or contradicted only with at least two findings from different calls; else open.
Write in English; keep his quotes in German.`,
    schema: {
      type: "OBJECT",
      properties: {
        headline: S,
        pains: { type: "ARRAY", items: { type: "OBJECT", properties: { pain: S, evidence: S, impact: S } } },
        hypotheses: { type: "ARRAY", items: { type: "OBJECT", properties: { id: S, verdict: { type: "STRING", enum: ["supported", "contradicted", "open"] }, why: S } } },
        follow_up_questions: { type: "ARRAY", items: S },
        implications: { type: "ARRAY", items: S },
      },
      required: ["headline", "pains", "hypotheses", "follow_up_questions", "implications"],
    },
    prompt: `Key question: ${fw.keyQuestion}\n\nUsage:\n${usage.join("\n")}\n\nHypotheses: ${JSON.stringify(fw.hypotheses)}\n\nFindings: ${JSON.stringify(findings.map(({ area, hypothesis, stance, kind, text, quote, date }) => ({ area, hypothesis, stance, kind, text, quote, date })))}`,
  });
  summary = [
    "## Executive summary", "", `**${result.headline}**`, "",
    "Pains, ranked by evidence:", ...result.pains.map((p, i) => `${i + 1}. **${p.pain}**: ${p.evidence} *Impact:* ${p.impact}`), "",
    "Hypotheses:", ...result.hypotheses.map(h => `- ${h.id}: **${h.verdict}**. ${h.why}`), "",
    "Ask in the follow-up interview:", ...result.follow_up_questions.map(q => `- ${q}`), "",
    "What it means for the product:", ...result.implications.map(q => `- ${q}`), "",
  ].join("\n");
}

const who = fw.participant;
const report = [
  `# Pilot week: ${who.name}, ${who.place}`, "",
  `*Key question:* ${fw.keyQuestion}`, "",
  `Generated ${new Date().toLocaleString("en-GB", tz)} from ${log.length} calls and ${findings.length} findings.`, "",
  summary,
  "## Usage", "", ...usage, "",
  "## Hypotheses", "", hypotheses.join("\n\n"), "",
  "## Findings by area", "", areas.join("\n\n"), "",
].join("\n");

const out = path.join(dataDir("discovery", "DISCOVERY_DIR"), "report.md");
writeFileSync(out, report);
console.log(`${out}: ${log.length} calls, ${findings.length} findings`);
