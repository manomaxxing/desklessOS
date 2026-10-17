// His lists for quotes (src/quotes/lists.ts): the text he'd write, what Toni goes through
// in the call (prompt, what's still open, the extraction), and the prices on the quote
// (his price × quality level × site factor, in code).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { openDb } from "../src/db/client.ts";
import { migrate } from "../src/db/migrate.ts";
import { openPgMemory } from "../src/memory/pg.ts";
import { loadSkillFromTemplates } from "../src/skills/from-templates.ts";
import { parseLists, listsIn, parseNumber, siteFactor, priceFromLists, openOnLists } from "../src/quotes/lists.ts";
import { createQuoteStore } from "../src/quotes/store.ts";
import { renderQuotePdf } from "../src/quotes/pdf.ts";
import { quoteSend } from "../src/tools/quote.ts";
import { createToolRunner } from "../src/tools/registry.ts";
import { noteMessage } from "../src/calls/note-message.ts";
import type { HttpError } from "../src/types/common.ts";
import type { ListsText } from "../src/types/user.ts";

// What Niko sent (2026-10-15), with example prices.
const NIKO = {
  jobs: `# Badumbau
Bodenfläche | m² | 65
Wandfläche | m² | 58,50
Dusche oder Badewanne, mit Grundfläche
Abdichtung | m² | 35
Wie hoch soll gefliest werden
Format Fliesen Boden
Format Fliesen Wand
Restliche Wände: Putz, glatt oder Pandomo
Welche Edelstahlschienen | m
Lochbohrungen | Stück | 25`,
  site: `Ort
Adresse
Haus oder Wohnung | Wohnung
Stockwerk | ab 2. OG ohne Aufzug
Laufweg in Metern | über 20 m
Parkplatz | kein Parkplatz am Haus`,
  siteMax: "1,8",
  levels: `Low Budget | 0,85
Standard | 1
Hochwertig | 1,25
Meisterstück | 1,5`,
};
// As his profile keeps them (listsIn: the factor as a number).
const NIKO_SAVED: ListsText = { ...NIKO, siteMax: 1.8 };

let db, memory, quotes;
const skill = loadSkillFromTemplates("pilot");
before(async () => {
  db = await openDb("pglite:memory");
  await migrate(db);
  memory = openPgMemory({ db, skill });
  await memory.ensureUser();
  quotes = createQuoteStore({ db });
});
after(async () => { await db?.close(); });

