# DesklessOS v2: templates, primitives, pluggable languages, real memory

> **Superseded in parts (2026-10-13):** the Cloud Run port changed how this runs: Postgres
> only (no JSON backend), one job queue for all background work, the after-call steps as one
> job, the office demo and the Live engine cut. The current design is `docs/architecture.md`;
> this file stays as the record of how the phases were planned and built. File names are as
> they were then (`.mjs`); the code is TypeScript now (2026-10-16), the same names with `.ts`.

> **Status (2026-10-12):** P1 (locale packs, English data keys, regression calls) done on branch `v2`.
> P2 (native tool calls, tool registry, `memory_search`) done on `v2`. P3 (personas, templates,
> primitives, agenda, objectives, "find out X" by API) done on `v2`. P4 (memory on Postgres behind
> MEMORY_BACKEND, budgeted context, search, migration) done on `v2`, tested on PGlite; not yet run
> against Supabase. P5 (admin page: instruction → plan → card → approve → result) done on `v2`.
> P6 (telephony adapters incl. Twilio, outbound scheduler) done on `v2`, tested without a real Twilio
> account. P7 (Smart Turn v3, the admin line by phone) done on `v2`. Each phase ships on its own;
> the pilot keeps working throughout.

## Context

DesklessOS grew from a hackathon demo into a pilot (Niko, Konstanz). Its shape no longer fits what's next:

- **Languages are hard-coded in ~30 places.** The reply parser accepts only `de|en` (`src/engine/reply.ts:83`). Voices are `{de,en}` env vars (`fish.mjs:9`, `gemini-tts.mjs:8`). Turn-taking word lists mix German and English (`endpointing.mjs`, `session.mjs:40-41`). Skills carry per-language lines and German examples. Pilot notes use German keys (`kunde_name`, `zusammenfassung`…) that stores, monitor and web UI read directly.
- **Behaviour lives in two monolithic skill modules**, one per process (`SKILL` env, `src/skills/index.ts`). There's no way to say "this call, do X".
- **No outbound calls, no admin trigger.** Dial is inbound-only, US-only and account-wide; nothing schedules calls.
- **Memory is a JSON dump in every prompt:**
  - all customers (≤25) with their latest notes go into every turn (`memory.context()` on every turn, `session.mjs:436`);
  - single tenant, and caller ID is never used to pick a memory;
  - no provenance, no search.
- **Actions are a header flag** (`DO: execute`, no arguments). `streamTurn` (`src/engine/gemini.ts:13`) drops function calls.

**Goal:**
- Max says "call Niko and find out X" (or picks a template), approves a generated plan, and gets a structured answer with Niko's own words back.
- Adding a language is a data change.
- Memory is per user, searchable, and cheap per turn.

**Decisions taken with the user:**
- Outbound calls go to **our users only** (consented tradespeople).
- Languages are **pluggable**, but only **German and English** ship; a test-only fixture pack proves a new language needs no code.
- **Supabase Postgres in the EU**, the same stack as mano-app.
- **DesklessOS's own admin**, copying mano-app's chat → card → confirm flow and its code + TOTP login (`mano-app/server/admin2fa.js`, `totp.js`, `assistantRoutes.js`).
- **Keep our voice engine**, behind interfaces.

## LangChain / LangGraph / voice frameworks: no, with clear revisit points

