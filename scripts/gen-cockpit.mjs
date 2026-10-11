// Generates the demo background: a tradesperson's van cockpit, no phone, no mount
// (the phone and its mount are HTML/CSS so they line up exactly).
//   npm run gen-cockpit [-- <n variants>]   → data/cockpit-<i>.png, pick one → web/assets/cockpit.jpg
import { writeFileSync, mkdirSync } from "node:fs";
import { geminiEndpoint } from "../src/engine/gemini-endpoint.mjs";

const model = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image"; // GA name on Vertex (the -preview id 404s)
const n = Number(process.argv[2] || 2);
const prompt = `Photorealistic photo, interior of a white work van (tradesperson's vehicle) in the daytime,
seen from the driver's seat at eye level, looking at the middle of the dashboard.
Composition: the center of the dashboard with the air vents is in the lower middle of the frame,
the top of the steering wheel is visible at the far left edge, the windshield fills the upper part
and shows a quiet German suburban street with houses and trees, soft overcast daylight.
On the dashboard, a few small tradesperson details: two ceramic tile samples, a yellow folding ruler
and a carpenter's pencil; a high-visibility vest lies on the passenger seat at the right edge.
Shallow depth of field: the dashboard center is in soft focus, the street outside is blurred.
Calm, clean, slightly desaturated colours, cinematic. Wide 16:9.
No phone, no phone holder or mount, no people, no hands, no text, no logos, no brand names.`;

const endpoint = geminiEndpoint();
mkdirSync("data", { recursive: true });
for (let i = 1; i <= n; i++) {
  const t = performance.now();
  const res = await fetch(endpoint.url(model, "generateContent"), {
    method: "POST",
    headers: await endpoint.headers(),
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9" } },
    }),
  });
  const body = await res.json();
  const part = body?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
  if (!res.ok || !part) { console.log(`variant ${i} failed: ${res.status} ${JSON.stringify(body).slice(0, 300)}`); continue; }
  const file = `data/cockpit-${i}.png`;
  writeFileSync(file, Buffer.from(part.inlineData.data, "base64"));
  console.log(`variant ${i}: ${file} (${part.inlineData.mimeType}) in ${Math.round(performance.now() - t)} ms`);
}
