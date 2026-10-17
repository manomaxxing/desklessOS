// DesklessOS: a phone line for tradespeople. The parts are put together in src/app.ts;
// this file starts them and stops them cleanly.
//   npm run dev       → http://localhost:8787 (the browser test phone), memory in PGlite (data/pg)
//   npm run tunnel    → a public https URL for Dial / Twilio (cloudflared)
//   deploy/cloudrun.sh → Google Cloud Run (see docs/architecture.md)

import { createApp } from "./src/app.ts";

const app = await createApp();

// The last line of defence: an error nobody caught is logged, not fatal. Node would otherwise end
// the process, and with it every call on this instance (each error path should catch its own;
// this only keeps a missed one from dropping calls).
process.on("unhandledRejection", err => app.log("unhandled rejection:", err));
process.on("uncaughtException", err => app.log("uncaught exception:", err));

await app.start();

// Cloud Run sends SIGTERM before it stops an instance (a deploy, scaling down) and gives it 10 s.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    app.log(`${signal}: ending calls on this instance, then exiting`);
    await Promise.race([app.stop().catch(err => app.log("stopping failed:", err)), new Promise<void>(r => setTimeout(r, 8000))]);
    process.exit(0);
  });
}