- **LangChain/LangGraph: no.**
  - They have no realtime voice primitive and would sit in the latency-critical loop.
  - They would put an abstraction over the Gemini features we rely on (audio parts, thought signatures, `thinkingLevel`, hedged streams).
  - The workflow we need (request → approve → call → retry → result) has about six states, each waiting hours on external events. A status column plus a `FOR UPDATE SKIP LOCKED` worker in the Postgres we're adopting anyway does that.
  - **Revisit when** flows branch heavily (call → no answer → WhatsApp → wait 2 days → escalate). Then use a durable workflow engine (Cloudflare Workflows fits mano's Workers; or pg-boss/Temporal), not LangGraph.
- **LiveKit Agents / Pipecat: not now.**
  - We'd rewrite exactly what makes our engine good (NEXT-driven endpointing, hedging, false-start undo) to gain WebRTC media that phone-only calls don't need.
  - Pipecat would also add Python.
  - The seam already exists: both engines expose `handle(frame)/close()` over one frame protocol, and phase 6 formalises it.
  - **Revisit with a 2-day spike** (one template on LiveKit Agents, comparing first-audio p50 against our 2.4–3.2 s) when in-app WebRTC calling is needed or turn-taking work exceeds about 2 weeks.

## Target architecture

**Concepts:**
- **Locale pack**, `locales/<id>.json`. Holds:
  - BCP-47 tag, country codes, voices (Fish / Gemini TTS / Live), number/currency format;
  - turn-taking lexicon (dangling, hold, backchannel, filler words, stopwords, goodbyes), register ("du"/"Sie", acknowledgements);
  - persona lines (greeting, outbound greeting, wrap-up, backchannel, fillers, oops, examples), document text (quotes).
  - Prompts stay in English; spoken examples come from the pack. Data keys are English; values are in the spoken language plus `lang`.
- **Persona**, `personas/<id>.md`: the English rules moved out of `CORE_RULES`/`RULES` (who the agent is, how it sounds, output format), with `{{ex.*}}` slots filled from the locale.
- **Template** (JSON, versioned, `templates/*.json`):
  - **capabilities** are what he can start: capture, brief, agenda, order;
  - **objectives** are what the agent brings: research (the discovery framework), inquiry ("find out X");
  - each template lists steps made of primitives, allowed tools, limits, an output schema and post-call steps.
- **Agenda:** the objectives for this call (template instances with status and priority). Inbound calls get the user's capabilities plus pending `next_inbound` objectives; outbound calls get their objective. At most 2 agent objectives per call, always after his own business.
- **Primitives:**
  - **Conversation**, each a module `{prompt(step,ctx), schema(step), isDone(step,output,state)}`: `capture`, `brief`, `agenda`, `ask{question,probe,required}`, `research{bank,hypotheses,perCall,perDay}`, `inform`, `confirm`, `act{tool,requiresConfirm}`, `consent_check` (outbound), `close`.
  - **Realtime tools:** only where the spoken answer depends on the result, or a side effect must happen mid-call: `memory_search`, `order_execute`, `callback_schedule`, `end_call` (Live).
  - **Done is checked in code:** the per-turn note extraction (today's `refreshNote`) runs against the agenda's merged output schema, and code checks `isDone`. No `objective.complete` tool round trips.
- **Planner:** turns a natural-language instruction into an instance of a fixed template (usually `inquiry`):
  - the target user, resolved with confidence plus alternatives;
  - params (1–5 questions with probes), success criteria;
  - language from the user's profile, mode `next_inbound` | `outbound` | `either`, not-before/deadline;
  - clarifications if it's ambiguous.
  - It never writes persona rules or limits, so the approval card stays checkable.
- **Memory v2 (Postgres + pgvector):** typed rows (contacts, facts with provenance, tasks, notes, calls). The context is built once per call within a fixed budget, plus a `memory_search` tool and lookups pre-fetched by the slow path.
- **Telephony adapters** (`dial`, `twilio`, `browser`, `fake`) behind one interface with `dialOut(userId)`. Inbound number → org; caller ID → user.

## Phases (each ships on its own; the pilot keeps working)

**Safety net, built first:**
- `scripts/regress.ts` with scenarios in `test/calls/*.json`: German capture with `[pause 3]`, German briefing, "Was steht an?", English office order, a false start.
- It drives fake-dial refactored into `runCall({url, lang, says, config}) → events` and asserts on the debug events (`heard`, `note`, `tool`, `hangup`).
- Run it before every merge. Unit tests stay offline.

### P1: Locale packs and language-neutral keys (S–M)
**Create:**
- `locales/{de,en}.json` only; `test/fixtures/locales/xx.json` is a test-only sample pack.
- `src/locale/index.ts`:
  - `loadLocales(dir) → {ids, enabled(), get(id), lexicon(id), forPhone(e164)}`;
  - `pickLanguage({userLang, dialTag, from, locales, fallback})`.
- `scripts/locale-check.ts` (`npm run locale:check`).
- `scripts/locale-fill.ts`: Gemini drafts missing lines into `locales/_draft/` with `reviewed:false`; an enabled locale can't ship unreviewed lines.
- `scripts/migrate-keys.ts`: backs up first, then renames German → English keys:
  - `kunde_name→customer_name`, `ort→place`, `arbeiten→work[{area,description,quantity,material}]`;
  - `naechste_schritte→next_steps[{what,due}]`, `zusammenfassung→summary`, `sprache→lang`, `bestaetigt→confirmed`;
  - `modus notiz|briefing|agenda→mode capture|brief|agenda`; finding kinds → `fact|number|story|opinion`.
- `scripts/regress.ts` and `test/{locale,no-lang-literals}.test.mjs`. The second fails on `"de"`/`"en"` literals in `src/` outside `src/locale/`.

**Modify:**
- `reply.mjs`: `createReplyParser({langs})`.
- `endpointing.mjs`: `dangling(heard, lex)` / `holdOn(heard, lex)`, using the current language's word list, not a union.
- `session.mjs`: filler and backchannel regexes from the lexicon.
- `fish.mjs`, `gemini-tts.mjs`: `voiceFor(lang)`.
- `live-session.mjs`: `languageCode` from `bcp47`; language guess from the locale's stopwords.
- `server.ts`: voice assets per enabled locale × persona.
- Skills: lines and examples from the locale; English `NOTE_SCHEMA` keys and `EXTRACT_SYSTEM`.
- `store/memory.mjs` (`noteLine`, `customerOf`) and `monitor.html`: read English keys, falling back to the German ones for one release.
- `workflow/order.mjs`, `quote-template.mjs`: text and format from the locale.

**Done when:** the de/en regression passes on locale packs, and a unit test loads the fixture pack `xx` (lines, lexicon, parser, endpointing) with no code change.

### P2: Native function calling in the cascade engine, one tool registry (M)
**`gemini.mjs`:**
- `streamTurn({endpoint, model, system, contents, tools, signal, …})` yields `{type:"text"} | {type:"call", call:{id,name,args}} | {type:"end", parts}`.
- Sends `tools` / `toolConfig AUTO`, skips `thought` parts, and keeps the raw parts including `thoughtSignature` (Gemini 3 rejects the follow-up without it).
- Stays backward compatible when `contents` isn't passed.

**`session.mjs` runTurn becomes a loop of at most 2 model calls:**
- **Header:** `parser.flushHeader()` on the first call event, and `NEXT: wait` ignores tool calls.
- **Mask and confirmation:** the spoken preface first, then typing. `requiresConfirm` tools run only if `turn.prevNext === "confirm"`.
- **Write tools:**
  - they wait until the false-start window has passed;
  - each run is recorded in `tool_runs` with the idempotency key `callId:name:hash(args)`;
  - they're never aborted.
- **Second call:** same user content + `{model, parts}` + `{user, functionResponse}`, with the parser in `{header:"optional"}` mode.
- **History:** stores `[did order_execute: …]`.
- **False starts:** `resumeAfterFalseStart` keeps the turn if a write already ran.

**Tools:**
- `src/tools/registry.ts`: `defineTool({name, description, parameters, effect, requiresConfirm, timeoutMs, run})` and `createToolRunner`.
- Tools `memory_search`, `order_execute`, `end_call`; Live uses the same declarations.
- `DO: execute` stays behind `TOOLS=header` for A/B testing; it's removed in P3.

**Tests:** `stream-turn.test.mjs` (mocked SSE with a functionCall and a thoughtSignature) and `tools.test.mjs`.

**Done when:** the office order runs through the native tool; first-audio p50 for turns without tools is unchanged (±100 ms); the false-start scenario executes the order once.

**As built (2026-10-12):**
- Gemini 3.5 Flash calls a tool *silently* (no header, no words) unless told otherwise; the TOOLS prompt block says "header and a few words first, then the call", and if no words came anyway a cached `working`/`looking` line from the locale pack plays.
- The follow-up goes to the same model with the raw parts (Gemini 3 answers 400 without the thought signature); if it stalls, the backup model races it with the exchange as plain text.
- `order_execute` reads the draft from a fresh extraction (hedged across models after 3.5 s) instead of queueing behind the background one; a stalled extraction had cost 17 s. Extractions apply in order of their start (sequence number), not of their finish.
- A confirm-gated tool is refused when the same answer is itself asking (recap + call in one breath).
- Idempotency is in memory per call for now (key `callId:name:hash`); the `tool_runs` table comes with P4.
- `memory_search` is offered only when memory holds more than the prompt shows; it matches names by trigram similarity.
- Result: the regression passed 7/7, office order through `order_execute` once, the false start on "yes, go ahead" ran it once. Pilot requests without tools are byte-identical to P1's; measured first-audio p50 varied 2.1–6.5 s between runs of the same code, so the ±100 ms target can't be read from regressions.

### P3: Templates, primitives and agenda (M–L; still JSON, one tenant)
**Create:**
- `templates/{notebook.capture,notebook.brief,notebook.agenda,office.order,research.discovery,inquiry}.json`, `personas/{notebook,office}.md`.
- `src/agenda/{templates,primitives,agenda,prompt}.mjs`:
  - `loadTemplates(dir)`;
  - `createAgenda({persona, capabilities, objectives, locale, state}) → {blocks(), outputSchema(), update(extracted), missing(), results(), tools()}`;
  - `assemblePrompt({engine, persona, locale, memory, agenda, today})`, ordered static → per call → per turn so Gemini's implicit prefix caching applies.
- `src/skills/from-templates.ts`: builds today's skill contract from persona + templates, so server and sessions move over gradually.
- An objectives store in `data/objectives.json` plus `POST /api/objectives` (DEV_TOKEN).

**Modify:**
- `skills/index.mjs` routes `pilot`/`office` through templates.
- Sessions use `agenda.outputSchema()/update()` instead of `NOTE_SCHEMA`/`missingFields`.
- `store/discovery.mjs` becomes the state store of the `research` primitive; reuse `next()`, `apply()`, `context()`.

**Done when:** the pilot and office regressions pass on templates, and an `inquiry` objective posted by hand is asked at the end of the next inbound call and its structured result stored. "Find out X" then works manually.

**As built (2026-10-12):**
- No shim: `src/skills/pilot.ts` and `office.mjs` are gone. A skill is `loadSkillFromTemplates(name)`; each call gets `skill.createAgenda({ objectives, discovery })`, which both engines use for prompt, extraction schema, missing fields, saving and tools. `DO: execute` / `TOOLS=header` is removed (a stray `DO:` line is still dropped, never spoken).
- Templates: `notebook.{capture,brief,agenda}`, `office.{order,calendar,brief}`, `research.discovery`, `inquiry`. Primitives: `capture`, `order` (per-item missing logic in code), `inform`, `ask`, `research`. `inform`, `confirm`, `act`, `consent_check`, `close` as separate primitives weren't needed yet; confirm and act live in the order template's text and its `order_execute` tool.
- The prompts were ported, not rewritten: the pilot's note and memory schemas are byte-identical to P1/P2; the office's differ only in enum order. The text changes are the reorder (static → per call → per turn), research moving from MEMORY into a "YOUR OWN AGENDA" section shared by all objectives, and the jobs listed as A), B), C).
- An inquiry's answers are extracted every turn under `agenda.<objective id>` (asked, probed, status, answer, quote); done is checked in code. A vague answer counts only after the one follow-up was asked (the first live run took a bare "ja, passt" as the answer).
- Objectives live in `data/agenda/objectives.json` (`src/store/objectives.ts`): pending → done | expired (3 calls) | cancelled; answers merge across calls. API: `GET/POST /api/objectives`, `POST /api/objectives/:id/cancel`, behind `DEV_TOKEN`.
- At most two of the agent's own items per call, Max's questions before the research question.