test("his lists as he'd write them: prices with a comma, items just asked, mistakes named by line", () => {
  assert.deepEqual([parseNumber("58,50"), parseNumber("1.234,50 €"), parseNumber("1,8"), parseNumber("65"), parseNumber("x")], [58.5, 1234.5, 1.8, 65, null]);
  const l = parseLists(NIKO);
  assert.deepEqual(l.errors, []);
  assert.equal(l.jobs[0].name, "Badumbau");
  assert.equal(l.jobs[0].items.length, 10);
  assert.deepEqual(l.jobs[0].items[1], { ask: "Wandfläche", label: "Wandfläche", choices: "", unit: "m²", price: 58.5 });
  assert.deepEqual(l.jobs[0].items[2], { ask: "Dusche oder Badewanne, mit Grundfläche", label: "Dusche oder Badewanne, mit Grundfläche", choices: "", unit: "", price: null });
  assert.deepEqual(l.jobs[0].items[7], { ask: "Restliche Wände: Putz, glatt oder Pandomo", label: "Restliche Wände", choices: "Putz, glatt oder Pandomo", unit: "", price: null }, "asked by its name; the choices aside");
  assert.deepEqual(l.jobs[0].items[8], { ask: "Welche Edelstahlschienen", label: "Welche Edelstahlschienen", choices: "", unit: "m", price: null }, "a unit without a price: asked, priced later");
  assert.deepEqual(l.site.map(s => s.bad), ["", "", "Wohnung", "ab 2. OG ohne Aufzug", "über 20 m", "kein Parkplatz am Haus"]);
  assert.equal(l.siteMax, 1.8);
  assert.deepEqual(l.levels.at(-1), { name: "Meisterstück", factor: 1.5 });

  assert.match(parseLists({ jobs: "Bodenfläche | m² | 65" }).errors[0], /jobs line 1: start with "# "/);
  assert.match(parseLists({ jobs: "# Bad\nBoden | m² | viel" }).errors[0], /jobs line 2: "viel" isn't a price/);
  assert.match(parseLists({ site: "Adresse", siteMax: "1,5" }).errors[0], /needs at least one line that says when it counts/);
  assert.match(parseLists({ levels: "Gold | 12" }).errors[0], /levels line 1: "12" isn't a factor/);
  assert.throws(() => listsIn({ jobs: "Boden" }), (e: HttpError) => e.status === 400 && /Lists: jobs line 1/.test(e.message));
  assert.deepEqual(listsIn({ ...NIKO, jobs: `${NIKO.jobs}\r\n` }), { jobs: NIKO.jobs, site: NIKO.site, levels: NIKO.levels, siteMax: 1.8 }, "kept as he wrote it; the factor as a number");
});

test("German thousands: \"1.200\" is twelve hundred, not 1.2; decimals stay decimals", () => {
  assert.deepEqual(["1.200", "1,200", "1.200,50", "1.200 €", "12.500.000", "-1.200"].map(parseNumber), [1200, 1200, 1200.5, 1200, 12500000, -1200]);
  assert.deepEqual(["1,5", "58,50", "0,85", "0,850", "1.25", "2.5", "1234.567"].map(parseNumber), [1.5, 58.5, 0.85, 0.85, 1.25, 2.5, 1234.567], "a separator not followed by exactly three digits, or after a 0: a decimal");
  assert.equal(parseNumber(1.234), 1.234, "a number (the model's NUMBER) stays as it is");
  assert.equal(parseNumber(Infinity), null);
  const l = parseLists({ jobs: "# Bad\nBodenfläche | m² | 1.200\nWand | m² | 58,50" });
  assert.deepEqual(l.jobs[0].items.map(i => i.price), [1200, 58.5], "a list price of 1.200 prices the quote 1200, not 1.2");
});

test("list prices × factor in exact cents: 0.35 × 1.5 is 0.53, not the float product's 0.52", () => {
  const l = parseLists({ jobs: "# Bad\nDübel | Stück | 0,35\nFuge | m | 1,15", levels: "Premium | 1,5" });
  const { items } = priceFromLists([{ description: "Dübel", quantity: 10, list_item: "Dübel" }, { description: "Fuge", quantity: 2, list_item: "Fuge" }], l, { quality_level: "Premium" });
  assert.deepEqual(items.map(i => i.unit_price), [0.53, 1.73]);
});

test("his lists, parsed once: createAgenda takes them as they are (start.ts has them for quote_send)", () => {
  const parsed = parseLists(NIKO);
  const listed = skill.createAgenda({ user: { name: "Niko", lang: "de", profile: {} }, lists: parsed });
  assert.match(listed.prompt({ lang: "de" }), /\nHIS LISTS:\n- Badumbau: Bodenfläche/, "the lists given, though his profile has none");
  const none = skill.createAgenda({ user: { name: "Niko", lang: "de", profile: { lists: NIKO_SAVED } }, lists: null });
  assert.doesNotMatch(none.prompt({ lang: "de" }), /HIS LISTS:/, "null: no lists for this call");
  assert.match(skill.createAgenda({ user: { name: "Niko", lang: "de", profile: { lists: NIKO_SAVED } } }).prompt({ lang: "de" }), /HIS LISTS:/, "left out: parsed from his profile, as before");
});

test("what's open on his lists: no crash on a missing note or a checklist that isn't a list", () => {
  const siteOnly = parseLists({ site: "Parkplatz | kein Parkplatz" });
  assert.equal(openOnLists(siteOnly, null), "the site: Parkplatz");
  const offSchema = { job_list: "Badumbau", checklist: "Bodenfläche" as unknown as [] }; // the model's output, not as its schema says
  assert.match(openOnLists(parseLists(NIKO), offSchema), /^Badumbau list: Bodenfläche,/);
});

test("the site factor: 1 when all is fine, his maximum when all of it is unfavourable, in between by count", () => {
  const l = parseLists(NIKO);
  assert.deepEqual(siteFactor(l, []), { factor: 1, unfavourable: [] });
  assert.equal(siteFactor(l, ["Wohnung", "Stockwerk", "Parkplatz"]).factor, 1.4, "two of the four counted lines (\"Wohnung\" is an answer, not an item)");
  assert.equal(siteFactor(l, ["Haus oder Wohnung", "Stockwerk", "Laufweg in Metern", "Parkplatz", "Adresse"]).factor, 1.8, "\"Adresse\" doesn't count");
  assert.equal(siteFactor(parseLists({ ...NIKO, siteMax: "" }), ["Parkplatz"]).factor, 1, "no maximum, no factor");
});

test("prices from his list: × quality × site; his own price in the call stays; the unit comes from the list", () => {
  const l = parseLists(NIKO);
  const { items, calc } = priceFromLists([
    { description: "Bodenfliesen 60×60 verlegen", quantity: 8.5, list_item: "Bodenfläche" },
    { description: "Wandfliesen", quantity: 24, unit: "m²", unit_price: 70, list_item: "Wandfläche" },
    { description: "Lochbohrungen", quantity: 6, list_item: "Lochbohrungen" },
    { description: "Edelstahlschienen", quantity: 4, unit: "m", list_item: "Welche Edelstahlschienen" },
    { description: "Silikon", unit: "pauschal", unit_price: 120 },
  ], l, { quality_level: "Hochwertig", site_unfavourable: ["Stockwerk", "Parkplatz"] });
  assert.equal(calc.factor, 1.75, "1.25 × 1.4");
  assert.deepEqual(items.map(i => [i.unit_price, i.unit]), [[113.75, "m²"], [70, "m²"], [43.75, "Stück"], [undefined, "m"], [120, "pauschal"]]);
  assert.equal(calc.fromList, 2);
  assert.deepEqual(calc.quality, { name: "Hochwertig", factor: 1.25 });
  assert.deepEqual(priceFromLists([{ description: "x" }], null), { items: [{ description: "x" }], calc: null }, "no lists: unchanged");
});

test("the checklist primitive: the capture template's second step; its how in YOUR JOBS, his lists per call, what's open every turn", () => {
  assert.deepEqual(skill.templates.get("notebook.capture").steps.map(s => s.primitive), ["capture", "checklist"]);
  const user = { name: "Niko", lang: "de", profile: { lists: NIKO_SAVED } };
  const agenda = skill.createAgenda({ user });
  const prompt = agenda.prompt({ lang: "de", note: {} });
  const [jobs, perCall] = [prompt.slice(0, prompt.indexOf("Today is")), prompt.slice(prompt.indexOf("Today is"))];
  assert.match(jobs, /- HIS LISTS \(below, only if he set some up; for those jobs they override "at most two questions"/, "the how: the template's text");
  assert.match(jobs, /\("Bodenfläche\?", "Und die Wand\?", "Dusche oder Wanne\?"\)/, "examples from the locale pack");
  assert.match(jobs, /never to read out on your own: ask plainly \("Welche Ausführung\?"\)\. Only\n  if he asks what there is, or doesn't know, offer "Soll ich dir die aufzählen\?" \(NEXT: confirm\), and list them after his yes\./);
  assert.match(perCall, /\nHIS LISTS:\n- Badumbau: Bodenfläche \(m²\); Wandfläche \(m²\); Dusche oder Badewanne, mit Grundfläche;/, "his lists: per call");
  assert.match(perCall, /; Restliche Wände \[choices, to recognise his answer: Putz, glatt oder Pandomo\];/);
  assert.match(perCall, /- Quality levels, for every job on his lists \(to recognise his answer; read them out only after his yes\): Low Budget, Standard,/);
  assert.doesNotMatch(prompt, /\nOpen on his lists:/, "nothing open before the job is clear");

  const note = { mode: "capture", job_list: "Badumbau", checklist: [{ item: "Bodenfläche", answer: "8,5 m²" }, { item: "Wandfläche", answer: "" }], site: [{ item: "Adresse", answer: "Seestraße 4", unfavourable: false }], quality: "", lists_done: false };
  const open = openOnLists(parseLists(NIKO), note);
  assert.match(open, /^Badumbau list: Wandfläche, Dusche oder Badewanne, mit Grundfläche, Abdichtung,/);
  assert.match(open, /Format Fliesen Wand, Restliche Wände, Welche Edelstahlschienen/, "what's open: by name, no choices");
  assert.match(open, /; the site: Ort, Haus oder Wohnung, Stockwerk, Laufweg in Metern, Parkplatz; the quality level$/, "no level names to read out");
  assert.match(agenda.prompt({ lang: "de", note }), /Still missing: [^\n]*\nOpen on his lists: Badumbau list: Wandfläche/);
  assert.equal(openOnLists(parseLists(NIKO), { ...note, lists_done: true }), "", "he said reicht: nothing more");
  assert.doesNotMatch(agenda.prompt({ lang: "de", note: { ...note, mode: "brief" } }), /\nOpen on his lists:/, "only while he tells about a job");

  const schema = agenda.schema();
  assert.deepEqual(schema.properties.job_list.enum, ["Badumbau", "none"], "Gemini takes no \"\" in an enum");
  assert.ok(schema.properties.checklist.items.properties.item.enum.includes("Lochbohrungen"));
  assert.deepEqual(schema.properties.quality.enum, ["Low Budget", "Standard", "Hochwertig", "Meisterstück", "none"]);
  assert.equal(agenda.update({ mode: "capture", job_list: "none", quality: "none", checklist: [], site: [], lists_done: false }).note.quality, "", "\"none\" is \"\" in the note (the step's tidy)");
  assert.ok(!JSON.stringify(schema).includes('""'), "no empty enum values anywhere");
  assert.ok(["job_list", "checklist", "site", "quality", "lists_done"].every(k => schema.required.includes(k)));
  assert.match(agenda.extractSystem("de"), /- site: per site item he answered \("Ort"; "Adresse"; "Haus oder Wohnung", unfavourable when: Wohnung;/);

  // Nobody without lists, and no call Toni makes, hears a word of it.
  const without = skill.createAgenda({ user: { name: "Chris", lang: "de", profile: {} } });
  assert.doesNotMatch(without.prompt({ lang: "de" }), /- HIS LISTS \(below|HIS LISTS:/);
  assert.equal(without.schema().properties.job_list, undefined);
  const out = skill.createAgenda({ user, direction: "outbound", objectives: [{ id: "errand_1", template: "discovery.day", params: { focus: "x" }, stored: false }] });
  assert.doesNotMatch(out.prompt({ lang: "de" }), /- HIS LISTS \(below|HIS LISTS:/, "a call Toni makes is for its errand");
  assert.equal(out.schema().properties.checklist, undefined);
});

test("quote_send with his lists: the line names its list item, the quote is priced, the PDF says the quality level", async () => {
  const [u] = await memory.listUsers();
  const scope = { user: { id: u.id, orgId: u.orgId, name: u.name, lang: u.lang, timezone: "Europe/Berlin", profile: { lists: NIKO_SAVED } } };
  const sent = [];
  const tool = quoteSend({ memory: scope, quotes, sender: { sendDocument: async d => { sent.push(d); return { messageId: "wamid.l" }; } }, to: "+491601", lists: parseLists(NIKO) });
  const p = tool.parameters.properties;
  assert.ok(p.items.items.properties.list_item.enum.includes("Bodenfläche"));
  assert.ok(!p.items.items.properties.list_item.enum.includes("Format Fliesen Boden"), "only priced items");
  assert.deepEqual(p.site_unfavourable.items.enum, ["Haus oder Wohnung", "Stockwerk", "Laufweg in Metern", "Parkplatz"]);
  assert.ok(p.quality_level.enum.includes("Meisterstück"));
  assert.equal(quoteSend({ memory: scope, quotes }).parameters.properties.quality_level, undefined, "no lists: the tool as before");

  const runner = createToolRunner({ tools: [tool] });
  const args = { customer_name: "Familie Huber", items: [{ description: "Bodenfliesen 60×60", quantity: 8.5, list_item: "Bodenfläche" }, { description: "Lochbohrungen", quantity: 6, list_item: "Lochbohrungen" }], quality_level: "Standard", site_unfavourable: ["Parkplatz"] };
  const r = await runner.run({ name: "quote_send", args }, { callId: "call-l", lang: "de", confirmed: true, emit: () => {} });
  assert.equal(r.status, "ok");
  const [q] = await quotes.forCall("call-l");
  assert.equal(q.calc.factor, 1.2, "Standard × site (one of four: 1 + 0.8/4)");
  const data = (await quotes.get(q.id)).data;
  assert.deepEqual(data.items.map(i => [i.unitPrice, i.total]), [[78, 663], [30, 180]]);
  assert.deepEqual([data.net, data.gross, data.complete, data.quality], [843, 1003.17, true, "Standard"]);
  assert.equal((await PDFDocument.load(sent[0].bytes)).getPageCount(), 1);
  assert.ok((await renderQuotePdf(data)).length > 1000);
});

test("his lists on his People card; the note on WhatsApp shows what was measured", async () => {
  const [u] = await memory.listUsers();
  const saved = await memory.updateUser(u.id, { lists: NIKO });
  assert.equal(saved.lists.siteMax, 1.8);
  assert.match(saved.lists.jobs, /^# Badumbau/);
  await assert.rejects(memory.updateUser(u.id, { lists: { levels: "Gold | 99" } }), (e: HttpError) => e.status === 400);
  assert.equal((await memory.getUser(u.id)).lists.siteMax, 1.8, "a bad save changes nothing");

  const msg = noteMessage({ customer_name: "Familie Huber", place: "Allensbach", work: [{ area: "Bad", description: "neu fliesen" }], checklist: [{ item: "Bodenfläche", answer: "8,5 m²" }, { item: "Format Fliesen Boden", answer: "60×60" }], site: [{ item: "Parkplatz", answer: "keiner", unfavourable: true }], quality: "Hochwertig", next_steps: [{ what: "Angebot an Huber", due: "Freitag" }, { what: "Fliesen beim Händler anfragen" }], open_questions: ["Anzahl Lochbohrungen"] }, "de");
  assert.equal(msg, [
    "*Notiert* ✅ Familie Huber, Allensbach",
    "• Bad: neu fliesen",
    "Aufgenommen: Bodenfläche: 8,5 m² · Format Fliesen Boden: 60×60 · Parkplatz: keiner · Hochwertig",
    "",
    "*Zu tun*",
    "☐ Angebot an Huber (Freitag)",
    "☐ Fliesen beim Händler anfragen",
    "☐ Klären: Anzahl Lochbohrungen",
    "",
    "_Stimmt was nicht? Ruf mich kurz an, dann korrigier ich's._",
  ].join("\n"), "what he has to do: its own list to work through");
});

test("HOW IT WORKS: the basics always; quotes when they're on for him, how his lists price only when he has some", () => {
  const parsed = parseLists(NIKO);
  const quotes = { name: "Niko", lang: "de", profile: { features: { quotes: "2026-10-15T00:00:00Z" } } };
  const p = (user: object, lists: ReturnType<typeof parseLists> | null = parsed) => skill.createAgenda({ user, lists } as never).prompt({ lang: "de" });
  const off = p({ name: "Niko", lang: "de", profile: {} });
  assert.match(off, /HOW IT WORKS:[^]*\n- basics: Ruf mich einfach an/);
  assert.doesNotMatch(off, /- quotes:|- quoteLists:/, "nothing about quotes when they're off");
  const on = p(quotes);
  assert.match(on, /\n- quotes: Angebote gehen bei einem Anruf über WhatsApp/, "also on a line without the tool: it says where they work");
  assert.match(on, /\n- quoteLists: [^\n]*Listenpreis mal dem Faktor der Ausführung/);
  assert.doesNotMatch(p(quotes, null), /- quoteLists:/, "no lists: nothing about them");
});
