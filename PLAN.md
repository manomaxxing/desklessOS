# DesklessOS: voice engine plan

Voice first. The phone call is the interface. Everything else (web pages,
quotes, calendars, employee messages) is downstream of what gets said.

## 1. The one use case: "Termin-Notiz" (appointment memory)

From the interview with the tiler:

- 2 to 6 customer appointments a day, 4 to 5 hours a day in the car.
- Self-described "notizfaul": takes no notes after appointments.
- Won't pick up the phone while driving. Hands-free calls over car Bluetooth
  are legal; holding the phone to type is not (§23 StVO).
- Wants to use car time as working time.

**The loop:**

1. **Capture, after the appointment.** He calls a number from the car and talks
   freely about what was discussed. The assistant asks at most two follow-up
   questions for what is missing, reads back a short summary, and saves a
   structured note.
2. **Recall, before the follow-up appointment.** He calls and says "Ich fahr
   jetzt zu Frau Müller." The assistant briefs him in under 30 seconds and lists
   the open points.

Capture and recall use the same data, so recall is cheap and it is what makes
the demo pay off. Site descriptions for employees, quotes, timesheets and
shift plans are **downstream** (section 8).

### Sample call (capture)

> **DesklessOS:** Servus, hier ist dein Notizbuch. Von welchem Termin kommst du?
> **Fliesenleger:** Von der Frau Müller in Haching, Bad komplett neu, alte
> Fliesen runter, Boden so acht Quadratmeter, Wand bis Decke, sie will
> Großformat sechzig mal hundertzwanzig in Beton-Optik, bodengleiche Dusche mit
> Rinne…
> **DesklessOS:** Alles klar. Zwei Fragen noch: Wer besorgt die Fliesen, und
> bis wann will sie das Angebot?
> **Fliesenleger:** Ich besorg sie, Angebot bis Freitag.
> **DesklessOS:** Ich fasse zusammen: Frau Müller, Haching, Bad komplett,
> acht Quadratmeter Boden, Wand raumhoch, sechzig mal hundertzwanzig
> Beton-Optik, bodengleiche Dusche mit Rinne, Fliesen besorgst du, Angebot bis
> Freitag. Passt das?
> **Fliesenleger:** Passt.
> **DesklessOS:** Gespeichert. Gute Fahrt.

## 2. What already exists (reuse, don't rebuild)

`~/manogames/mano-games/tools/buddy-lab` is a working German/English voice
loop with **zero npm dependencies**:

| File | What we take |
|---|---|
| `src/gemini-endpoint.ts` | Vertex AI endpoint plus ADC token cache (credits cover Vertex, not AI Studio) |
| `src/buddy.ts` | Pattern: audio goes straight to Gemini, so **hearing and answering are one call** (`HEARD:` line plus the reply) |
| `src/reply.ts` | Stream parser: releases the transcript, then each finished sentence |
| `src/fish.ts` | Fish Audio TTS, streamed per sentence, playback starts before Fish is done |
| `src/cost.ts` | Per-turn cost metering |

Measured there: audio turn to transcript 1.6–2.0 s; Fish first byte
0.2–1.4 s after a sentence is ready.

**Credentials:** `~/manogames/mano-games/apps/library/.env.local` has
`GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` (Vertex), `GEMINI_MODEL`,
`FISH_AUDIO_API_KEY` and the Fish voice IDs. ADC is logged in (checked).
Node 24, ffmpeg and sox are installed.

**Gotcha:** Fish bills API credit separately from platform credit. Without API
credit every paid model returns 402, so default to `s2.1-pro-free`.

## 3. Architecture

```
 caller (car Bluetooth)                         dev: browser mic
        │  phone call                                  │
 ┌──────▼──────────────┐                     ┌─────────▼─────────┐
 │ Dial Self-Hosted    │  l16 16 kHz         │ AudioWorklet 16k  │
 │ (WebSocket)         │                     │ (WebSocket)       │
 └──────┬──────────────┘                     └─────────┬─────────┘
        └──────────────────┬───────────────────────────┘
                           ▼   transports: audio frames in/out
 ┌──────────────────────────────────────────────────────────────┐
 │ VOICE ENGINE (transport-agnostic)                            │
 │                                                              │
 │  VAD/endpointing ─► utterance WAV ─► FAST PATH (Gemini       │
 │  (noise floor,                       stream: HEARD + reply   │
 │   barge-in)                          sentences)              │
 │       ▲                                   │                  │
 │       │ stop playback                     ▼                  │
 │       │ on speech              Fish TTS per sentence ─► out  │
 │       │                                                      │
 │  filler clips ("Mhm", "Alles klar"), pre-synthesised         │
 │                                                              │
 │  SLOW PATH (async, after each turn): Gemini + JSON schema    │
 │  ─► update note, list missing fields ─► feeds next turn      │
 └───────────────────────────┬──────────────────────────────────┘
                             ▼
              skill: Termin-Notiz (prompt, schema, states)
                             ▼
              store: notes/*.json  ─►  downstream (section 8)
```

