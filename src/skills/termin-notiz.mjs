// Skill: Termin-Notiz (appointment memory) for a tiler, in German or English.
// Capture after an appointment, recall before the next one. Everything the
// fast path writes is spoken; the slow path keeps the structured note.

export const LANGS = ["de", "en"];

// Pre-synthesised lines per language (greeting plays the instant a call connects).
export const VOICE_LINES = {
  de: {
    greeting: "Servus, hier ist dein Notizbuch. Kommst du von einem Termin, oder fährst du zu einem?",
    fillers: ["Mhm.", "Okay.", "Alles klar."],
    wrapUp: "Wir sind gleich am Zeitlimit. Ich speichere alles, was ich habe. Bis später!",
    oops: "Sorry, da hat gerade was gehakt. Sag's bitte nochmal.",
  },
  en: {
    greeting: "Hi, this is your notebook. Coming from an appointment, or heading to one?",
    fillers: ["Mhm.", "Okay.", "Got it."],
    wrapUp: "We're almost at the time limit. I'm saving everything I have. Talk soon!",
    oops: "Sorry, something glitched there. Could you say that again?",
  },
};

// Language for the greeting: Dial's `language` if it sent one, else the caller's country code.
export function initialLanguage({ language, from } = {}, fallback = process.env.DEFAULT_LANG || "de") {
  const tag = (language ?? "").toLowerCase();
  if (tag.startsWith("en")) return "en";
  if (tag.startsWith("de")) return "de";
  if (/^\+(49|43|41)/.test(from ?? "")) return "de";
  if (/^\+(1|44|61|64|353)/.test(from ?? "")) return "en";
  return LANGS.includes(fallback) ? fallback : "de";
}

const today = () => new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

export function systemPrompt({ note, missing, memory = "", lang = "de" }) {
  return `You are the voice notebook of a tiler (DesklessOS). He calls you from his car, hands-free.
Everything you write is read aloud by a text-to-speech voice. Today is ${today()}.

LANGUAGE: he speaks German or English. Always answer in the language of his latest utterance;
if he switches, you switch. Language of the call so far: ${lang === "en" ? "English" : "German"}.
German: casual "du", like a good colleague. English: casual and friendly.

You have two jobs.

A) AFTER A CUSTOMER APPOINTMENT: take a note.
- Let him talk freely. Don't interrupt.
- Only if his last sentence is audibly cut off mid-sentence, reply just "Mhm." (NEXT: listen).
  If the sentence is complete, move on to the next step.
- When he's done and required details are missing, ask briefly: at most two questions per call,
  ideally in one sentence. Required are only: customer or place, the work to be done, and the
  next step (e.g. quote by when). Never ask about anything else.
- Then summarise in two or three short sentences and ask "Passt das so?" / "Does that sound right?"
  (NEXT: confirm).
- If he says yes: "Gespeichert. Gute Fahrt!" / "Saved. Drive safe!" (NEXT: hangup). If he corrects
  something, take it, confirm the change briefly, and ask again.

B) BEFORE AN APPOINTMENT: briefing.
- If he says "ich fahr zu …", "was war bei …", "I'm heading to …", "what was the deal with …" or
  names a customer, find that customer in MEMORY below (also by place or job if the name is
  fuzzy). In at most 30 seconds say who and where, what was discussed (key specs: area, tile,
  special wishes), what's open and what's next. If he asks a detail, answer it from the notes.
  Then "Soll ich noch was vorlesen?" / "Want me to read anything else?" (NEXT: confirm).
- If there's no matching note, say so honestly and offer to take one now.
- Notes may be in either language; brief him in his language.

C) AGENDA: his to-do list (from MEMORY below).
- "Was steht an?", "Was ist offen?", "What's on my list?", "Was muss ich heute machen?": read the
  most urgent open to-dos, overdue and soonest due first, at most three, one short clause each
  ("Angebot für Frau Müller bis Freitag"). Say how many more there are. (NEXT: confirm)
- "Angebot Müller ist raus", "Huber ist erledigt", "I sent the quote to …": confirm briefly that
  you've ticked it off ("Super, hab ich abgehakt.") and mention the next most urgent one if any.
- After a note in job A, if he has something overdue or due today, you may add one short reminder
  before saying goodbye.

If he says "das war's", "tschüss", "that's it", "bye" or similar: say goodbye briefly (NEXT: hangup).

If you get "(Silence: …)" instead of audio, he's saying nothing. Leave HEARD empty and answer in
the language of the call.
- "for a few seconds": just ask "Bist du noch dran?" / "Are you still there?" (NEXT: listen).
  Never hang up the first time.
- "second time": say goodbye briefly (NEXT: hangup). Only say it's saved if he actually told you
  about an appointment.
- "didn't continue after your Mhm": he's done; continue with the next step (missing details or summary).

How you speak:
- One or two short sentences, at most 35 words. Only the summary and the briefing may use up to 60.
- Spoken language only: no lists, no markdown, no emoji.
- Numbers the way people say them: "acht Quadratmeter", "sechzig mal hundertzwanzig";
  "eight square metres", "sixty by one-twenty".
- Trade words you know. German: Feinsteinzeug, Großformat, Fuge, Fugenfarbe, Silikon, Abdichtung,
  Estrich, Gefälle, bodengleiche Dusche, Rinne, Sockel, Aufmaß, abschlagen. English: porcelain
  stoneware, large format, grout, grout colour, silicone, waterproofing, screed, fall, walk-in
  shower, linear drain, skirting, site measure, strip the old tiles.
- Never ask him to look at his phone. He's driving.
- Never invent details. What he didn't say doesn't exist.
- If the audio is unclear (noise, silence, nothing intelligible), write "HEARD: (unclear)" and ask
  him briefly to say it again (NEXT: listen).

MEMORY (persists across calls: to-dos, customers and their appointment notes):
${memory || "(empty)"}

Output format, always, exactly:
HEARD: <word for word what he just said, in his language>
LANG: <de | en>
NEXT: <listen | confirm | hangup>

<your spoken reply>

LANG is the language of your reply. NEXT means: listen = you expect him to talk at length;
confirm = you asked a short question (yes/no, one detail); hangup = the call is over, you said goodbye.

THIS CALL (changes every turn, so it comes last):
Current state of the note in this call (may lag one turn behind):
${JSON.stringify(note ?? {}, null, 0)}
Required details still missing: ${missing?.length ? missing.join(", ") : "none"}`;
}

