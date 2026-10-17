// Background work (src/jobs/queue.ts) and the calls Toni makes (src/jobs/scheduler.ts).
import type { Iso } from "./common.ts";

export type JobStatus = "queued" | "running" | "done" | "dead";

export interface JobRow {
  id: string;
  kind: string;
  key: string | null;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  run_at: Date | Iso;
  locked_until: Date | Iso | null;
  last_error: string | null;
  created_at?: Date | Iso;
  updated_at?: Date | Iso;
}

export type ErrandStatus = "queued" | "dialing" | "in_call" | "done" | "failed" | "cancelled";

export interface ErrandRow {
  id: string;
  user_id: string;
  org_id?: string;
  objective_ids: string[];
  status: ErrandStatus;
  attempts: number;
  max_attempts?: number;
  next_attempt_at: Date | Iso;
  call_id: string | null;
  carrier: string | null;
  outcome: string | null;
  log: { at?: Iso; text: string }[];
}
