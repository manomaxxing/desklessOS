import { test } from "node:test";
import assert from "node:assert/strict";
import { dangling, holdOn } from "../src/engine/endpointing.mjs";

test("a transcript that stops on a word no sentence ends on is unfinished", () => {
  for (const t of ["Hallo, ich komme gerade von der Frau Weber in Radolfzell, die will", "Also ich bin", "und dann die", "Bad und Küche, und", "Ich war beim Meier und äh", "die will…", "I just came from the", "and then we"]) {
    assert.equal(dangling(t), true, t);
  }
});

test("finished sentences and short answers are not", () => {
  for (const t of ["Und das Angebot soll bis Freitag raus.", "Passt", "Ja, passt.", "Nein, das war's", "Ich mach es", "Die will ein neues Bad", "That's it", "", null]) {
    assert.equal(dangling(t), false, String(t));
  }
});

test("hold on: at the start or the end, German and English", () => {
  for (const t of ["Moment, ich muss kurz parken.", "Warte mal.", "Sekunde", "Eine Sekunde, ich hab noch einen Anruf.", "Ich schau mal nach, warte mal", "Lass mich kurz überlegen.", "Hold on.", "One sec, I'm parking", "Ich fahr gleich zu Frau Weber, Moment, ich muss kurz parken."]) {
    assert.equal(holdOn(t), true, t);
  }
  for (const t of ["Im Moment hab ich viel zu tun.", "Das dauert eine Sekunde länger als gedacht, aber passt.", "Ich warte auf den Estrich.", "Der Moment, wo sie das Bad gesehen hat, war gut."]) {
    assert.equal(holdOn(t), false, t);
  }
});
