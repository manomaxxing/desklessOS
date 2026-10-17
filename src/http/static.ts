// The pages (/admin, /monitor: the HTML; / is the test phone) and the files they load from web/.
// Their TypeScript reaches the browser without a build: the types are stripped here (positions
// kept, so the browser's line:column is the file's). Files are kept in memory by path, mtime and
// size, and revalidated with an ETag (no-cache), so an unchanged file costs a 304. HTML is
// no-store: it's small, and it names the current modules.

import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Route } from "./router.ts";
import { send } from "./router.ts";

export const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "web");
const JS = "text/javascript; charset=utf-8";
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": JS, ".mjs": JS, ".ts": JS, ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
};

const page = (name: string) => ({ html: readFileSync(path.join(WEB, name)) });
export const pageRoutes: Route[] = [
  ["GET", "/admin", "public", () => page("admin.html")],
  ["GET", "/monitor", "user", () => page("monitor.html")],
];

interface StaticFile {
  mtimeMs: number;
  size: number;
  body: Buffer;
  etag: string;
  type: string;
}
const cache = new Map<string, StaticFile>(); // full path → the file as served

/** A file under web/ (never outside it, never a directory), as served; null if there's none. */
export function staticFile(urlPath: string): StaticFile | null {
  const full = path.join(WEB, path.normalize(`/${urlPath}`)); // rooted first: ".." can't climb out of web/
  if (!full.startsWith(WEB + path.sep)) return null;
  const st = statSync(full, { throwIfNoEntry: false });
  if (!st?.isFile()) return null;
  const hit = cache.get(full);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit;
  let body = readFileSync(full);
  if (full.endsWith(".ts")) body = Buffer.from(stripTypeScriptTypes(body.toString("utf8"), { mode: "strip" }));
  const file: StaticFile = { mtimeMs: st.mtimeMs, size: st.size, body, etag: `"${createHash("sha256").update(body).digest("base64url")}"`, type: MIME[path.extname(full)] ?? "application/octet-stream" };
  cache.set(full, file);
  return file;
}

/** GET or HEAD for a file under web/, or a 404. */
export function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const f = req.method === "GET" || req.method === "HEAD" ? staticFile(url.pathname === "/" ? "index.html" : url.pathname.slice(1)) : null;
  if (!f) { send(res, 404, { error: "not found" }); return; }
  if (f.type.startsWith("text/html")) {
    res.writeHead(200, { "cache-control": "no-store", "content-type": f.type, "content-length": f.body.length });
    res.end(f.body);
    return;
  }
  const headers = { "cache-control": "no-cache", etag: f.etag, "content-type": f.type };
  const tags = String(req.headers["if-none-match"] ?? "").split(/\s*,\s*/);
  if (tags.some(t => t === "*" || t.replace(/^W\//, "") === f.etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, "content-length": f.body.length });
  res.end(f.body); // (no body on a HEAD: node leaves it out)
}
