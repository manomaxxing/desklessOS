# DesklessOS

Voice-first assistant for tradespeople. A tiler calls from the car after a
customer appointment, talks, and gets a structured note ("Termin-Notiz").
Before the next visit he calls again and gets a 30-second briefing. No screen.

Stack: **Gemini** (hears and answers in one streamed call) + **Fish Audio**
(voice) + **Twilio** (German number, EU) and **Dial** (US number) for the phone line,
**Postgres** (Supabase, EU) for everything that's kept, on **Google Cloud Run**.

**German and English**, one file each in `locales/` (see Languages below). The
greeting language comes from Dial's `language`, else the caller's country code,
else the skill's default. After that it answers in whatever language the caller
last spoke, switching mid-call if he does.
Design, scaling and the audit behind it: `docs/architecture.md`. The why and the
roadmap: `PLAN.md`.

## Languages

Everything language-specific lives in a locale pack, `locales/<id>.json`: the
BCP-47 tag, phone country codes, the Fish voice, the turn-taking word lists (words
no sentence ends on, "Moment"-style hold phrases, fillers), and each persona's
spoken lines (greeting, fillers, "sorry, say again") and the example phrases its
prompt quotes. Prompts are
English; the model speaks the caller's language. Code outside `src/locale/` never
names a language (a test enforces it).

- **Add a language:** copy `locales/en.json` to `locales/<id>.json`, translate it,
  pick a Fish voice, then `npm run locale:check` (every key the default pack has
  must exist). `LANGS=de,en,<id>` limits which packs are live; `DEFAULT_LANG` sets
  the fallback.
- **Voices:** the pack's `voices.fish`; `FISH_VOICE_<ID>` overrides it, and
  `FISH_VOICE` still overrides the default language's.
- **Data:** notes use English keys (`customer_name`, `work`, `next_steps`,
  `summary`, …) with values in the spoken language and a `lang` field. Notes from
  before v2 had German keys; `scripts/migrate-json-to-pg.mjs` renames them on the way in.

## Skills, personas and templates

The agent is the **notebook** for the pilot week with one tradesperson: notes and
briefings for any trade. At the end of a call it may ask one research question from the
discovery framework in `config/discovery.json`; after the call, what he said about how he
works is filed as findings. `npm run report` (`-- --synthesize` for an executive summary)
writes `pilot-report.md`. Method and rules: `PLAN.md` section 14. Max's own line by phone
is a second persona (below).

A skill is a persona plus templates, no code of its own (`src/skills/from-templates.mjs`):

- **Persona** (`personas/notebook.md`, `personas/admin.md`): who the agent is and
  how it sounds, in English, with `{{ex.*}}` slots filled from the locale pack.
- **Templates** (`templates/*.json`): *capabilities* are what he can start (take a
  note, a briefing, the agenda); *objectives* are what the agent brings
  (the pilot's research, "find out X"). Each lists steps made of primitives
  (`src/agenda/primitives.mjs`: capture, inform, ask, research), its tools and
  for capabilities the note fields.
- **Agenda** (`src/agenda/agenda.mjs`): per call, the persona's capabilities plus at
  most two of the agent's own items, always after his business. It writes the prompt
  (static first, so the prefix caches), one extraction schema for his note and the
  objectives' answers, and checks in code after every turn which objective is done.

**Quotes, during the call** (`src/tools/quote.mjs`, `src/quotes/`): when he has described a job
and confirmed Toni's summary, Toni offers to send it as a quote ("Soll ich dir das als Angebot auf
WhatsApp schicken?"). On his yes, the `quote_send` tool turns the line items into a quote (quantity,
unit, a net price only where he said one; totals and VAT in code), makes the A4 PDF (pdf-lib, the
locale pack's `documents.quote` texts, so English or any new language is a pack) and sends it into
his WhatsApp chat while he's still on the line: free, because his call opened the chat window.
It's offered on WhatsApp calls only (on the online test phone it's saved for the dashboard).
Without his business details (People → his card → "Business details for quotes": name, address,
phone, email, VAT no., VAT %, currency) it's an "Angebotsentwurf"; with them, his letterhead.
Each quote is numbered per business and year (2026-001), kept as data (`quotes`), and linked on
the call's page, where its PDF is made again on demand.

