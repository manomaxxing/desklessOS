// Where a Gemini Live (native audio) session connects. A live model id in the
// mode selector looks like "<door>:<model>":
//   vertex-eu:gemini-3.8-live            Vertex, EU multi-region (Gemini 3 only)
//   vertex-us:gemini-3.8-live            Vertex, US multi-region
//   vertex@us-central1:gemini-3.8-live   Vertex, a region
//   vertex@europe-west4:gemini-live-2.5-flash-native-audio
//   studio:gemini-3.8-live               AI Studio key (not covered by Vertex credits)

/** A live session's socket and model path; `vertex`: authenticate with the Vertex token. */
export type LiveTarget =
  | { id: string; door: string; model: string; vertex: false; url: string; modelPath: string }
  | { id: string; door: string; model: string; vertex: true; location: string; url: string; modelPath: string };

export function liveTarget(id: string, env: Record<string, string | undefined> = process.env): LiveTarget {
  const [door, ...rest] = String(id).split(":");
  const model = rest.join(":");
  const project = (env.GOOGLE_CLOUD_PROJECT ?? "").trim();
  if (door === "studio") {
    if (!env.GEMINI_API_KEY) throw new Error("studio live needs GEMINI_API_KEY");
    return {
      id, door, model, vertex: false,
      url: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
      modelPath: `models/${model}`,
    };
  }
  let location: string, host: string;
  if (door === "vertex-eu" || door === "vertex-us") {
    location = door.slice(-2);
    host = `aiplatform.${location}.rep.googleapis.com`;
  } else if (door.startsWith("vertex@")) {
    location = door.slice(7);
    host = `${location}-aiplatform.googleapis.com`;
  } else {
    throw new Error(`unknown live door "${door}"`);
  }
  return {
    id, door, model, vertex: true, location,
    url: `wss://${host}/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent`,
    modelPath: `projects/${project}/locations/${location}/publishers/google/models/${model}`,
  };
}
