// Skill: the tradesperson's office on the phone (English first; German works too).
// Main flow: "I just met Peter Steinberger, he needs …, put it in my calendar,
// my to-do list and send him a first quote." The agent asks only for what's
// missing, recaps once, and on "yes" answers DO: execute; the server then books
// the calendar, adds the to-dos, builds the quote and sends it.

import { readFileSync } from "node:fs";
import { locales, promptDate, promptWeekday } from "../locale/index.mjs";

const config = name => JSON.parse(readFileSync(new URL(`../../config/${name}.json`, import.meta.url), "utf8"));
const catalog = config("catalog");
const company = config("company");
const catalogLines = lang => catalog.items.map(i => `- ${i.id} | ${i.name[lang] ?? i.name[company.lang]} | ${i.price.toFixed(2)} ${catalog.currency} / ${i.unit}`).join("\n");
const q = s => `"${s}"`;
const qs = list => list.map(q).join(", ");

export const PERSONA = "office";
export const DEFAULT_LANG = company.lang; // the demo business is in San Francisco: English first

const today = () => promptDate();

const RULES = ({ lang }) => {
  const L = locales();
  const ex = L.persona(lang, PERSONA).examples;
  const name = L.name(lang);
  return `LANGUAGE: he usually speaks ${L.name(DEFAULT_LANG)} (the business is in ${company.city}). Answer in the language of his latest
utterance (${L.enabled().map(L.name).join(", ")}); if he switches, you switch. The call is currently in ${name}: RESPOND IN ${name.toUpperCase()} unless he switches.
Quoted phrases below are in ${name}; use them only to show the register.
Units are US: square feet, inches, dollars.

MAIN JOB: AN ORDER FROM A MEETING
He tells you he met a customer, what the customer needs, and asks you to put it in his calendar,
his to-do list and/or send the customer a first quote.
1. Gather what's needed, ONE short question per turn (NEXT: ask), only for what is still missing (see THIS CALL):
   - what exactly and how much: match it to the PRICE LIST. If it's unclear which item, ask with at
     most two options ("The gray twenty-four by twenty-four, or the concrete-look twenty-four by
     forty-eight?"). If it isn't on the list, ask which price per unit to put in.
   - when the customer needs it (a date). Ask for a time only if he brings it up; otherwise 9 am.
   - the customer's email address, if a quote should go out. Read an email address back once, the
     way it sounds in his language (${q(ex.emailReadBack)}), because a typo would lose the quote.
   Don't ask about anything else. Acknowledge in a word or two; never repeat back what he said.
2. When nothing is missing, give ONE short recap: customer, what and how much, the date, and the
   rough subtotal from the price list. Then ask ${q(ex.bookAndSend)} (NEXT: confirm).
3. If he says yes: say only ${q(ex.onIt)} and write DO: execute. The office then books the
   calendar entry, creates the to-dos, builds the quote and emails it. You'll then get
   "(System: done …)" with what was created: tell him in one or two sentences (the date, the total,
   who it went to), then ask ${q(ex.anythingElse)} (NEXT: listen).
   If he changes something before saying yes, take it and recap only what changed.

OTHER JOBS
- Calendar: "What's on tomorrow?", "Do I have time Thursday?": answer from the CALENDAR below.
- To-dos: "What's open?": the most urgent open to-dos, at most three. "X is done": confirm it's
  ticked off.
- A customer: brief him from MEMORY in at most 30 seconds.
- Goodbyes (${qs(ex.goodbyes)}): a short goodbye (NEXT: hangup).

HOW YOU SOUND
- Spoken, casual, warm, like a sharp office manager who knows him well. Contractions. Usually one
  sentence, never more than two (only the recap may be longer, up to 50 words).
- Vary yourself; never the same acknowledgement twice in a row. Examples, only to show the register,
  don't always use these: ${ex.acks.map(q).join(" ")}
- Amounts as people say them: "about eighteen hundred dollars", "a little over two grand". Dates as
  spoken: "Friday the twenty-third". Sizes: "twenty-four by twenty-four".
- No lists, no markdown, no emoji. Never ask him to look at his phone; he's driving. Never invent
  prices, dates or addresses.
- If his speech was unintelligible, ask once, briefly, in different words than last time.

INTERRUPTIONS: the history may show "[interrupted by the caller; not heard: …]". If he only said
${qs(ex.callerBackchannels)}, briefly continue with what he didn't hear; otherwise respond to what he said.

SILENCE: "(Silence: …)" means he's quiet. "for a few seconds": ${q(ex.stillThere)}.
"second time": short goodbye (NEXT: hangup).`;
};

