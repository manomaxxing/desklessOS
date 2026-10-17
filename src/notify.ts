// Tells Max when something he asked for came back. The outbox is the job queue: a closed
// request queues a "notify" job (src/admin/requests.ts), which this delivers; a failed
// delivery throws, and the queue retries it.
//   NOTIFY_WEBHOOK_URL   POST { type, text, request } (Slack/Make/n8n incoming webhooks)
//   RESEND_API_KEY + NOTIFY_EMAIL_TO [+ NOTIFY_EMAIL_FROM]   an email through Resend
// With neither set, results are only on the admin page.

export type Env = Record<string, string | undefined>;
export type NotifyChannel = "webhook" | "email";

/** One message to Max: `payload` is the webhook's JSON (with `text` added); the email gets subject and text. */
export interface Notification {
  subject: string;
  text: string;
  payload: Record<string, unknown>;
}

export interface Notifier {
  channels: NotifyChannel[];
  /** Delivers on every channel; throws if one fails (the outbox retries). */
  send(message: Notification): Promise<void>;
}

export function createNotifier({ env = process.env, fetchImpl = fetch }: { env?: Env; fetchImpl?: typeof fetch } = {}): Notifier {
  const webhook = env.NOTIFY_WEBHOOK_URL?.trim();
  const resendKey = env.RESEND_API_KEY?.trim();
  const to = env.NOTIFY_EMAIL_TO?.trim();
  const from = env.NOTIFY_EMAIL_FROM?.trim() || "DesklessOS <onboarding@resend.dev>";
  const channels: NotifyChannel[] = [];
  if (webhook) channels.push("webhook");
  if (resendKey && to) channels.push("email");

  return {
    channels,
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
