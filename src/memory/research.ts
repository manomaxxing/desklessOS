// The research log: what we've learned about how he works, and which framework questions
// (config/discovery.json) were asked. Filled by the post-call step; the state of the research
// primitive (src/agenda/primitives.ts), which puts context() into the agenda to pick at most one
// question per call. Loaded from Postgres for a call and saved back after apply()
// (src/memory/post-call.ts): findings are rows in facts (tagged area:/hyp:/stance:), the
// question states and the call log one research_state row.

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Day } from "../types/common.ts";
import type { DiscoveryResult } from "../types/memory.ts";

export type { DiscoveryResult };

const FINDINGS_PER_AREA_IN_PROMPT = 4;
const RETRIES_PER_QUESTION = 2; // asked twice without an answer: drop it

export interface FrameworkQuestion { id: string; ask: string; probe?: string; hypothesis?: string }
export interface FrameworkArea { id: string; title: string; phase: "start" | "week" | "end"; goal?: string; doneWhen?: string; questions: FrameworkQuestion[] }
export interface Framework {
  participant?: { name?: string; place?: string; trade?: string; lang?: string; accent?: string; timezone?: string; [key: string]: unknown };
  keyQuestion?: string;
  pilotDays: number;
  dailyQuestionCap: number;
  hypotheses: { id: string; area: string; text: string }[];
  areas: FrameworkArea[];
}

export type FindingKind = "fact" | "number" | "story" | "opinion" | "";
export interface Finding {
  id?: string;
  area: string;
  hypothesis: string;
  stance: "supports" | "contradicts" | "";
  kind: FindingKind | string;
  text: string;
  quote: string;
  callId: string | null;
  date: Day;
}
export interface QuestionState { asked?: number; lastAsked?: Day; answered?: boolean; declined?: number }
export interface ResearchCall { callId: string | null; date: Day; asked: string[]; answered: string[]; declined: string[]; findings: number }
/** All of it, as kept between calls. */
export interface ResearchState { findings: Finding[]; questions: Record<string, QuestionState>; calls: ResearchCall[] }
export const emptyResearchState = (): ResearchState => ({ findings: [], questions: {}, calls: [] });

export const loadFramework = (file: string | URL = new URL("../../config/discovery.json", import.meta.url)): Framework => JSON.parse(readFileSync(file, "utf8")) as Framework;

const day = (d: Date | string): Day => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

export interface NextQuestions {
  intro: boolean;
  pilotDay: number;
  questions: { area: FrameworkArea; question: FrameworkQuestion }[];
  capped: boolean;
}

export type Discovery = ReturnType<typeof createDiscovery>;

