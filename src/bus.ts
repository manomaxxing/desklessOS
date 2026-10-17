// Messages between the app's instances: Postgres NOTIFY on one channel. With one
// process (PGlite: local runs, tests) it's an in-process fan-out. A message reaches
// every subscriber on every instance, its own included, once.
//   publish({ type, … })   fire and forget; payloads over ~7.5 kB are cut down by the caller
//   subscribe(fn)          → unsubscribe
// Used for what one instance knows and another needs: Twilio's answering-machine
// verdict (it arrives on whichever instance got the webhook, the call may be on
// another), and the monitor's live events.

import { randomUUID } from "node:crypto";
import type { Db } from "./db/client.ts";
import type { Log } from "./types/common.ts";

const CHANNEL = "deskless";
export const MAX_PAYLOAD = 7500; // NOTIFY allows 8000 bytes

/** One message on the bus: `type` says what it is; `from` is the instance that sent it. */
export interface BusMessage {
  type: string;
  from?: string;
  [key: string]: unknown;
}

export interface Bus {
  /** This instance's id: its own messages carry it in `from`. */
  instance: string;
  publish(msg: BusMessage): void;
  subscribe(fn: (msg: BusMessage) => void): () => void;
}

/** A payload's size as NOTIFY counts it: bytes, not characters (an umlaut is two). */
export const payloadBytes = (text: string): number => Buffer.byteLength(text, "utf8");

const isMessage = (v: unknown): v is BusMessage => typeof v === "object" && v !== null && "type" in v && typeof v.type === "string";
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function createBus({ db = null, log = () => {} }: { db?: Pick<Db, "kind" | "query" | "listen"> | null; log?: Log } = {}): Promise<Bus> {
  const instance = randomUUID().slice(0, 8);
  const subscribers = new Set<(msg: BusMessage) => void>();
  const deliver = (msg: BusMessage) => { for (const fn of subscribers) { try { fn(msg); } catch (err) { log("bus subscriber error", errText(err)); } } };
  let remote = false;
  if (db?.kind === "postgres" && db.listen) {
    try {
      await db.listen(CHANNEL, payload => {
        let msg: unknown;
        try { msg = JSON.parse(payload); } catch { return; }
        if (isMessage(msg) && msg.from !== instance) deliver(msg); // our own were delivered when published
      });
      remote = true;
    } catch (err) {
      // e.g. a transaction pooler: one instance still works; several need LISTEN (docs/architecture.md §8)
      log(`bus: LISTEN failed (${errText(err)}); messages stay on this instance`);
    }
  }
  return {
    instance,
    publish(msg) {
      const m = { ...msg, from: instance };
      deliver(m);
      if (!remote || !db) return;
      const payload = JSON.stringify(m);
      const bytes = payloadBytes(payload);
      if (bytes > MAX_PAYLOAD) { log(`bus: ${msg.type} message too big (${bytes} bytes), not sent to other instances`); return; }
      db.query("select pg_notify($1, $2)", [CHANNEL, payload]).catch((err: unknown) => log("bus publish failed", errText(err)));
    },
    subscribe(fn) { subscribers.add(fn); return () => { subscribers.delete(fn); }; },
  };
}
