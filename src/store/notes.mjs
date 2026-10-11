// Notes on disk: one JSON file per appointment in data/notes/.
// Kept in memory after the first read: the fast path builds its prompt from
// them on every turn, and parsing every file per turn grows with every call.

import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { dataDir, readJson, writeJson, slug } from "./files.mjs";

export function createNotesStore(dir = dataDir("notes", "NOTES_DIR")) {
  mkdirSync(dir, { recursive: true });
  let cache = null;

  function load() {
    if (cache) return cache;
    cache = readdirSync(dir)
      .filter(f => f.endsWith(".json"))
      .map(f => {
        try { return readJson(path.join(dir, f), null); } catch (err) { console.warn(`skipping note ${f}: ${err.message}`); return null; }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return cache;
  }

  return {
    /** Newest first. Treat as read-only. */
    list: () => load(),
    get: id => load().find(n => n.id === id) ?? null,
    save(note) {
      const created_at = note.created_at ?? new Date().toISOString();
      const id = note.id ?? `${created_at.replace(/[:.]/g, "-")}-${slug(note.customer_name || note.kunde_name || note.ort || "notiz").slice(0, 40)}`;
      const full = { ...note, id, created_at };
      writeJson(path.join(dir, `${id}.json`), full);
      cache = [full, ...load().filter(n => n.id !== id)].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return full;
    },
    reset() { cache = null; mkdirSync(dir, { recursive: true }); },
    /** Merges fields into a saved note (e.g. the customer id once memory knows it). */
    update(id, patch) {
      const note = load().find(n => n.id === id);
      return note ? this.save({ ...note, ...patch }) : null;
    },
  };
}