**Rule: the fast path speaks, the slow path writes.** Structured extraction
never sits between the caller and the next sound.

## 4. Voice engine design

- **Audio in.** Internal format is 16-bit mono PCM. Browser: 16 kHz from an
  AudioWorklet. Phone: Dial streams `l16_16000` (16-bit PCM, 16 kHz), the same
  format, so there is no codec work. Utterances go to Gemini as WAV.
- **Endpointing.** Energy VAD on 20 ms frames with an adaptive noise floor (car
  noise). Speech starts after about 200 ms above threshold. The end-of-speech
  silence depends on state: about **1.2 s while he is dictating** (lets him
  think mid-sentence) and about 0.6 s for yes/no confirmations.
- **Fast path.** One `streamGenerateContent` call per turn. Inputs: the skill
  prompt, earlier turns as text, the current note JSON, the missing fields, and
  the utterance audio. Output: `HEARD:` then plain spoken sentences. Thinking
  budget 0.
- **Slow path.** After each turn, a separate Gemini call with `responseSchema`
  over the transcript so far. Output: updated note plus `missing[]`. It also
  runs once more at hang-up as the final save.
- **TTS.** Fish per sentence (reuse `fish.mjs`). Browser gets mp3. Phone needs
  16 kHz PCM for Dial: request PCM/WAV from Fish and resample in-process, or via
  an ffmpeg/sox pipe. Verify which formats Fish returns in M4.
- **Latency masking.** At end of speech, play a cached filler clip at once
  ("Mhm", "Okay", "Alles klar", in the same Fish voice, synthesised at startup).
- **Barge-in.** Speech detected during playback stops it immediately (browser:
  stop audio; Dial: send a `clear` frame), aborts pending Fish clips, and
  starts the next turn.
- **Language.** Standard German with tile vocabulary in the prompt:
  Feinsteinzeug, Großformat, 60×120 ("sechzig mal hundertzwanzig"), Fuge,
  Fugenfarbe, Silikon, Abdichtung, Estrich, Gefälle, bodengleiche Dusche,
  Rinne, Sockel, Aufmaß, abschlagen, Quadratmeter.
- **Spoken style.** 1 to 2 short sentences, at most 2 follow-up questions per
  call, never ask him to look at a screen. On unclear audio say so and ask
  again; never invent details.
- **Metrics per turn.** Log end-of-speech → first audio, Gemini time to first
  sentence, Fish first byte, and cost.

### Latency budget (target)

| Step | Target |
|---|---|
| end of speech detected | 0.6–1.2 s (by state) |
| filler clip starts | < 0.3 s after endpoint |
| Gemini first sentence | ≤ 1.5 s |
| Fish first byte | ≤ 0.8 s (`latency: low`) |
| **real answer audible** | **≤ 2.5 s after endpoint** |

## 5. Skill: Termin-Notiz

**States:** `greet → dictate → follow_up (≤2) → read_back → confirm → saved`.
A correction in `confirm` goes back to `read_back`. Recall mode is chosen by
intent in the first utterance ("ich fahr zu…", "was war bei…").

**Note schema:**

```json
{
  "kunde":      { "name": "", "telefon": "" },
  "baustelle":  { "adresse": "", "ort": "" },
  "termin":     "2026-10-11",
  "arbeiten":   [{ "raum": "Bad", "bereich": "Boden|Wand",
                   "flaeche_m2": 8, "fliese": { "format": "60x120",
                   "material": "", "optik": "Beton", "beschaffung": "Handwerker|Kunde" } }],
  "untergrund": "",
  "sonderwuensche": [],
  "zeitrahmen": "",
  "budget": "",
  "naechste_schritte": [{ "was": "Angebot schicken", "bis": "Freitag" }],
  "offene_fragen": [],
  "transcript": [],
  "created_at": ""
}
```

