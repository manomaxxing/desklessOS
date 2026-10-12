// Gemini text-to-speech: the backup voice when Fish fails (and an option in the
// mode selector). Not streamed: returns the whole sentence as 16 kHz PCM16.

import { resample } from "./audio.mjs";
import { locales } from "../locale/index.mjs";

export function createGeminiTts({ endpoint, env = process.env }) {
  const model = env.GEMINI_TTS_MODEL || "gemini-2.5-flash-preview-tts";
  return {
    model,
    async synth(text, { lang = locales().defaultId, signal } = {}) {
      const res = await fetch(endpoint.url(model, "generateContent"), {
        method: "POST",
        headers: await endpoint.headers(),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: locales().voice(lang, "geminiTts", env) } } } },
        }),
      });
      if (!res.ok) throw new Error(`gemini tts ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const body = await res.json();
      const part = body?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!part) throw new Error("gemini tts: no audio in response");
      const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? "")?.[1] ?? 24000);
      return { pcm: resample(Buffer.from(part.inlineData.data, "base64"), rate, 16000), usage: body.usageMetadata };
    },
  };
}
