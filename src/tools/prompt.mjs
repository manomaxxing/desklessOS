// The TOOLS block of a cascade system prompt. He must hear something while a
// tool runs, so the header and a few spoken words come first, then the call.
// `lines`: the persona's locale lines (working / looking).

export function toolRules(names, lines = {}) {
  if (!names?.length) return "";
  return `TOOLS (${names.join(", ")}): when you call one, FIRST write the header and a few spoken words
("${lines.working ?? "On it."}" before you change something, "${lines.looking ?? "Let me check."}" before you look something up),
THEN call it in the same response. Never call a tool before the header (HEARD with his words, as
always), and never with NEXT: wait; a turn that calls a tool is NEXT: listen, not a question.
You then get its result: answer him from it in one or two sentences, header first again. If the result
says it was NOT done (an error, "not run"), it did not happen: never say it did.`;
}
