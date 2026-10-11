// Small JSON-on-disk helpers shared by the stores.
// Writes are atomic (temp file + rename), so a crash mid-write never leaves half a file.
// A corrupt file throws instead of reading as empty: an empty read followed by a
// write would silently wipe all customers and to-dos.

import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";

export const dataDir = (sub, envName) => process.env[envName] || path.join(process.env.DATA_DIR || "data", sub);

export function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  const raw = readFileSync(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    try { copyFileSync(file, backup); } catch {}
    throw new Error(`${path.basename(file)} is not valid JSON (copy kept at ${backup}): ${err.message}`);
  }
}

export function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

export const slug = s => String(s ?? "").toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/^(frau|herr|familie|fam\.?|mrs?\.?|ms\.?|mr\.?)\s+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