### P4: Memory v2 on Supabase Postgres (EU) with tenancy (L)
**Infrastructure:**
- One runtime dependency, `postgres` (porsager), on Supabase's direct or session-pooler connection; transactions and SKIP LOCKED need it.
- `@electric-sql/pglite` + pgvector as a devDependency, so `node --test` runs the real migrations without Docker.

**Tables** (all with `org_id`; RLS on, service role only):
- `orgs`, `users` (phone_e164, role, lang/langs, timezone, call_window, consent_outbound_at, outbound_paused, profile).
- `contacts` (aliases, embedding, legacy_id; trigram index), `projects`.
- `calls` (transcript, cost, consolidation_status/consolidated_at), `call_contacts`.
- `notes` (template outputs, jsonb).
- `facts` (subject, kind, text, quote, tags, confidence, source_call_id, valid_from, superseded_by, embedding).
- `tasks`, `requests`, `objectives` (template_id@version, params, mode, status, state, result), `tool_runs`.

**Context builder:**
- `buildContext({user, objectives, now, budget: 2500 tokens})`, built once at `call_connected`; nothing on the hot path.
- Filled in order: profile facts → the agenda's objectives (never cut) → up to 10 tasks → top 8 contacts scored by recency, open tasks and mentions → a name index of the next 40 → lookups pre-fetched mid-call.
- `memory_search` = trigram match on contacts + vector search on facts and notes.

