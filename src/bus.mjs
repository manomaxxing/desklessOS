// Messages between the app's instances: Postgres NOTIFY on one channel. With one
// process (PGlite: local runs, tests) it's an in-process fan-out. A message reaches
// every subscriber on every instance, its own included, once.
//   publish({ type, … })   fire and forget; payloads over ~7.5 kB are cut down by the caller
//   subscribe(fn)          → unsubscribe
// Used for what one instance knows and another needs: Twilio's answering-machine
// verdict (it arrives on whichever instance got the webhook, the call may be on
// another), and the monitor's live events.

import { randomUUID } from "node:crypto";

const CHANNEL = "deskless";
export const MAX_PAYLOAD = 7500; // NOTIFY allows 8000 bytes

export async function createBus({ db = null, log = () => {} } = {}) {
  const instance = randomUUID().slice(0, 8);
  const subscribers = new Set();
  const deliver = msg => { for (const fn of subscribers) { try { fn(msg); } catch (err) { log("bus subscriber error", err.message); } } };
  let remote = db?.kind === "postgres";
  if (remote) {
    try {
      await db.listen(CHANNEL, payload => {
        let msg;
        try { msg = JSON.parse(payload); } catch { return; }
        if (msg.from !== instance) deliver(msg); // our own were delivered when published
      });
    } catch (err) {
      // e.g. a transaction pooler: one instance still works; several need LISTEN (docs/architecture.md §8)
      remote = false;
      log(`bus: LISTEN failed (${err.message}); messages stay on this instance`);
    }
  }
  return {
    instance,
    publish(msg) {
      const m = { ...msg, from: instance };
      deliver(m);
      if (!remote) return;
      const payload = JSON.stringify(m);
      if (payload.length > MAX_PAYLOAD) { log(`bus: ${msg.type} message too big (${payload.length} bytes), not sent to other instances`); return; }
      db.query("select pg_notify($1, $2)", [CHANNEL, payload]).catch(err => log("bus publish failed", err.message));
    },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
  };
}
