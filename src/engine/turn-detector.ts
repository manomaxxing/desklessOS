// Is he done talking? Smart Turn v3 (pipecat-ai/smart-turn-v3, BSD-2-Clause) hears it
// in the audio: intonation, a trailing "und…", a breath before the next clause. In 23
// languages, ~25 ms on a CPU, in a worker thread (turn-worker.ts).
//   TURN_DETECTOR=smart-turn, the model from `npm run smart-turn:fetch`, and the
//   optional dependency onnxruntime-node. Otherwise there is no detector and the
//   per-language word lists (endpointing.ts) do the job alone.
// The session asks right when he stops (in parallel with the model's answer) and treats
// "probably not done" like a dangling "…die will": stay silent, keep listening.

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Log } from "../types/common.ts";
import type { TurnReply, TurnRequest } from "./turn-worker.ts";
import { BYTES_PER_MS } from "./audio.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MODEL = path.join(here, "..", "..", "models", "smart-turn-v3.2-cpu.onnx");

// Smart Turn hears the last 8 s of a turn (turn-features.ts, N_SAMPLES): only those go to the
// worker, not all his pending audio (a minute of it is ~1.9 MB, copied on every ask).
const WINDOW_BYTES = 8000 * BYTES_PER_MS;

/** The last 8 s of PCM16 (whole samples), copied into its own ArrayBuffer to hand to the worker. */
export function lastWindow(pcm: Uint8Array): ArrayBuffer {
  const end = pcm.length & ~1;
  return new Uint8Array(pcm.subarray(Math.max(0, end - WINDOW_BYTES), end)).buffer;
}

/** Smart Turn's verdict on a turn: `complete` at or above the threshold. */
export interface TurnEnd {
  probability: number;
  complete: boolean;
  ms: number;
}
export interface TurnDetector {
  threshold: number;
  /** PCM16 16 kHz of his turn → { probability, complete, ms }, or null if it took too long or failed. */
  predict(pcm: Uint8Array): Promise<TurnEnd | null>;
  close(): Promise<number>;
}

// TURN_THRESHOLD that isn't a number: the default. NaN made every turn "not done" (the agent kept waiting).
function envThreshold(): number {
  const t = Number(process.env.TURN_THRESHOLD || 0.5);
  return Number.isFinite(t) ? t : 0.5;
}

export async function createTurnDetector({ modelPath = process.env.TURN_MODEL || DEFAULT_MODEL, threshold = envThreshold(), timeoutMs = 600, log = () => {} }: { modelPath?: string; threshold?: number; timeoutMs?: number; log?: Log } = {}): Promise<TurnDetector | null> {
  if (!existsSync(modelPath)) { log(`turn detector: no model at ${modelPath} (npm run smart-turn:fetch)`); return null; }
  try { await import("onnxruntime-node"); } catch { log("turn detector: onnxruntime-node isn't installed (npm install --include=optional)"); return null; }
  const worker = new Worker(new URL("./turn-worker.ts", import.meta.url), { workerData: { modelPath } });
  worker.unref();
  const pending = new Map<number, (reply: TurnReply) => void>();
  let seq = 0;
  // A model that won't load (a broken download): no detector, like a missing one, instead of a crash at startup.
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("message", (m: TurnReply) => ("ready" in m ? resolve() : reject(new Error("worker didn't start"))));
      worker.once("error", reject);
    });
  } catch (err) {
    log("turn detector: Smart Turn didn't start:", err instanceof Error ? err.message : String(err));
    void worker.terminate();
    return null;
  }
  worker.on("message", (m: TurnReply) => {
    if (!("id" in m)) return;
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); p(m); }
  });
  worker.on("error", err => log("turn detector error", err.message));
  log(`turn detector: Smart Turn v3 (${path.basename(modelPath)}), done above ${threshold}`);

  return {
    threshold,
    predict(pcm) {
      const id = ++seq;
      const request: TurnRequest = { id, pcm: lastWindow(pcm) };
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
        pending.set(id, m => { clearTimeout(timer); resolve("probability" in m ? { probability: m.probability, complete: m.probability >= threshold, ms: m.ms } : null); });
        worker.postMessage(request, [request.pcm]);
      });
    },
    close: () => worker.terminate(),
  };
}