**Consolidation:**
- Fixed-shape schema; code turns it into typed ops.
- One transaction, guarded by `UPDATE calls SET consolidated_at=now() WHERE … IS NULL`, so running it twice does nothing.
- Discovery findings become facts tagged `area:* hyp:* stance:*`.
- `src/jobs/consolidation-worker.ts` replaces `memory/pending` and `retryPending`.

**Migration:** `scripts/migrate-json-to-pg.ts` (`--dry-run`, safe to re-run via `legacy_id`) maps notes, customers, actions, findings and question state. Calendar and quotes (the US demo) stay in JSON. `MEMORY_BACKEND=json|pg` is the rollback switch.

**Modify:** `server.ts` (caller ID → user/org), the sessions (snapshot at connect), `engine/consolidate.mjs` (database snapshot + ops).

**Done when:**
- the migrated counts match and the pilot runs on Postgres;
- "Was war bei <contact outside the top 8>?" is answered through `memory_search`;
- the snapshot takes under 20 ms at p95;
- the context test with 500 contacts stays in budget.

**As built (2026-10-13):**
- One interface, two backends (`src/memory/`): a backend opens a **scope per call** (who, the MEMORY text, search, saving the note, the office's writes, the post-call step, objectives). `MEMORY_BACKEND=json` wraps the old stores unchanged; `pg` is new. Sessions no longer touch stores directly.
- `src/db/client.ts` gives `postgres` (Supabase) and PGlite one `query/tx` interface; PGlite (+ `@electric-sql/pglite-pgvector`, pg_trgm, unaccent) is a devDependency, used by tests and `DATABASE_URL=pglite:<dir>`. Versions pinned ≥ 6 weeks old (0.5.8 / 0.0.9; 0.5.9 came out the day this was built).
- Tables as planned except: no `projects` and `requests` yet (nothing uses them; P5 adds `requests`); the pilot's question state is a `research_state` row per user rather than objective state; `calls.job` holds what a retry needs. `consolidation-worker.mjs` became `pendingConsolidations()` (claims with `FOR UPDATE SKIP LOCKED`, increments attempts) driven by the server's existing retry timer.
- The memory model's prompt and schema are unchanged; `apply()` turns its answer into typed changes inside one transaction guarded by `consolidated_at`. Its snapshot is the likely customers (trigram on the note's name) plus the 15 most recent, not all of them.
- Embeddings: `text-multilingual-embedding-002` (768-d, ~200 ms) rather than `gemini-embedding-001` (11 s cold). Filled in the background after writes; search works without them (trigram on names, word similarity on notes). A search waits at most 1.2 s for the query's vector; after a late one it searches by name only for 5 minutes (Vertex embeddings timed out for a stretch during testing; the Postgres regression failed on that before this cap).
- Unknown callers: with one user every call is theirs (pilot); among several, an unknown caller gets an empty memory and nothing is saved. `DEFAULT_USER_ID` pins one.
- Measured in PGlite (in process): opening a call with 500 customers and 500 notes takes tens of ms and stays within 2,500 tokens. The 20 ms p95 target has to be measured on Supabase from Fly (fra → eu-central-1); the monitor logs it per call as a `context` event.
- Found on the way: the Docker image never had `config/` (since the office demo, so `main` can't start on Fly either), nor `locales/`, `personas/`, `templates/`. Fixed on `v2`.

### P5: Admin requests: instruction → plan → card → approve → result (M)
**Create:**
- `src/admin/{auth,planner,requests}.mjs` and `web/admin.html`.
- Auth: code + TOTP → signed token, ported from mano-app; DEV_TOKEN becomes dev-only.
- `src/notify.ts`: email via the outbox pattern, plus a webhook.

**API:**
- `POST /api/requests {instruction} → {id, plan, card, confirmToken}`
- `POST /api/requests/:id/approve {confirmToken, edits?}`
- `POST /api/requests/:id/cancel`
- `GET /api/requests[/:id]`

**Planner and approval:**
- The planner uses `extractJsonResilient` with a thinking model; it runs offline, so ~5 s is fine.
- The confirm token is an HMAC over (request id + plan hash + expiry), so the plan can't change between preview and approval.
- Unknown or ambiguous users → clarifications; no user without consent can be targeted.

**Done when:** Max types "Frag Niko, wie lange sein letztes Angebot gedauert hat", approves the card, and in Niko's next inbound call the question comes after his own business. Within a minute of hangup the admin page shows the answer, his quote and a call link. The flow needs no carrier.

**As built (2026-10-13):**
- `src/admin/auth.ts` ports mano-app's TOTP and signed tokens; the TOTP secret is an env var (`ADMIN_TOTP_SECRET`, `npm run admin:totp`) rather than enrolled in-app. Without `ADMIN_CODE` the admin routes use the old dev rule; with it, `DEV_TOKEN` no longer opens them (sessions do, and also open the monitor).
- Not a free chat: one instruction → a card. Max can answer the planner's clarifications or say what to change ("Plan again", the model re-plans with its earlier plan) or edit the questions on the card (no model). Either way a new card and a new confirm token; the old token fails because the plan hash changed.
- The planner (`gemini-3.5-flash` with thinking, `PLANNER_MODEL` overrides) fills only the `inquiry` params and picks the user; code checks the user exists, the params pass the template's validation, and the mode is available (only `next_inbound` until P6). Low confidence or alternatives show a warning; no user or invalid questions block approval.
- Requests are stored with the memory backend (`data/admin/requests.json` or the `requests` table, migration 002). A request follows its objective: partial answers show up after each call, `done`/`expired` close it. Its `notify_status` is the outbox (one flush at a time, retried up to five times).
- `/monitor?call=<id>` opens one call (the card's call links).
- Regression `pilot+admin`: the real planner on Max's sentence, approval through the API, Niko's scripted call, the request `done` with "zwei Stunden". Passed on JSON and on Postgres memory.

### P6: Telephony adapters and outbound scheduler (L)
**Create:**
- `src/telephony/{adapter,dial,twilio,fake,browser}.mjs`. Signature check and attach code move out of `server.ts`. The adapter interface is `{id, http?, upgrade?, dialOut?({userId, jobId})}`; internally the frames stay Dial's protocol.
- A μ-law codec in `audio.mjs` (reuse `resample` for 8↔16 kHz).
- `src/jobs/{scheduler,windows}.mjs` and a `call_jobs` migration.
- `fake-dial --answer` for outbound tests.

**Guards:**
- `dialOut` takes only a `userId` with `consent_outbound_at` set; no code path dials a raw number.
- Call windows in the user's timezone, at most 1 outbound call per day, never while he's already on a call, and `outbound_paused`.

**Scheduler:**
- Claims jobs with `SKIP LOCKED`.
- Uses Twilio's answering-machine detection (async), if available in IE1; fallback heuristic: callee talks 4 s without a pause → voicemail.
- Retries at 30 min, 2 h, then the next window; after that the objective falls back to `next_inbound` and the admin is notified.

**Outbound opening (`consent_check`):** wait for "Hallo" or 1.5 s, then the outbound greeting, the purpose, and "hast du zwei Minuten?". If he says no, offer a callback.

**Tests:** `mulaw`, `twilio-frames`, `windows` (time zones, DST), `outbound-guard`.

**Done when:** a German Twilio number (IE1) handles every template inbound; an approved outbound request rings Niko inside his window and fills the result; no-answer ends in `next_inbound`.

**As built (2026-10-13), without a Twilio account yet:**
- `src/telephony/`: `host.mjs` (calls by id, reconnect grace, who's on a call), `dial.mjs` (Dial + the dev phone), `twilio.mjs` (voice webhook → TwiML `<Connect><Stream>` with a signed token parameter; stream ↔ host frames with μ-law 8 kHz ↔ PCM16 16 kHz at the edge; REST `Calls.json` with async AMD and status callbacks; `X-Twilio-Signature` on every webhook), `fake.mjs` (rings a test phone). `browser.mjs` wasn't needed: the browser phone is Dial's dev path.
- `src/jobs/`: `windows.mjs` (wall-clock windows per time zone, DST-safe without a library), `scheduler.mjs` (`call_jobs`, migration 003; guard; retries 30 min / 2 h / next day; four tries, then `next_inbound` and a note to Max). The plan's "at most one outbound call per day" counts calls he took (a mailbox doesn't count); `OUTBOUND_PER_DAY` changes it.
- The outbound opening is the session's (cached greeting on "Hallo?" or after 1.5 s, then the model: why, two minutes?), with the rules in the persona's new `outbound` section; `consent_check` became two extracted fields (`call_consent`, `callback_when`) the scheduler acts on, not a primitive. Outbound calls carry only their errand (no research question) and run on the cascade engine.
- The planner may plan `outbound`/`either` only for people who agreed to be called (admin page: People); otherwise the card says why it falls back to their next call.
- Verified: unit tests (μ-law, Twilio signatures and stream bridge, windows across DST, guard, scheduler on PGlite); regression `pilot+outbound` (the real planner on "Ruf Niko an …", the fake carrier rings `fake-dial --answer`, the answer lands on the request, the job completes; a mailbox is hung up on) and `pilot+twilio` (a whole call through the Twilio webhook and μ-law stream). Not verified: real PSTN calls, Twilio's AMD timing, IE1 credentials.

### P7: Later
- **Smart Turn v3 sidecar** (`src/engine/turn-detector.ts`, audio-native, 23 languages) combined with `NEXT: wait`; the word lists become the fallback.
- **An admin persona reachable by phone**, with a `request_create` tool. It only drafts; approval stays a card or PIN.

**As built (2026-10-13):**
- Smart Turn runs in process, in a `worker_thread`, not as a separate service: `turn-features.mjs` reimplements Whisper's feature extractor in JS (Slaney mel, periodic Hann, reflect-padded STFT, log10 with an 8 dynamic range; Smart Turn's left padding to 8 s and whole-window normalisation), `turn-worker.mjs` runs `smart-turn-v3.2-cpu.onnx` with `onnxruntime-node` (an optional dependency, 1.30.0; the image only includes it with `--build-arg SMART_TURN=1`). No Python reference was available to diff the features against; the check is the model itself on real speech (finished 0.97–0.99, broken-off 0.005–0.07, German and English), kept as an offline test with two recorded clips. It runs when he stops, in parallel with Gemini, and only adds "not done" (wait); the word lists decide when it's off or late. In the pilot regression with it on (4/4 passed) it caught "…die will" (0.17) but also called short closings "not done" ("Ja." 0.07, "Keine Zeit. Tschüss." 0.06), holding the agent silent ~6 s; so its "not done" only counts when the model would listen or ask and he spoke ≥ 1.2 s. It stays off by default (`TURN_DETECTOR`) until it's been checked on Niko's real recordings rather than TTS voices. Shortening the end-of-turn silence when it says "done" is the obvious next step, not taken yet.
- The admin line: `personas/admin.md` + `templates/admin.requests.json`, tools in `src/tools/admin.ts` (`request_create`, `request_approve`, `request_status`). Caller ID (`ADMIN_PHONE`) picks the persona; the PIN (`ADMIN_PIN`) is the actual check for approving and for reading answers, since caller ID can be spoofed; three wrong PINs lock that call. A refused PIN is an error, not a result, so the tool runner's write idempotency doesn't keep it. Admin calls get a memory scope that keeps nothing. The first live run showed Gemini re-drafting instead of approving, so the tools carry the flow: `request_create` returns the call's existing draft for the same words, `request_approve` takes just the PIN (digits or spoken number words, from each locale's `lexicon.digits`) and approves the call's latest draft.
- Vertex answered 429 "Resource exhausted" and timed out for long stretches while these phases were tested (most regression failures today were that, rerun once it recovered). What changed because of it: the planner and background note updates retry 429s (1.5 s, 4 s); `order_execute` falls back to the background draft when that draft already covers every turn before his "yes" (otherwise it still refuses rather than book from a stale one); after a failed write, his "yes, try again" may run it again without a new recap.