// ---------- slow path: structured note ----------

const S = { type: "STRING" };
export const NOTE_SCHEMA = {
  type: "OBJECT",
  properties: {
    modus: { type: "STRING", enum: ["notiz", "briefing", "agenda", "unklar"] },
    kunde_name: S,
    kunde_telefon: S,
    adresse: S,
    ort: S,
    termin_datum: S,
    arbeiten: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          raum: S,
          bereich: S,
          flaeche_m2: { type: "NUMBER", nullable: true },
          fliese_format: S,
          fliese_material: S,
          fliese_optik: S,
          beschaffung: S,
          beschreibung: S,
        },
      },
    },
    untergrund: S,
    sonderwuensche: { type: "ARRAY", items: S },
    zeitrahmen: S,
    budget: S,
    naechste_schritte: { type: "ARRAY", items: { type: "OBJECT", properties: { was: S, bis: S } } },
    offene_fragen: { type: "ARRAY", items: S },
    zusammenfassung: S,
    bestaetigt: { type: "BOOLEAN" },
  },
  required: ["modus", "kunde_name", "ort", "arbeiten", "naechste_schritte", "zusammenfassung", "bestaetigt"],
};

export const EXTRACT_SYSTEM = `Du liest das Protokoll eines Telefonats zwischen einem Fliesenleger und seinem
Sprach-Notizbuch und pflegst daraus eine strukturierte Termin-Notiz.
- modus: "notiz", wenn er von einem Termin erzählt; "briefing", wenn er nur eine alte Notiz hören will;
  "agenda", wenn es um seine To-dos geht (was steht an, was ist erledigt); sonst "unklar".
- Nur übernehmen, was der Fliesenleger gesagt oder bestätigt hat. Unbekannt = leerer String / leere Liste.
- Korrekturen ersetzen den alten Wert.
- termin_datum: Datum des besprochenen Termins im Format JJJJ-MM-TT, falls nicht anders gesagt heute.
- zusammenfassung: ein kurzer deutscher Satz (wer, wo, was, nächster Schritt).
- bestaetigt: true nur, wenn er die vorgelesene Zusammenfassung bestätigt hat.
- Das Gespräch kann Deutsch oder Englisch sein. Die Schlüssel bleiben deutsch; die Werte und die
  zusammenfassung schreibst du in der Sprache, in der er erzählt hat.`;

export function extractPrompt({ turns, note }) {
  const transcript = turns.map(t => `${t.role === "user" ? "Fliesenleger" : "Notizbuch"}: ${t.text}`).join("\n");
  return `Heute ist ${new Date().toISOString().slice(0, 10)}.
Bisherige Notiz: ${JSON.stringify(note ?? {})}

Protokoll:
${transcript}

Gib die aktualisierte Notiz zurück.`;
}

export function missingFields(note) {
  if (!note || (note.modus && note.modus !== "notiz")) return []; // only appointment notes have required fields
  const missing = [];
  if (!note.kunde_name && !note.ort && !note.adresse) missing.push("customer or place");
  if (!note.arbeiten?.length) missing.push("the work to be done");
  if (!note.naechste_schritte?.length) missing.push("next step");
  return missing;
}

export function worthSaving(note) {
  return note?.modus === "notiz" && Boolean(note.kunde_name || note.ort || note.adresse || note.arbeiten?.length);
}

// ---------- after the call: long-term memory ----------

export const MEMORY_SCHEMA = {
  type: "OBJECT",
  properties: {
    call_type: { type: "STRING", enum: ["notiz", "briefing", "agenda", "other"] },
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
  return `Today is ${new Date().toISOString().slice(0, 10)} (${new Date().toLocaleDateString("en-GB", { weekday: "long" })}).

Known customers:
${JSON.stringify(snapshot.customers)}

Open to-dos:
${JSON.stringify(snapshot.openActions)}

Note from this call:
${JSON.stringify(note ?? {})}

Transcript:
${transcript}`;
}
