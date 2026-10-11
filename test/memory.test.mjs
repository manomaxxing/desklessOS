import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMemory } from "../src/store/memory.mjs";
import { createNotesStore } from "../src/store/notes.mjs";

const tmp = () => mkdtempSync(path.join(tmpdir(), "deskless-"));
const mueller = {
  call_type: "notiz", call_summary: "Bad Müller aufgenommen.",
  customer: { name: "Frau Müller", place: "Unterhaching", summary_update: "Bad komplett neu." },
  new_actions: [{ text: "Angebot schicken", due: "2026-10-16" }], completed_action_ids: [],
};

test("a corrupt memory file throws instead of being overwritten with nothing", () => {
  const dir = tmp();
  writeFileSync(path.join(dir, "customers.json"), '{"mueller": {"name": "Frau Mü');
  const memory = createMemory(dir);
  assert.throws(() => memory.apply(mueller, { callId: "c1" }), /not valid JSON/);
  assert.match(readFileSync(path.join(dir, "customers.json"), "utf8"), /Frau Mü/, "original left alone");
  assert.ok(readdirSync(dir).some(f => f.startsWith("customers.json.corrupt-")), "backup kept");
});

test("writes leave no temp files and survive a fresh instance", () => {
  const dir = tmp();
  createMemory(dir).apply(mueller, { callId: "c1" });
  assert.deepEqual(readdirSync(dir).sort(), ["actions.json", "customers.json"]);
  const again = createMemory(dir);
  assert.equal(Object.values(again.customers())[0].name, "Frau Müller");
  assert.equal(again.actions()[0].status, "open");
});

test("context lists each customer with the specs from their notes", () => {
  const memory = createMemory(tmp());
  const store = createNotesStore(tmp());
  const note = store.save({
    modus: "notiz", kunde_name: "Frau Müller", ort: "Unterhaching", termin_datum: "2026-10-11",
    arbeiten: [{ raum: "Bad", bereich: "Boden", flaeche_m2: 8, fliese_format: "60x120", fliese_optik: "Beton", beschaffung: "Handwerker" }],
    naechste_schritte: [{ was: "Angebot", bis: "Freitag" }], zusammenfassung: "Bad komplett neu.",
  });
  const changed = memory.apply(mueller, { callId: "c1", noteId: note.id, date: "2026-10-11" });
  store.update(note.id, { customerId: changed.customer.id });
  assert.equal(store.get(note.id).customerId, changed.customer.id);

  const ctx = memory.context({ notes: store.list(), today: new Date("2026-10-11") });
  assert.match(ctx, /Frau Müller, Unterhaching/);
  assert.match(ctx, /note 2026-10-11 .*8 m² 60x120 Beton tiles: Handwerker/);
  assert.match(ctx, /Angebot schicken \| due 2026-10-16 \(in 5 d\)/);
  assert.doesNotMatch(ctx, /OTHER NOTES/);
});

test("notes without a customer link still match by name, others are listed separately", () => {
  const memory = createMemory(tmp());
  memory.apply(mueller, { callId: "c1" });
  const notes = [
    { id: "a", kunde_name: "Müller", ort: "Unterhaching", zusammenfassung: "alte Notiz" },
    { id: "b", kunde_name: "Huber", ort: "Pullach", zusammenfassung: "Terrasse" },
  ];
  const ctx = memory.context({ notes });
  assert.match(ctx, /Frau Müller[^\n]*\n {4}note [^\n]*alte Notiz/);
  assert.match(ctx, /OTHER NOTES[^]*Huber, Pullach \| Terrasse/);
});

test("notes store caches but sees its own saves and updates", () => {
  const dir = tmp();
  const store = createNotesStore(dir);
  assert.equal(store.list().length, 0);
  const a = store.save({ kunde_name: "A", created_at: "2026-10-10T08:00:00.000Z" });
  store.save({ kunde_name: "B", created_at: "2026-10-11T08:00:00.000Z" });
  assert.deepEqual(store.list().map(n => n.kunde_name), ["B", "A"]);
  store.update(a.id, { customerId: "a" });
  assert.equal(createNotesStore(dir).get(a.id).customerId, "a", "update hits disk");
  assert.equal(store.list().length, 2);
});
