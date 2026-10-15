// The server's settings, read from the environment once and checked at startup:
// a bad deploy fails at boot, not on the first call. Modules with settings of their
// own (Fish, Twilio, the admin login, …) read theirs where they're used.
//
// On Cloud Run (K_SERVICE is set) the defaults change: there's no disk, so Postgres
// (DATABASE_URL) is required, and background work runs inside HTTP requests (BACKGROUND=http).

import path from "node:path";

const ONE_OF = (name, value, allowed) => (allowed.includes(value) ? null : `${name}=${value}: ${allowed.join(" | ")}`);

export function loadConfig(env = process.env) {
  const cloudRun = Boolean(env.K_SERVICE);
  const dataDir = env.DATA_DIR || "data";
  const c = {
    cloudRun,
    port: Number(env.PORT || 8787),
    dataDir, // local runs only: PGlite's files, recorded call audio
    databaseUrl: env.DATABASE_URL?.trim() || `pglite:${path.join(dataDir, "pg")}`,
    model: env.GEMINI_MODEL || "gemini-3.5-flash",
    plannerModel: env.PLANNER_MODEL || "",
    // Phone calls: "cascade" (Gemini hears, Fish speaks) or "live" (Gemini Live hears and speaks)
    engine: env.ENGINE || "cascade",
    liveModel: env.LIVE_MODEL || "vertex-eu:gemini-3.8-live", // <door>:<model>, src/engine/live-endpoint.mjs
    liveVoice: env.LIVE_VOICE || "Kore",
    mask: env.MASK || "typing", // what the caller hears while Gemini thinks: typing | filler | none
    publicUrl: (env.PUBLIC_URL ?? "").trim().replace(/\/$/, ""),
    dialSecret: env.DIAL_SIGNING_SECRET?.trim() || "",
    devToken: env.DEV_TOKEN?.trim() || "",
    recordCalls: env.RECORD_CALLS === "1",
    background: env.BACKGROUND || (cloudRun ? "http" : "inline"),
    tickToken: env.TICK_TOKEN?.trim() || "",
    tickMs: Number(env.TICK_MS || 30000), // BACKGROUND=inline
    outbound: env.OUTBOUND || "twilio", // twilio | fake (tests) | off
    adminPhones: (env.ADMIN_PHONE ?? "").split(",").map(s => s.trim()).filter(Boolean),
    turnDetector: env.TURN_DETECTOR === "smart-turn",
    logFormat: env.LOG_FORMAT || (cloudRun ? "json" : "text"),
  };
  const problems = [
    ONE_OF("BACKGROUND", c.background, ["inline", "http"]),
    ONE_OF("OUTBOUND", c.outbound, ["twilio", "fake", "off"]),
    ONE_OF("MASK", c.mask, ["typing", "filler", "none"]),
    ONE_OF("ENGINE", c.engine, ["cascade", "live"]),
    cloudRun && c.databaseUrl.startsWith("pglite:") ? "DATABASE_URL: Cloud Run has no disk; set a Postgres URL (Supabase)" : null,
    c.background === "http" && !c.tickToken ? "BACKGROUND=http needs TICK_TOKEN (Cloud Scheduler sends it to /internal/tick)" : null,
    cloudRun && !c.devToken && !env.ADMIN_CODE ? "a public server needs DEV_TOKEN or ADMIN_CODE (the API and monitor are open otherwise)" : null,
  ].filter(Boolean);
  if (problems.length) throw new Error(`config: ${problems.join("; ")}`);
  return c;
}
