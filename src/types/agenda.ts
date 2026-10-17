// What a call is about: personas, templates and their steps, and the objectives a call brings.
import type { Iso, LangId } from "./common.ts";
import type { Schema } from "./gemini.ts";

export type TemplateKind = "capability" | "objective";
export type ObjectiveMode = "next_inbound" | "outbound" | "either";
export type ObjectiveStatus = "pending" | "done" | "expired" | "cancelled" | string;

/** A "missing" rule of the capture step: satisfied when any of the fields is filled. */
export interface MissingRule {
  label: string;
  anyOf: string[];
}

/** One step of a template, run by its primitive (src/agenda/primitives.ts). */
export interface Step {
  primitive: string;
  title?: string;
  instructions?: string | string[];
  toolInstructions?: Record<string, string | string[]>;
  fields?: Record<string, Schema>;
  required?: string[];
  rules?: string | string[];
  missing?: MissingRule[];
  save?: { anyOf: string[] };
  memoryRules?: string | string[];
  [key: string]: unknown;
}

export interface Template {
  id: string;
  version: number;
  kind: TemplateKind;
  title: string;
  description?: string;
  priority?: number;
  standalone?: boolean;
  /** Capabilities: the note mode it stands for. */
  mode?: { id: string; when: string; default?: boolean; rule?: string };
  /** Objectives: how they may reach him. */
  modes?: ObjectiveMode[];
  params?: Record<string, string>;
  limits: { attempts?: number; [key: string]: unknown };
  steps: Step[];
  tools: string[];
}

export interface Persona {
  id: string;
  version: number;
  profile?: string;
  agentLabel?: string;
  capabilities: string[];
  standing: string[];
  sections: Record<string, string>;
  [key: string]: unknown;
}

/** A stored objective (objectives table), as the code and the API see it. */
export interface Objective {
  id: string;
  template: string;
  version: number;
  params: Record<string, unknown>;
  mode: ObjectiveMode;
  status: ObjectiveStatus;
  priority: number;
  lang: LangId | null;
  createdAt: Iso;
  createdBy: string;
  notBefore: Iso | null;
  deadline: Iso | null;
  attempts: number;
  maxAttempts: number;
  calls: string[];
  result: Record<string, unknown> | null;
  updatedAt: Iso;
  userId: string | null;
  /** The last call that worked on it (picked up by the next one). */
  lastCall?: { turns?: { role: string; text: string }[] } | null;
  /** False: a copy that isn't written back (a rehearsal's, a call's errand). */
  stored?: boolean;
}

/** An objective as a call's agenda gets it (stored ones, a rehearsal's copies, a call's errand). */
export interface ObjectiveInput {
  id: string;
  template: string;
  params: Record<string, unknown>;
  stored?: boolean;
  lang?: LangId | null;
  result?: Record<string, unknown> | null;
  lastCall?: Objective["lastCall"];
}

/** What a stored objective keeps after a call. */
export interface ObjectiveResult {
  id: string;
  template: string;
  done: boolean;
  result: Record<string, unknown>;
}
