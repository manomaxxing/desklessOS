# DesklessOS

Voice-first assistant for tradespeople. A tiler calls from the car after a
customer appointment, talks, and gets a structured note ("Termin-Notiz").
Before the next visit he calls again and gets a 30-second briefing. No screen.

Stack: **Gemini** (hears and answers in one streamed call) + **Fish Audio**
(voice) + **Dial** (phone number, self-hosted audio over WebSocket).

**German and English**, one file each in `locales/` (see Languages below). The
greeting language comes from Dial's `language`, else the caller's country code,
else the skill's default. After that it answers in whatever language the caller
last spoke, switching mid-call if he does.
See `PLAN.md` for the why and the roadmap.

## Languages

Everything language-specific lives in a locale pack, `locales/<id>.json`: the
BCP-47 tag, phone country codes, Fish and Gemini TTS voices, the turn-taking word
lists (words no sentence ends on, "Moment"-style hold phrases, fillers), each
persona's spoken lines (greeting, fillers, "sorry, say again") and the example
phrases its prompt quotes, and document text (quote, order email). Prompts are
English; the model speaks the caller's language. Code outside `src/locale/` never
names a language (a test enforces it).

- **Add a language:** copy `locales/en.json` to `locales/<id>.json`, translate it,
  pick a Fish voice, then `npm run locale:check` (every key the default pack has
  must exist). `LANGS=de,en,<id>` limits which packs are live; `DEFAULT_LANG` sets
  the fallback.
- **Voices:** the pack's `voices.fish`; `FISH_VOICE_<ID>` overrides it, and
  `FISH_VOICE` still overrides the default language's.
- **Data:** notes use English keys (`customer_name`, `work`, `next_steps`,
  `summary`, …) with values in the spoken language and a `lang` field. Data from
  before v2 used German keys: `node scripts/migrate-keys.mjs --dry-run`, then
  without `--dry-run` (backs up first; `DATA_DIR=/data` on Fly). Readers still
  understand the old keys meanwhile.

## Skills, personas and templates

`SKILL` picks what the agent does:

- **`pilot`** (default): the pilot week with one tradesperson. Notes and briefings
  for any trade. At the end of a call it may ask one research question from the
  discovery framework in `config/discovery.json`; after the call, what he said about
  how he works is filed as findings in `data/discovery/`. `npm run report`
  (`-- --synthesize` for an executive summary) writes `data/discovery/report.md`.
  Method and rules: `PLAN.md` section 14.
- **`office`**: the hackathon demo. Calendar, to-dos and quotes by voice, for a tile
  contractor in San Francisco; the phone page's tabs are built for it.

A skill is a persona plus templates, no code of its own (`src/skills/from-templates.mjs`):

- **Persona** (`personas/notebook.md`, `personas/office.md`): who the agent is and
  how it sounds, in English, with `{{ex.*}}` slots filled from the locale pack.
