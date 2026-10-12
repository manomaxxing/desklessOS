// Rebuilds long-term memory (customers, to-dos) from the saved notes, oldest first,
// running the same consolidation step a call runs at hang-up. The pilot's
// research log (data/discovery) is left alone: it comes from calls, not notes.
//   npm run rebuild-memory            (keeps existing memory and adds to it)
//   npm run rebuild-memory -- --fresh (wipes data/memory first)

import { rmSync } from "node:fs";
import path from "node:path";
import { geminiEndpoint } from "../src/engine/gemini-endpoint.mjs";
import { extractJson } from "../src/engine/gemini.mjs";
import { createNotesStore } from "../src/store/notes.mjs";
import { createMemory } from "../src/store/memory.mjs";
import { loadSkill } from "../src/skills/index.mjs";

if (process.argv.includes("--fresh")) rmSync(process.env.MEMORY_DIR || path.join(process.env.DATA_DIR || "data", "memory"), { recursive: true, force: true });
const skill = await loadSkill();
const endpoint = geminiEndpoint();
const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const memory = createMemory();
const store = createNotesStore();
const notes = [...store.list()].reverse();

for (const note of notes) {
  const { transcript = [], ...rest } = note;
  const run = () => extractJson({
    endpoint, model, system: skill.MEMORY_SYSTEM, schema: skill.MEMORY_SCHEMA,
    prompt: skill.memoryPrompt({ turns: transcript, note: rest, snapshot: memory.snapshot() }),
  });
  let result;
  try { result = await run(); } catch (err) {
    console.log(`  retrying ${note.id}: ${err.message}`);
    try { result = await run(); } catch (err2) { console.log(`  skipped ${note.id}: ${err2.message}`); continue; }
  }
  const changed = memory.apply(result, { callId: note.call_id, noteId: note.id, date: note.created_at.slice(0, 10), lang: note.sprache || "de" });
  if (changed.customer) store.update(note.id, { customerId: changed.customer.id });
  console.log(`${note.kunde_name || note.id}: ${changed.customer ? "customer " + changed.customer.id : "no customer"}, +${changed.added.length} to-dos, ${changed.completed.length} done`);
}
console.log(`\n${Object.keys(memory.customers()).length} customers, ${memory.actions().filter(a => a.status === "open").length} open to-dos`);