## Risks and how the plan handles them

- **Silence while tools run:** few realtime tools, a spoken preface plus typing, pre-fetched lookups, and a `toolHopMs` metric in the monitor.
- **Missing header or thought signature with tools:** `flushHeader` fallback, raw parts preserved, mocked-SSE tests, and the fallback model `gemini-2.5-flash` supports tools.
- **Side effects running twice** (hedging, false starts, retries): only the winning attempt runs tools; idempotency keys; writes wait out the false-start window.
- **Breaking the pilot:** regression scenarios every phase, the `from-templates` shim, the `MEMORY_BACKEND` and `TOOLS` switches, and the JSON files kept for rollback.
- **Calling the wrong person or without consent:** userId-only `dialOut`, consent fields, windows, caps, the `consent_check` opening, and an audit trail on requests.
- **Planner misreads the instruction:** confidence, alternatives and clarifications on the card; approval bound to the plan hash; no auto-approval.
- **Auto-translated lines sound wrong:** drafts need review; locales are `beta` until reviewed.
- **GDPR:** Supabase eu-central-1 and Vertex EU, a retention policy, per-user deletion; facts are never hard-overwritten (superseded rows keep a quote and a call link).

## Verification

- **Every phase:**
  - `npm test` (unit, offline, PGlite for SQL);
  - `node scripts/regress.ts` against a local server, on a scratch `DATA_DIR`;
  - latency check: first-audio p50 from the monitor's `latency` events, before and after.
- **P1:** `npm run locale:check` passes for de/en; the fixture-pack test passes; the de/en regression passes.
- **P2–P3:** the regression office order runs through `order_execute`. Then post an `inquiry` objective with `curl`, run a scripted inbound call, and check that the result JSON holds the answer and quote.
- **P4:** `migrate-json-to-pg --dry-run` counts match the JSON files; a briefing about a contact outside the top 8 uses `memory_search`; the 500-contact context test passes.
- **P5:** admin page → instruction → card → approve → scripted inbound call → result visible.
- **P6:** `fake-dial --answer` takes an outbound job; the guard tests pass; then one real call to a consenting test number in the IE1 region.
