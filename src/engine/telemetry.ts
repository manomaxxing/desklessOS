// What an engine reports about its call, the same for both engines: events for the monitor
// (dev callers get them inline too), errors, model costs, and per-turn audio when the call is
// recorded (RECORD_CALLS).

import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Log } from "../types/common.ts";
import type { FrameOut, CallEvent } from "../types/call.ts";
import type { Usage } from "../types/gemini.ts";
import { createMeter, geminiCost, type Meter } from "./cost.ts";

export interface TelemetryOptions {
  send: (frame: FrameOut) => void;
  /** Dev callers (the test phone, scripted calls) get every event inline as a debug frame. */
  dev?: boolean;
  onEvent?: (event: CallEvent) => void;
  log?: Log;
  /** callId → the directory for this call's audio, or null not to record. */
  recordDir?: ((callId: string) => string | null) | null;
  /** The call's id, once it's known (call_connected). */
  callId: () => string | null;
}

export interface Telemetry {
  meter: Meter;
  debug(event: string, data?: Record<string, unknown>): void;
  fail(where: string, err: unknown): void;
  /** A model call's usage → its cost on the meter and the monitor. */
  record(step: string, usage: Usage | null | undefined, turnId: number | null | undefined, model: string): void;
  /** Whether this call's audio is kept: skip building audio files otherwise. */
  readonly recording: boolean;
  /** Saves one file of the call's audio; its name, or null when not recording (or it failed). */
  saveAudio(name: string, data: Buffer | (() => Buffer)): string | null;
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createTelemetry({ send, dev = false, onEvent = () => {}, log = () => {}, recordDir = null, callId }: TelemetryOptions): Telemetry {
  const meter = createMeter();
  const debug = (event: string, data: Record<string, unknown> = {}) => {
    onEvent({ event, ...data });
    if (dev) send({ type: "debug", ...data, event, t: Date.now() });
  };
  let known: { id: string; dir: string | null } | null = null; // recordDir may create the directory: once per call
  const dir = (): string | null => {
    const id = callId();
    if (!id || !recordDir) return null;
    if (known?.id !== id) {
      let d: string | null = null;
      try { d = recordDir(id); } catch (err) { log("recording off for this call:", errorMessage(err)); }
      known = { id, dir: d };
    }
    return known.dir;
  };
  return {
    meter,
    debug,
    fail(where, err) {
      const message = errorMessage(err);
      log(`${where} error`, message);
      debug("error", { where, message });
    },
    record(step, usage, turnId, model) {
      const entry = geminiCost(model, usage ?? {}, step);
      meter.add(entry);
      debug("cost", { turn: turnId ?? null, step, usd: entry.usd, inputTokens: entry.inputTokens, audioTokens: entry.audioTokens, outputTokens: entry.outputTokens, totals: meter.totals() });
    },
    get recording() { return Boolean(recordDir) && Boolean(dir()); },
    saveAudio(name, data) {
      const d = dir();
      if (!d) return null;
      try {
        writeFileSync(path.join(d, path.basename(name)), typeof data === "function" ? data() : data);
        return name;
      } catch {
        return null;
      }
    },
  };
}