**Required to save** (these drive the follow-ups): customer or location, the
work to do, and the next step. Everything else is captured if said and never
asked for.

**Recall:** fuzzy-match the customer name or town against saved notes. Speak
who and where, what was agreed, and open points or next steps, in under 30 s.
End with "Soll ich noch was vorlesen?"

## 6. Code layout

```
speedhacks/
  .env                     # keys copied from mano-games (gitignored)
  package.json             # type: module; only dependency: ws (WebSocket server)
  server.ts               # HTTP + WS: /dev (browser), /dial/:call_id (Dial audio WS), /notes
  src/engine/
    session.mjs            # turn loop, states, barge-in
    vad.mjs                # energy VAD, adaptive floor, state-based endpointing
    audio.mjs              # PCM framing, WAV wrap, resample (μ-law only for a Twilio fallback)
    gemini.mjs             # fast path (stream) + slow path (schema)  ← buddy-lab
    reply.mjs              # HEARD/sentence parser                   ← buddy-lab
    fish.mjs               # streamed TTS + filler cache              ← buddy-lab
    cost.mjs               #                                         ← buddy-lab
  src/skills/termin-notiz.ts   # prompt, schema, required fields, recall
  src/transports/browser.ts  dial.mjs   # dial.mjs: signature check, call_connected, media, mark/clear, ping_pong, end_call
  src/store/notes.ts      # notes/*.json
  web/dev.html             # hands-free test client (mic, VAD meter, transcript)
  web/notes.html           # read-only notes view for the demo screen
  test/                    # node --test, plus audio fixtures
```

## 7. Milestones

| # | Milestone | Done when | Est. |
|---|---|---|---|
| M0 | Setup | `.env` copied, Vertex and Fish calls succeed from a smoke script, German Fish voice picked | 0.5 h |
| M1 | Engine, push-to-talk, browser | Port buddy-lab into `src/engine`, German prompt, speak and hear an answer in the browser | 2 h |
| M2 | Termin-Notiz skill | Follow-ups, read-back, confirm, `notes/*.json` written; slow-path extraction | 3 h |
| M3 | Hands-free | VAD with state-based endpointing, filler clips, barge-in; no button | 2 h |
| M4 | Phone | Dial US number → Self-Hosted audio WS (`l16_16000`) → same engine; barge-in via `clear` | 2–3 h |
| M5 | Recall | "Ich fahr zu Müller" → briefing from saved notes | 1 h |
| M6 | Demo polish | `notes.html` on the projector, latency log, 3 rehearsed calls | 1 h |

M1–M3 need nothing new. M4 needs Dial Self-Hosted access, which must be
**requested today** because approval time is unknown (section 11). Until then,
`dev.html` in hands-free mode is the demo fallback.

## 8. Downstream (not now)

- **Baustellenbeschreibung:** turn the note into a site brief for employees,
  sent as WhatsApp text or a voice message.
- **Angebot:** a first quote draft from the note's areas and tile choices.
- **Kalender:** a shared crew calendar, created from "nächste Schritte".
- **Stundenzettel:** timesheets from a daily voice check-out.
- **Voice clone:** "a KI that answers all questions" in the boss's voice (Fish
  cloning), for employees calling in.
- **Notes view, search and export.**

## 9. Testing

- **Fixtures without a tiler:** write 10 German debrief scripts, synthesise
  them with Fish in 2–3 voices, then mix in car noise with sox
  (`sox -m speech.wav car.wav out.wav`). Some scripts deliberately omit
  required fields.
- **Offline runner:** feed fixtures through the engine and score extraction
  per field against the expected JSON. Check that follow-ups ask for exactly
  the missing required fields.
- **Unit tests** (`node --test`): VAD endpointing on fixture audio, Dial frame
  codec and signature check, reply parser, recall matching.
- **Real-world check:** one call from an actual car before the demo, plus a
  voice-note round with the tiler (he offered to send more use cases).

**Success criteria:**

- Real answer ≤ 2.5 s after end of speech; filler < 0.3 s.
- Required fields correct in ≥ 9 of 10 fixtures, including the noisy ones.
- Whole capture call under 3 minutes with zero screen touches.
- Recall briefing under 30 s.

## 10. Risks and open questions

