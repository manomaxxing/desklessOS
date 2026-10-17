import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Languages live in locales/<id>.json. Code outside src/locale/ must not name one,
// or adding a language would mean hunting down another hard-coded "de".
const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(d => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith(".ts") ? [path.join(dir, d.name)] : []));

test("no language ids hard-coded in src/ outside src/locale/", () => {
  const hits = [];
  for (const file of files(src).filter(f => !f.includes(`${path.sep}locale${path.sep}`))) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (/["'`](de|en)["'`]|\b(de|en)-[A-Z]{2}\b/.test(line)) hits.push(`${path.relative(src, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});