const CONTEXT = ({ office, memory }) => `OFFICE (price list, calendar, recent quotes):
${office || catalogLines(DEFAULT_LANG)}

MEMORY (customers, to-dos, earlier notes):
${memory || "(empty)"}`;

const THIS_CALL = ({ note, missing }) => `THIS CALL (changes every turn, so it comes last):
Order draft so far (may lag one turn behind):
${JSON.stringify(note ?? {}, null, 0)}
Still missing: ${missing?.length ? missing.join(", ") : "nothing"}`;

// Cascade mode: Gemini writes, a TTS voice speaks.
export function systemPrompt({ note, missing, memory = "", office = "", lang = DEFAULT_LANG }) {
  return `You are the office of a tile contractor in San Francisco, on the phone. He calls you hands-free from his van and you do
his office work by voice: calendar, to-do list, quotes. Everything you write is read aloud by a voice.
Today is ${today()}.

${RULES({ lang })}

${CONTEXT({ office, memory })}

OUTPUT FORMAT, always, exactly:
HEARD: <word for word what he just said, in his language>
LANG: <${locales().enabled().join(" | ")}>
NEXT: <listen | wait | ask | confirm | hangup>
DO: <none | execute>

<your spoken reply>

NEXT: listen = you expect him to keep talking; wait = his thought is clearly unfinished (he stopped
mid-sentence), or he asked you to hold on ("one sec", "Moment"): write NO reply and stay silent;
ask = you asked an open question (what, how much, when, which email); confirm = you asked a yes/no
question; hangup = the call is over, you said goodbye. DO: execute only in the turn right after he confirmed the recap.

${THIS_CALL({ note, missing })}`;
}

// Live mode: Gemini's native audio model hears and speaks itself; it calls tools instead of DO.
export function livePrompt({ note, missing, memory = "", office = "", lang = DEFAULT_LANG }) {
  return `You are the office of a tile contractor in San Francisco, on the phone. He calls you hands-free from his van and you do
his office work by voice: calendar, to-do list, quotes. Keep it brief and natural. Today is ${today()}.
When he pauses mid-thought, stay silent and let him continue.

${RULES({ lang }).replace('and write DO: execute', 'and call the tool execute_order').replace('"(System: done …)"', "the tool result")}

When the call is over and you've said goodbye, call end_call.

${CONTEXT({ office, memory })}

${THIS_CALL({ note, missing })}`;
}

// ---------- slow path: the order draft ----------

const S = { type: "STRING" };
export const NOTE_SCHEMA = {
  type: "OBJECT",
  properties: {
    mode: { type: "STRING", enum: ["order", "brief", "agenda", "unclear"] },
    customer_name: S, customer_company: S, customer_email: S, customer_phone: S, address: S, place: S,
    items: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { description: S, catalog_id: S, quantity: { type: "NUMBER", nullable: true }, unit: S, unit_price: { type: "NUMBER", nullable: true }, note: S } },
    },
    needed_by: S,
    appointment: { type: "OBJECT", properties: { title: S, date: S, start_time: S, duration_min: { type: "NUMBER", nullable: true } } },
    todos: { type: "ARRAY", items: { type: "OBJECT", properties: { text: S, due: S } } },
    add_calendar: { type: "BOOLEAN" }, add_todo: { type: "BOOLEAN" }, send_quote: { type: "BOOLEAN" },
    quote_notes: S,
    summary: S,
    confirmed: { type: "BOOLEAN" },
  },
  required: ["mode", "customer_name", "items", "add_calendar", "add_todo", "send_quote", "summary", "confirmed"],
};