| Risk | Mitigation |
|---|---|
| **Dial Self-Hosted access not granted in time** (approval required; turnaround unknown) | Request today. Plan B: Twilio Media Streams. Plan C: Dial's managed agent plus post-call transcript extraction (section 11) |
| **Dial numbers are US-only** | Fine for the demo; the tiler would make an international call. German number via Twilio Media Streams in IE1 (section 12) |
| Fish paid models return 402 without API credit | Default `s2.1-pro-free`; top up API credit for `latency: low` models if needed |
| Phone latency feels slow | Filler clips, Fish `latency: low` and its WebSocket streaming; spike the Gemini Live API (audio in, text out, built-in VAD) as an upgrade |
| Car noise or dialect hurts recognition | Noisy fixtures; on unclear audio the assistant asks again; read-back catches errors |
| Customer data goes to Google, Fish and Twilio (GDPR) | Demo with fictional customers; DPA with each before real use |
| Driving safety | Short turns, no screen prompts, at most 2 questions, he can hang up anytime and the note still saves |

**Open questions for the team:**

1. **Telephony:** OK to go with Dial (US number) and request Self-Hosted access
   today? Is a Twilio account available as Plan B?
2. **Voice:** which Fish voice? Use an existing ID or clone one (the tiler
   joked about cloning)?
3. **Hackathon timeline:** how many hours until the demo? That sets whether M4
   or M5 comes first.

## 11. Telephony: Dial (getdial.ai)

Dial gives an agent its own phone number (voice, SMS, WhatsApp). Its
**Self-Hosted audio mode** lets us keep our own voice stack:

- **Dial calls us.** For each call it opens `wss://<our-url>/<call_id>`. We need
  a public `wss://` URL (ngrok or cloudflared in dev).
- **Auth.** The header `X-Dial-Signature: t=…,v1=…` is HMAC-SHA256 over
  `<t>.<call_id>` with our signing secret. The SDK (`@getdial/sdk`) has a
  server helper for verification, the frame codec and keepalive.
- **Audio.** Choose `l16_16000`, mono 16-bit PCM, which is our internal format.
  Caller audio arrives in about 20 ms frames as base64 inside `media` frames.
  We send audio back in any chunking; Dial paces playback.
- **Messages.** Dial → us: `call_connected`, `media`, `dtmf`, `mark`,
  `duration_warning`, `call_ended`. Us → Dial: `media`, `clear` (barge-in),
  `mark` (playback checkpoints), `end_call`. Both directions: `ping_pong`
  (echo pings about every 2 s).
- **Resilience.** If the socket drops, the call stays up and Dial reconnects
  with `reconnect: true` for about 15 s, so session state is keyed by `call_id`.

**Constraints:**

- Self-Hosted needs **access approval**: `POST /v1/self-hosted` with
  `{"action":"request_access","useCase":…,"companyUrl":…}`. `save` and
  `activate` return 403 until it is granted.
- It is **account-wide**: once active, all calls on the account route to our
  server.
- **US numbers only** for now.
- Free tier: $5 credit, calls capped at 5 min and 2 at a time until the first
  top-up. Then $3 per number per month plus per-minute usage.

**Setup:**

```bash
# 1. today: request access
curl -X POST https://api.getdial.ai/v1/self-hosted -H "Authorization: Bearer $DIAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"request_access","useCase":"Voice-first assistant for tradespeople: German phone debriefs after customer appointments, own STT/LLM (Gemini) and TTS (Fish Audio)","companyUrl":"…"}'
# 2. buy a number
dial number purchase --explicit-programmatic-consent "…" --json
# 3. once granted
curl -X POST https://api.getdial.ai/v1/self-hosted -H "Authorization: Bearer $DIAL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"activate","config":{"type":"audio","wsUrl":"wss://<tunnel>/dial"}}'
```

Set the audio format to `l16_16000` in the config. Check the exact field name
in the `self-hosted` REST reference.

**If access hasn't come through by demo time:**

- **Plan B: Twilio Media Streams.** Same engine; μ-law 8 kHz in `audio.mjs`.
- **Plan C: Dial's managed agent.** A number with a German `inboundInstruction`
  and `inboundLanguage: de-DE`. After hang-up, the `call.transcribed` event
  feeds our slow-path extraction, which saves the note. It's a working phone
  demo, but without our voice (Fish) or our turn-taking.

**Downstream on the same number:**

- SMS and WhatsApp the confirmed note to the tiler.
- Send the Baustellenbeschreibung to employees.
- Outbound AI calls later, e.g. confirming the appointment with the customer.

