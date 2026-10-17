// Where Gemini calls go and how they authenticate.
//
// Vertex AI first (the Google for Startups credits cover Vertex, not AI Studio):
//   GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION (default global), and one of
//   VERTEX_API_KEY | GOOGLE_SERVICE_ACCOUNT_JSON (raw or base64) |
//   on Cloud Run: the service's own service account, from the metadata server (no key) |
//   `gcloud auth application-default` (local dev).
// AI Studio as the fallback door: GEMINI_BACKEND=studio, or no project, plus GEMINI_API_KEY.

import { execFile } from "node:child_process";
import { createSign } from "node:crypto";
import type { Endpoint } from "../types/gemini.ts";
import { isRecord } from "../shared/is-record.ts";

type Env = Record<string, string | undefined>;
/** Both doors can warm up (fetch the token ahead), so `warm` is always there. */
export type GeminiEndpoint = Required<Endpoint>;

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

let cached: { token: Promise<string> | null; until: number } = { token: null, until: 0 };

function serviceAccount(env: Env): ServiceAccount | null {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const sa: unknown = JSON.parse(json);
  if (!isRecord(sa) || typeof sa.client_email !== "string" || typeof sa.private_key !== "string") throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON: no client_email or private_key");
  return { client_email: sa.client_email, private_key: sa.private_key };
}

// The access token in a token answer (Google's OAuth endpoint, the metadata server).
function accessToken(body: unknown, from: string): string {
  if (!isRecord(body) || typeof body.access_token !== "string") throw new Error(`${from}: no access_token in the answer`);
  return body.access_token;
}

// OAuth token from a service account key: a signed JWT traded at Google's token endpoint.
async function serviceAccountToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const b64 = (obj: object) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key, "base64url");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }),
  });
  if (!res.ok) throw new Error(`service account token ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return accessToken(await res.json(), "service account token");
}

// On Cloud Run (and GCE): the attached service account's token, no key file anywhere.
// It may come back with only minutes left, so the cache goes by its own expiry.
async function metadataToken(): Promise<string> {
  const res = await fetch("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`metadata token ${res.status}`);
  const body: unknown = await res.json();
  const token = accessToken(body, "metadata token");
  // No expires_in (or not a number): keep the usual 45 minutes. NaN here made every request fetch a new token.
  const s = isRecord(body) ? Number(body.expires_in) : NaN;
  if (Number.isFinite(s)) cached.until = Math.min(cached.until, Date.now() + Math.max(0, (s - 120) * 1000));
  return token;
}

function adcToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gcloud", ["auth", "application-default", "print-access-token"], { timeout: 15000 }, (err, stdout) => {
      if (err) return reject(new Error("no Vertex credentials: run `gcloud auth application-default login`"));
      resolve(stdout.trim());
    });
  });
}

// One token fetch at a time, reused for 45 minutes (tokens live 60).
function vertexToken(env: Env): Promise<string> {
  if (cached.token && cached.until > Date.now()) return cached.token;
  const sa = serviceAccount(env);
  const token = sa ? serviceAccountToken(sa) : env.K_SERVICE ? metadataToken() : adcToken();
  cached = { until: Date.now() + 45 * 60 * 1000, token };
  token.catch(() => { cached = { token: null, until: 0 }; });
  return token;
}

export function geminiEndpoint(env: Env = process.env): GeminiEndpoint | null {
  const project = (env.GOOGLE_CLOUD_PROJECT ?? "").trim();
  const studioKey = env.GEMINI_API_KEY?.trim();
  if (project && env.GEMINI_BACKEND !== "studio") {
    const location = env.GOOGLE_CLOUD_LOCATION?.trim() || "global";
    // global; the multi-regions ("eu", "us": EU data residency is "eu") on their own hosts; or a region.
    const host = location === "global" ? "aiplatform.googleapis.com" : /^(eu|us)$/.test(location) ? `aiplatform.${location}.rep.googleapis.com` : `${location}-aiplatform.googleapis.com`;
    const key = env.VERTEX_API_KEY?.trim();
    return {
      door: "vertex",
      url: (model, method) => {
        const query = [method === "streamGenerateContent" ? "alt=sse" : "", key ? `key=${encodeURIComponent(key)}` : ""].filter(Boolean).join("&");
        return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:${method}${query ? `?${query}` : ""}`;
      },
      headers: async () => ({ "content-type": "application/json", ...(key ? {} : { authorization: `Bearer ${await vertexToken(env)}` }) }),
      // Fetch the token before a caller needs it (startup, and ahead of expiry).
      warm: async () => {
        if (key) return;
        if (cached.token && cached.until - Date.now() < 10 * 60 * 1000) cached = { token: null, until: 0 };
        await vertexToken(env);
      },
    };
  }
  if (studioKey) {
    return {
      door: "studio",
      url: (model, method) =>
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${method}?${method === "streamGenerateContent" ? "alt=sse&" : ""}key=${encodeURIComponent(studioKey)}`,
      headers: async () => ({ "content-type": "application/json" }),
      warm: async () => {},
    };
  }
  return null;
}
