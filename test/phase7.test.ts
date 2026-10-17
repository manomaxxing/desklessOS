// Phase 7: Smart Turn's features and detector, and the admin line's tools.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { melFilterBank, windowOf, logMel, turnFeatures, N_MELS, N_FRAMES, N_SAMPLES } from "../src/engine/turn-features.ts";
import { createTurnDetector, DEFAULT_MODEL } from "../src/engine/turn-detector.ts";
import { wavData } from "../src/engine/audio.ts";
import { adminTools } from "../src/tools/admin.ts";
import { createToolRunner } from "../src/tools/registry.ts";
import { createAuth, planHash } from "../src/admin/auth.ts";
import type { Auth } from "../src/admin/auth.ts";
import type { AdminRequests } from "../src/tools/admin.ts";
import type { Request } from "../src/types/request.ts";
import { loadSkillFromTemplates } from "../src/skills/from-templates.ts";

test("Slaney mel filters: 80 triangles over 0–8 kHz, each with the same area", () => {
  const f = melFilterBank();
  assert.equal(f.length, N_MELS * 201);
  for (let m = 0; m < N_MELS; m++) {
    let peak = 0, area = 0;
    for (let k = 0; k < 201; k++) { peak = Math.max(peak, f[m * 201 + k]); area += f[m * 201 + k] * 40; } // 40 Hz per bin
    assert.ok(peak > 0, `filter ${m} is empty`);
    assert.ok(Math.abs(area - 1) < 0.35, `filter ${m}: area ${area.toFixed(2)} (Slaney-normalised ≈ 1)`);
  }
});

test("the 8 s window: his last words at the end, silence in front; features in Whisper's range", () => {
  const pcm = Buffer.alloc(2 * 16000);
  for (let i = 0; i < 16000; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i / 5) * Math.sin(i / 900)), i * 2);
  const { samples, padded } = windowOf(pcm);
  assert.equal(samples.length, N_SAMPLES);
  assert.equal(padded, N_SAMPLES - 16000);
  assert.equal(samples[0], 0);
  assert.notEqual(samples[N_SAMPLES - 100], 0);
  const feats = logMel(samples, padded);
  assert.equal(feats.length, N_MELS * N_FRAMES);
  let lo = Infinity, hi = -Infinity;
  for (const v of feats) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  assert.ok(hi - lo <= 2 + 1e-6, "an 8 (log10) dynamic range, divided by 4");
  // frames inside the padding are shared, not recomputed: same as computing them all
  const full = logMel(samples, 0);
  for (let i = 0; i < feats.length; i += 997) assert.ok(Math.abs(feats[i] - full[i]) < 1e-5);
  const long = Buffer.alloc(2 * 16000 * 10);
  assert.equal(windowOf(long).padded, 0, "longer than 8 s: only the last 8 s");
  assert.equal(turnFeatures(long).length, N_MELS * N_FRAMES);
});

const haveModel = existsSync(DEFAULT_MODEL);
test("Smart Turn on recorded speech: a finished sentence is done, a broken-off one isn't", { skip: haveModel ? false : "no model (npm run smart-turn:fetch)" }, async () => {
  const det = await createTurnDetector({ timeoutMs: 10000 });
  if (!det) return; // onnxruntime-node not installed
  try {
    const done = await det.predict(wavData(readFileSync(new URL("./fixtures/audio/done-de.wav", import.meta.url))).pcm);
    const notDone = await det.predict(wavData(readFileSync(new URL("./fixtures/audio/not-done-de.wav", import.meta.url))).pcm);
    assert.equal(done.complete, true, `"Angebot bis Freitag, das war's." → ${done.probability}`);
    assert.equal(notDone.complete, false, `"…, die will" → ${notDone.probability}`);
  } finally { await det.close(); }
});

