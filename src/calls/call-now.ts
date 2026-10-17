// A call Toni makes on WhatsApp, now (the People card's "Call now"): placed on the service that
// holds the call's audio (WHATSAPP_CALLS_URL), or here; only ever to our own users' numbers.

import type { Memory } from "../memory/pg.ts";
import type { Log } from "../types/common.ts";
import type { Adapter } from "../http/deps.ts";
import { e164 } from "../memory/rows.ts";

export interface CallNow {
  /** One of our users' numbers. */
  to?: unknown;
  /** A user id: Max plays that person (his memory, read only). */
  rehearsalOf?: unknown;
  /** What the call is for. */
  objectives?: unknown;
}

const fail = (status: number, message: string): Error & { status: number } => Object.assign(new Error(message), { status });

export function createCallNow({ memory, adapters, objectiveParams, callsUrl, tickToken, log }: {
  memory: Pick<Memory, "listUsers">;
  adapters: Adapter[];
  objectiveParams(templateId: string, params: unknown): Record<string, unknown>;
  callsUrl: string;
  tickToken: string;
  log: Log;
}) {
  /** Places it on this instance. */
  async function placeHere(body: CallNow): Promise<{ callId: string }> {
    const whatsapp = adapters.find(a => a.id === "whatsapp");
    if (!whatsapp?.dialOut) throw fail(503, "no WhatsApp here");
    const users = await memory.listUsers();
    const to = users.find(u => u.phone && u.phone === e164(body.to))?.phone;
    if (!to) throw fail(400, "to: only our own users' numbers");
    const rehearsalOf = typeof body.rehearsalOf === "string" && body.rehearsalOf ? body.rehearsalOf : null;
    const played = rehearsalOf ? users.find(u => u.id === rehearsalOf) : null;
    if (rehearsalOf && !played) throw fail(400, "rehearsalOf: no such user");
    const objectives = [body.objectives ?? []].flat().map(o => {
      const { template, params } = (o ?? {}) as { template?: unknown; params?: unknown }; // checked by objectiveParams
      if (typeof template !== "string") throw fail(400, "objectives: each needs a template");
      return { template, params: objectiveParams(template, params ?? {}) };
    });
    const placed = await whatsapp.dialOut({ to, extra: { rehearsal_of: rehearsalOf, objectives } }).catch((err: Error) => {
      const permission = /permission/i.test(err.message);
      throw fail(permission ? 409 : 502, permission ? "WhatsApp: he hasn't allowed Toni's calls yet" : err.message);
    });
    log(`whatsapp: calling ${to}${played ? ` (a rehearsal of a call to ${played.name})` : ""}`);
    return placed;
  }

  /** Where the call's audio lives: the WhatsApp service (WHATSAPP_CALLS_URL), or here. */
  async function place(body: CallNow): Promise<{ callId: string }> {
    if (!callsUrl) return placeHere(body);
    const res = await fetch(`${callsUrl}/internal/whatsapp/call`, {
      method: "POST", headers: { "content-type": "application/json", "x-tick-token": tickToken }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    const out = (await res.json().catch(() => ({}))) as { error?: string; callId?: string };
    if (!res.ok || !out.callId) throw fail(res.ok ? 502 : res.status, out.error ?? `the WhatsApp service answered ${res.status}`);
    return { ...out, callId: out.callId };
  }

  return { placeHere, place };
}
