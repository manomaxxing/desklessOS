// Tells Max when something he asked for came back. The outbox is the request's
// notify_status (pending → sent | failed, retried): a closed request is marked
// pending in the same write that closes it, and this delivers it.
//   NOTIFY_WEBHOOK_URL   POST { type, text, request } (Slack/Make/n8n incoming webhooks)
//   RESEND_API_KEY + NOTIFY_EMAIL_TO [+ NOTIFY_EMAIL_FROM]   an email through Resend
// With neither set, results are only on the admin page.

export function createNotifier({ env = process.env, fetchImpl = fetch } = {}) {
  const webhook = env.NOTIFY_WEBHOOK_URL?.trim();
  const resendKey = env.RESEND_API_KEY?.trim();
  const to = env.NOTIFY_EMAIL_TO?.trim();
  const from = env.NOTIFY_EMAIL_FROM?.trim() || "DesklessOS <onboarding@resend.dev>";
  const channels = [webhook && "webhook", resendKey && to && "email"].filter(Boolean);

  return {
    channels,
    /** Delivers on every channel; throws if one fails (the outbox retries). */
    async send({ subject, text, payload }) {
      if (webhook) {
        const res = await fetchImpl(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...payload, text }), signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`webhook ${res.status}`);
      }
      if (resendKey && to) {
        const res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${resendKey}` }, signal: AbortSignal.timeout(10000),
          body: JSON.stringify({ from, to: to.split(",").map(s => s.trim()), subject, text }),
        });
        if (!res.ok) throw new Error(`email ${res.status}: ${(await res.text()).slice(0, 120)}`);
      }
    },
  };
}
