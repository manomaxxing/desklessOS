// Conversation quality, offline: Toni's real prompts in 12 situations (most from real calls:
// an impossible request, a one-word "Okay", unclear audio, "00:00", a goodbye with research due,
// his checklist, quality levels, the summary, the quote offer, a briefing, his to-dos, a sentence
// broken off), each model × K samples, judged by gemini-2.5-pro against a fixed rubric (general
// rules + one per situation). Text stands in for his audio, so it measures what Toni says, not
// how fast she hears. Run it before and after a prompt change.
//   npm run eval -- [K=3] [models=gemini-3.5-flash] [out.json]     ONLY=terse_okay,agenda for some
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadSkillFromTemplates } from "../src/skills/from-templates.ts";
import { createDiscovery, loadFramework } from "../src/memory/research.ts";
import { geminiEndpoint } from "../src/engine/gemini-endpoint.ts";
import { streamTurn, extractJsonResilient } from "../src/engine/gemini.ts";
import { buildContext } from "../src/memory/context.ts";
import { quoteSend } from "../src/tools/quote.ts";
import { declaration } from "../src/tools/registry.ts";
import type { Schema } from "../src/types/gemini.ts";

const [K = 3, modelList = "gemini-3.5-flash", outFile = path.join(tmpdir(), "deskless-eval.json")] = process.argv.slice(2);
const MODELS = modelList.split(",");
const endpoint = geminiEndpoint(process.env);
const skill = loadSkillFromTemplates("pilot");
const NIKO = { name: "Niko", lang: "de", profile: { trade: "tiler (Fliesenleger)", place: "Konstanz" } };
const LISTS = { jobs: "# Badumbau\nBodenfläche | m² | 65\nWandfläche | m² | 58,50\nDusche oder Badewanne, mit Grundfläche\nAbdichtung | m² | 35\nFormat Fliesen Boden", site: "Adresse\nStockwerk | ab 2. OG ohne Aufzug\nParkplatz | kein Parkplatz am Haus", siteMax: 1.8, levels: "Low Budget | 0,85\nStandard | 1\nHochwertig | 1,25\nMeisterstück | 1,5" };
const memory = buildContext({ today: "2026-10-16", facts: [{ text: "Laut seiner Website: Kerngeschäft sind Badsanierung, Boden- und Wandfliesen." }],
  tasks: [{ text: "Angebot an Familie Huber schicken", due: "2026-10-17", contactName: "Familie Huber" }, { text: "Fliesen 60×60 beim Händler anfragen", due: "2026-10-16", contactName: "Familie Huber" }, { text: "Rückruf Kliniken Schmieder", due: "2026-10-20", contactName: "Kliniken Schmieder" }, { text: "Silikon nachkaufen", due: "", contactName: "" }], openTaskCount: 4,
  contacts: [{ name: "Familie Huber", place: "Allensbach", address: "Seestraße 4", lastContact: "2026-10-15", summary: "Bad komplett neu: Boden 6 m², Wand 22 m², bodengleiche Dusche 90×120. Angebot bis Freitag.", notes: ["2026-10-15: Boden 60×60, Wand 30×60, Dusche raumhoch."] }, { name: "Kliniken Schmieder", place: "Allensbach", lastContact: "2026-10-14", summary: "40 Bäder komplett sanieren, Standardqualität.", notes: [] }],
  totalContacts: 2 }).text;
const research = () => createDiscovery({ framework: loadFramework() });
const H = (...pairs) => pairs.map(([role, text]) => ({ role, text }));

