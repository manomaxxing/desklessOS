// Notes on disk: one JSON file per appointment in data/notes/.
// Plenty for a demo; swap for a database once there is more than one tradesperson.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function createNotesStore(dir = process.env.NOTES_DIR || "data/notes") {
  mkdirSync(dir, { recursive: true });
  return {
    list() {
      return readdirSync(dir)
        .filter(f => f.endsWith(".json"))
        .map(f => {
          try { return JSON.parse(readFileSync(path.join(dir, f), "utf8")); } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    },
    save(note) {
      const created_at = note.created_at ?? new Date().toISOString();
      const slug = (note.kunde_name || note.ort || "notiz").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      const id = note.id ?? `${created_at.replace(/[:.]/g, "-")}-${slug}`;
      const full = { ...note, id, created_at };
      writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(full, null, 2));
      return full;
    },
  };
}
