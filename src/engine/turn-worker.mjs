// Smart Turn in a worker thread: the features (~100 ms of arithmetic) and the model
// never block the call's audio loop. Messages: { id, pcm: ArrayBuffer (PCM16 16 kHz) }
// → { id, probability, ms } | { id, error }.

import { parentPort, workerData } from "node:worker_threads";
import { turnFeatures, N_MELS, N_FRAMES } from "./turn-features.mjs";

const ort = await import("onnxruntime-node");
const session = await ort.InferenceSession.create(workerData.modelPath, { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: "sequential", graphOptimizationLevel: "all" });
parentPort.postMessage({ ready: true });

parentPort.on("message", async ({ id, pcm }) => {
  const t0 = performance.now();
  try {
    const features = turnFeatures(Buffer.from(pcm));
    const out = await session.run({ input_features: new ort.Tensor("float32", features, [1, N_MELS, N_FRAMES]) });
    parentPort.postMessage({ id, probability: Number(out[session.outputNames[0]].data[0]), ms: Math.round(performance.now() - t0) });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
