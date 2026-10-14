// One small query interface over two drivers:
//   postgres://…       Supabase (EU) through `postgres` (porsager); use the direct or
//                      session-pooler connection: transactions and SKIP LOCKED need it
//   pglite:memory      PGlite in this process (tests), pglite:<dir> on disk (local runs);
//                      a devDependency, loaded only when asked for
// db.query(text, params) → rows; db.tx(async q => …) runs one transaction, q has the same query().
// db.listen(channel, fn) gets NOTIFYs (Postgres only: one extra connection; through Supabase's
// session pooler or a direct connection, not the transaction pooler).
// Every connection runs with search_path public, extensions (Supabase keeps
// extensions such as vector and pg_trgm in their own schema).

export async function openDb(url = process.env.DATABASE_URL) {
  if (!url) throw new Error("no DATABASE_URL (postgres://… or pglite:memory | pglite:<dir>)");
  if (url.startsWith("pglite:")) return openPglite(url.slice("pglite:".length));
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, {
    max: Number(process.env.DB_POOL || 5),
    idle_timeout: 30,
    prepare: !/pooler\.supabase\.com:6543/.test(url), // the transaction pooler can't keep prepared statements
    connection: { search_path: "public, extensions", application_name: "desklessos" },
    onnotice: () => {},
  });
  const wrap = q => ({ query: (text, params = []) => q.unsafe(text, params) });
  return {
    kind: "postgres",
    ...wrap(sql),
    tx: fn => sql.begin(tx => fn(wrap(tx))),
    exec: text => sql.unsafe(text),
    listen: (channel, fn) => sql.listen(channel, fn),
    close: () => sql.end({ timeout: 5 }),
  };
}

async function openPglite(where) {
  const [{ PGlite }, { vector }, { pg_trgm }, { unaccent }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite-pgvector"),
    import("@electric-sql/pglite/contrib/pg_trgm"),
    import("@electric-sql/pglite/contrib/unaccent"),
  ]);
  const pg = new PGlite({ ...(where && where !== "memory" ? { dataDir: where } : {}), extensions: { vector, pg_trgm, unaccent } });
  await pg.exec("create schema if not exists extensions; set search_path = public, extensions;");
  const wrap = q => ({ query: async (text, params = []) => (await q.query(text, params)).rows });
  let chain = Promise.resolve(); // PGlite is one connection: transactions wait their turn
  return {
    kind: "pglite",
    ...wrap(pg),
    tx: fn => (chain = chain.catch(() => {}).then(() => pg.transaction(tx => fn(wrap(tx))))),
    exec: text => pg.exec(text),
    close: () => pg.close(),
  };
}
