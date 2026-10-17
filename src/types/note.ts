// His note: what the extraction makes of the call (the capture template's fields, his lists'
// answers), kept per call. Keys are English; values are in the language of the call.

export interface WorkItem {
  area?: string;
  description?: string;
  quantity?: string;
  material?: string;
  /** Who gets the material (old notes). */
  supply?: string;
}
export interface NextStep {
  what?: string;
  due?: string;
}
export interface ListAnswer {
  item: string;
  answer: string;
}
export interface SiteAnswer extends ListAnswer {
  unfavourable: boolean;
}

export interface Note {
  /** Which capability the call is: "capture", "brief", "agenda", or "unclear". */
  mode?: string;
  lang?: string;
  customer_name?: string;
  customer_phone?: string;
  address?: string;
  place?: string;
  appointment_date?: string;
  work?: WorkItem[];
  special_requests?: string[];
  timeframe?: string;
  budget?: string;
  next_steps?: NextStep[];
  open_questions?: string[];
  summary?: string;
  confirmed?: boolean;
  job_list?: string;
  checklist?: ListAnswer[];
  site?: SiteAnswer[];
  quality?: string;
  lists_done?: boolean;
  [key: string]: unknown;
}
