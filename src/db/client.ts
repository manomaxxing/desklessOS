// One small query interface over two drivers:
//   postgres://…       Supabase (EU) through `postgres` (porsager); use the direct or
//                      session-pooler connection: transactions and SKIP LOCKED need it
//   pglite:memory      PGlite in this process (tests), pglite:<dir> on disk (local runs);
//                      a devDependency, loaded only when asked for
// db.query<Row>(text, params) → rows; db.tx(async q => …) runs one transaction, q has the same query().
// db.listen(channel, fn) gets NOTIFYs (Postgres only: one extra connection; through Supabase's
// session pooler or a direct connection, not the transaction pooler).
// Every connection runs with search_path <DB_SCHEMA>, extensions: the app's tables live in
// DB_SCHEMA (default public; "deskless" when it shares a Supabase project with another app),
// and Supabase keeps extensions such as vector and pg_trgm in their own schema.

/** A query parameter. json/jsonb values go in already encoded (JSON.stringify). */
export type SqlParam = string | number | boolean | bigint | null | undefined | Date | Buffer | readonly string[] | readonly number[];

/** Something that runs queries: the pool, or one transaction. `Row` is what the caller expects back. */
export interface Queryable {
  query<Row extends object = Record<string, unknown>>(text: string, params?: readonly SqlParam[]): Promise<Row[]>;
}

export interface Db extends Queryable {
  kind: "postgres" | "pglite";
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  exec(text: string): Promise<unknown>;
  /** NOTIFYs on a channel (Postgres only). */
  listen?(channel: string, fn: (payload: string) => void): Promise<unknown>;
  close(): Promise<void>;
}

// The app passes json/jsonb values already encoded (JSON.stringify), which PGlite takes as is.
// postgres.js would JSON.stringify them again and store a quoted string, so its json
// serializer lets strings through.
export const pgTypes = {
  json: { to: 114, from: [114, 3802], serialize: (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)), parse: (x: string): unknown => JSON.parse(x) },
};

export async function openDb(url = process.env.DATABASE_URL, schema = process.env.DB_SCHEMA || "public"): Promise<Db> {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`DB_SCHEMA=${schema}: a plain lowercase name`);
  if (!url) throw new Error("no DATABASE_URL (postgres://… or pglite:memory | pglite:<dir>)");
  if (url.startsWith("pglite:")) return openPglite(url.slice("pglite:".length));
  const { default: postgres } = await import("postgres");
  const sql = postgres(url, {
    max: Number(process.env.DB_POOL || 5),
    idle_timeout: 30,
    prepare: !/pooler\.supabase\.com:6543/.test(url), // the transaction pooler can't keep prepared statements
    connection: { search_path: `${schema}, extensions`, application_name: "desklessos" },
    types: pgTypes,
    onnotice: () => {},
  });
  // postgres.js types its parameters for its tagged-template API; unsafe() takes our plain values as they are.
  type Unsafe = { unsafe(text: string, params?: readonly SqlParam[]): PromiseLike<object[]> };
  const wrap = (q: Unsafe): Queryable => ({
    query: async <Row extends object>(text: string, params: readonly SqlParam[] = []) => (await q.unsafe(text, params)) as Row[],
  });
  return {
    kind: "postgres",
    ...wrap(sql as unknown as Unsafe),
    tx: <T>(fn: (q: Queryable) => Promise<T>) => sql.begin(tx => fn(wrap(tx as unknown as Unsafe))) as Promise<T>,
    exec: text => sql.unsafe(text),
    listen: (channel, fn) => sql.listen(channel, fn),
    close: () => sql.end({ timeout: 5 }),
  };
}

async function openPglite(where: string): Promise<Db> {
  const [{ PGlite }, { vector }, { pg_trgm }, { unaccent }] = await Promise.all([
    import("@electric-sql/pglite"),
    import("@electric-sql/pglite-pgvector"),
    import("@electric-sql/pglite/contrib/pg_trgm"),
    import("@electric-sql/pglite/contrib/unaccent"),
  ]);
  const pg = new PGlite({ ...(where && where !== "memory" ? { dataDir: where } : {}), extensions: { vector, pg_trgm, unaccent } });
  await pg.exec("create schema if not exists extensions; set search_path = public, extensions;");
  type Pg = { query<Row>(text: string, params?: unknown[]): Promise<{ rows: Row[] }> };
  const wrap = (q: Pg): Queryable => ({
    query: async <Row extends object>(text: string, params: readonly SqlParam[] = []) => (await q.query<Row>(text, [...params])).rows,
  });
  let chain: Promise<unknown> = Promise.resolve(); // PGlite is one connection: transactions wait their turn
  return {
    kind: "pglite",
    ...wrap(pg),
    tx: <T>(fn: (q: Queryable) => Promise<T>) => {
      const run = chain.catch(() => {}).then(() => pg.transaction(tx => fn(wrap(tx))));
      chain = run;
      return run;
    },
    exec: text => pg.exec(text),
    close: () => pg.close(),
  };
}
