// Rewrites stored data from the old German keys to the v2 English keys
// (kunde_name → customer_name, modus notiz → mode capture, finding kind fakt → fact, …).
// Copies everything it touches to <DATA_DIR>/backups/<time>-migrate-keys/ first.
// Safe to run twice: already-migrated data comes back unchanged.
//   node scripts/migrate-keys.mjs --dry-run     what would change
//   node scripts/migrate-keys.mjs               do it (DATA_DIR=/data on Fly)

import { readdirSync, existsSync, mkdirSync, cpSync } from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "../src/store/files.mjs";
import { normalizeNote, normalizeMode, normalizeFinding } from "../src/store/note-keys.mjs";

const dry = process.argv.includes("--dry-run");
const root = process.env.DATA_DIR || "data";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const counts = {};
const writes = [];

function plan(file, before, after, kind) {
  if (same(before, after)) return;
  counts[kind] = (counts[kind] ?? 0) + 1;
  writes.push({ file, after });
}
const jsonFiles = dir => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")).map(f => path.join(dir, f)) : []);

for (const file of jsonFiles(path.join(root, "notes"))) {
  const note = readJson(file, null);
  plan(file, note, normalizeNote(note), "notes");
}
for (const file of jsonFiles(path.join(root, "calls"))) {
  const call = readJson(file, null);
  if (call?.note) plan(file, call, { ...call, note: normalizeNote(call.note) }, "call records");
}
const customersFile = path.join(root, "memory", "customers.json");
if (existsSync(customersFile)) {
  const all = readJson(customersFile, {});
  const after = Object.fromEntries(Object.entries(all).map(([id, c]) => [id, { ...c, history: (c.history ?? []).map(h => ({ ...h, type: normalizeMode(h.type) })) }]));
  plan(customersFile, all, after, "customer histories");
}
for (const file of jsonFiles(path.join(root, "memory", "pending"))) {
  const job = readJson(file, null);
  if (job?.note) plan(file, job, { ...job, note: normalizeNote(job.note) }, "pending memory jobs");
}
const findingsFile = path.join(root, "discovery", "findings.json");
if (existsSync(findingsFile)) {
  const list = readJson(findingsFile, []);
  plan(findingsFile, list, list.map(normalizeFinding), "findings file");
}

const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ") || "nothing to change";
if (dry) {
  console.log(`dry run in ${root}: ${summary}`);
  process.exit(0);
}
if (writes.length) {
  const backup = path.join(root, "backups", `${new Date().toISOString().replace(/[:.]/g, "-")}-migrate-keys`);
  for (const sub of ["notes", "calls", "memory", "discovery"]) {
    if (existsSync(path.join(root, sub))) cpSync(path.join(root, sub), path.join(backup, sub), { recursive: true, filter: src => !src.endsWith(".wav") });
  }
  mkdirSync(backup, { recursive: true });
  for (const w of writes) writeJson(w.file, w.after);
  console.log(`migrated in ${root}: ${summary}. Backup: ${backup}`);
} else {
  console.log(`${root}: ${summary}`);
}
