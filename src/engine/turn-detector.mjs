// Is he done talking? Smart Turn v3 (pipecat-ai/smart-turn-v3, BSD-2-Clause) hears it
// in the audio: intonation, a trailing "und…", a breath before the next clause. In 23
// languages, ~25 ms on a CPU, in a worker thread (turn-worker.mjs).
//   TURN_DETECTOR=smart-turn, the model from `npm run smart-turn:fetch`, and the
//   optional dependency onnxruntime-node. Otherwise there is no detector and the
//   per-language word lists (endpointing.mjs) do the job alone.
// The session asks right when he stops (in parallel with the model's answer) and treats
// "probably not done" like a dangling "…die will": stay silent, keep listening.

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MODEL = path.join(here, "..", "..", "models", "smart-turn-v3.2-cpu.onnx");

export async function createTurnDetector({ modelPath = process.env.TURN_MODEL || DEFAULT_MODEL, threshold = Number(process.env.TURN_THRESHOLD || 0.5), timeoutMs = 600, log = () => {} } = {}) {
  if (!existsSync(modelPath)) { log(`turn detector: no model at ${modelPath} (npm run smart-turn:fetch)`); return null; }
  try { await import("onnxruntime-node"); } catch { log("turn detector: onnxruntime-node isn't installed (npm install --include=optional)"); return null; }
  const worker = new Worker(new URL("./turn-worker.mjs", import.meta.url), { workerData: { modelPath } });
  worker.unref();
  const pending = new Map();
  let seq = 0;
  await new Promise((resolve, reject) => {
    worker.once("message", m => (m.ready ? resolve() : reject(new Error("worker didn't start"))));
    worker.once("error", reject);
  });
  worker.on("message", m => { const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } });
  worker.on("error", err => log("turn detector error", err.message));
  log(`turn detector: Smart Turn v3 (${path.basename(modelPath)}), done above ${threshold}`);

  return {
    threshold,
    /** PCM16 16 kHz of his turn → { probability, complete, ms }, or null if it took too long or failed. */
    predict(pcm) {
      const id = ++seq;
      const copy = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      return new Promise(resolve => {
        const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
        pending.set(id, m => { clearTimeout(timer); resolve(m.error ? null : { probability: m.probability, complete: m.probability >= threshold, ms: m.ms }); });
        worker.postMessage({ id, pcm: copy }, [copy]);
      });
    },
    close: () => worker.terminate(),
  };
}
