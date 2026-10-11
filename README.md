# DesklessOS

Voice-first assistant for tradespeople. A tiler calls from the car after a
customer appointment, talks, and gets a structured note ("Termin-Notiz").
Before the next visit he calls again and gets a 30-second briefing. No screen.

Stack: **Gemini** (hears and answers in one streamed call) + **Fish Audio**
(voice) + **Dial** (phone number, self-hosted audio over WebSocket).

**German and English.** The greeting language comes from Dial's `language`
(or the caller's country code: +49/+43/+41 → German, +1/+44/… → English,
else `DEFAULT_LANG`). After that it answers in whatever language the caller
last spoke, switching mid-call if he does. Voices: `FISH_VOICE_DE` / `FISH_VOICE`
(Catrinja) and `FISH_VOICE_EN` (Sarah). Set both to the same ID for one persona
in both languages. Notes keep German keys; values are in the language spoken.
See `PLAN.md` for the why and the roadmap.

## One protocol, three ways to call

The server speaks Dial's self-hosted audio protocol (`call_connected`,
`media`, `mark`, `clear`, `end_call`, `ping_pong`; 16 kHz PCM). Everything
that calls it uses that same protocol:

| Caller | How | Use it for |
|---|---|---|
| **Browser** | `npm run dev` → http://localhost:8787 → "Anrufen" | Talking to it yourself (Chrome, headphones) |
| **Fake Dial** | `npm run fake-dial -- --say "…" --say "…"` | Scripted calls, no mic needed; caller voice via Fish |
| **Dial** | real phone call → `wss://<public-host>/dial/<call_id>` | The real thing |

## Memory and cost

- **Long-term memory** (`data/memory/`): after every call a consolidation step
  updates three things. **Customers** get a rolling summary and a history of
  calls. **To-dos** get a due date and open/done status, so "Angebot bis
  Freitag" becomes a to-do. Each call also gets a **summary**. The next call
  starts with all of it in the prompt. "Was steht an?" reads the most urgent
  to-dos; "Angebot Müller ist raus" ticks one off. You can also tick them off
  in the UI. `npm run rebuild-memory -- --fresh` rebuilds memory from the saved
  notes.
- **Cost per call** (`src/engine/cost.mjs`): Gemini tokens (text, audio,
  output) for the conversation, note extraction and memory step; Fish bytes
  (with what the paid tier would cost); call minutes (set `DIAL_USD_PER_MIN`).
  Shown live in the phone's Cost tab and per call in the monitor. These are
  list-price estimates. Gemini 3.5 Flash prices come from aggregators.
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

## Layout

```
server.mjs                 HTTP + WebSocket (/dial/<call_id>), signature check, reconnect grace
src/engine/session.mjs     one call: VAD → Gemini → Fish, barge-in, fillers, idle nudges, note
src/engine/vad.mjs         energy VAD, adaptive noise floor, end-of-turn by state
src/engine/gemini*.mjs     fast path (stream) + slow path (JSON schema); Vertex or AI Studio
src/engine/fish.mjs        streamed TTS as 16 kHz PCM
src/engine/reply.mjs       HEARD/NEXT header + sentence streaming
src/skills/termin-notiz.mjs  prompt, note schema, required fields
src/store/notes.mjs        data/notes/*.json
web/index.html             browser test phone (pretends to be Dial)
scripts/                   smoke, fake-dial, dial admin
```
