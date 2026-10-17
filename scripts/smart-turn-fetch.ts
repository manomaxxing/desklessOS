// Downloads Smart Turn v3.2 (CPU, int8, ~8 MB, BSD-2-Clause, pipecat-ai/smart-turn-v3) to
// models/, for TURN_DETECTOR=smart-turn. Needs the optional dependency onnxruntime-node.
//   npm run smart-turn:fetch

import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const FILE = "smart-turn-v3.2-cpu.onnx";
const URL_ = `https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/${FILE}`;
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "models");
const target = path.join(dir, FILE);

if (existsSync(target) && statSync(target).size > 1e6) {
  console.log(`${target} is there (${(statSync(target).size / 1e6).toFixed(1)} MB)`);
} else {
  mkdirSync(dir, { recursive: true });
  const res = await fetch(URL_);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1e6 || buf.length > 100e6) throw new Error(`unexpected size ${buf.length}`);
  writeFileSync(target, buf);
  console.log(`saved ${target} (${(buf.length / 1e6).toFixed(1)} MB, sha256 ${createHash("sha256").update(buf).digest("hex").slice(0, 16)}…)`);
}
