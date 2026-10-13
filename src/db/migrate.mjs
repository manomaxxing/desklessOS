// Applies src/db/migrations/NNN_name.sql in order, each once, each in its own
// transaction, and records it in schema_migrations. Safe to run on every start.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

export async function migrate(db, { dir = DIR, log = () => {} } = {}) {
  await db.exec("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query("select name from schema_migrations")).map(r => r.name));
  const applied = [];
  for (const file of readdirSync(dir).filter(f => /^\d+_.+\.sql$/.test(f)).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(path.join(dir, file), "utf8");
    await db.tx(async q => {
      for (const statement of splitSql(sql)) await q.query(statement);
      await q.query("insert into schema_migrations (name) values ($1)", [file]);
    });
    log(`migration ${file} applied`);
    applied.push(file);
  }
  return applied;
}

// Statements end at ";" outside quotes and $$ bodies; "--" comments are dropped.
export function splitSql(sql) {
  const out = [];
  let cur = "";
  let dollar = false;
  let quote = false;
  for (const line of sql.split("\n")) {
    if (!dollar && !quote && /^\s*--/.test(line)) continue;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (!quote && !dollar && line.startsWith("--", i)) break; // a comment runs to the end of the line
      if (!quote && line.startsWith("$$", i)) { dollar = !dollar; cur += "$$"; i++; continue; }
      if (!dollar && c === "'") quote = !quote;
      if (!dollar && !quote && c === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
      cur += c;
    }
    cur += "\n";
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
