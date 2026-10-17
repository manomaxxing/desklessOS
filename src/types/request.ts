// Max's requests (src/admin/requests.ts): his instruction, the plan he approved, and what came of it.
import type { Iso, LangId } from "./common.ts";
import type { ObjectiveMode } from "./agenda.ts";

export type RequestStatus = "draft" | "approved" | "done" | "expired" | "cancelled";

export interface PlanQuestion {
  /** Given by the template ("q1", …): where its answer goes. */
  id?: string;
  ask: string;
  probe?: string;
  required?: boolean;
}

export interface PlanTarget {
  userId: string | null;
  name: string;
  lang?: LangId;
  confidence?: number;
  alternatives?: { userId: string; name: string }[];
}
export type PlanParams = Record<string, unknown> & { questions?: PlanQuestion[]; purpose?: string; focus?: string };

/**
 * The planner's plan for a request. A draft's may not know yet whom to ask or what (target or
 * params null; its card says why it's blocked): only a whole one can be approved.
 */
export interface Plan {
  template: string;
  version?: number;
  target: PlanTarget | null;
  params: PlanParams | null;
  mode: ObjectiveMode;
  lang?: LangId;
  notBefore?: Iso | null;
  deadline?: Iso | null;
  clarifications?: string[];
  summary?: string;
}

/** What Max sees before he approves. */
export interface Card {
  title: string;
  summary: string;
  who: string;
  when: string;
  purpose: string;
  questions: PlanQuestion[];
  clarifications: string[];
  warnings: string[];
  blocked: string[];
}

export interface Request {
  id: string;
  userId: string | null;
  instruction: string;
  plan: Plan | null;
  planHash: string | null;
  card: Card | null;
  turns: unknown[];
  status: RequestStatus;
  objectiveId: string | null;
  result: Record<string, unknown> | null;
  createdBy: string;
  createdAt: Iso;
  approvedAt: Iso | null;
  closedAt: Iso | null;
  notifiedAt: Iso | null;
  log: { at: Iso; text: string }[];
  updatedAt: Iso;
}
