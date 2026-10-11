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
const prompt = `Photorealistic photo taken from the driver's seat of a white work van (a tile contractor's vehicle) parked on a street in San Francisco, daytime.
In the foreground, slightly right of centre, a modern black smartphone sits upright in a black dashboard phone mount
(spring clamp arms on both sides of the phone, a short arm going down to the dashboard). The phone is close to the
camera and large in the frame: it fills about two thirds of the image height. It is seen from the driver's point of
view, turned slightly towards the driver, so it shows gentle natural perspective.
IMPORTANT: the phone's entire screen is a completely flat, uniform, pure bright green (#00FF00), edge to edge, with
no reflections, no glare, no icons, no text, no user interface.
Behind it: the van's dashboard and centre air vents, the top of the steering wheel at the left edge (left-hand drive),
and through the windshield a typical San Francisco street: colourful painted Victorian row houses on a sloping
street, parked cars, soft morning light with a bit of fog. On the dashboard: two porcelain tile samples and a yellow
tape measure. A high-visibility vest lies on the passenger seat at the right edge.
Shallow depth of field: the phone and mount are sharp, the background is softly blurred.
Natural, slightly desaturated colours. Wide 16:9. No people, no hands, no text, no logos, no brand names, no street signs.`;

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
  // Exact corners: the convex hull of the green area (it fills the notch) is four
  // long straight sides joined by short arcs (the rounded corners). Take the four
  // longest straight runs of the hull, fit a line to each, intersect neighbours.
  const inBlob = new Uint8Array(w * h);
  for (const p of best) inBlob[p] = 1;
  const outline = [];
  const rows = new Map(), cols = new Map();
  for (const p of best) {
    const x = p % w, y = (p / w) | 0;
    const r = rows.get(y); if (!r) rows.set(y, [x, x]); else { if (x < r[0]) r[0] = x; if (x > r[1]) r[1] = x; }
    const c = cols.get(x); if (!c) cols.set(x, [y, y]); else { if (y < c[0]) c[0] = y; if (y > c[1]) c[1] = y; }
  }
  for (const [y, [a, b]] of rows) outline.push([a, y], [b, y]);
  for (const [x, [a, b]] of cols) outline.push([x, a], [x, b]);
  const pts = [...new Map(outline.map(q => [`${q[0]},${q[1]}`, q])).values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of pts) { while (lower.length > 1 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...pts].reverse()) { while (upper.length > 1 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  // straight runs: consecutive hull edges whose direction stays within a few degrees
  const angle = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
  const runs = [];
  let run = [hull[0]];
  for (let k = 1; k <= hull.length; k++) {
    const q = hull[k % hull.length];
    if (run.length > 1) {
      const d = Math.abs(((angle(run[0], run.at(-1)) - angle(run.at(-1), q) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      if (d > (4 * Math.PI) / 180) { runs.push(run); run = [run.at(-1)]; }
    }
    run.push(q);
  }
  runs.push(run);
  const len = r => Math.hypot(r.at(-1)[0] - r[0][0], r.at(-1)[1] - r[0][1]);
  const sides = runs.map((r, i) => ({ r, i, len: len(r) })).sort((a, b) => b.len - a.len).slice(0, 4).sort((a, b) => a.i - b.i);
  if (sides.length < 4) throw new Error("could not find four screen edges");
  const lineOf = r => { // total least squares through the run's points: point + direction
    const n = r.length, mx = r.reduce((a, q) => a + q[0], 0) / n, my = r.reduce((a, q) => a + q[1], 0) / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [x, y] of r) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { p: [mx, my], d: [Math.cos(th), Math.sin(th)] };
  };
  const meet = (L1, L2) => {
    const den = L1.d[0] * L2.d[1] - L1.d[1] * L2.d[0];
    const t = ((L2.p[0] - L1.p[0]) * L2.d[1] - (L2.p[1] - L1.p[1]) * L2.d[0]) / den;
    return [+(L1.p[0] + t * L1.d[0]).toFixed(1), +(L1.p[1] + t * L1.d[1]).toFixed(1)];
  };
  const lines = sides.map(s => lineOf(s.r));
  const corners = lines.map((L, k) => meet(L, lines[(k + 1) % 4]));
  const tl = corners.reduce((a, b) => (b[0] + b[1] < a[0] + a[1] ? b : a));
  const br = corners.reduce((a, b) => (b[0] + b[1] > a[0] + a[1] ? b : a));
  const tr = corners.reduce((a, b) => (b[0] - b[1] > a[0] - a[1] ? b : a));
  const bl = corners.reduce((a, b) => (b[0] - b[1] < a[0] - a[1] ? b : a));
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
  // Debug overlay: the detected screen outline in red, to check the fit by eye.
  const check = Buffer.from(raw);
  const quad = [tl, tr, br, bl];
  for (let k = 0; k < 4; k++) {
    const [x0, y0] = quad[k], [x1, y1] = quad[(k + 1) % 4];
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    for (let t = 0; t <= steps; t++) for (let o = -2; o <= 2; o++) {
      const x = Math.round(x0 + ((x1 - x0) * t) / steps) + o, y = Math.round(y0 + ((y1 - y0) * t) / steps);
      if (x >= 0 && x < w && y >= 0 && y < h) { const i = (y * w + x) * 3; check[i] = 255; check[i + 1] = 0; check[i + 2] = 0; }
    }
  }
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "-", "data/cockpit-check.png"], { input: check });
  mkdirSync("web/assets", { recursive: true });
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`, "-i", "-", "-q:v", "4", "web/assets/cockpit.jpg"], { input: raw });
  const meta = { width: w, height: h, quad: [tl, tr, br, bl], greenPx: best.length };
  writeFileSync("web/assets/cockpit.json", JSON.stringify(meta, null, 2));
  console.log("screen quad (tl, tr, br, bl):", JSON.stringify(meta.quad), `of ${w}x${h}`);
}

mkdirSync("data", { recursive: true });
if (!process.argv.includes("--process") || !existsSync(RAW)) await generate();
processImage();
