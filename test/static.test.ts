// The pages' files (src/http/static.ts): never outside web/, TypeScript served as JavaScript,
// revalidated with an ETag, HTML never cached.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { serveStatic } from "../src/http/static.ts";

async function withServer(fn: (base: string) => Promise<void>) {
  const server = http.createServer((req, res) => serveStatic(req, res, new URL(req.url ?? "/", "http://x")));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try { await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
}
// fetch normalises "..", so raw paths go out through http.request.
const raw = (base: string, p: string) => new Promise<number>((resolve, reject) => {
  const u = new URL(base);
  http.get({ host: u.hostname, port: u.port, path: p }, res => { res.resume(); resolve(res.statusCode ?? 0); }).on("error", reject);
});

test("static: the page's TypeScript arrives as JavaScript, cached by ETag; HTML is no-store", async () => {
  await withServer(async base => {
    const ts = await fetch(`${base}/shared/format.ts`);
    assert.equal(ts.status, 200);
    assert.match(ts.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.equal(ts.headers.get("cache-control"), "no-cache");
    const body = await ts.text();
    assert.match(body, /export const fmtDur = \(ms\s*\)/, "its types are gone (fmtDur takes ms: number)");
    const etag = ts.headers.get("etag") ?? "";
    assert.ok(etag);
    const again = await fetch(`${base}/shared/format.ts`, { headers: { "if-none-match": etag } });
    assert.equal(again.status, 304);
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(await page.text(), /<html/i);
  });
});

test("static: nothing outside web/, no directories, nothing but GET and HEAD", async () => {
  await withServer(async base => {
    for (const p of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/shared/../../server.ts", "/shared", "/shared/", "/nope.ts"]) {
      assert.equal(await raw(base, p), 404, p);
    }
    assert.equal((await fetch(`${base}/index.html`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/index.html`, { method: "HEAD" })).status, 200);
  });
});