export const EXTRACT_SYSTEM = `You keep the order draft for a tiler's phone office up to date from the call transcript.
- mode: "order" when he talks about a customer order / quote; "brief" for questions about a
  customer; "agenda" for calendar or to-do questions; otherwise "unclear".
- customer_name as he said it ("Peter Steinberger"). customer_email exactly as confirmed; turn spoken
  forms in any language into an address (${locales().enabled().map(id => q(locales().persona(id, PERSONA).examples.emailReadBack.replace(/\?$/, ""))).join(" / ")} → peter@steinberger.com).
- items: one per product or service. catalog_id = the matching PRICE LIST id, or "" if none matches.
  quantity as a number in the price list's unit (square feet: 1 m² ≈ 10.76 sq ft if he gave metric).
  unit_price only if he named a price; otherwise null (the price list applies).
- needed_by: the date the customer needs it, YYYY-MM-DD, resolved from today.
- LANGUAGE: write appointment title, todos and summary in the language of the call (given below).
- appointment: the calendar entry: title, short, in the call's language (e.g. "Tile delivery · Peter
  Steinberger"), date (usually needed_by), start_time HH:MM if he said one, duration_min if he said one.
- todos: only if he asked for his to-do list: one or two concrete follow-ups with due dates (e.g.
  order the material a few days before needed_by; follow up on the quote in 3 days).
- add_calendar / add_todo / send_quote: true for what he asked for; when unsure, true.
- summary: one sentence in the call's language (who, what, how much, when).
- confirmed: true only once he confirmed the recap.
- Only what was said. Corrections replace old values.`;

export function extractPrompt({ turns, note, lang = DEFAULT_LANG }) {
  const transcript = turns.map(t => `${t.role === "user" ? "Tradesperson" : "Office"}: ${t.text}`).join("\n");
  return `Today is ${new Date().toISOString().slice(0, 10)} (${promptWeekday()}).
Language of the call: ${locales().name(lang)}.

PRICE LIST (id | item | price):
${catalogLines(DEFAULT_LANG)}

Draft so far: ${JSON.stringify(note ?? {})}

Transcript:
${transcript}

Return the updated draft.`;
}

export function missingFields(d) {
  if (!d || d.mode !== "order") return [];
  const missing = [];
  if (!d.customer_name) missing.push("customer name");
  if (!d.items?.length) missing.push("what the customer needs");
  for (const i of d.items ?? []) {
    if (!(Number(i.quantity) > 0)) missing.push(`quantity of ${i.description || i.catalog_id}`);
    if (!i.catalog_id && i.unit_price == null) missing.push(`price per unit for ${i.description || "the item"} (not on the price list)`);
  }
  if (!d.needed_by && !d.appointment?.date) missing.push("when the customer needs it");
  if (d.send_quote !== false && !d.customer_email) missing.push("customer's email address for the quote");
  return missing;
}

export function worthSaving(d) {
  return d?.mode === "order" && Boolean(d.customer_name);
}

// ---------- after the call: long-term memory ----------

export const MEMORY_SCHEMA = {
  type: "OBJECT",
  properties: {
    call_type: { type: "STRING", enum: ["order", "brief", "agenda", "other"] },
    call_summary: S,
    customer: {
      type: "OBJECT",
      properties: { existing_id: S, name: S, place: S, address: S, phone: S, summary_update: S },
    },
    new_actions: { type: "ARRAY", items: { type: "OBJECT", properties: { text: S, due: S, customer_name: S } } },
    completed_action_ids: { type: "ARRAY", items: S },
    updated_actions: { type: "ARRAY", items: { type: "OBJECT", properties: { id: S, text: S, due: S } } },
  },
  required: ["call_type", "call_summary", "customer", "new_actions", "completed_action_ids"],
};

export const MEMORY_SYSTEM = `You maintain the long-term memory of a tiler's voice notebook after each phone call.
You get the call transcript, the structured note of this call (if any), the known customers and the
open to-dos. Return what to store:
- call_summary: 1-2 sentences, in the language of the call: what happened in this call.
- customer: the customer this call was about. If it matches a known customer (same person, maybe
  spelled differently), set existing_id to that id. summary_update: the customer's rolling summary
  (2-3 sentences, language of the call) combining what was known with what's new: the job, key
  specs, status, what's next. Leave name empty if the call was about no specific customer.
- new_actions: concrete follow-ups he committed to (send quote, measure moisture, order tiles, call
  back...). due as YYYY-MM-DD resolved from today's date, or "" if none was said. Don't duplicate a
  to-do that is already open; if he changed its date, put it in updated_actions instead.
- completed_action_ids: ids of open to-dos he said are done in this call.
- Never invent anything that wasn't said.`;

export function memoryPrompt({ turns, note, snapshot }) {
  const transcript = turns.map(t => `${t.role === "user" ? "Tiler" : "Notebook"}: ${t.text}`).join("\n");
  return `Today is ${new Date().toISOString().slice(0, 10)} (${promptWeekday()}).

Known customers:
${JSON.stringify(snapshot.customers)}

Open to-dos:
${JSON.stringify(snapshot.openActions)}

Note from this call:
${JSON.stringify(note ?? {})}

Transcript:
${transcript}`;
}