## 12. German number and scaling: Twilio (2026-10-12)

Dial sells US numbers only. For Germany and other countries we use **Twilio
Media Streams in Twilio's Ireland region (IE1)**. Twilio sits behind a carrier
adapter, so Telnyx or Dial can be added later or used as a fallback.

**Why Twilio:**

- Larger and publicly listed, with a mature process for German number
  paperwork. Most voice-AI frameworks ship a Twilio integration.
- Media Streams run in IE1 (Dublin): low latency to Fly `fra`, and the audio
  stays in the EU. The account and the number must be homed in IE1.
- Cost: local number $1.35/month; inbound $0.0100/min plus Media Streams
  $0.0044/min = **$0.0144/min**.
- Trade-off: Media Streams are μ-law 8 kHz only. Telnyx can stream 16 kHz L16,
  but only Telnyx's own marketing claims the wideband audio survives the phone
  network from a German mobile. Settle it with a $2 test: one number on each
  carrier, ten calls from a German mobile, compare the transcripts.

**Carriers compared:**

| Carrier | Number | Per minute (inbound + stream) | Notes |
|---|---|---|---|
| **Twilio** (chosen) | $1.35/mo | $0.0144 | μ-law 8 kHz; IE1 region |
| Telnyx | $1/mo | ≈ $0.0055–0.0087 | L16 16 kHz via Call Control (not TeXML); Frankfurt endpoint. Reviews flag strict account checks, suspensions and slow support. FCC proposed a $4.5M fine in 2025 (contested). Incidents in 2026, including a reported audio degradation |
| easybell SIP trunk | €1.95/mo | probably free inbound | Needs our own SIP-to-WebSocket bridge (Asterisk or FreeSWITCH); not worth running |
| Dial | $3/mo | not published | US numbers only |

**One number per country, not per customer.** The caller is our user, the
tradesperson, so every user in a country dials the same number. His caller ID
(his mobile) identifies the account. Caller ID can be spoofed, so ask for a
short PIN when it is unknown or withheld, and before sensitive actions. The
number costs about $1/month per country whatever the user count, and the German
paperwork happens once, for our company. A company gets its own local number
only when its customers should call in, or outbound calls should show its
number; that number is registered with the company's Gewerbeanmeldung and
billed to it.

**Regulatory (Germany):** a local number needs a business address inside the
number's area code, proven by a Handelsregisterauszug or Gewerbeanmeldung. No
P.O. boxes, and not available to individuals. It takes days, so start early.
Each new country has its own rules. Austria and Switzerland come first; the
greeting already picks German for +43 and +41.

**Not on this number:** SMS. German landline numbers generally can't send or
receive SMS, and a German mobile number on Twilio costs $30/month. Send the
note by alphanumeric sender ID or WhatsApp instead.

**Build:**

1. Twilio account and number in IE1. Check Twilio's list of Voice features that
   are unavailable in IE1.
2. A Twilio adapter beside the Dial handler in `server.ts`: a TwiML
   `<Connect><Stream>` webhook; μ-law 8 kHz ↔ 16 kHz PCM (`resample` in
   `audio.mjs` exists); Twilio's `start`/`media`/`mark`/`clear`/`stop` events
   mapped to the session.
3. Per-company data, keyed by the caller-ID lookup.

**The phone isn't the scaling limit.** Data is JSON on one Fly volume and
memory is one shared store, so today the server can serve one company from one
machine. Before onboarding many companies: per-company data and a real database.