- **Templates** (`templates/*.json`): *capabilities* are what he can start (take a
  note, a briefing, the agenda, an order); *objectives* are what the agent brings
  (the pilot's research, "find out X"). Each lists steps made of primitives
  (`src/agenda/primitives.mjs`: capture, order, inform, ask, research), its tools and
  for capabilities the note fields.
- **Agenda** (`src/agenda/agenda.mjs`): per call, the persona's capabilities plus at
  most two of the agent's own items, always after his business. It writes the prompt
  (static first, so the prefix caches), one extraction schema for his note and the
  objectives' answers, and checks in code after every turn which objective is done.

**Find out X:** post an objective and the next inbound call asks it at the end:

```
curl -X POST "localhost:8787/api/objectives?token=$DEV_TOKEN" -d '{"template": "inquiry",
  "params": {"purpose": "how long quotes take", "questions": [{"ask": "Wie lange hast du an deinem
  letzten Angebot gesessen?", "probe": "Ungefähr reicht."}]}}'
curl "localhost:8787/api/objectives?token=$DEV_TOKEN"      # status, answers, his words, calls
```

1 to 5 questions; a vague answer gets one follow-up. Answers add up across calls; after
three calls without getting to it the objective expires. `POST /api/objectives/<id>/cancel`
withdraws one. Stored in `data/agenda/objectives.json`.

## Tools

The model calls tools natively (Gemini function calling, `src/tools/`):

- `order_execute` (office): books the calendar entry, adds the to-dos, builds the
  quote and emails it, from the call's draft. Only right after he said yes to a recap.
- `memory_search`: offered only when memory holds more than the prompt shows; finds
  a customer by a sound-alike name, place or topic.
- `end_call` (Live only; the cascade hangs up with `NEXT: hangup`).

A turn makes at most two model calls: the answer that calls the tool, then a
follow-up with the result. He hears something first: the model's own "On it."
(the prompt asks for header and preface before the call), or a cached `working` /
`looking` line from the locale pack, then typing until the result is spoken.
Writes wait until the false-start window has passed, run at most once per call and
order (idempotency key), and are never aborted once started. A template lists the
tools it may use; a call offers only those.

## Regression calls

`npm run regress` starts a server per folder on a scratch data dir and plays the
scripted calls in `test/calls/<skill>/*.json` (German capture with a thinking
pause, briefing, agenda, false start; English office order, and a false start
on "yes, go ahead"), checking what each must and should produce, and printing
first-audio latency. A folder named `<skill>+<variant>` starts from a copy of its
`_seed/` data (`pilot+memory`: 30 customers, a briefing that needs `memory_search`;
`pilot+inquiry`: Max's question posted before the call, its answer checked after).
Run it before every merge; `npm test` stays offline.

## One protocol, three ways to call

The server speaks Dial's self-hosted audio protocol (`call_connected`,
`media`, `mark`, `clear`, `end_call`, `ping_pong`; 16 kHz PCM). Everything
that calls it uses that same protocol:

| Caller | How | Use it for |
|---|---|---|
| **Browser** | `npm run dev` → http://localhost:8787 → "Anrufen" | Talking to it yourself (Chrome, headphones) |
| **Fake Dial** | `npm run fake-dial -- --say "…" --say "…"` | Scripted calls, no mic needed; caller voice via Fish |
| **Dial** | real phone call → `wss://<public-host>/dial/<call_id>` | The real thing |

## Modes (selector in the phone's top bar)

| Engine | What happens | First audio (measured) |
|---|---|---|
| **Gemini + Fish** (cascade) | Gemini hears the audio and writes the reply; Fish speaks it sentence by sentence | ~2.2–3.4 s, masked by typing |
| **Gemini + Gemini TTS** | Same, Gemini's TTS voice (slow, mainly the backup voice) | ~5 s |
| **Gemini Live** | Native audio model hears and speaks itself; its own VAD and barge-in | ~1.2–1.4 s |

- **Pick per call** in the browser. **"Use for phone calls"** sets what real Dial
  calls use (`GET/POST /api/config`).
- **Gemini models** for the cascade: 3.5 Flash, 3 Flash preview, 2.5 Flash,
  2.5 Flash-Lite.
- **Live connections** (all probed working, `npm run live-probe`):
  `vertex-eu:gemini-3.8-live` (default: EU, Vertex credits),
  `vertex@us-central1:…`, `studio:…` (AI Studio key, billed separately), and
  the 2.5 native-audio model (retires 2026-12-13).
- **While thinking:** keyboard typing (synthesised, `TYPING_LEVEL_DB`), a spoken
  "Mhm", or silence.

## Conversation design

These follow published guidance from Pipecat, LiveKit, Vapi, Retell, OpenAI
Realtime and Google's Live best practices.

- **Acknowledgements:** one to three words, varied; no parroting. At most one
  question per turn and two per call, only for missing essentials. One executive
  summary at the end, then "Passt das?", then goodbye.
- **Turn-taking** (cascade engine only; `src/engine/session.mjs`, `endpointing.mjs`):
  - A pause of 0.8 s ends his turn (0.6 s after a yes/no question, 1 s after an
    open one). The model answers `NEXT: wait` when he stopped mid-thought, and a
    word check overrides it when his words stop on "und", "die", "will" and the
    like. The agent then stays silent and keeps his audio.
  - If he stays quiet, a quiet "Mhm." after 2 s says it's still listening; after
    4 s it answers the whole thought as one turn. "Moment", "warte mal" or
    "Sekunde" hold the floor for 15 s, without the "mhm".
  - The model marks its question as yes/no (`NEXT: confirm`, short wait, no
    mid-thought check) or open (`NEXT: ask`, he may pause while answering).
  - False starts: if he goes on talking within 1.5 s of the agent starting, a
    short burst (0.3 s) cuts it off, the reply is forgotten, and his two parts
    are answered as one.
  - Gemini Live uses Gemini's own silence detection (0.8 s) without these checks,
    so the pilot runs on the cascade.
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
    model races it and the first to speak wins.
  - Voice: if Fish fails, Gemini TTS takes over.
  - Live: if it fails, the call continues on the cascade engine mid-call.
  - Background calls: note extraction and the memory step retry with a fallback
    model; if memory still fails it is queued on disk and retried.
  - Spoken: three pre-rendered "sorry, say again" lines per language.

## Memory and cost

- **Long-term memory** (`data/memory/`): after every call a consolidation step
  updates three things. **Customers** get a rolling summary and a history of
  calls. **To-dos** get a due date and open/done status, so "Angebot bis
  Freitag" becomes a to-do. Each call also gets a **summary**. The next call
  starts with all of it in the prompt. "Was steht an?" reads the most urgent
  to-dos; "Angebot Müller ist raus" ticks one off. You can also tick them off
  in the UI. `npm run rebuild-memory -- --fresh` rebuilds memory from the saved
  notes.
- **Notes and memory are linked.** Each saved note gets the `customerId` it was
  filed under. Every turn the prompt lists the 25 most recent customers, each
  with the full specs from their latest 3 notes (area, tile, wishes, next steps).
  So a briefing can answer "what format did she want?" for any of them, not
  just the last few calls.
- **Storage** is JSON on disk under `DATA_DIR` (default `data/`: `notes/`,
  `memory/`, `calls/`). Writes are atomic. A corrupt file stops the write
  instead of being replaced with an empty one; a `.corrupt-<ts>` copy is kept.
  On Fly, `DATA_DIR=/data` is the volume.
- **Cost per call** (`src/engine/cost.mjs`): Gemini tokens (text, audio,
  output) for the conversation, note extraction and memory step; Fish bytes
  (with what the paid tier would cost); call minutes (set `DIAL_USD_PER_MIN`).
  Shown live in the phone's Cost tab and per call in the monitor. These are
  list-price estimates. Gemini 3.5 Flash prices come from aggregators.
- **Cockpit backdrop:** the demo phone sits in a dashboard mount in a tradesperson's van.
  `npm run gen-cockpit` generates the photo with Gemini (`gemini-3.1-flash-image`, 2K)
  with the phone's screen solid green. It then finds the screen's corners by fitting
  the edges, keys the green out, and writes `web/assets/cockpit.jpg` and `cockpit.json`.
  The page maps the live screen onto those corners (CSS `matrix3d`), so it takes the
  photo's perspective and the buttons still work. `/?cockpit=0` and mobile use the plain
  CSS phone frame.
- **UI previews** for slides: `/?orb=speaking&tab=memory` (orb: `listening`,
  `thinking`, `speaking`; tab: `note`, `memory`, `cost`).

## Monitor (debugging)

http://localhost:8787/monitor shows **every** call (Dial, browser, fake-dial),
live and past:

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

Calls are kept in `data/calls/<id>.json`. Audio is recorded per turn when
`RECORD_CALLS=1` (on in the local `.env`; it's customer audio, so think before
enabling it on a deploy). **On a public deploy set `DEV_TOKEN`**: the monitor,
`/api/*` and the test phone then need `?token=…`.

## Local

```bash
npm install
npm run smoke      # Gemini + Fish reachable? writes data/smoke.wav
npm run dev        # http://localhost:8787
npm test           # parser + VAD unit tests
npm run fake-dial -- \
  --say "Ich komm grad von der Frau Müller in Unterhaching, Bad komplett neu, acht Quadratmeter, sechzig mal hundertzwanzig Beton-Optik." \
  --say "Angebot bis Freitag." --say "Passt."
npm run fake-dial -- --lang en --say "Just came from Mrs Johnson, kitchen backsplash…" --say "Quote by Wednesday." --say "Yep."
```

Keys live in `.env` (copied from `mano-games/apps/library/.env.local`):
`GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION` (Vertex, ADC locally),
`GEMINI_MODEL` (default here `gemini-3.5-flash`), `FISH_AUDIO_API_KEY`,
`FISH_VOICE`, `FISH_MODEL` (`s2.1-pro-free` unless Fish API credit is topped up).
Notes are written to `data/notes/*.json`.

## On Dial

1. Put `DIAL_API_KEY` in `.env`.
2. Self-hosted mode needs approval once:
   `npm run dial -- request-access "<use case>" <company-url>`, then `npm run dial -- status`.
3. Public URL: `npm run tunnel` (cloudflared quick tunnel, prints `https://….trycloudflare.com`)
   or deploy to Fly (`fly.toml`).
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

## Layout

```
server.mjs                 HTTP + WebSocket (/dial/<call_id>), signature check, reconnect grace
src/engine/session.mjs     one call: VAD → Gemini → Fish, barge-in, fillers, idle nudges, note
src/engine/vad.mjs         energy VAD, adaptive noise floor, end-of-turn by state
src/engine/gemini*.mjs     fast path (stream) + slow path (JSON schema); Vertex or AI Studio
src/engine/fish.mjs        streamed TTS as 16 kHz PCM
src/engine/reply.mjs       HEARD/NEXT header + sentence streaming
src/tools/                 tool registry (idempotent writes, confirm gate) and the call's tools
personas/<id>.md           who the agent is, how it sounds (English, locale slots)
templates/<id>.json        capabilities (note, briefing, agenda, order) and objectives (research, inquiry)
src/agenda/                primitives, per-call agenda, prompt and extraction assembly
src/skills/from-templates.mjs  a skill from a persona and its templates
src/store/objectives.mjs   data/agenda/objectives.json: what the agent should find out
config/discovery.json      the research framework: key question, hypotheses, areas, questions
locales/<id>.json          everything language-specific (see Languages)
src/locale/                loads packs, picks the call's language, checks completeness
src/store/note-keys.mjs    old German note keys → v2 English keys
src/testing/caller.mjs     scripted caller (fake-dial, regress)
src/store/notes.mjs        data/notes/*.json
src/store/discovery.mjs    data/discovery: findings, question state, which question to ask next
web/index.html             browser test phone (pretends to be Dial)
scripts/                   smoke, fake-dial, dial admin, report
```