**Calls, on the admin page:** `/admin` opens on the calls, newest first (live ones with a red
dot). A call has two tabs. **Summary** (`src/calls/recap.mjs`, written by the after-call job,
in the call's language): the gist in a box, the topics with their points and his own words,
action items (who, by when), and open questions worth asking next time. **Transcript**: who
said what. The copy button copies the open tab as Markdown; the download button saves both
as one `.md` file. A call that ended before summaries existed gets a "Write the summary" button
(`POST /api/calls/:id/recap`), and "Write it again" redoes one.

**Find out X, from the admin page:** `/admin`. Type what you want to know ("Frag Niko,
wie lange sein letztes Angebot gedauert hat"). A planner (`src/admin/planner.mjs`, Gemini
with thinking, a few seconds) picks the user and writes 1 to 5 questions in their language
into an `inquiry` objective; it never writes rules for the agent. You get a card: who, when,
the questions (editable), anything it needs to ask you back. **Approve** binds to exactly that
card (a token signed over the request and the plan's hash, 30 minutes); editing or re-planning
makes a new card. The question is asked at the end of their next call, after their own
business; the card then shows the answer, their words and a link to the call.
Results also go out by webhook (`NOTIFY_WEBHOOK_URL`) and/or email (`RESEND_API_KEY`,
`NOTIFY_EMAIL_TO`), with `PUBLIC_URL` for the link back; each message is a job, retried
until it goes through.

- **Login, for the team** (`src/admin/team.mjs`): everyone has their own email and password.
  An owner invites someone under People → "Who can log in here" and sends them the link
  (`/admin#invite=…`, works once, for 7 days); they choose their name and password on it.
  A new link for someone already on the team resets their password. Owners invite and
  remove people; members do everything else. Removing someone, or a new password, logs them
  out at once (each request checks the session against the `members` table, cached 30 s).
  Passwords are scrypt hashes; sessions are an HttpOnly, SameSite=Lax cookie signed with
  `SESSION_SECRET`, valid for 30 days.
- **The owner's code:** `ADMIN_CODE` (leave the email empty) plus, if `ADMIN_TOTP_SECRET` is
  set, a code from an authenticator app (`npm run admin:totp` makes a secret); 12-hour
  sessions, and a new `ADMIN_CODE` ends them. It's the way in to invite the first people,
  and a spare key. Five wrong tries lock an address for 15 minutes. With `ADMIN_CODE` or
  `DEV_TOKEN` set, the API needs one of them; on Cloud Run the server won't start without either.
- **API** (admin session): `POST /api/requests {instruction}` → `{request, confirmToken}`;
  `POST /api/requests/:id/revise {answer | edits}`; `POST /api/requests/:id/approve
  {confirmToken}`; `POST /api/requests/:id/cancel`; `GET /api/requests[/:id]`; `GET /api/users`.

**Talk with him about his day** (problem discovery, `templates/discovery.day.json`): on the admin
page, "Talk with him about his day" plans a card you approve. Toni then has a relaxed conversation
with him:
- **Opener by his time of day:** yesterday or what's on today in the early morning, how today is
  going during the day, how it went in the evening.
- **Mostly listening:** only now and then one light Mom-Test follow-up about something that went
  wrong (when, how he handled it, what it cost).
- **Ideas and feedback:** when he brings one up, Toni asks about the problem behind it (the last
  time, how often, what it costs today, how he handles it now). It promises nothing and doesn't pitch.
- **Picking up:** if his drive ends mid-conversation, the next call continues from there. It sees
  where the last one stopped.
- **The result:** the card collects his day, the stories and the ideas, in his words.

Toni calls him once Twilio is set up; until then it happens in his next call.

**By phone:** calls from `ADMIN_PHONE` (E.164, comma-separated) reach Max's own line
(`personas/admin.md`): "Frag Niko, …" drafts the same request and reads the card back;
approving it, and hearing what came back, need `ADMIN_PIN` (said on the call; three wrong
tries and that call can't approve). Without a PIN it only drafts, and the card waits on the
admin page. Nothing from these calls goes into anyone's memory.

**Objectives directly:** post an objective and the next inbound call asks it at the end:

```
curl -X POST "localhost:8787/api/objectives?token=$DEV_TOKEN" -d '{"template": "inquiry",
  "params": {"purpose": "how long quotes take", "questions": [{"ask": "Wie lange hast du an deinem
  letzten Angebot gesessen?", "probe": "Ungefähr reicht."}]}}'
curl "localhost:8787/api/objectives?token=$DEV_TOKEN"      # status, answers, his words, calls
```

1 to 5 questions; a vague answer gets one follow-up. Answers add up across calls; after
three calls without getting to it the objective expires. `POST /api/objectives/<id>/cancel`
withdraws one. Stored in Postgres (`objectives`).

## Tools

The model calls tools natively (Gemini function calling, `src/tools/`):

- `memory_search`: offered only when memory holds more than the prompt shows; finds
  a customer by a sound-alike name, place or topic.
- On Max's own line: `request_create`, `request_approve` (needs the PIN), `request_status`
  (`src/tools/admin.mjs`).

The model hangs up through its header (`NEXT: hangup`), not a tool.

A turn makes at most two model calls: the answer that calls the tool, then a
follow-up with the result. He hears something first: the model's own "On it."
(the prompt asks for header and preface before the call), or a cached `working` /
`looking` line from the locale pack, then typing until the result is spoken.
Writes wait until the false-start window has passed, run at most once per call and
input (idempotency key), and are never aborted once started. A template lists the
tools it may use; a call offers only those.

## Regression calls

`npm run regress` starts a server per folder on a scratch data dir (memory in PGlite there)
and plays the scripted calls in `test/calls/<folder>/*.json` (German capture with a thinking
pause, briefing, agenda, false start; Max's question, his own line, outbound calls, a call
over the Twilio path), checking what each must and should produce, and printing first-audio
latency. A folder's `_seed/` is old-style JSON memory, moved in through
`scripts/migrate-json-to-pg.mjs` (`pilot+memory`: 30 customers, a briefing that needs
`memory_search`). Run it before every merge; `npm test` stays offline (PGlite, Gemini stubbed).

## One protocol, several ways to call

Inside, every call speaks Dial's self-hosted audio protocol (`call_connected`,
`media`, `mark`, `clear`, `end_call`, `ping_pong`; 16 kHz PCM). Carriers come in
through adapters (`src/telephony/`) that translate their protocol into it; the
call host (`host.mjs`) keeps the calls, whichever line they came in on.

| Caller | How | Use it for |
|---|---|---|
| **Browser** | `npm run dev` → http://localhost:8787 → "Anrufen" | Talking to it yourself (Chrome, headphones) |
| **Fake Dial** | `npm run fake-dial -- --say "…" --say "…"` | Scripted calls, no mic needed; caller voice via Fish |
| **Dial** | real phone call → `wss://<public-host>/dial/<call_id>` | US numbers |
| **Twilio** | the number's voice webhook → `POST /twilio/voice` → media stream `wss://<public-host>/twilio/stream` | The German number (region IE1), and calls we make |
| **WhatsApp** | Meta's webhook → `POST /whatsapp/webhook` → WebRTC (Opus) | He calls the business number in WhatsApp (free); runs on its own service |
| **Fake carrier** | `OUTBOUND=fake`, then `npm run fake-dial -- --answer +49…` | Being called by the server, in tests |

**Twilio:** set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_NUMBER` (E.164),
`PUBLIC_URL` (https://…), and for the EU `TWILIO_REGION=ie1` `TWILIO_EDGE=dublin`; point
the number's "A call comes in" webhook at `https://<public-host>/twilio/voice` (POST).
Every webhook's `X-Twilio-Signature` is checked; the media stream must present a token we
signed into the TwiML. Audio is μ-law 8 kHz on the line, converted at the edge. Calls are
wrapped up before `MAX_CALL_MIN` (15).

**WhatsApp:** a Meta app with the WhatsApp product (its test number works). Set
`WHATSAPP_TOKEN` (a system user's token), `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_ID`,
`WHATSAPP_APP_SECRET`; `deploy/cloudrun.sh` then deploys `desklessos-wa` (CPU always on: the
call audio is UDP, not a request), and `npm run whatsapp:setup -- <its url>/whatsapp/webhook`
registers the webhook and turns calling on. Webhooks are checked against the app secret.

## Calls we make (outbound)

When Max approves "Ruf Niko an und frag ihn …" (mode `outbound`, or `either`: whichever
comes first), the scheduler (`src/jobs/scheduler.mjs`, run by the background tick) makes one
errand per person and calls through `OUTBOUND` (`twilio` when configured, `fake` for tests,
`off`). Guards, checked against the person's row before every try:

- they **agreed to be called** (ticked on the admin page, dated), aren't **paused**, have a number;
  a job only ever dials a person, never a raw number;
- inside their **call times** in their time zone (default Mon–Fri 08:00–18:00), never while
  they're on a call (on any instance), at most `OUTBOUND_PER_DAY` (1) calls they actually took per day.

The call: the agent waits for "Hallo?" (or 1.5 s), says the persona's outbound greeting,
why it's calling, and asks for two minutes. Yes: the questions, then goodbye. Not now: it asks
when, and the errand comes back at that time (his wall clock). Doesn't want such calls: calls
to him are paused. A mailbox (Twilio's answering-machine detection, or 4 s of speech without
a pause) gets no message. No answer, busy or mailbox: retries after 30 min, 2 h, then the next
day's window; after the fourth try the question moves to his next own call, and Max is told.

## Modes

Two engines; phone calls use `ENGINE` (default `cascade`), the browser test phone picks per call
(top bar), and `npm run fake-dial -- --engine live …` scripts one:

| Engine | What happens | First audio (measured) |
|---|---|---|
| **Gemini + Fish** (`cascade`, `src/engine/session.mjs`) | Gemini hears his audio and writes the reply (`GEMINI_MODEL`); Fish speaks it sentence by sentence. Our own turn-taking (below) | ~2.2–3.4 s, masked by typing (`MASK`: `typing`, `filler`, `none`) |
| **Gemini Live** (`live`, `src/engine/live-session.mjs`) | Gemini's native audio model hears and speaks itself (`LIVE_MODEL`, `LIVE_VOICE`); its own silence detection and barge-in; hangs up with an `end_call` tool | ~1.2 s (2.4 s before a spoken summary) |

- **Live connections** (`npm run live-probe`): `vertex-eu:gemini-3.8-live` (default: audio stays
  in the EU, Vertex credits), `vertex@us-central1:…`, the 2.5 native-audio model in europe-west4.
- **If Live fails** (setup refused, socket drop) the call goes on with Gemini + Fish mid-call.
  Calls we make and Max's own line always run on Gemini + Fish.
- **Trade-off:** Live is faster and more natural, but has none of the turn-taking checks below
  (pausing mid-sentence, "Moment", false starts, Smart Turn): it cuts in after 0.8 s of silence.
- Both save the call as it goes and hand the note and memory to the after-call job.

## Conversation design

These follow published guidance from Pipecat, LiveKit, Vapi, Retell, OpenAI
Realtime and Google's Live best practices.

- **Acknowledgements:** one to three words, varied; no parroting (only a new name or place
  may be echoed, so he can correct it). At most one question per turn and two per call, only
  for missing essentials. One summary at the end, then "Passt das?", then "Noch was?".
- **Trust first** (what a first-time user must never meet):
  - **He ends the call, never Toni:** goodbye only after his goodbye, his "nein, das war's", or
    the second silence.
  - **One extra per call, at most:** Max's question, a new feature to mention, or one research
    question, never more, and always after his own business. On his first call: one question,
    and only if he says yes to it.
  - **No promise it can't keep:** a tool's instructions are in the prompt only on calls that have
    the tool; asked for something it can't do, Toni says so and offers to note it as a to-do.
  - **A plain yes, checked in code:** anything with consequences (a quote sent) runs only if his
    words say yes and nothing takes it back ("ja, aber…", "nee, warte"; `affirmed()`, word lists
    in the locale pack). Gemini sometimes answers such a turn with only the tool call and no
    transcript: then his audio is written down separately (`transcribe()`, Flash-Lite, ~1 s) and
    checked. A refused action comes back as "NOT DONE", and Toni must never claim otherwise.
  - **He knows it's an AI:** his first call's greeting says so ("…deine KI-Assistentin…", EU AI Act
    Art. 50); asked, Toni says so plainly.
  - **Unclear audio:** ask for just the missing piece, then offer a best guess, never three times
    in a row; a transcript that came back empty never gets the last answer repeated (a short
    "nicht angekommen, nochmal?" instead).
  - **New things one at a time:** what Toni does beyond notes, briefings and to-dos is switched on
    per person on the People card (`src/features.mjs`): the confirmed note into his WhatsApp
    chat after each WhatsApp call (laid out from the note's fields, never written by a model), and
    quotes. Toni mentions a newly switched-on one once, at the end of the next call (a
    `feature.intro` objective).
- **Turn-taking** (Gemini + Fish only; `src/engine/session.mjs`, `endpointing.mjs`):
  - A pause of 0.8 s ends his turn (0.6 s after a yes/no question, 1 s after an
    open one). The model answers `NEXT: wait` when he stopped mid-thought, and a
    word check overrides it when his words stop on "und", "die", "will" and the
    like. The agent then stays silent and keeps his audio.
  - If he stays quiet, a quiet "Mhm." 2.5 s after his last word says it's still
    listening; at 5 s it answers the whole thought as one turn. That answer is
    prepared right after the "wait" and held (no typing sound, no tool runs), so it
    plays at once; if he goes on, it's dropped unheard and his parts are answered
    together. "Moment", "warte mal" or "Sekunde" hold the floor for 15 s, without the "mhm".
  - The greeting needs 1.2 s of his speech to be cut off: a "Hallo?" said over it
    (people do, the moment the call connects) doesn't stop it.
  - The model marks its question as yes/no (`NEXT: confirm`, short wait, no
    mid-thought check) or open (`NEXT: ask`, he may pause while answering).
  - False starts: if he goes on talking within 1.5 s of the agent starting, a
    short burst (0.3 s) cuts it off, the reply is forgotten, and his two parts
    are answered as one.
  - **Smart Turn v3** (`TURN_DETECTOR=smart-turn`; `npm run smart-turn:fetch` for the 8 MB
    model, the optional dependency `onnxruntime-node`): when he stops, a small audio model
    (pipecat-ai/smart-turn-v3, BSD-2) hears from his voice whether he's done, in ~50–150 ms in a
    worker thread, while the model writes its answer. "Not done" keeps the agent silent, like
    "…die will"; without it, or if it's late, the word lists decide. Tested: finished German
    and English sentences 0.97–0.99, broken-off ones 0.01–0.07; but short closings ("Ja.",
    "Tschüss") also scored "not done", so it only counts on turns of 1.2 s or more that the model
    would answer by listening or asking. Off by default until checked on real recordings.
- **Interruptions:** otherwise half a second of loud speech is needed to cut the
  agent off, so a "mhm" doesn't count. History keeps only what the caller
  actually heard (marks); if the interjection was just "ja/genau", the agent
  finishes the part he missed. Bracketed stage directions ("[Silence]") are
  never spoken.
- **Testing pauses:** `npm run fake-dial -- --say "Die will [pause 5] ein neues Bad."`
  puts a thinking pause mid-line. `npm run report` counts pauses held, "mhm"s,
  holds and false starts per pilot week.
- **Failures:**
  - Gemini: hedged requests; if there's no first token after 2.2 s, the fallback
    model (`FALLBACK_MODEL`, default `gemini-3.5-flash-lite`; Vertex retires 2.5 Flash on
    2026-10-20) races it and the first to speak wins.
  - Voice: if Fish fails for a whole answer, a pre-rendered "sorry, say again" plays.
  - After the call: the final note and the memory step run as a job with a fallback
    model; a failed job is retried with backoff (1 min … 6 h), then shown on the admin page.
  - Memory down when a call starts: the call goes on without it.
  - Spoken: three pre-rendered "sorry, say again" lines per language; they own the glitch
    ("bei mir hat's gehakt"), never blame his line.

## Memory and cost

- **Storage:** Postgres only (`src/memory/pg.mjs`, schema in `src/db/migrations/`, applied
  on start). `DATABASE_URL` is Supabase (EU) in production; locally it defaults to PGlite
  (Postgres compiled to WebAssembly, in the process) at `data/pg`. Only one process can open
  that at a time.
- **Per user.** The caller ID picks the user (`users.phone_e164`); with one user every call
  is theirs (the pilot); an unknown caller among several users gets an empty memory and
  nothing is saved. The first start creates the org and user from the persona's profile.
- **The demo.** A user of its own (`users.demo`, its own org, made on the first start): the
  online test phone (no caller ID) and the number on its People card (Max's) reach it. Its
  calls are saved and summarised into its own memory; it gets no research questions, and no
  one else's memory gets these calls.
- **Budgeted context.** When the call connects, the MEMORY block is built once
  (`src/memory/context.mjs`, 2,500 tokens): what we know about him, up to 10 open to-dos,
  the 8 most relevant customers (recent, open to-dos, due soon) with their latest notes,
  then the next 40 by name. Everything else is for `memory_search`: sound-alike names
  (trigram) and notes and facts by meaning (embeddings, `text-multilingual-embedding-002`).
- **During the call** its transcript and latest note are saved after every turn, so an
  instance that dies loses nothing.
- **After the call** (`src/calls/after-call.mjs`), one job, queued in the transaction
  that ends the call:
  - the final note, saved (one per call);
  - Max's questions recorded and their requests closed;
  - an outbound call's outcome sent to the scheduler;
  - the memory step: customers get a rolling summary and call history, "Angebot bis Freitag"
    becomes a to-do, "Angebot Müller ist raus" ticks one off, research findings become facts
    tagged `area:` / `hyp:` / `stance:`;
  - the call's summary for the admin page (`calls.recap`).

  Each step does its work once however often the job runs.
- **Moving the pilot's old JSON data in:** `node scripts/migrate-json-to-pg.mjs --dry-run`,
  then with `DATABASE_URL` and `DATA_DIR` (the old data) set; re-runnable, checks the counts;
  `--embed` fills in the embeddings.
- **Cost per call** (`src/engine/cost.mjs`): Gemini tokens (text, audio,
  output) for the conversation, note extraction and memory step; Fish bytes
  (with what the paid tier would cost); call minutes (set `DIAL_USD_PER_MIN`).
  Shown live in the phone's Cost tab and per call in the monitor (the after-call
  job's share is added to the call). These are list-price estimates. Gemini 3.5
  Flash prices come from aggregators.
- **UI previews** for slides: `/?orb=speaking&tab=memory` (orb: `listening`,
  `thinking`, `speaking`; tab: `note`, `memory`, `cost`).

## Monitor (debugging)

http://localhost:8787/monitor shows **every** call (Twilio, Dial, browser, fake-dial),
live (on any instance) and past:

- **Timeline:** what Gemini heard and what the agent said. Each turn has ▶ play
  for the caller's audio exactly as the VAD cut it, and for the agent's audio
  exactly as Fish produced it.
- **Events:** fillers, barge-ins, silence nudges, Gemini retries, errors, note
  updates, save and hang-up.
- **Latency per turn:** first audio, Gemini first token, Fish first byte.
  Coloured: ≤2.5 s green, ≤4 s amber, worse red.
- **Note panel:** the structured note as it fills, plus raw JSON.
- **Connection log:** test-phone and Dial connections, rejected signatures,
  socket drops and reconnects.

Calls are kept in Postgres (`calls`: transcript, timeline, cost). Audio is recorded per
turn on the local disk when `RECORD_CALLS=1` (on in the local `.env`; local runs only).
On a public deploy the monitor and `/api/*` need `?token=<DEV_TOKEN>` or an admin login
(the cookie); the test phone needs `?token=<DEV_TOKEN>`. The admin page also lists background jobs that keep failing.

## Local

```bash
npm install
npm run smoke      # Gemini + Fish reachable? writes data/smoke.wav
npm run dev        # http://localhost:8787
npm test           # unit tests, offline (PGlite, Gemini stubbed)
npm run fake-dial -- \
  --say "Ich komm grad von der Frau Müller in Unterhaching, Bad komplett neu, acht Quadratmeter, sechzig mal hundertzwanzig Beton-Optik." \
  --say "Angebot bis Freitag." --say "Passt."
npm run fake-dial -- --lang en --say "Just came from Mrs Johnson, kitchen backsplash…" --say "Quote by Wednesday." --say "Yep."
```

Keys live in `.env` (copied from `mano-games/apps/library/.env.local`):
`GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION` (Vertex, ADC locally),
`GEMINI_MODEL` (default here `gemini-3.5-flash`), `FISH_AUDIO_API_KEY`,
`FISH_VOICE`, `FISH_MODEL` (`s2.1-pro-free` unless Fish API credit is topped up).
Memory lives in PGlite at `data/pg` (set `DATABASE_URL` for a real Postgres).

## On Dial

1. Put `DIAL_API_KEY` in `.env`.
2. Self-hosted mode needs approval once:
   `npm run dial -- request-access "<use case>" <company-url>`, then `npm run dial -- status`.
3. Public URL: `npm run tunnel` (cloudflared quick tunnel, prints `https://….trycloudflare.com`)
   or deploy to Cloud Run (below).
4. `npm run dial -- activate wss://<host>/dial`. **This routes every call on the
   Dial account to that URL.** `npm run dial -- disable` reverts.
5. `npm run dial -- secret` writes `DIAL_SIGNING_SECRET` to `.env`; restart the server
   so it rejects unsigned connections.
6. Test the public endpoint like Dial would, before dialing:
   `npm run fake-dial -- --url wss://<host>/dial --signed --say "…"`
7. Call the Dial number.

Dial numbers are US-only for now; a German caller makes an international call.
The German number plan (Twilio, one number per country) is in `PLAN.md`
section 12; cost per tradesperson and pricing are in section 13.

## Deploy (Google Cloud Run)

```bash
cp deploy/env.example deploy/env.production    # fill in: Supabase URL, keys, TICK_TOKEN, DEV_TOKEN/ADMIN_CODE
PROJECT=<gcp project> deploy/cloudrun.sh       # europe-west1 by default; safe to run again
```

It creates:
- a service account (Vertex through the metadata server, no key file);
- one Secret Manager secret holding `env.production`, mounted at `/secrets/env`;
- the Cloud Run service (request-based billing, 0–3 instances, 60-minute requests);
- a Cloud Scheduler job that POSTs `/internal/tick` every minute. That tick runs the
  background work, and keeps an instance warm and the database awake.

At pilot volume this stays inside the free tiers; only Gemini, Fish and the phone line
cost money. The details, the cost estimate and moving off Fly are in
`docs/architecture.md` §10.

## Layout

```
server.mjs                 starts the app, drains calls on SIGTERM
src/app.mjs                composition root: every part built once, here
src/config.mjs             the server's settings, checked at boot
src/http/api.mjs           routes and pages, one table with access levels; WebSocket upgrades
src/calls/start.mjs        one call's wiring: memory, agenda, engine, its end
src/calls/after-call.mjs   after the call: final note, objectives, requests, outbound outcome, memory, summary
src/calls/recap.mjs        the call's summary for the admin page: overview, topics, action items, open questions
src/quotes/                a quote as data (totals in code), its PDF (pdf-lib, texts from the locale pack), storage
src/tools/quote.mjs        quote_send: the confirmed job as a PDF into his WhatsApp chat, during the call
src/calls/voice.mjs        pre-recorded lines, cached in Postgres
src/engine/session.mjs     one call: VAD → Gemini → Fish, barge-in, fillers, idle nudges, checkpoints
src/engine/vad.mjs         energy VAD, adaptive noise floor, end-of-turn by state
src/engine/gemini*.mjs     fast path (stream) + slow path (JSON schema); Vertex or AI Studio
src/engine/fish.mjs        streamed TTS as 16 kHz PCM
src/engine/reply.mjs       HEARD/NEXT header + sentence streaming
src/engine/turn-*.mjs      Smart Turn v3: Whisper features in JS, the model in a worker thread
src/tools/                 tool registry (idempotent writes, confirm gate), memory_search, the admin line's tools
personas/<id>.md           who the agent is, how it sounds (English, locale slots)
templates/<id>.json        capabilities (note, briefing, agenda) and objectives (research, inquiry)
src/agenda/                primitives, per-call agenda, prompt and extraction assembly
src/skills/from-templates.mjs  a skill from a persona and its templates
src/memory/                Postgres: per-call scope, budgeted context, search, the after-call writes
src/memory/research.mjs    the pilot's research state: which question to ask next
src/db/                    Postgres client (Supabase or PGlite) and the schema
src/jobs/queue.mjs         the job queue (all background work)
src/jobs/background.mjs    the tick: lost calls, due jobs, outbound calls, embeddings
src/jobs/scheduler.mjs     outbound errands, guards, call windows (time zones, DST)
src/bus.mjs                messages between instances (Postgres NOTIFY)
src/monitor.mjs            live call timelines, the call log
src/admin/                 logins (the team's own, the owner's code + TOTP), planner, requests (plan → card → approve → result)
src/notify.mjs             results to Max: webhook, email (Resend)
src/telephony/             call host + carriers: Dial, Twilio (IE1, μ-law), a fake carrier for tests
src/locale/                loads packs, picks the call's language, checks completeness
src/testing/caller.mjs     scripted caller (fake-dial, regress)
config/discovery.json      the research framework: key question, hypotheses, areas, questions
locales/<id>.json          everything language-specific (see Languages)
web/                       test phone (/), monitor (/monitor), admin (/admin: calls, requests, people)
deploy/                    Cloud Run: deploy script, settings template
scripts/                   smoke, fake-dial, dial admin, report, regress, the JSON → Postgres move
```