// ---------- the admin line ----------
function fakeRequests(): AdminRequests & { auth: Auth; approved: string[] } {
  const store = new Map<string, Request>();
  const approved: string[] = [];
  const auth = createAuth({ ADMIN_CODE: "x", SESSION_SECRET: "s" });
  return {
    auth, approved,
    async plan({ instruction }) {
      const plan = { template: "inquiry", target: { userId: null, name: "Niko" }, params: { questions: [{ ask: "Wie lange?" }] }, mode: "next_inbound" as const };
      const at = new Date().toISOString();
      const r: Request = {
        id: "req_1", userId: null, instruction, plan, planHash: null, turns: [], status: "draft", objectiveId: null, result: null, createdBy: "phone", createdAt: at, approvedAt: null, closedAt: null, notifiedAt: null, log: [], updatedAt: at,
        card: { title: "", summary: "Niko wird gefragt", who: "Niko (de)", when: "in his next call", purpose: "", questions: [{ ask: "Wie lange?" }], warnings: [], clarifications: [], blocked: [] },
      };
      store.set(r.id, r);
      return { request: r, confirmToken: auth.confirmToken(r.id, planHash(plan)) };
    },
    get: async id => store.get(id) ?? null,
    async approve(id, { confirmToken }) {
      const r = store.get(id);
      const why = auth.checkConfirm(confirmToken, id, planHash(r.plan));
      if (why) throw new Error(why);
      approved.push(id);
      return { ...r, status: "approved" };
    },
    list: async () => [...store.values()].map(r => ({ ...r, result: { questions: [{ ask: "Wie lange?", status: "answered", answer: "Zwei Stunden.", quote: "so zwei Stunden" }] }, log: [] })),
  };
}

test("admin line: drafts freely; approving and hearing answers need the PIN, three tries per call", async () => {
  const requests = fakeRequests();
  const runner = createToolRunner({ tools: adminTools({ requests, auth: requests.auth, pin: "4711" }) });
  const ctx = { callId: "c1", lang: "de", confirmed: false, signal: new AbortController().signal };
  const draft = await runner.run({ name: "request_create", args: { instruction: "Frag Niko, wie lange sein letztes Angebot gedauert hat" } }, ctx);
  assert.equal(draft.result.request_id, "req_1");
  assert.equal(draft.result.can_approve, true);
  assert.deepEqual(draft.result.questions, ["Wie lange?"]);
  const status = await runner.run({ name: "request_status", args: { pin: "0000" } }, ctx);
  assert.match(status.result.error, /Wrong PIN \(2 tries left/);
  const wrong = await runner.run({ name: "request_approve", args: { request_id: "req_1", pin: "1234" } }, ctx);
  assert.equal(wrong.status, "error");
  assert.match(wrong.result.error, /Wrong PIN \(1 tries left/);
  assert.deepEqual(requests.approved, []);
  const again: { result: any } = await runner.run({ name: "request_create", args: { instruction: "Frag Niko, wie lange sein letztes Angebot gedauert hat" } }, ctx); // the tool's JSON, read as it came
  assert.match(again.result.note, /already drafted/, "the same words again: no second plan");
  const right = await runner.run({ name: "request_approve", args: { pin: "vier sieben eins eins" } }, ctx);
  assert.equal(right.result.approved, true, "spoken as words, and the call's draft by default");
  assert.deepEqual(requests.approved, ["req_1"]);
  const heard = await runner.run({ name: "request_status", args: { pin: "4711" } }, ctx);
  assert.equal(heard.result.requests[0].answers[0].words, "so zwei Stunden");
  await runner.run({ name: "request_status", args: { pin: "9" } }, ctx);
  const locked = await runner.run({ name: "request_status", args: { pin: "4711" } }, ctx);
  assert.match(locked.result.error, /Three wrong PINs/, "even the right PIN, after three wrong ones");

  const noPin = createToolRunner({ tools: adminTools({ requests, auth: requests.auth, pin: "" }) });
  assert.match((await noPin.run({ name: "request_approve", args: { request_id: "req_2", pin: "4711" } }, ctx)).result.error, /admin page/);
});

test("the admin persona renders, with only its own tools", () => {
  const admin = loadSkillFromTemplates("admin");
  const agenda = admin.createAgenda();
  assert.deepEqual(agenda.tools(), ["request_create", "request_approve", "request_status"]);
  const prompt = agenda.prompt({ engine: "cascade", lang: "de", tools: agenda.tools() });
  assert.match(prompt, /You are Toni, the DesklessOS assistant, on Max's own line/);
  assert.match(prompt, /"Moment, ich plane das\." and call request_create/);
  assert.match(prompt, /"Soll ich das so freigeben\?"/);
  assert.doesNotMatch(prompt, /\{\{|undefined/);
});