const S = [
  { id: "impossible", setup: { user: NIKO }, history: H(["model", "Hey, hier ist Toni. Erzähl."], ["user", "Haben gerade eine Anfrage bekommen, eine Klinik, vierzig Bäder komplett neu."], ["model", "Vierzig Bäder, das ist ein Riesending. Wo ist denn die Klinik?"]),
    says: "Kliniken Schmieder in Allensbach. Kannst du mir mal basierend auf unseren alten Projekten einen Kostenvoranschlag für die vierzig Bäder vorbereiten?",
    checks: ["cant: says plainly that it can't do this (a cost estimate from old projects) yet, and that it passes it on to Max; it does not promise or imply it will prepare the estimate"] },
  { id: "terse_okay", setup: { user: NIKO, direction: "outbound", objectives: [{ id: "errand_1", template: "discovery.day", params: { focus: "wie seine letzte Anfrage bis zum Angebot lief" }, stored: false }] },
    history: H(["model", "Hallo, hier ist Toni."], ["user", "Ja, hallo?"], ["model", "Ich ruf an, weil Max wissen will, wie bei dir Anfragen bis zum Angebot laufen. Hast du zwei Minuten?"], ["user", "Ja klar."], ["model", "Super. Wie war das bei deiner letzten Anfrage?"]),
    says: "Okay.", checks: ["engages: does not answer with only a backchannel (\"Mhm\") or silence; asks one concrete, easy question about that last inquiry (when it came, how), not a vague or broad one", "no_time_remark: no remark about the time of day"] },
  { id: "unclear", setup: { user: NIKO, direction: "outbound", objectives: [{ id: "errand_1", template: "discovery.day", params: { focus: "seine letzte Anfrage" }, stored: false }] },
    history: H(["model", "Hallo, hier ist Toni."], ["user", "Hallo."], ["model", "Hast du zwei Minuten für mich?"], ["user", "Ja."], ["model", "Gab's heute Anrufe von Kunden oder neue Anfragen?"]),
    says: "(unclear)", checks: ["repeat: only asks him to say it again, briefly; does not guess what he said, does not act as if it understood, does not move on to a new topic"] },
  { id: "garbage_after_confirm", setup: { user: NIKO }, history: H(["model", "Hey, hier ist Toni."], ["user", "Erinner mich dran, dass wir das Angebot Huber bis Freitag ausschicken."], ["model", "Alles klar, die Erinnerung für Freitag steht. Passt das so?"]),
    says: "00:00", checks: ["no_hangup: NEXT is not hangup and it does not say goodbye; it treats this as not understood or asks again"] },
  { id: "goodbye_research", setup: { user: NIKO, discovery: true }, history: H(["model", "Hey, hier ist Toni."], ["user", "Hallo Toni, Niko hier."], ["model", "Hallo Niko! Was gibt's?"], ["user", "Meine Notizen hab ich für heute schon erledigt, für heute bist du freigestellt."], ["model", "Alles klar. Noch was?"]),
    says: "Nee, das war's, ich wünsch dir einen schönen Abend.", checks: ["goodbye_ok: no \"Noch was?\" (or similar) after his goodbye; if it asks a research question at all, it is exactly one short question and nothing else", "understood: doesn't misread who is off for the day (he said Toni is off, not him)"] },
  { id: "checklist_next", setup: { user: { ...NIKO, profile: { ...NIKO.profile, lists: LISTS } } }, note: { mode: "capture", customer_name: "Familie Huber", place: "Allensbach", job_list: "Badumbau", checklist: [], site: [{ item: "Adresse", answer: "Seestraße 4", unfavourable: false }], quality: "", lists_done: false, next_steps: [{ what: "Angebot", due: "Freitag" }] },
    history: H(["model", "Hey, hier ist Toni."], ["user", "Komm grad von Familie Huber, Seestraße 4 in Allensbach. Bad komplett neu. Angebot bis Freitag."], ["model", "Huber in Allensbach, okay. Bodenfläche?"]),
    says: "Boden sechs Quadratmeter, Wand so zweiundzwanzig.", checks: ["next_item: asks for the next open item (Dusche oder Badewanne), not Boden/Wand again", "no_options: does not read out lists of choices or quality levels"] },
  { id: "levels_offer", setup: { user: { ...NIKO, profile: { ...NIKO.profile, lists: LISTS } } }, note: { mode: "capture", customer_name: "Familie Huber", job_list: "Badumbau", checklist: [{ item: "Bodenfläche", answer: "6 m²" }, { item: "Wandfläche", answer: "22 m²" }, { item: "Dusche oder Badewanne, mit Grundfläche", answer: "Dusche 90×120" }, { item: "Abdichtung", answer: "10 m²" }, { item: "Format Fliesen Boden", answer: "60×60" }], site: [{ item: "Adresse", answer: "Seestraße 4", unfavourable: false }, { item: "Stockwerk", answer: "EG", unfavourable: false }, { item: "Parkplatz", answer: "ja", unfavourable: false }], quality: "", lists_done: false },
    history: H(["model", "Hey, hier ist Toni."], ["user", "Familie Huber, Bad neu, Angebot bis Freitag."], ["model", "Okay. Welche Ausführung?"]),
    says: "Was gibt's denn da?", checks: ["offer_first: offers to list the quality levels (a yes/no question) and does NOT list them yet"] },
  { id: "summary", setup: { user: NIKO }, note: { mode: "capture", customer_name: "Familie Huber", place: "Allensbach", work: [{ area: "", description: "alte Fliesen raus", quantity: "18 m²" }, { area: "", description: "neue Wandfliesen", quantity: "32 m²" }], next_steps: [{ what: "Angebot schicken", due: "Freitag" }], confirmed: false },
    history: H(["model", "Hey, hier ist Toni."], ["user", "Familie Huber in Allensbach, alte Fliesen raus, achtzehn Quadratmeter. Neue Wandfliesen, zweiunddreißig Quadratmeter. Angebot bis Freitag."], ["model", "Okay. Noch was?"]),
    says: "Das war's.", checks: ["summary: ONE summary of at most three short spoken sentences (who/where, the work with the numbers exactly as he said them, the next step with its date), then asks \"Passt das?\" or similar; NEXT is confirm", "spoken: sounds spoken, not written (no \"Zusammenfassend:\", no lists)"] },
  { id: "quote_offer", setup: { user: NIKO, quote: true }, note: { mode: "capture", customer_name: "Familie Huber", place: "Allensbach", work: [{ area: "", description: "neue Wandfliesen", quantity: "32 m²", material: "" }], next_steps: [{ what: "Angebot", due: "Freitag" }], confirmed: false },
    history: H(["model", "Hey, hier ist Toni."], ["user", "Familie Huber in Allensbach, neue Wandfliesen, zweiunddreißig Quadratmeter, fünfundsechzig Euro. Angebot bis Freitag."], ["model", "Okay. Noch was?"], ["user", "Nee."], ["model", "Familie Huber in Allensbach: neue Wandfliesen, zweiunddreißig Quadratmeter zu fünfundsechzig Euro, Angebot bis Freitag. Passt das?"]),
    says: "Ja, passt.", checks: ["offers_quote: asks whether to send it to his WhatsApp as a quote; does not send it or claim it was sent before he says yes to sending"] },
  { id: "briefing", setup: { user: NIKO, memory }, history: H(["model", "Hey, hier ist Toni."]),
    says: "Ich fahr jetzt zu Huber, was war da nochmal?", checks: ["brief: a short briefing (who/where, the job's key facts, what's next) using only facts in MEMORY, then offers to read more; no invented details"] },
  { id: "agenda", setup: { user: NIKO, memory }, history: H(["model", "Hey, hier ist Toni."]),
    says: "Was steht an?", checks: ["todos: names the most urgent open to-dos (at most three, overdue and soonest first: Fliesen anfragen today, Angebot Huber tomorrow), one short clause each, and says how many more there are; nothing invented"] },
  { id: "mid_thought", setup: { user: NIKO }, history: H(["model", "Hey, hier ist Toni."], ["user", "Familie Huber in Allensbach, Bad neu."], ["model", "Okay."]),
    says: "Und dann wollten die noch, äh,", checks: ["waits: NEXT is wait and there is no spoken reply"], noGeneric: true },
];
const GENERIC = [
  "one_question: at most one question in the reply (a yes/no question at the end of a summary counts as the one)",
  "no_echo: doesn't repeat or rephrase back what he just said (echoing a short name, or the bare numbers he just gave, is fine)",
  "concise: at most two short sentences, unless this situation asks for a summary or a briefing",
  "no_invention: nothing that isn't in the conversation, the note or MEMORY",
  "spoken_register: casual spoken German with \"du\"; no markdown, no lists, no formal written phrases",
];

