// Connects the WhatsApp number to our webhook and turns calling on, over the Graph API.
// Run once deploy/cloudrun.sh has deployed the WhatsApp service (its webhook must answer
// Meta's handshake):
//   npm run whatsapp:setup -- https://desklessos-wa-….run.app/whatsapp/webhook
// Reads WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_ID, WHATSAPP_APP_SECRET,
// WHATSAPP_BUSINESS_ACCOUNT_ID (when the token doesn't name it; a developer's token from API
// Setup doesn't) and SESSION_SECRET from deploy/env.production. Prints no secrets.

import { whatsappVerifyToken } from "../src/telephony/whatsapp.mjs";

const callback = process.argv[2];
const env = process.env;
const need = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_ID", "WHATSAPP_APP_SECRET"].filter(k => !env[k]?.trim());
if (!callback || need.length) {
  console.error(`usage: npm run whatsapp:setup -- https://<whatsapp service>/whatsapp/webhook${need.length ? `\nmissing in deploy/env.production: ${need.join(", ")}` : ""}`);
  process.exit(1);
}
const version = env.WHATSAPP_GRAPH?.trim() || "v26.0";
const token = env.WHATSAPP_TOKEN.trim();
const numberId = env.WHATSAPP_PHONE_NUMBER_ID.trim();
const appId = env.WHATSAPP_APP_ID.trim();
const appToken = `${appId}|${env.WHATSAPP_APP_SECRET.trim()}`;

async function graph(method, path, { auth = token, json, form } = {}) {
  const res = await fetch(`https://graph.facebook.com/${version}/${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, ...(json ? { "content-type": "application/json" } : {}) },
    body: json ? JSON.stringify(json) : form ? new URLSearchParams(form) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path.split("?")[0]}: ${body.error?.message ?? res.status}`);
  return body;
}
const step = async (label, fn) => {
  process.stdout.write(`→ ${label} … `);
  try { const out = await fn(); console.log(out ?? "ok"); return out; } catch (err) { console.log(`FAILED\n  ${err.message}`); process.exit(1); }
};

const waba = await step("the token and its WhatsApp Business Account", async () => {
  const { data } = await graph("GET", `debug_token?input_token=${encodeURIComponent(token)}`, { auth: appToken });
  if (!data?.is_valid) throw new Error("WHATSAPP_TOKEN isn't valid for this app");
  const ids = data.granular_scopes?.find(s => s.scope === "whatsapp_business_management")?.target_ids ?? [];
  const id = env.WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() || ids[0];
  if (!id) throw new Error("the token doesn't name its account: set WHATSAPP_BUSINESS_ACCOUNT_ID (API Setup shows it)");
  return `${id}${data.expires_at ? ` (token expires ${new Date(data.expires_at * 1000).toISOString().slice(0, 10)})` : " (token never expires)"}`;
}).then(s => s.split(" ")[0]);

await step(`webhook → ${callback} (calls, messages)`, () =>
  graph("POST", `${appId}/subscriptions`, { auth: appToken, form: { object: "whatsapp_business_account", callback_url: callback, verify_token: whatsappVerifyToken(env), fields: "calls,messages", include_values: "true" } }).then(() => "ok, Meta's handshake passed"));
await step("the account's webhooks go to this app", () => graph("POST", `${waba}/subscribed_apps`).then(() => "ok"));
await step("calling on (and callback permission when he calls us)", () =>
  graph("POST", `${numberId}/settings`, { json: { calling: { status: "ENABLED", callback_permission_status: "ENABLED" } } }).then(() => "ok"));
await step("the number", async () => {
  const n = await graph("GET", `${numberId}?fields=display_phone_number,verified_name,quality_rating`);
  const s = await graph("GET", `${numberId}/settings`);
  return `${n.display_phone_number} (${n.verified_name}), calling ${s.calling?.status ?? "?"}`;
});
console.log("\nDone. Call that number in WhatsApp from a number on the test list (API Setup).");
