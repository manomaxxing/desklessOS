// The call's summary for the dashboard, like a good meeting note: a title, the gist,
// the topics with their points, action items, open questions. In the call's language.
// Written once by the after-call job (src/calls/after-call.ts), or on demand from the
// admin page for a call that has none (POST /api/calls/:id/recap). Stored in calls.recap.

import { extractJsonResilient, FALLBACK_MODEL } from "../engine/gemini.ts";
import { locales } from "../locale/index.ts";
import { isRecord } from "../shared/is-record.ts";
import type { Endpoint, Schema, Usage } from "../types/gemini.ts";
import type { Iso, LangId, Turn } from "../types/common.ts";

const S: Schema = { type: "STRING" };
export const RECAP_SCHEMA: Schema = {
  type: "OBJECT",
  properties: {
    title: S,
    overview: S,
    topics: { type: "ARRAY", items: { type: "OBJECT", properties: { heading: S, points: { type: "ARRAY", items: S } }, required: ["heading", "points"] } },
    actions: { type: "ARRAY", items: { type: "OBJECT", properties: { text: S, owner: S, due: S }, required: ["text", "owner", "due"] } },
    open_questions: { type: "ARRAY", items: S },
  },
  required: ["title", "overview", "topics", "actions", "open_questions"],
};

/** The summary as stored (calls.recap). */
export type Recap = {
  title: string;
  overview: string;
  topics: { heading: string; points: string[] }[];
  actions: { text: string; owner: string; due: string }[];
  open_questions: string[];
  lang: LangId | null;
  writtenAt: Iso;
};

export const recapSystem = ({ agent, name, langName }: { agent: string; name: string; langName: string }): string => `You write the summary of a phone call between ${agent}, an AI assistant on the phone for tradespeople, and ${name}. The team behind ${agent} reads it on a dashboard to understand ${name}'s work, so it must be faithful and quick to scan, like a good meeting note.

- title: 3 to 7 words, what the call was about.
- overview: 1 to 3 sentences: the gist and what came out of it.
- topics: the call's topics in the order they came up, 1 to 5 of them, each a short heading and 1 to 6 points. A point is one concrete thing ${name} said: a fact, a number, a problem, a habit, a decision, an opinion. Keep numbers, names, places and times exactly. Where ${name}'s own words say it best, quote them briefly in quotation marks.
- actions: the concrete next steps that came up: what, who (${name}, ${agent}, or "Team" for something the team should follow up on), and when if it was said (else ""). Only steps that were said or clearly agreed; none is fine.
- open_questions: what stayed unclear, and what is worth asking ${name} next time: a surprising answer, a vague number, a problem mentioned in passing. About the work, not about how something was worded. At most 3; none is fine.

Only what was said: no guesses, no advice, no filler. Leave out ${agent}'s own questions and small talk unless the answer matters. A short call gets a short summary. Write in ${langName}.`;

/** The transcript as the prompt (and the dashboard) shows it: who said what, without the engine's [notes]. */
export const spokenText = (text: unknown): string => String(text ?? "").replace(/\s*\[(?:did|called|interrupted)[^\]]*\]/g, "").trim();

/** The engine's own notes in his place ("(Silence: …)", "(You called him …)"): nobody said them. */
export const engineHint = /^\((?:Silence|You called him|System:|The caller is speaking)/;

export function recapPrompt({ turns, name, agent, date }: { turns: readonly Turn[]; name: string; agent: string; date?: string }): string {
  const lines = turns.filter(t => !(t.role === "user" && engineHint.test(String(t.text ?? ""))))
    .map(t => `${t.role === "user" ? name : agent}: ${spokenText(t.text)}`).filter(l => !/:\s*$/.test(l));
  return `${date ? `The call was on ${date}.\n\n` : ""}Transcript:\n${lines.join("\n")}`;
}

// The model's JSON, kept to the schema's shape whatever came back.
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => String(v ?? "").trim();
const clean = (raw: unknown): Omit<Recap, "lang" | "writtenAt"> => {
  const r = isRecord(raw) ? raw : {};
  return {
    title: str(r.title),
    overview: str(r.overview),
    topics: list(r.topics).filter(isRecord).map(t => ({ heading: str(t.heading), points: list(t.points).map(str).filter(Boolean) })).filter(t => t.heading || t.points.length),
    actions: list(r.actions).filter(isRecord).map(a => ({ text: str(a.text), owner: str(a.owner), due: str(a.due) })).filter(a => a.text),
    open_questions: list(r.open_questions).map(str).filter(Boolean),
  };
};

export type WriteRecap = (o: { turns: readonly Turn[]; name?: string | null; lang?: LangId | null; startedAt?: Iso | Date | number | null; onUsage?: (usage: Usage) => void }) => Promise<Recap>;

/** writeRecap({ turns, name, lang, startedAt }) → the summary, with when and by which model it was written. */
export function createRecapWriter({ endpoint, model, fallbackModel = FALLBACK_MODEL, agent = "Toni" }: { endpoint: Endpoint; model: string; fallbackModel?: string; agent?: string }): WriteRecap {
  return async function writeRecap({ turns, name, lang = null, startedAt = null, onUsage }) {
    const L = locales();
    const langName = lang && L.ids.includes(lang) ? L.name(lang) : "the language of the conversation";
    const date = startedAt ? new Date(startedAt).toISOString().slice(0, 10) : "";
    const recap = await extractJsonResilient({
      endpoint, models: [model, fallbackModel], timeoutMs: 30000, retries429: 2, think: true,
      system: recapSystem({ agent, name: name || "the caller", langName }), prompt: recapPrompt({ turns, name: name || "Caller", agent, date }),
      schema: RECAP_SCHEMA, onUsage,
    });
    return { ...clean(recap), lang, writtenAt: new Date().toISOString() };
  };
}
