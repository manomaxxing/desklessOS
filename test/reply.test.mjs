import { test } from "node:test";
import assert from "node:assert/strict";
import { createReplyParser } from "../src/engine/reply.mjs";

function run(chunks) {
  const out = { header: null, sentences: [] };
  const p = createReplyParser({ onHeader: h => { out.header = h; }, onSentence: s => out.sentences.push(s) });
  for (const c of chunks) p.push(c);
  p.end();
  return out;
}

test("parses header and splits sentences while streaming", () => {
  const out = run(["HEARD: Ich komm von der Frau Müller.\nLANG: de\nNEXT: con", "firm\n\nAlles klar, notiert. ", "Bis wann soll das Angebot raus?"]);
  assert.deepEqual(out.header, { heard: "Ich komm von der Frau Müller.", lang: "de", next: "confirm", act: "none", present: true });
  assert.equal(out.sentences.join(" "), "Alles klar, notiert. Bis wann soll das Angebot raus?");
});

test("an empty HEARD line still parses NEXT", () => {
  const out = run(["HEARD:\nLANG: de\nNEXT: hangup\n\nGespeichert. Gute Fahrt!"]);
  assert.deepEqual(out.header, { heard: "", lang: "de", next: "hangup", act: "none", present: true });
  assert.match(out.sentences.join(" "), /Gespeichert/);
});

test("first chunk may end at a comma so the voice starts early", () => {
  const first = [];
  const p = createReplyParser({ onHeader() {}, onSentence: s => first.push(s) });
  p.push("HEARD: x\nLANG: de\nNEXT: confirm\n\nHerr Yilmaz in Giesing möchte fünfundzwanzig Quadratmeter Feinsteinzeug, ");
  assert.equal(first.length, 1, "released before the sentence ends");
  p.push("in Holzoptik im Wohnzimmer.");
  p.end();
  assert.equal(first.join(" "), "Herr Yilmaz in Giesing möchte fünfundzwanzig Quadratmeter Feinsteinzeug, in Holzoptik im Wohnzimmer.");
});

test("missing header falls back to speaking the text", () => {
  const out = run(["Sorry, kannst du das nochmal sagen? Ich hab dich nicht verstanden."]);
  assert.equal(out.header.next, "listen");
  assert.match(out.sentences.join(" "), /nochmal sagen/);
});

test("English turn, header lines in any order, no blank line", () => {
  const out = run(["HEARD: Just came from Mrs Miller's.\nNEXT: listen\nLA", "NG: en\nGot it. Which town was that in?"]);
  assert.deepEqual(out.header, { heard: "Just came from Mrs Miller's.", lang: "en", next: "listen", act: "none", present: true });
  assert.equal(out.sentences.join(" "), "Got it. Which town was that in?");
});

test("missing LANG leaves it empty (session keeps the last language)", () => {
  const out = run(["HEARD: Passt.\nNEXT: hangup\n\nGespeichert. Gute Fahrt!"]);
  assert.deepEqual(out.header, { heard: "Passt.", lang: "", next: "hangup", act: "none", present: true });
});

test("blank line inside the header, tags on the reply line", () => {
  const out = run(["HEARD: Passt\n\nLANG: de NEXT: hangup\nAlles klar, dann gute Fahrt!"]);
  assert.deepEqual(out.header, { heard: "Passt", lang: "de", next: "hangup", act: "none", present: true });
  assert.equal(out.sentences.join(" "), "Alles klar, dann gute Fahrt!");
});

test("tags leaked into the start of the reply are stripped", () => {
  const out = run(["HEARD: Passt\n\nLANG: de\nNEXT: hangup\n\nTschüss!"]);
  assert.deepEqual(out.header, { heard: "Passt", lang: "de", next: "hangup", act: "none", present: true });
  assert.equal(out.sentences.join(" "), "Tschüss!");
});

test("wait means silence", () => {
  const out = run(["HEARD: Also Küche und\nLANG: de\nNEXT: wait\n"]);
  assert.equal(out.header.next, "wait");
  assert.equal(out.sentences.length, 0);
});

test("DO: execute is parsed and never spoken", () => {
  const out = run(["HEARD: Ja, schick's raus.\nLANG: de\nNEXT: listen\nDO: execute\n\nMach ich."]);
  assert.deepEqual(out.header, { heard: "Ja, schick's raus.", lang: "de", next: "listen", act: "execute", present: true });
  assert.equal(out.sentences.join(" "), "Mach ich.");
});

test("DO squeezed onto the NEXT line", () => {
  const out = run(["HEARD: Yes.\nLANG: en\nNEXT: listen DO: execute\n\nOn it."]);
  assert.equal(out.header.act, "execute");
  assert.equal(out.sentences.join(" "), "On it.");
});

test("ask (an open question) is its own NEXT value", () => {
  const out = run(["HEARD: Ich komm grad vom Meier.\nLANG: de\nNEXT: ask\n\nWo war das nochmal?"]);
  assert.equal(out.header.next, "ask");
  assert.equal(out.sentences.join(" "), "Wo war das nochmal?");
});

test("a header that starts with LANG is still a header", () => {
  const out = run(["LANG: en\nNEXT: listen\n\nDone, the quote is out."]);
  assert.equal(out.header.present, true);
  assert.equal(out.header.next, "listen");
  assert.equal(out.sentences.join(" "), "Done, the quote is out.");
});

test("a reply without header is spoken at once, and says so", () => {
  const out = { header: null, sentences: [] };
  const p = createReplyParser({ onHeader: h => { out.header = h; }, onSentence: s => out.sentences.push(s) });
  p.push("Done. I've booked Friday and the quote went to Peter. ");
  assert.equal(out.header?.present, false, "no waiting for 40 characters");
  assert.equal(out.sentences.length, 1);
  p.end();
});

test("words that merely start like a tag are not a header", () => {
  const out = run(["Done, booked for Friday."]);
  assert.equal(out.header.present, false);
  assert.equal(out.sentences.join(" "), "Done, booked for Friday.");
});

test("flush() on a tool call: header done, preface spoken, more text may follow", () => {
  const out = { header: null, sentences: [] };
  const p = createReplyParser({ onHeader: h => { out.header = h; }, onSentence: s => out.sentences.push(s) });
  p.push("HEARD: Yes, go ahead.\nLANG: en\nNEXT: listen\n\nOn it.");
  assert.equal(out.sentences.length, 0, "a short preface waits for more text");
  p.flush();
  assert.deepEqual(out.sentences, ["On it."]);
  p.push("Let me just check.");
  p.end();
  assert.deepEqual(out.sentences, ["On it.", "Let me just check."]);
});

test("flush() with nothing written: an empty, absent header", () => {
  const out = { header: null, sentences: [] };
  const p = createReplyParser({ onHeader: h => { out.header = h; }, onSentence: s => out.sentences.push(s) });
  p.flush();
  assert.deepEqual(out.header, { heard: "", lang: "", next: "listen", act: "none", present: false });
  assert.equal(out.sentences.length, 0);
});
