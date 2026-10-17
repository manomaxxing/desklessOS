// Gemini's wire shapes we use: the JSON schema subset, usage, the endpoint, stream events.

export type SchemaType = "STRING" | "NUMBER" | "INTEGER" | "BOOLEAN" | "ARRAY" | "OBJECT";
/** Gemini's response/function schema (an OpenAPI subset). */
export interface Schema {
  type: SchemaType;
  description?: string;
  enum?: string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  nullable?: boolean;
}

export interface Usage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  responseTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  promptTokensDetails?: { modality: string; tokenCount?: number }[];
  candidatesTokensDetails?: { modality: string; tokenCount?: number }[];
  responseTokensDetails?: { modality: string; tokenCount?: number }[];
}

/** Where Gemini is reached: Vertex (EU) or AI Studio. */
export interface Endpoint {
  door: string;
  url(model: string, method: string): string;
  headers(): Promise<Record<string, string>>;
  warm?(): Promise<void>;
}

export interface FunctionCall {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
}
/** A raw content part, kept as received (thought signatures included). */
export type Part = Record<string, unknown>;

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "call"; call: FunctionCall }
  | { type: "end"; parts: Part[]; model?: string };

export interface Content {
  role: string;
  parts: Part[];
}
