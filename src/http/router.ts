// The HTTP API as one table: method, path, who may call it, handler. Who's asking and what they
// may do: src/http/access.ts. A handler returns JSON, or { html }, { file, type } or
// { bytes, type, filename }; a thrown error with a `status` is answered with it.

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import type { Access, Who } from "./access.ts";
import type { Log } from "../types/common.ts";

export type Body = Record<string, unknown>;
export interface RouteCtx {
  req: IncomingMessage;
  url: URL;
  params: string[];
  body: Body;
  who: Who;
  setCookie(cookie: string): void;
}
export type RouteOut =
  | { html: Buffer | string }
  | { file: string; type: string }
  | { bytes: Uint8Array; type: string; filename: string }
  | object
  | null;
export type Handler = (ctx: RouteCtx) => RouteOut | Promise<RouteOut>;
/** [method, path (a regex's groups are the handler's params), access, handler] */
export type Route = readonly [method: "GET" | "POST", path: string | RegExp, access: Access, handler: Handler];

/** A path parameter (the route's regex groups, in order). */
export const param = (ctx: RouteCtx, i = 0): string => ctx.params[i] ?? "";

/** An error the API answers with its status and message. */
export const fail = (status: number, message: string): Error & { status: number } => Object.assign(new Error(message), { status });
const statusOf = (err: unknown): number | undefined => (err && typeof err === "object" && "status" in err && typeof err.status === "number" ? err.status : undefined);

const MAX_BODY = 1_000_000;
/** A JSON object body: read as bytes (a "ü" split across chunks stays one), 413 when too big, 400 when it isn't an object. */
export function readBody(req: IncomingMessage): Promise<Body> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(fail(413, "body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      let parsed: unknown;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { reject(fail(400, "not JSON")); return; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { reject(fail(400, "a JSON object, please")); return; }
      resolve(parsed as Body); // checked: a plain object
    });
    req.on("error", reject);
  });
}

export function send(res: ServerResponse, status: number, out: RouteOut, cookies: string[] = []): void {
  const base: Record<string, string | string[]> = { "cache-control": "no-store", ...(cookies.length ? { "set-cookie": cookies } : {}) };
  if (out && typeof out === "object") {
    if ("html" in out) { res.writeHead(status, { ...base, "content-type": "text/html; charset=utf-8" }); res.end(out.html); return; }
    if ("file" in out && typeof out.file === "string") { res.writeHead(status, { ...base, "content-type": out.type }); res.end(readFileSync(out.file)); return; }
    if ("bytes" in out) {
      res.writeHead(status, { ...base, "content-type": out.type, "content-disposition": `inline; filename="${out.filename.replace(/[^\w.-]/g, "_")}"` });
      res.end(Buffer.from(out.bytes));
      return;
    }
  }
  res.writeHead(status, { ...base, "content-type": "application/json" });
  res.end(JSON.stringify(out ?? null));
}

export interface RouterDeps {
  routes: readonly Route[];
  identify(req: IncomingMessage, url: URL): Promise<Who>;
  allowed(access: Access, who: Who, req: IncomingMessage): boolean;
  log: Log;
}

/** Answers a request if a route matches; false if none did. */
export function createRouter({ routes, identify, allowed, log }: RouterDeps) {
  return async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    for (const [method, match, access, fn] of routes) {
      let m: string[] | null;
      try {
        m = typeof match === "string" ? (url.pathname === match ? [] : null) : url.pathname.match(match)?.slice(1).map(p => decodeURIComponent(p ?? "")) ?? null;
      } catch {
        send(res, 400, { error: "bad URL encoding" }); // a malformed %-escape in a path parameter
        return true;
      }
      if (!m || (req.method !== method && !(method === "GET" && req.method === "HEAD"))) continue;
      const who: Who = access === "public" ? { dev: false, session: null, viaCookie: false } : await identify(req, url);
      if (!allowed(access, who, req)) {
        send(res, access === "owner" && who.session ? 403 : 401, { error: access === "owner" ? "only an owner can do this" : access === "admin" ? "admin login required" : "token required" });
        return true;
      }
      if (req.method === "POST" && who.viaCookie && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) { send(res, 415, { error: "JSON only" }); return true; }
      const cookies: string[] = [];
      try {
        const body = req.method === "POST" ? await readBody(req) : {};
        send(res, 200, await fn({ req, url, params: m, body, who, setCookie: c => cookies.push(c) }), cookies);
      } catch (err) {
        const status = statusOf(err) ?? 500;
        const message = err instanceof Error ? err.message : String(err);
        if (status >= 500) log("http error", req.method, url.pathname, message);
        send(res, status, { error: message });
      }
      return true;
    }
    return false;
  };
}
