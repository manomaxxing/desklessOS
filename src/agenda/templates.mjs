// Personas and templates, the data a call is built from.
//
// personas/<id>.md: who the agent is and how it sounds. A frontmatter block
//   (id, version, profile, capabilities, standing, agentLabel), then "## <name>"
//   sections of English text with {{slots}} (src/agenda/render.mjs) filled from
//   the locale pack: role, language, closing, sound, interruptions, silence,
//   next, agenda, extract, memory.
// templates/<id>.json: what a call can do. kind "capability" (he starts it:
//   capture, brief, order) or "objective" (the agent brings it: research,
//   inquiry). A template has a title, steps made of primitives
//   (src/agenda/primitives.mjs), the tools it may use, limits, and for
//   capabilities the note mode it stands for.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { primitives } from "./primitives.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PERSONAS_DIR = path.join(root, "personas");
export const TEMPLATES_DIR = path.join(root, "templates");
const PERSONA_SECTIONS = ["role", "language", "closing", "sound", "interruptions", "silence", "next", "agenda", "extract", "memory"];
const LIST_KEYS = new Set(["capabilities", "standing"]);

export function parsePersona(text, where = "persona") {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${where}: frontmatter (--- … ---) missing`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (!kv) continue;
    meta[kv[1]] = LIST_KEYS.has(kv[1]) ? kv[2].split(",").map(s => s.trim()).filter(Boolean) : kv[2].trim();
  }
  const sections = {};
  for (const part of m[2].split(/^## /m).slice(1)) {
    const nl = part.indexOf("\n");
    sections[part.slice(0, nl).trim()] = part.slice(nl + 1).trim();
  }
  for (const s of PERSONA_SECTIONS) if (!sections[s]) throw new Error(`${where}: section "## ${s}" missing`);
  if (!meta.id) throw new Error(`${where}: id missing`);
  return { ...meta, version: Number(meta.version || 1), capabilities: meta.capabilities ?? [], standing: meta.standing ?? [], sections };
}

export function loadPersona(id, dir = PERSONAS_DIR) {
  return parsePersona(readFileSync(path.join(dir, `${id}.md`), "utf8"), `personas/${id}.md`);
}

export function checkTemplate(t, where = t?.id ?? "template") {
  if (!t?.id || !/^[a-z][a-z0-9_.-]*$/.test(t.id)) throw new Error(`${where}: id missing or not lowercase`);
  if (!["capability", "objective"].includes(t.kind)) throw new Error(`${where}: kind must be capability or objective`);
  if (!t.title) throw new Error(`${where}: title missing`);
  if (!Array.isArray(t.steps) || !t.steps.length) throw new Error(`${where}: steps missing`);
  for (const s of t.steps) if (!primitives[s.primitive]) throw new Error(`${where}: unknown primitive "${s.primitive}"`);
  if (t.kind === "capability" && !t.mode?.id) throw new Error(`${where}: a capability needs mode.id`);
  return { version: 1, tools: [], limits: {}, ...t };
}

/** Every template in the directory, by id. */
export function loadTemplates(dir = TEMPLATES_DIR) {
  const out = new Map();
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
    const t = checkTemplate(JSON.parse(readFileSync(path.join(dir, f), "utf8")), `templates/${f}`);
    if (`${t.id}.json` !== f) throw new Error(`templates/${f}: id "${t.id}" doesn't match the file name`);
    out.set(t.id, t);
  }
  return out;
}
