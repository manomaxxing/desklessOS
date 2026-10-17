// Smart Turn in a worker thread: the features (~100 ms of arithmetic) and the model
// never block the call's audio loop. Messages: { id, pcm: ArrayBuffer (PCM16 16 kHz) }
// → { id, probability, ms } | { id, error }.

import { parentPort, workerData } from "node:worker_threads";
import { turnFeatures, N_MELS, N_FRAMES } from "./turn-features.ts";
import { isRecord } from "../shared/is-record.ts";

/** Main thread → worker: one turn's audio. */
export interface TurnRequest {
  id: number;
  pcm: ArrayBuffer;
}
/** Worker → main thread: `ready` once the model is loaded, then one answer per request. */
export type TurnReply = { ready: true } | { id: number; probability: number; ms: number } | { id: number; error: string };

if (!parentPort) throw new Error("turn-worker.ts runs as a worker thread (turn-detector.ts starts it)");
const port = parentPort;
const modelPath: unknown = isRecord(workerData) ? workerData.modelPath : undefined;
if (typeof modelPath !== "string") throw new Error("turn-worker: no modelPath in workerData");
const reply = (message: TurnReply) => port.postMessage(message);

const ort = await import("onnxruntime-node");
const session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: "sequential", graphOptimizationLevel: "all" });
reply({ ready: true });

port.on("message", async ({ id, pcm }: TurnRequest) => {
  const t0 = performance.now();
  try {
    const features = turnFeatures(Buffer.from(pcm));
    const out = await session.run({ input_features: new ort.Tensor("float32", features, [1, N_MELS, N_FRAMES]) });
    reply({ id, probability: Number(out[session.outputNames[0]].data[0]), ms: Math.round(performance.now() - t0) });
  } catch (err) {
    reply({ id, error: err instanceof Error ? err.message : String(err) });
  }
});