/** `state` is read and replaced in place: what apply() leaves there is what gets saved. */
export function createDiscovery({ framework = loadFramework(), state = emptyResearchState() }: { framework?: Framework; state?: ResearchState } = {}) {
  const areaIds = framework.areas.map(a => a.id);
  const questionIds = new Set(framework.areas.flatMap(a => a.questions.map(q => q.id)));
  const hypothesisIds = new Set(framework.hypotheses.map(h => h.id));

  /** The questions for this call: start-phase areas first, end-phase from the last pilot day, else the least-covered area. */
  function next({ today = new Date() }: { today?: Date } = {}): NextQuestions {
    const date = day(today);
    const log = state.calls;
    const intro = log.length === 0;
    const pilotDay = log[0] ? daysBetween(log[0].date, date) + 1 : 1;
    if (log.filter(c => c.date === date && c.asked.length).length >= framework.dailyQuestionCap) return { intro, pilotDay, questions: [], capped: true };
    const qs = state.questions;
    const open = (q: FrameworkQuestion) => !qs[q.id]?.answered && (qs[q.id]?.asked ?? 0) < RETRIES_PER_QUESTION && qs[q.id]?.lastAsked !== date;
    const coverage = (a: FrameworkArea) => state.findings.filter(f => f.area === a.id).length;
    const rank = (a: FrameworkArea) => (a.phase === "start" ? 0 : a.phase === "end" ? 1 : 2);
    const areas = framework.areas
      .filter(a => a.phase !== "end" || pilotDay >= framework.pilotDays)
      .filter(a => a.questions.some(open))
      .sort((a, b) => rank(a) - rank(b) || coverage(a) - coverage(b) || areaIds.indexOf(a.id) - areaIds.indexOf(b.id));
    const questions = areas.slice(0, 3).flatMap(area => {
      const question = area.questions.find(open);
      return question ? [{ area, question }] : [];
    });
    return { intro, pilotDay, questions, capped: false };
  }

  return {
    framework,
    state,
    findings: (): Finding[] => state.findings,
    questions: (): Record<string, QuestionState> => state.questions,
    calls: (): ResearchCall[] => state.calls,
    next,

    /** Applies the `discovery` part of one call's consolidation result. */
    apply(d: DiscoveryResult = {}, { callId = null, date = day(new Date()) }: { callId?: string | null; date?: Day } = {}) {
      const known = (ids: string[] | undefined) => [...new Set((ids ?? []).filter(id => questionIds.has(id)))];
      const asked = known(d.asked_question_ids), answered = known(d.answered_question_ids), declined = known(d.declined_question_ids);
      const qs = structuredClone(state.questions);
      for (const id of asked) qs[id] = { ...qs[id], asked: (qs[id]?.asked ?? 0) + 1, lastAsked: date };
      for (const id of answered) qs[id] = { ...qs[id], answered: true };
      for (const id of declined) qs[id] = { ...qs[id], declined: (qs[id]?.declined ?? 0) + 1 };
      const added: Finding[] = (d.findings ?? []).filter(f => f.text && areaIds.includes(f.area)).map(f => {
        const hypothesis = f.hypothesis && hypothesisIds.has(f.hypothesis) ? f.hypothesis : "";
        const stance = hypothesis && (f.stance === "supports" || f.stance === "contradicts") ? f.stance : "";
        return { id: randomUUID().slice(0, 8), area: f.area, hypothesis, stance, kind: f.kind || "", text: f.text, quote: f.quote || "", callId, date };
      });
      state.findings = [...state.findings, ...added];
      state.questions = qs;
      state.calls = [...state.calls, { callId, date, asked, answered, declined, findings: added.length }];
      return { asked, answered, declined, findings: added };
    },

    /** What he's told so far, by area (only areas with something), for calls without a research question. Empty if nothing. */
    known(): string {
      return framework.areas
        .map(a => [a.title, state.findings.filter(f => f.area === a.id).slice(-FINDINGS_PER_AREA_IN_PROMPT).map(f => f.text)] as const)
        .filter(([, own]) => own.length).map(([title, own]) => `- ${title}: ${own.join(" ")}`)
        .join("\n");
    },

    /** The prompt block: what we know so far and the question for this call. */
    context({ today = new Date() }: { today?: Date } = {}): string {
      const { intro, pilotDay, questions: picks, capped } = next({ today });
      const known = framework.areas.map(a => {
        const own = state.findings.filter(f => f.area === a.id).slice(-FINDINGS_PER_AREA_IN_PROMPT).map(f => f.text);
        return `- ${a.title}: ${own.length ? own.join(" ") : "(nothing yet)"}`;
      });
      const ask = picks.map(({ area, question }, i) =>
        `${i + 1}. [${question.id}] (${area.title}) "${question.ask}"${question.probe ? ` If his answer is vague, one follow-up: "${question.probe}"` : ""}`);
      return [
        `WHAT WE'VE LEARNED ABOUT HIM AND HIS BUSINESS (pilot week, day ${pilotDay} of ${framework.pilotDays}):`,
        ...known,
        "",
        intro ? "FIRST CALL: yes, this is his first call to you (see RESEARCH above)." : "FIRST CALL: no. He knows you already; don't introduce yourself again.",
        capped || !picks.length
          ? "DISCOVERY QUESTION FOR THIS CALL: none. Don't ask any research question in this call."
          : `DISCOVERY QUESTION FOR THIS CALL (ask at most one, at the end; take the first unless another one links directly to what he said):\n${ask.join("\n")}`,
      ].filter(Boolean).join("\n");
    },

    /** What the consolidation step needs: the framework ids and recent findings, so it can tag without duplicating. */
    snapshot() {
      return {
        areas: framework.areas.map(a => ({ id: a.id, title: a.title, goal: a.goal })),
        hypotheses: framework.hypotheses.map(h => ({ id: h.id, area: h.area, text: h.text })),
        questions: framework.areas.flatMap(a => a.questions.map(q => ({ id: q.id, area: a.id, ask: q.ask }))),
        recentFindings: state.findings.slice(-40).map(f => `${f.area}: ${f.text}`),
      };
    },
  };
}
