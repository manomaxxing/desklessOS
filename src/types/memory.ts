// What the memory step after a call gets from the model (MEMORY_SCHEMA, src/skills/from-templates.ts):
// shared by the step that asks (src/engine/consolidate.ts) and the one that applies it
// (src/memory/post-call.ts). Every field may be missing: the schema shapes the answer, it doesn't
// promise it.

/** What the memory model returns about the research (its `discovery` part). */
export interface DiscoveryResult {
  asked_question_ids?: string[];
  answered_question_ids?: string[];
  declined_question_ids?: string[];
  findings?: { area: string; hypothesis?: string; stance?: string; kind?: string; text: string; quote?: string }[];
}

export interface MemoryResult {
  call_type?: string;
  call_summary?: string;
  customer?: { existing_id?: string; name?: string; place?: string; address?: string; phone?: string; summary_update?: string };
  new_actions?: { text?: string; due?: string; customer_name?: string }[];
  completed_action_ids?: string[];
  updated_actions?: { id?: string; text?: string; due?: string }[];
  /** What he asked for that the agent can't do yet. */
  wishes?: { what?: string; why?: string; quote?: string }[];
  discovery?: DiscoveryResult;
}
