import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadLocales, pickLanguage, LOCALES_DIR } from "../src/locale/index.ts";
import { checkLocales } from "../src/locale/check.ts";
import { createReplyParser, type ReplyHeader } from "../src/engine/reply.ts";
import { dangling, holdOn } from "../src/engine/endpointing.ts";

const shipped = loadLocales(LOCALES_DIR, { only: "de,en", fallback: "de" });

test("the shipped packs are German and English, and complete", () => {
  assert.deepEqual(shipped.enabled().sort(), ["de", "en"]);
  assert.deepEqual(checkLocales(shipped), {});
});

test("language for a call: user profile, then the carrier's tag, then the country code, then the fallback", () => {
  assert.equal(pickLanguage({ locales: shipped, userLang: "en", from: "+4917012345" }), "en");
  assert.equal(pickLanguage({ locales: shipped, dialTag: "en-US", from: "+4917012345" }), "en");
  assert.equal(pickLanguage({ locales: shipped, from: "+4917012345" }), "de");
  assert.equal(pickLanguage({ locales: shipped, from: "+41791234567" }), "de", "Switzerland");
  assert.equal(pickLanguage({ locales: shipped, from: "+14155550100" }), "en");
  assert.equal(pickLanguage({ locales: shipped, from: "+33612345678", fallback: "en" }), "en", "unknown country: the skill's fallback");
  assert.equal(pickLanguage({ locales: shipped, from: "+33612345678" }), "de", "then DEFAULT_LANG / the first pack");
  assert.equal(pickLanguage({ locales: shipped, dialTag: "fr-FR", from: "+4917012345" }), "de", "a tag we don't ship is ignored");
});

test("guessing the language of a sentence (Live mode has no LANG header)", () => {
  assert.equal(shipped.guess("Ich bin grad bei der Frau Weber und das Bad ist nicht fertig"), "de");
  assert.equal(shipped.guess("I just left the site and it is not done"), "en");
  assert.equal(shipped.guess("Okay"), null, "unsure: keep the current language");
  assert.equal(shipped.guess(undefined), null, "no text: unsure, not a TypeError (German has its own letters to look for)");
  assert.equal(shipped.guess(null), null);
});

test("voices: the pack's, overridable per language by env", () => {
  assert.equal(shipped.voice("de", "fish", {}), shipped.get("de").voices?.fish);
  assert.equal(shipped.voice("de", "fish", { FISH_VOICE_DE: "custom" }), "custom");
  assert.equal(shipped.voice("de", "fish", { FISH_VOICE: "old-deploy" }), "old-deploy", "FISH_VOICE still sets the default language's voice");
  assert.equal(shipped.voice("en", "fish", { FISH_VOICE: "old-deploy" }), shipped.get("en").voices?.fish, "but not the others'");
});

test("a new language is a new pack: the test-only 'xx' works without code changes", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "locales-"));
  for (const id of ["de", "en"]) copyFileSync(path.join(LOCALES_DIR, `${id}.json`), path.join(dir, `${id}.json`));
  copyFileSync(new URL("./fixtures/locales/xx.json", import.meta.url), path.join(dir, "xx.json"));
  const L = loadLocales(dir, { only: "de,en,xx", fallback: "de" });
  assert.deepEqual(checkLocales(L), {}, "xx is complete");
  assert.equal(L.forPhone("+99912345"), "xx");
  assert.equal(L.persona("xx", "notebook")?.greeting?.startsWith("xx:"), true);
  assert.equal(L.guess("zor blen ik da"), "xx");
  assert.equal(dangling("ik blen", L.lexicon("xx")), true);
  assert.equal(holdOn("wap, ik da", L.lexicon("xx")), true);
  const headers: ReplyHeader[] = [];
  const parser = createReplyParser({ langs: L.enabled(), onHeader: h => headers.push(h), onSentence: () => {} });
  parser.push("HEARD: zor\nLANG: xx\nNEXT: listen\n\nxx:Okay.");
  parser.end();
  assert.equal(headers[0]?.lang, "xx");
});

test("an incomplete pack is reported", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "locales-"));
  copyFileSync(path.join(LOCALES_DIR, "de.json"), path.join(dir, "de.json"));
  const broken = { ...JSON.parse(JSON.stringify(shipped.get("en"))), lex: undefined };
  delete broken.lex;
  delete broken.personas.notebook.examples.probes;
  broken.lexicon = { ...broken.lexicon, hold: undefined };
  writeFileSync(path.join(dir, "en.json"), JSON.stringify(broken));
  const problems = checkLocales(loadLocales(dir, { only: "de,en", fallback: "de" }));
  assert.ok(problems.en.some(p => p.includes("examples.probes")), JSON.stringify(problems));
  assert.ok(problems.en.some(p => p.includes("lexicon.hold")), JSON.stringify(problems));
});

test("Fish speaks each language with its pack's voice; the scripted caller keeps its own", async () => {
  const { createFish } = await import("../src/engine/fish.ts");
  const fish = createFish({ FISH_AUDIO_API_KEY: "test", FISH_VOICE: "caller-voice" });
  assert.equal(fish?.voiceFor(undefined), "caller-voice");
  assert.equal(fish?.voiceFor("en"), shipped.get("en").voices?.fish);
});

test("FISH_SPEED empty or not a number: the usual speed, not 0 (or null on the wire)", async () => {
  const { createFish } = await import("../src/engine/fish.ts");
  const original = globalThis.fetch;
  const speeds: unknown[] = [];
  globalThis.fetch = async (_url, init) => { speeds.push(JSON.parse(String(init?.body)).prosody.speed); return new Response(new Uint8Array(4), { status: 200 }); };
  try {
    for (const FISH_SPEED of ["", "fast", "0.9"]) assert.equal((await createFish({ FISH_AUDIO_API_KEY: "test", FISH_SPEED })?.synth("Hallo."))?.length, 4);
    assert.deepEqual(speeds, [1.05, 1.05, 0.9]);
  } finally { globalThis.fetch = original; }
});
