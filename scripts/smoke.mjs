// M0 smoke test: can we reach Gemini and Fish, and what does Fish's PCM look like?
//   npm run smoke            (add --voices to list popular German Fish voices)
import { writeFileSync, mkdirSync } from "node:fs";
import { geminiEndpoint } from "../src/engine/gemini-endpoint.mjs";
import { createFish } from "../src/engine/fish.mjs";
import { wav, durationMs } from "../src/engine/audio.mjs";

const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const endpoint = geminiEndpoint();
console.log("gemini door:", endpoint?.door ?? "none", "model:", model);

if (endpoint) {
  const t = Date.now();
  const res = await fetch(endpoint.url(model, "generateContent"), {
    method: "POST",
    headers: await endpoint.headers(),
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Sag in einem kurzen Satz Hallo zu einem Fliesenleger." }] }],
      generationConfig: { maxOutputTokens: 60, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  const body = await res.json();
  console.log(`gemini ${res.status} in ${Date.now() - t} ms:`, body?.candidates?.[0]?.content?.parts?.[0]?.text ?? JSON.stringify(body).slice(0, 300));
}

const fish = createFish();
console.log("fish:", fish ? `model ${fish.model}, voice ${fish.voice ? fish.voice.slice(0, 6) + "…" : "(default)"}` : "no key");
if (fish) {
  const t = Date.now();
  const pcm = await fish.synth("Servus, hier ist dein Notizbuch. Von welchem Termin kommst du?");
  console.log(`fish pcm: ${pcm.length} bytes = ${durationMs(pcm).toFixed(0)} ms audio, first bytes "${pcm.subarray(0, 4).toString("latin1")}" (RIFF would mean a WAV header), took ${Date.now() - t} ms, first byte ${fish.stream.lastFirstByteMs} ms`);
  mkdirSync("data", { recursive: true });
  writeFileSync("data/smoke.wav", wav(pcm));
  console.log("wrote data/smoke.wav (play it to check byte order and voice)");
}

if (process.argv.includes("--voices") && process.env.FISH_AUDIO_API_KEY) {
  const res = await fetch("https://api.fish.audio/model?page_size=15&language=de&sort_by=score", {
    headers: { authorization: `Bearer ${process.env.FISH_AUDIO_API_KEY}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) console.log("voice list failed", res.status, JSON.stringify(body).slice(0, 200));
  for (const m of body.items ?? []) console.log(`${m._id}  ${m.title}  [${(m.languages ?? []).join(",")}]  ${(m.tags ?? []).slice(0, 4).join(",")}`);
}