function agendaFor(s) {
  const o = s.setup;
  return skill.createAgenda({ user: o.user, direction: o.direction ?? "inbound", objectives: o.objectives ?? [], discovery: o.discovery ? research() : null });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function reply(model, s) {
  for (let i = 0; ; i++) {
    try { return await replyOnce(model, s); } catch (e) { if (i >= 5 || !/429|timeout|aborted/i.test(e.message)) throw e; await sleep(2000 * (i + 1) ** 1.5); }
  }
}
async function replyOnce(model, s) {
  const agenda = agendaFor(s);
  const tools = s.setup.quote ? [declaration(quoteSend({ memory: { user: { id: "x", orgId: "x", name: "Niko", lang: "de", timezone: "Europe/Berlin", profile: {} } }, quotes: null }))] : [];
  const system = agenda.prompt({ lang: "de", note: s.note ?? {}, missing: s.note ? agenda.missing(s.note) : undefined, memory: s.setup.memory ?? "", tools: tools.map(t => t.name) });
  const t0 = performance.now(); let first = null, text = "", call = null;
  for await (const ev of streamTurn({ endpoint, model, system, history: s.history, text: s.says, tools: tools.length ? tools : undefined })) {
    if (ev.type === "text") { first ??= performance.now() - t0; text += ev.text; }
    if (ev.type === "call") { first ??= performance.now() - t0; call = ev.call; }
  }
  const next = (text.match(/NEXT:\s*(\w+)/) ?? [])[1] ?? "?";
  const spoken = text.split("\n").filter(l => !/^\s*(HEARD|LANG|NEXT|DO):/.test(l)).join(" ").replace(/\s+/g, " ").trim();
  return { next, spoken: call ? `${spoken} [CALLED TOOL ${call.name} ${JSON.stringify(call.args)}]`.trim() : spoken, firstMs: Math.round(first ?? -1) };
}
const JUDGE: Schema = { type: "OBJECT", properties: { checks: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, pass: { type: "BOOLEAN" }, why: { type: "STRING" } }, required: ["id", "pass", "why"] } } }, required: ["checks"] };
async function judge(s, r) {
  const checks = [...(s.noGeneric ? [] : GENERIC), ...s.checks];
  const prompt = `You grade one reply of Toni, a German AI phone assistant for tradespeople (he calls from his car). Grade strictly but fairly, one verdict per check.

Conversation so far:
${s.history.map(t => `${t.role === "user" ? "HIM" : "TONI"}: ${t.text}`).join("\n")}
HIM (latest): ${s.says}
${s.note ? `\nToni's note so far: ${JSON.stringify(s.note)}` : ""}${s.setup.memory ? `\nToni's MEMORY:\n${s.setup.memory}` : ""}

Toni's reply: NEXT: ${r.next}
"${r.spoken || "(no spoken reply)"}"

Checks (id: rule):
${checks.map(c => `- ${c}`).join("\n")}

Return one entry per check, id = the word before the colon.`;
  return (await extractJsonResilient<{ checks: { id: string; pass: boolean; why: string }[] }>({ endpoint, models: ["gemini-2.5-pro"], system: "You are a meticulous evaluator of voice-assistant replies.", prompt, schema: JUDGE, think: true, timeoutMs: 120000, retries429: 5 })).checks;
}
const results = [];
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
for (let k = 0; k < Number(K); k++) for (const s of S.filter(x => !ONLY || ONLY.has(x.id))) for (const model of MODELS) {
  try {
    const r = await reply(model, s);
    const checks = await judge(s, r);
    results.push({ model, situation: s.id, k, ...r, checks });
    process.stdout.write(checks.every(c => c.pass) ? "." : "x");
    await sleep(400);
  } catch (e) { results.push({ model, situation: s.id, k, error: e.message.slice(0, 120) }); process.stdout.write("E"); }
}
writeFileSync(outFile, JSON.stringify(results, null, 1));
console.log(`\n\nevery reply and verdict: ${outFile}\n`);
const q = (a, p) => { const s = a.filter(x => x >= 0).sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(p * (s.length - 1))]) : "-"; };
for (const model of MODELS) {
  const r = results.filter(x => x.model === model && !x.error);
  const all = r.flatMap(x => x.checks), clean = r.filter(x => x.checks.every(c => c.pass)).length;
  console.log(`${model.padEnd(24)} replies ${r.length} (errors ${results.filter(x => x.model === model && x.error).length}) · all checks passed: ${clean}/${r.length} · checks passed ${all.filter(c => c.pass).length}/${all.length} · first token p50 ${q(r.map(x => x.firstMs), .5)} p90 ${q(r.map(x => x.firstMs), .9)}`);
}
console.log("\nfailures by check (model: count)");
const ids = [...new Set(results.flatMap(x => (x.checks ?? []).map(c => c.id)))];
for (const id of ids) { const row = MODELS.map(m => `${m.replace("gemini-", "")}: ${results.filter(x => x.model === m).flatMap(x => (x.checks ?? []).filter(c => c.id === id && !c.pass)).length}`); if (row.some(r => !r.endsWith(": 0"))) console.log(`  ${id.padEnd(16)} ${row.join("  ")}`); }
console.log("\nfailures by situation");
for (const s of S) console.log(`  ${s.id.padEnd(22)} ${MODELS.map(m => `${m.replace("gemini-", "")}: ${results.filter(x => x.model === m && x.situation === s.id && x.checks && !x.checks.every(c => c.pass)).length}/${results.filter(x => x.model === m && x.situation === s.id).length}`).join("  ")}`);
