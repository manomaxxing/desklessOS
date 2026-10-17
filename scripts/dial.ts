// Dial self-hosted admin. Needs DIAL_API_KEY in .env.
//   npm run dial -- status
//   npm run dial -- request-access "<use case>" <company-url>    (once; Dial reviews it)
//   npm run dial -- activate wss://<host>/dial                    (ALL calls on the account go to that URL)
//   npm run dial -- disable                                       (back to Dial's managed agent)
//   npm run dial -- secret                                        (writes DIAL_SIGNING_SECRET into .env, never prints it)

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const KEY = process.env.DIAL_API_KEY;
const BASE = process.env.DIAL_API_BASE || "https://api.getdial.ai";
const [cmd, ...rest] = process.argv.slice(2);
if (!KEY) { console.error("set DIAL_API_KEY in .env"); process.exit(1); }

// The docs show both /v1/… and /api/v1/…; try the first, fall back on 404.
async function api(path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}) {
  for (const prefix of ["/v1", "/api/v1"]) {
    const res = await fetch(`${BASE}${prefix}${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && prefix === "/v1") continue;
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (!res.ok) throw new Error(`${method} ${prefix}${path} → ${res.status}: ${typeof json === "string" ? json.slice(0, 300) : JSON.stringify(json)}`);
    return json;
  }
}

const redact = obj => JSON.parse(JSON.stringify(obj, (k, v) => (/secret/i.test(k) && typeof v === "string" ? "…" : v)));

switch (cmd) {
  case "status":
    console.log(JSON.stringify(redact(await api("/self-hosted")), null, 2));
    break;
  case "request-access": {
    const [useCase, companyUrl] = rest;
    if (!useCase || !companyUrl) throw new Error('usage: request-access "<use case>" <company-url>');
    console.log(JSON.stringify(redact(await api("/self-hosted", { method: "POST", body: { action: "request_access", useCase, companyUrl } })), null, 2));
    break;
  }
  case "activate": {
    const [wsUrl] = rest;
    if (!wsUrl?.startsWith("wss://")) throw new Error("usage: activate wss://<host>/dial");
    const config = { type: "audio", wsUrl, audioInboundFormat: "l16_16000", audioOutboundFormat: "l16_16000" };
    console.log(JSON.stringify(redact(await api("/self-hosted", { method: "POST", body: { action: "activate", config } })), null, 2));
    console.log("\nActive: every call on this Dial account now goes to", wsUrl);
    break;
  }
  case "disable":
    console.log(JSON.stringify(redact(await api("/self-hosted", { method: "POST", body: { action: "disable" } })), null, 2));
    break;
  case "secret": {
    const res = await api("/self-hosted/secret?mode=audio");
    const secret = typeof res === "string" ? res : res.secret ?? res.signingSecret ?? res.value;
    if (!secret) throw new Error(`no secret in response (keys: ${Object.keys(res ?? {}).join(", ")})`);
    const env = existsSync(".env") ? readFileSync(".env", "utf8") : "";
    const line = `DIAL_SIGNING_SECRET=${secret}`;
    writeFileSync(".env", /^#?\s*DIAL_SIGNING_SECRET=.*$/m.test(env) ? env.replace(/^#?\s*DIAL_SIGNING_SECRET=.*$/m, line) : `${env.trimEnd()}\n${line}\n`);
    console.log("DIAL_SIGNING_SECRET written to .env (restart the server to require signatures)");
    break;
  }
  default:
    console.log(readFileSync(new URL(import.meta.url)).toString().split("\n").slice(0, 7).join("\n"));
}
