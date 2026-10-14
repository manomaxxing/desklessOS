// DesklessOS: a phone line for tradespeople. The parts are put together in src/app.mjs;
// this file starts them and stops them cleanly.
//   npm run dev       → http://localhost:8787 (the browser test phone), memory in PGlite (data/pg)
//   npm run tunnel    → a public https URL for Dial / Twilio (cloudflared)
//   deploy/cloudrun.sh → Google Cloud Run (see docs/architecture.md)

import { createApp } from "./src/app.mjs";

const app = await createApp();
await app.start();

// Cloud Run sends SIGTERM before it stops an instance (a deploy, scaling down) and gives it 10 s.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    app.log(`${signal}: ending calls on this instance, then exiting`);
    await Promise.race([app.stop(), new Promise(r => setTimeout(r, 8000))]);
    process.exit(0);
  });
}
