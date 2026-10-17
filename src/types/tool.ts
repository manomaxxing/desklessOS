// Tools the agent calls mid-call (Gemini function calling), shared by both engines.
import type { Schema } from "./gemini.ts";
import type { LangId, Log } from "./common.ts";

export type ToolEffect = "read" | "write" | "call";
export type ToolStatus = "ok" | "repeated" | "rejected" | "skipped" | "aborted" | "error" | "unknown";

export interface ToolCall {
  id?: string | null;
  name: string;
  args?: Record<string, unknown>;
}

/** What a tool's run returns to the model: a plain object; `summary` goes into the call's history. */
export type ToolResult = Record<string, unknown> & { summary?: string; error?: string };

export interface ToolContext {
  callId: string | null;
  readonly lang: LangId;
  signal?: AbortSignal;
  /** His plain yes, checked in code (a boolean, or asked only when such a tool is called). */
  confirmed: boolean | ((tool: Tool) => Promise<boolean>);
  latestNote?: () => Promise<unknown>;
  memory?: unknown;
  emit?: (event: string, data: Record<string, unknown>) => void;
  log?: Log;
  mayWrite?: (tool: Tool) => Promise<boolean>;
  onWrite?: (tool: Tool) => void;
  hangup?: () => void;
  [key: string]: unknown;
}

export interface ToolSpec<I = Record<string, unknown>> {
  name: string;
  description: string;
  parameters?: Schema;
  effect?: ToolEffect;
  requiresConfirm?: boolean;
  /** "send": the yes must be to sending (the question he answered, or his own words, are about sending). */
  confirmAbout?: "send";
  timeoutMs?: number;
  /** Args never shown: masked in the outcome (the monitor, tool_runs), e.g. a PIN. The tool gets them as they came. */
  secretArgs?: readonly string[];
  available?: (ctx?: Partial<ToolContext>) => boolean;
  prepare?: (args: Record<string, unknown>, ctx: ToolContext) => I | Promise<I>;
  key?: (input: I) => unknown;
  run: (input: I, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
}

export type Tool<I = Record<string, unknown>> = Readonly<Required<Pick<ToolSpec<I>, "name" | "description" | "parameters" | "effect" | "requiresConfirm" | "timeoutMs" | "run">> & Omit<ToolSpec<I>, "name" | "description" | "parameters" | "effect" | "requiresConfirm" | "timeoutMs" | "run">>;

export interface ToolOutcome {
  id: string | null;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  result: ToolResult;
  summary: string;
  ms: number;
  key: string | null;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Schema;
}
