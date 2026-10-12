import { test } from "node:test";
import assert from "node:assert/strict";
import { dangling, holdOn } from "../src/engine/endpointing.mjs";
import { loadLocales } from "../src/locale/index.mjs";

const L = loadLocales(undefined, { only: "de,en" });
const de = L.lexicon("de");
const en = L.lexicon("en");

test("a transcript that stops on a word no sentence ends on is unfinished", () => {
  for (const t of ["Hallo, ich komme gerade von der Frau Weber in Radolfzell, die will", "Also ich bin", "und dann die", "Bad und Küche, und", "Ich war beim Meier und äh", "die will…"]) {
    assert.equal(dangling(t, de), true, t);
  }
  for (const t of ["I just came from the", "and then we", "she wants…"]) assert.equal(dangling(t, en), true, t);
});

test("finished sentences and short answers are not", () => {
  for (const t of ["Und das Angebot soll bis Freitag raus.", "Passt", "Ja, passt.", "Nein, das war's", "Ich mach es", "Die will ein neues Bad", "", null]) {
    assert.equal(dangling(t, de), false, String(t));
  }
  assert.equal(dangling("That's it", en), false);
});

test("each language uses its own list: an English sentence can end on 'die'", () => {
  assert.equal(dangling("I hope the old pipes don't die", en), false);
  assert.equal(dangling("Und dann kommt die", de), true);
  assert.equal(dangling("whatever", undefined), false, "no lexicon: never dangling");
});

test("hold on: at the start, mid-utterance or the end, in German and English", () => {
  for (const t of ["Moment, ich muss kurz parken.", "Warte mal.", "Sekunde", "Eine Sekunde, ich hab noch einen Anruf.", "Ich schau mal nach, warte mal", "Lass mich kurz überlegen.", "Ich fahr gleich zu Frau Weber, Moment, ich muss kurz parken."]) {
    assert.equal(holdOn(t, de), true, t);
  }
  for (const t of ["Hold on.", "One sec, I'm parking", "Let me think."]) assert.equal(holdOn(t, en), true, t);
  for (const t of ["Im Moment hab ich viel zu tun.", "Das dauert eine Sekunde länger als gedacht, aber passt.", "Ich warte auf den Estrich.", "Der Moment, wo sie das Bad gesehen hat, war gut."]) {
    assert.equal(holdOn(t, de), false, t);
  }
});