Sources: [Twilio Voice pricing DE](https://www.twilio.com/en-us/voice/pricing/de),
[Twilio DE regulatory](https://www.twilio.com/en-us/guidelines/de/regulatory),
[Media Streams in IE1](https://www.twilio.com/en-us/changelog/media-streams-available-in-ie1-and-au1),
[Telnyx Voice API pricing](https://telnyx.com/pricing/voice-api),
[Telnyx streaming codecs](https://developers.telnyx.com/api-reference/call-commands/streaming-start),
[FCC fine](https://broadbandbreakfast.com/telnyx-calls-fccs-4-5-million-penalty-mistaken/),
[easybell SIP trunks](https://www.easybell.de/business/sip-trunks/).

## 13. Unit economics and pricing (2026-10-12)

**Cost per call minute**, measured by the cost meter on 26 test calls in
`data/calls/` (about 1.2 min each, almost no memory), plus Twilio:

| Engine | AI | Phone | Total |
|---|---|---|---|
| Gemini + Fish | $0.036 | $0.014 | **≈ $0.05/min** |
| Gemini Live | $0.060 | $0.014 | **≈ $0.075/min** |

Fish is counted at the paid rate ($15 per 1M bytes), although
`s2.1-pro-free` bills $0 today. The Gemini 3.5 Flash prices ($1.50 in, $9.00
out per 1M tokens) come from aggregators and aren't yet confirmed on Google's
page.

**Cost per tradesperson per month.** There are no real users yet, so usage is
assumed. Typical means 3 debriefs, 1 briefing and 1 office call per working
day, about 2 minutes each.

| Usage | Minutes/month | Gemini + Fish | Gemini Live |
|---|---|---|---|
| Light | ~60 | $3 | $4.50 |
| Typical | ~200 | **$10** | **$15** |
| Heavy | ~400 | $20 | $30 |

Real prompts carry up to 25 customers' notes, so budget 1.5× until measured.
The shared number and hosting add a few dollars a month in total.

**Price: about €69/month net, 300 minutes included, per-minute beyond.**

- Typical use on Live costs €13–20, a 70–80% gross margin. The minute cap
  protects against heavy users.
- Comparable trades software: Craftnote €15–50 per user per month, Plancraft
  about €29–48, HERO from €69. Sell it on saved office time: at €50–70 an hour,
  it pays for itself with one saved hour a month.
- €49 only works on Gemini + Fish.

**Cut costs before fixing the price:**

- Note extraction re-runs after every agent turn (`refreshNote` in
  `session.mjs` and `live-session.mjs`) and is about 40% of the AI cost.
  Running it once at the end, or on a cheaper model, cuts the AI cost by about
  a third.
- Gemini context caching: $0.15 instead of $1.50 per 1M tokens for the prompt
  parts repeated every turn, mostly the memory.
- Live costs about 1.7× the cascade. Use one engine for everyone, or put Live in
  a higher tier.

**Next:** a month of real use from pilot users replaces the usage assumption.

Sources: [Craftnote pricing](https://omr.com/de/reviews/product/craftnote/pricing),
[Plancraft](https://trusted.de/plancraft-kosten),
[HERO](https://trusted.de/hero-kosten),
[Gemini 3.5 Flash pricing (aggregator)](https://evolink.ai/blog/gemini-3-5-flash-pricing-guide).

## 14. Pilot week with Niko, Konstanz: discovery framework (2026-10-12)

After the hackathon: one real user, Niko in Konstanz, for one week. The goal is
to understand his situation. For the product only note-taking matters; on top,
the notebook works as a field researcher.

**Method, consultant style:**

1. **Key question:** where does he lose time, money or nerves between inquiry
   and paid invoice, and which part of that can be done by a call from the car?
2. **Issue tree:** seven areas, along the job from inquiry to payment plus
   context and wrap-up: Betrieb und Rolle → Anfragen und Kundentermine →
   Angebote → Ausführung, Material und Team → Rechnung und Geld → Werkzeuge,
   Büro und Zeit → Abschluss und Prioritäten.
3. **Hypotheses H1–H6**, each tied to an area. Every finding is tagged as
   evidence for or against one, or none.
4. **Questions** per area, each with one follow-up for vague answers. They
   follow The Mom Test: what he did last time, not what he would do; numbers
   (minutes, euros, how often); never pitch the notebook or ask if he'd pay.
5. **Evidence:** each finding is a fact, a number, a story or an opinion, with
   his own words as the quote. What he does (when and how often he calls)
   counts more than what he says.
6. **Synthesis:** at the end of the week, a report per area and hypothesis,
   plus an executive summary.

**In the call:**

- Notes come first. The research question comes only at the end: after he
  confirmed the summary, or after a briefing.
- At most one question per call, plus one follow-up if the answer is vague. At
  most three calls a day with a question. "Keine Zeit" ends the call at once.
- First call: the notebook introduces itself and the week, says his answers go
  to Max, and asks the Betrieb questions if he has two minutes.
- Order: Betrieb first; then the area with the fewest findings; Abschluss from
  day 5 (check the picture with him, rank the pains, ask what annoyed him about
  the notebook). A question that wasn't answered comes back once, on another day.
- It links the question to what he just said when it can. What he mentions in
  passing while dictating ("das Angebot mach ich heute Abend") is a finding too.

**Code:**

- `config/discovery.json`: participant, key question, hypotheses, areas and
  questions. Edit the framework there, no code change.
- `src/skills/pilot.ts`: note-taking for any trade, job D (research) in the
  prompt, findings in the consolidation step after the call.
- `src/store/discovery.ts`: findings, question state, call log; picks the
  question for each call.
- `SKILL=pilot` is the default; `SKILL=office` brings back the order demo.
- `npm run report` writes `data/discovery/report.md`; `-- --synthesize` adds the
  executive summary, `-- --from +49…` keeps only his calls. `/api/discovery` has
  the raw data.

**Tested with scripted calls (2026-10-12):** a first call went note → intro →
b1 plus its follow-up, and filed three findings; b2 and b3 were marked answered
from what he said unprompted. A briefing call asked b4. An answer to a
different question than the one asked was filed under the right one (q1, as
evidence for H2). A briefing no longer saves a duplicate note.

**Before the week starts:**

- **Phone number:** see section 12. Dial is US-only and the Twilio adapter isn't
  built yet.
- **Consent:** his calls carry his customers' names and addresses. A short
  written agreement with Niko (what's stored, who reads it, deleted after the
  pilot); DPAs with Google and Fish; `RECORD_CALLS` off.
- **Clean start:** reset the data so test calls don't count, or use `--from`.

## 15. v2 architecture (2026-10-12)

Templates and primitives, pluggable languages, memory on Supabase Postgres,
admin requests ("call Niko and find out X"), outbound calls. The full plan, with
decisions and phases, is in `docs/v2-architecture.md`. Phase 1 (locale packs,
English data keys, regression calls), phase 2 (native tool calls: `order_execute`,
`memory_search`, one tool registry for both engines) and phase 3 (personas, templates,
primitives, a per-call agenda; "find out X" via `POST /api/objectives`) are done. Phase 4
(memory on Postgres: per user, budgeted context, search, `MEMORY_BACKEND=json|pg`) is built
and tested on PGlite; Supabase itself is still to be connected. Phase 5 (the admin page at
`/admin`: "Frag Niko, …" → plan → card → approve → his answer) is done. Phase 6 (Twilio for
the German number, and calls the assistant makes, with consent, call times and retries) is
built and tested without a Twilio account. Phase 7 (Smart Turn v3 turn detection, and Max's
own phone line to set and approve requests) is done.

## 16. Status (2026-10-11)

Done and tested locally (browser test phone and scripted fake-Dial calls):

- **M0–M3:** engine, Termin-Notiz skill, hands-free VAD with state-based
  endpointing, fillers, barge-in, idle nudges ("Bist du noch dran?").
- **M5:** briefing before the next visit.
- **One protocol everywhere:** the server speaks Dial's self-hosted audio
  protocol. `web/index.html` and `scripts/fake-dial.ts` both pretend to be Dial.
- **Model:** `gemini-3.5-flash` on Vertex global with `thinkingLevel: MINIMAL`.
  Measured: Gemini first token 1.5–2.1 s, first audio 2.4–3.2 s after end of
  speech, filler at 0.7 s. The token and the model are warmed at startup and on
  `call_connected`.
- **Unit tests:** `npm test` (reply parser, VAD), 8 passing.

Not yet verified against real Dial (no API key or access yet):

- **M4:** signature check, `l16_16000` formats, `mark`/`clear` pacing and
  reconnects are implemented from the docs but untested on a live call.
- **Deploy:** `fly.toml` and `Dockerfile` are ready but not deployed. The server
  needs Gemini auth via `GOOGLE_SERVICE_ACCOUNT_JSON` (Vertex) or AI Studio.

**Update: German and English.** Gemini writes a `LANG:` header each turn and the
session follows it (fillers, cached lines, Fish voice). The greeting language
comes from Dial's `language` or the caller's country code. Tested: an English
capture call, and a German briefing that switched to English mid-call.

**Update: memory, cost and UI.** After every call a consolidation step
updates `data/memory/`: customers (rolling summary and history), to-dos (due
date, open/done) and a call summary. The next call's prompt starts with it.
Tested: "Was steht an?" read the three most urgent to-dos; "Angebot Müller ist
raus" ticked one off. Per-call cost metering covers Gemini tokens by step, Fish
bytes and minutes; a 3-turn call is about $0.03. The phone (orb with state glow,
transcript/note/memory/cost tabs) and the monitor were redesigned.
