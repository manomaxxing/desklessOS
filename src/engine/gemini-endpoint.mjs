// Where Gemini calls go and how they authenticate.
//
// Vertex AI first (the Google for Startups credits cover Vertex, not AI Studio):
//   GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION (default global), and one of
//   VERTEX_API_KEY | GOOGLE_SERVICE_ACCOUNT_JSON (raw or base64, for servers) |
//   `gcloud auth application-default` (local dev).
// AI Studio as the fallback door: GEMINI_BACKEND=studio, or no project, plus GEMINI_API_KEY.

import { execFile } from "node:child_process";
import { createSign } from "node:crypto";

let cached = { token: null, until: 0 };

function serviceAccount(env) {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  return JSON.parse(json);
}

// OAuth token from a service account key: a signed JWT traded at Google's token endpoint.
async function serviceAccountToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
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
  return (await res.json()).access_token;
}

function adcToken() {
  return new Promise((resolve, reject) => {
    execFile("gcloud", ["auth", "application-default", "print-access-token"], { timeout: 15000 }, (err, stdout) => {
      if (err) return reject(new Error("no Vertex credentials: run `gcloud auth application-default login`"));
      resolve(stdout.trim());
    });
  });
}

// One token fetch at a time, reused for 45 minutes (tokens live 60).
function vertexToken(env) {
  if (cached.token && cached.until > Date.now()) return cached.token;
  const sa = serviceAccount(env);
  cached = { until: Date.now() + 45 * 60 * 1000, token: sa ? serviceAccountToken(sa) : adcToken() };
  cached.token.catch(() => { cached = { token: null, until: 0 }; });
  return cached.token;
}

export function geminiEndpoint(env = process.env) {
  const project = (env.GOOGLE_CLOUD_PROJECT ?? "").trim();
  const studioKey = env.GEMINI_API_KEY?.trim();
  if (project && env.GEMINI_BACKEND !== "studio") {
    const location = env.GOOGLE_CLOUD_LOCATION?.trim() || "global";
    const host = location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
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
