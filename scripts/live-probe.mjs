// Which Gemini Live doors work for this project? Connects, sends setup, asks for
// one German sentence, and times setupComplete and the first audio.
//   npm run live-probe [-- vertex-eu:gemini-3.8-live studio:gemini-3.8-live ...]
import WebSocket from "ws";
import { execFileSync } from "node:child_process";
import { liveTarget } from "../src/engine/live-endpoint.mjs";

const ids = process.argv.slice(2).length ? process.argv.slice(2) : [
  "vertex-eu:gemini-3.8-live", "vertex@us-central1:gemini-3.8-live",
  "vertex@europe-west4:gemini-live-2.5-flash-native-audio", "studio:gemini-3.8-live",
];
const token = execFileSync("gcloud", ["auth", "application-default", "print-access-token"]).toString().trim();

for (const id of ids) {
  const target = liveTarget(id);
  const t0 = performance.now();
  const result = await new Promise(resolve => {
    const ws = new WebSocket(target.url, target.vertex ? { headers: { Authorization: `Bearer ${token}` } } : {});
    const done = r => { try { ws.close(); } catch {} resolve(r); };
    const timer = setTimeout(() => done({ ok: false, why: "timeout 20s" }), 20000);
    let setupMs, firstAudioMs, text = "", audioBytes = 0;
    ws.on("open", () => ws.send(JSON.stringify({ setup: {
      model: target.modelPath,
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } }, ...(target.vertex ? { languageCode: "de-DE" } : {}) } },
      systemInstruction: { parts: [{ text: "Du bist ein knapper Assistent. RESPOND IN GERMAN." }] },
      outputAudioTranscription: {},
    } })));
    ws.on("message", data => {
      const msg = JSON.parse(data.toString());
      if (msg.setupComplete) {
        setupMs = performance.now() - t0;
        ws.send(JSON.stringify({ realtimeInput: { text: "Sag in einem Satz Hallo zu einem Fliesenleger." } }));
      }
      for (const p of msg.serverContent?.modelTurn?.parts ?? []) if (p.inlineData) { firstAudioMs ??= performance.now() - t0 - setupMs; audioBytes += Buffer.from(p.inlineData.data, "base64").length; }
      if (msg.serverContent?.outputTranscription?.text) text += msg.serverContent.outputTranscription.text;
      if (msg.serverContent?.turnComplete) { clearTimeout(timer); done({ ok: true, setupMs, firstAudioMs, text, audioS: audioBytes / 48000, mime: "" }); }
    });
    ws.on("close", (code, reason) => { clearTimeout(timer); done({ ok: false, why: `closed ${code} ${reason.toString().slice(0, 140)}` }); });
    ws.on("error", err => { clearTimeout(timer); done({ ok: false, why: err.message }); });
  });
  console.log(id.padEnd(58), result.ok ? `OK setup ${Math.round(result.setupMs)} ms, first audio ${Math.round(result.firstAudioMs)} ms, ${result.audioS.toFixed(1)} s: "${result.text.trim()}"` : `FAIL ${result.why}`);
}
