// The tradesperson's calendar: data/calendar/events.json.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataDir, readJson, writeJson } from "./files.mjs";

export function createCalendar(dir = dataDir("calendar", "CALENDAR_DIR")) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "events.json");
  let cache = null;
  const all = () => (cache ??= readJson(file, []));
  const save = list => { writeJson(file, list); cache = list; };
  return {
    list({ from, to } = {}) {
      return all().filter(e => (!from || e.end >= from) && (!to || e.start <= to)).sort((a, b) => a.start.localeCompare(b.start));
    },
    add(event) {
      const e = { id: randomUUID().slice(0, 8), createdAt: new Date().toISOString(), ...event };
      save([...all(), e]);
      return e;
    },
    remove(id) { save(all().filter(e => e.id !== id)); },
    clear() { save([]); },
    reset() { cache = null; mkdirSync(dir, { recursive: true }); },
  };
}
