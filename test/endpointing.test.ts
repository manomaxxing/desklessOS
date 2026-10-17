import { test } from "node:test";
import assert from "node:assert/strict";
import { dangling, holdOn, misheard } from "../src/engine/endpointing.ts";
import { loadLocales } from "../src/locale/index.ts";

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

test("a plain yes, for actions with consequences: a yes word and nothing that takes it back", async () => {
  const { affirmed } = await import("../src/engine/endpointing.ts");
  const { locales } = await import("../src/locale/index.ts");
  const de = locales().lexicon("de"), en = locales().lexicon("en");
  for (const t of ["Ja, schick's mir.", "Genau so.", "ja bitte", "Passt, ne?", "Okay, mach."]) assert.equal(affirmed(t, de), true, t);
  for (const t of ["Ja, aber erst morgen", "Nee, warte mal", "Schick es nicht", "Moment", "", "(not transcribed)", "Hm."]) assert.equal(affirmed(t, de), false, t);
  assert.equal(affirmed("Sure, send it", en), true);
  assert.equal(affirmed("Yeah, but wait", en), false);
});

test("misheard, checked in code: no goodbye to words nobody said, no answer to a copied transcript", () => {
  assert.equal(misheard("00:00", { next: "hangup" }), "a goodbye to words nobody understood", "the call that hung up on \"00:00\"");
  assert.equal(misheard("(unclear)", { next: "hangup" }), "a goodbye to words nobody understood");
  assert.equal(misheard("", { next: "hangup" }), "a goodbye to words nobody understood");
  assert.equal(misheard("Tschüss!", { next: "hangup" }), "", "a real goodbye");
  assert.equal(misheard("00:00", { next: "ask" }), "", "not ending the call: the model's own unclear handling");
  const last = "Genau, erinner mich dran, dass wir es bis Freitag ausschicken.";
  assert.equal(misheard("genau erinner mich dran dass wir es bis freitag ausschicken", { next: "confirm", lastUser: last }), "the transcript repeats his last turn");
  assert.equal(misheard(last, { next: "confirm", lastUser: last, askedToRepeat: true }), "", "after \"say that again?\" he may well say it again");
  assert.equal(misheard("Ja.", { next: "listen", lastUser: "Ja." }), "", "short answers repeat for real");
  assert.equal(misheard("Ja, passt.", { next: "listen", lastUser: last }), "");
});
