// A call as Markdown: what the copy button and the download give.

import { turnsOf, speaker, isStored } from "../shared/transcript.ts";
import { agentName } from "./auth.ts";
import { callTitle, callMeta } from "./calls.ts";
import type { CallDetail } from "../shared/types.ts";

/** "PRÜFEN" → "Prüfen": the goal's titles are written in capitals. */
export const sentence = (t: string | null | undefined): string => String(t ?? "").charAt(0) + String(t ?? "").slice(1).toLowerCase();

const head = (c: CallDetail): string => `# ${callTitle(c)}\n\n${callMeta(c).join(" · ")}\n`;

function summaryMd(c: CallDetail): string {
  const r = "recap" in c ? c.recap : null;
  if (!r) return "";
  return [
    "## Summary",
    r.overview && r.overview.split("\n").map(l => `> ${l}`).join("\n"),
    ...r.topics.map(t => `### ${t.heading}\n\n${t.points.map(p => `- ${p}`).join("\n")}`),
    r.actions.length && `### Action items\n\n${r.actions.map(a => `- [ ] ${a.text}${[a.owner, a.due].filter(Boolean).length ? ` (${[a.owner, a.due].filter(Boolean).join(", ")})` : ""}`).join("\n")}`,
    r.open_questions.length && `### Open questions\n\n${r.open_questions.map(q => `- ${q}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
}

const transcriptMd = (c: CallDetail): string =>
  `## Transcript\n\n${turnsOf(c).map(t => (t.role === "hint" ? `_${t.text}_` : `**${speaker(c, t, agentName())}:** ${t.text}${t.cut ? " …" : ""}`)).join("\n\n")}`;

/** What the call was for: why Toni called, or her own items at the end of his call. */
function goalMd(c: CallDetail): string {
  if (!isStored(c) || !c.goal?.length) return "";
  const items = c.goal.map(g => `- **${sentence(g.title)}**${g.focus ? `: ${g.focus}` : ""}${g.questions?.length ? `\n${g.questions.map(q => `  - ${q}`).join("\n")}` : ""}`);
  return `## ${c.direction === "outbound" ? `Why ${agentName()} called` : `${agentName()}'s own items`}\n\n${items.join("\n")}\n`;
}
/** What he asked for that Toni can't do yet: for Max to build. */
function wishesMd(c: CallDetail): string {
  if (!isStored(c) || !c.wishes?.length) return "";
  return `## Asked for, ${agentName()} can't do it yet\n\n${c.wishes.map(w => `- **${w.what}**${w.why ? ` (for: ${w.why})` : ""}${w.quote ? ` “${w.quote}”` : ""}`).join("\n")}\n`;
}

/** The tab as Markdown: the summary (with the goal and wishes) or the transcript. */
export const tabMd = (c: CallDetail, tab: "summary" | "transcript"): string =>
  [head(c), tab === "summary" ? [goalMd(c), wishesMd(c), summaryMd(c) || "(no summary yet)"].filter(Boolean).join("\n") : transcriptMd(c)].join("\n");

/** Everything, as a .md file named after the day and the title. */
export function downloadMd(c: CallDetail): void {
  const md = [head(c), goalMd(c), wishesMd(c), summaryMd(c), transcriptMd(c)].filter(Boolean).join("\n");
  const slug = callTitle(c).toLowerCase().replace(/[äöüß]/g, ch => ({ ä: "ae", ö: "oe", ü: "ue", ß: "ss" })[ch] ?? ch)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(new Blob([`${md}\n`], { type: "text/markdown" })),
    download: `${new Date(c.startedAt).toISOString().slice(0, 10)}-${slug || "call"}.md`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
