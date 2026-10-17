// The server's settings, read from the environment once and checked at startup:
// a bad deploy fails at boot, not on the first call. Modules with settings of their
// own (Fish, Twilio, the admin login, …) read theirs where they're used.
//
// On Cloud Run (K_SERVICE is set) the defaults change: there's no disk, so Postgres
// (DATABASE_URL) is required, background work runs inside HTTP requests (BACKGROUND=http),
// and sessions must be signed with a SESSION_SECRET of their own.

import path from "node:path";

export type Engine = "cascade" | "live";
export type Mask = "typing" | "filler" | "none";
export type BackgroundMode = "inline" | "http";
export type Outbound = "twilio" | "fake" | "off";

const ENGINES = ["cascade", "live"] as const;
const MASKS = ["typing", "filler", "none"] as const;
const BACKGROUNDS = ["inline", "http"] as const;
const OUTBOUNDS = ["twilio", "fake", "off"] as const;

/** A setting that must be one of a few values: the value, or a problem to report. */
function oneOf<T extends string>(name: string, value: string, allowed: readonly T[], problems: string[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T; // just checked
  problems.push(`${name}=${value}: ${allowed.join(" | ")}`);
  return allowed[0]!;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const cloudRun = Boolean(env.K_SERVICE);
  const dataDir = env.DATA_DIR || "data";
  const problems: string[] = [];
  const c = {
    cloudRun,
    port: Number(env.PORT || 8787),
    dataDir, // local runs only: PGlite's files, recorded call audio
    databaseUrl: env.DATABASE_URL?.trim() || `pglite:${path.join(dataDir, "pg")}`,
    model: env.GEMINI_MODEL || "gemini-3.5-flash",
    plannerModel: env.PLANNER_MODEL || "",
    // Phone calls: "cascade" (Gemini hears, Fish speaks) or "live" (Gemini Live hears and speaks)
    engine: oneOf<Engine>("ENGINE", env.ENGINE || "cascade", ENGINES, problems),
    liveModel: env.LIVE_MODEL || "vertex-eu:gemini-3.8-live", // <door>:<model>, src/engine/live-endpoint.ts
    liveVoice: env.LIVE_VOICE || "Kore",
    mask: oneOf<Mask>("MASK", env.MASK || "typing", MASKS, problems), // what the caller hears while Gemini thinks
    publicUrl: (env.PUBLIC_URL ?? "").trim().replace(/\/$/, ""),
    dialSecret: env.DIAL_SIGNING_SECRET?.trim() || "",
    devToken: env.DEV_TOKEN?.trim() || "",
    recordCalls: env.RECORD_CALLS === "1",
    background: oneOf<BackgroundMode>("BACKGROUND", env.BACKGROUND || (cloudRun ? "http" : "inline"), BACKGROUNDS, problems),
    tickToken: env.TICK_TOKEN?.trim() || "",
    tickMs: Number(env.TICK_MS || 30000), // BACKGROUND=inline
    outbound: oneOf<Outbound>("OUTBOUND", env.OUTBOUND || "twilio", OUTBOUNDS, problems), // fake: tests
    // Where WhatsApp calls Toni makes are placed: the service that holds their audio (deploy/cloudrun.sh sets it on
    // the main service; unset: here).
    whatsappCallsUrl: (env.WHATSAPP_CALLS_URL ?? "").trim().replace(/\/$/, ""),
    adminPhones: (env.ADMIN_PHONE ?? "").split(",").map(s => s.trim()).filter(Boolean),
    turnDetector: env.TURN_DETECTOR === "smart-turn",
    logFormat: env.LOG_FORMAT || (cloudRun ? "json" : "text"),
  };
  if (cloudRun && c.databaseUrl.startsWith("pglite:")) problems.push("DATABASE_URL: Cloud Run has no disk; set a Postgres URL (Supabase)");
  if (c.background === "http" && !c.tickToken) problems.push("BACKGROUND=http needs TICK_TOKEN (Cloud Scheduler sends it to /internal/tick)");
  if (cloudRun && !c.devToken && !env.ADMIN_CODE) problems.push("a public server needs DEV_TOKEN or ADMIN_CODE (the API and monitor are open otherwise)");
  // Sessions signed with a key derived from ADMIN_CODE could be cracked offline from any one session.
  if (cloudRun && env.ADMIN_CODE && (env.SESSION_SECRET?.trim().length ?? 0) < 32) problems.push("SESSION_SECRET: a random secret of 32+ characters (sessions are signed with it)");
  if (problems.length) throw new Error(`config: ${problems.join("; ")}`);
  return c;
}
export type Config = ReturnType<typeof loadConfig>;
