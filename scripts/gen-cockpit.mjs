// Demo backdrop: a phone in a dashboard mount in a tradesperson's van, with its
// screen solid green. We find the green quad, key it out, and the page maps the
// live HTML screen onto those four corners (CSS matrix3d), so the phone has the
// photo's real perspective, mount and light.
//   npm run gen-cockpit                → generates data/cockpit-raw.png, then processes it
//   npm run gen-cockpit -- --process   → only processes data/cockpit-raw.png
// Output: web/assets/cockpit.jpg + web/assets/cockpit.json { width, height, quad: [tl, tr, br, bl] }
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { geminiEndpoint } from "../src/engine/gemini-endpoint.mjs";

const RAW = "data/cockpit-raw.png";
const prompt = `Photorealistic photo taken from the driver's seat of a white work van (a tradesperson's vehicle), daytime.
In the foreground, slightly right of centre, a modern black smartphone sits upright in a black dashboard phone mount
(spring clamp arms on both sides of the phone, a short arm going down to the dashboard). The phone is close to the
camera and large in the frame: it fills about two thirds of the image height. It is seen from the driver's point of
view, turned slightly towards the driver, so it shows gentle natural perspective.
IMPORTANT: the phone's entire screen is a completely flat, uniform, pure bright green (#00FF00), edge to edge, with
no reflections, no glare, no icons, no text, no user interface.
Behind it: the van's dashboard and centre air vents, the top of the steering wheel at the left edge, the windshield
showing a quiet German suburban street with houses and trees, soft overcast daylight. On the dashboard: two ceramic
tile samples and a yellow folding ruler. A high-visibility vest lies on the passenger seat at the right edge.
Shallow depth of field: the phone and mount are sharp, the background is softly blurred.
Calm, slightly desaturated colours. Wide 16:9. No people, no hands, no text, no logos, no brand names.`;

async function generate() {
  const endpoint = geminiEndpoint();
  const models = [process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image", "gemini-2.5-flash-image"];
  for (let attempt = 0; attempt < 6; attempt++) {
    const model = models[attempt % 2];
    const res = await fetch(endpoint.url(model, "generateContent"), {
      method: "POST",
      headers: await endpoint.headers(),
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: process.env.COCKPIT_SIZE || "2K" } } }),
    });
    const body = await res.json().catch(() => ({}));
    const part = body?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
    if (res.ok && part) {
      writeFileSync(RAW, Buffer.from(part.inlineData.data, "base64"));
      console.log(`generated with ${model} → ${RAW}`);
      return;
    }
    console.log(`${model}: ${res.status} ${(body?.error?.message ?? "").slice(0, 80)}; retrying in 30 s`);
    await new Promise(r => setTimeout(r, 30000));
  }
  throw new Error("image generation failed");
}

function processImage() {
  const probe = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", RAW]).toString().trim();
  const [w, h] = probe.split(",").map(Number);
  const raw = execFileSync("ffmpeg", ["-loglevel", "error", "-i", RAW, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1 << 28 });
  const isGreen = i => { const r = raw[i], g = raw[i + 1], b = raw[i + 2]; return g > 120 && g - Math.max(r, b) > 60; };
  // Largest green blob = the screen (flood fill from every unvisited green pixel).
  const seen = new Uint8Array(w * h);
  let best = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !isGreen(start * 3)) continue;
    const blob = [];
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop();
      blob.push(p);
      const x = p % w, y = (p / w) | 0;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]) {
        if (q >= 0 && !seen[q] && isGreen(q * 3)) { seen[q] = 1; stack.push(q); }
      }
    }
    if (blob.length > best.length) best = blob;
  }
  if (best.length < w * h * 0.01) throw new Error(`no green screen found (largest blob ${best.length} px)`);
  // Exact corners: fit straight lines to the four edges (skipping the rounded
  // corners and the notch), then intersect them.
  const inBlob = new Uint8Array(w * h);
  let minX = w, maxX = 0, minY = h, maxY = 0;
  for (const p of best) { inBlob[p] = 1; const x = p % w, y = (p / w) | 0; minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const fit = pts => { // least squares t = a*s + b, then drop outliers > 2 px and refit
    const solve = ps => { const n = ps.length; let sx = 0, sy = 0, sxx = 0, sxy = 0; for (const [a, b] of ps) { sx += a; sy += b; sxx += a * a; sxy += a * b; } const k = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1); return [k, (sy - k * sx) / n]; };
    let [k, c] = solve(pts);
    const kept = pts.filter(([a, b]) => Math.abs(k * a + c - b) <= 2);
    if (kept.length > pts.length / 3) [k, c] = solve(kept);
    return [k, c];
  };
  const left = [], right = [], top = [], bottom = [];
  const hgt = maxY - minY, wid = maxX - minX;
  for (let y = Math.round(minY + hgt * 0.15); y <= maxY - hgt * 0.15; y++) {
    let l = -1, r = -1;
    for (let x = minX; x <= maxX; x++) if (inBlob[y * w + x]) { if (l < 0) l = x; r = x; }
    if (l >= 0) { left.push([y, l]); right.push([y, r]); }
  }
  for (let x = Math.round(minX + wid * 0.12); x <= maxX - wid * 0.12; x++) {
    const nearNotch = Math.abs(x - (minX + maxX) / 2) < wid * 0.28; // the notch sits top-centre
    let t = -1, b = -1;
    for (let y = minY; y <= maxY; y++) if (inBlob[y * w + x]) { if (t < 0) t = y; b = y; }
    if (t >= 0) { if (!nearNotch) top.push([x, t]); bottom.push([x, b]); }
  }
  const [la, lb] = fit(left), [ra, rb] = fit(right);      // x = a*y + b
  const [ta, tb] = fit(top), [ba, bb] = fit(bottom);      // y = a*x + b
  const meet = ([va, vb], [ha, hb]) => { const y = (ha * vb + hb) / (1 - ha * va); return [+(va * y + vb).toFixed(1), +y.toFixed(1)]; };
  const tl = meet([la, lb], [ta, tb]), tr = meet([ra, rb], [ta, tb]), br = meet([ra, rb], [ba, bb]), bl = meet([la, lb], [ba, bb]);
  // Key out the green (and its fringe) so no green shows at the edges: paint it near-black.
  const blobSet = new Uint8Array(w * h);
  for (const p of best) blobSet[p] = 1;
  for (let p = 0; p < w * h; p++) {
    const x = p % w, y = (p / w) | 0;
    let near = blobSet[p];
    for (let dy = -3; !near && dy <= 3; dy++) for (let dx = -3; !near && dx <= 3; dx++) {
      const q = (y + dy) * w + (x + dx);
      if (q >= 0 && q < w * h && blobSet[q]) near = 1;
    }
    if (near) { const i = p * 3; const g = raw[i + 1], m = Math.max(raw[i], raw[i + 2]); if (g > m) { raw[i] = raw[i + 1] = raw[i + 2] = Math.min(m, 24); } }
  }
  mkdirSync("web/assets", { recursive: true });
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "-", "-q:v", "4", "web/assets/cockpit.jpg"], { input: raw });
  const meta = { width: w, height: h, quad: [tl, tr, br, bl], greenPx: best.length };
  writeFileSync("web/assets/cockpit.json", JSON.stringify(meta, null, 2));
  console.log("screen quad (tl, tr, br, bl):", JSON.stringify(meta.quad), `of ${w}x${h}`);
}

mkdirSync("data", { recursive: true });
if (!process.argv.includes("--process") || !existsSync(RAW)) await generate();
processImage();
