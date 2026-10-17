// Parses the assistant's streamed answer as it arrives. The model starts with
// header lines, then speaks:
//   HEARD: <what the caller said, word for word>
//   LANG: <language id, one of the enabled locales>
//   NEXT: listen | wait | ask | confirm | hangup   (wait: he isn't done, say nothing;
//         ask: an open question, confirm: a yes/no question)
//   <blank line>
//   <spoken reply>
// Headers come out once; the reply comes out one sentence at a time so each
// sentence can go to the voice while the next is still being written.
// A follow-up answer after a tool call may repeat the header or skip it:
// onHeader gets `present: false` when there was none.
// (Adapted from mano-games/tools/buddy-lab/src/reply.ts.)

import { NEXT_VALUES, type LangId, type Next } from "../types/common.ts";

/** The header as parsed: lang "" when missing or not an enabled language; next "listen" when missing. */
export interface ReplyHeader {
  heard: string;
  lang: LangId | "";
  next: Next;
  present: boolean;
}

export interface ReplyParser {
  push(text: string): void;
  /** A tool call arrived: finish the header and speak what's written so far. More text may follow. */
  flush(): void;
  end(): Omit<ReplyHeader, "present">;
}

const MIN_SENTENCE = 24; // shorter pieces ride along with the next sentence
// DO: is the old protocol's tag (the TOOLS=header switch). No prompt asks for it any more, but a
// stray DO line is still read as a header line, never spoken; the header is whole without it.
const TAGS = ["HEARD", "LANG", "NEXT", "DO"];
const HEADER_START = /^\s*(HEARD|LANG|NEXT|DO)\s*:/i;

// Could the text so far still grow into a header line ("HEA", "NEXT")? Then wait for more.
function maybeHeader(text: string): boolean {
  const t = text.trimStart().toUpperCase();
  return TAGS.some(tag => (t.length <= tag.length ? tag.startsWith(t) : new RegExp(`^${tag}\\s*(:|$)`).test(t)));
}

// `langs`: the language ids LANG may name (the enabled locales); other values read as "".
export function createReplyParser({ onHeader, onSentence, langs = null }: {
  onHeader: (header: ReplyHeader) => void;
  onSentence: (sentence: string) => void;
  langs?: readonly LangId[] | null;
}): ReplyParser {
  let buf = "";
  let headerDone = false;
  let heard = "";
  let lang: LangId | "" = "";
  let next: Next = "listen";
  let pending = "";

  let emitted = 0;
  const emitSentences = (final: boolean) => {
    let cut = final ? pending.length : lastBoundary(pending);
    if (cut <= 0 && !emitted && pending.length >= 45) cut = firstComma(pending, 30);
    if (cut <= 0) return;
    const ready = pending.slice(0, cut);
    pending = pending.slice(cut);
    const parts = ready.match(/[^.!?…\n]*[.!?…]+["»”')]*\s*|[^\n]*\n|[^.!?…\n]+$/g) ?? [];
    let chunk = "";
    for (const part of parts) {
      chunk += part;
      if (clean(chunk).length >= MIN_SENTENCE) {
        onSentence(clean(chunk));
        emitted++;
        chunk = "";
      }
    }
    if (!clean(chunk)) return;
    if (final || (!emitted && /,\s*$/.test(chunk))) { onSentence(clean(chunk)); emitted++; }
    else pending = chunk + pending;
  };

  // Header lines (HEARD, LANG, NEXT, any order) end at the first other line, or once all three
  // are in and the line after them can't be a tag: the reply then starts without waiting for its newline.
  const readHeader = (final: boolean) => {
    if (!HEADER_START.test(buf)) {
      if (!final && maybeHeader(buf)) return;
      // No header (skipped, or a follow-up that doesn't repeat it): it's all reply, never silence.
      pending = buf.replace(/^\s*(HEARD|LANG|NEXT|DO):.*\n?/gim, "");
      headerDone = true;
      onHeader({ heard, lang, next, present: false });
      return;
    }
    const lines = buf.split("\n");
    const complete = final ? lines : lines.slice(0, -1); // the last line may still be arriving
    const fields = new Map<string, string>(); // tag (upper case) → its value
    let consumed = 0;
    let done = false;
    for (const line of complete) {
      // Blank lines inside the header are tolerated until NEXT has been seen.
      if (!line.trim() && !fields.has("NEXT")) { consumed += line.length + 1; continue; }
      const m = line.match(/^\s*(HEARD|LANG|NEXT|DO):[ \t]*(.*)$/i);
      if (!m) { done = true; break; }
      fields.set(m[1].toUpperCase(), m[2].trim());
      consumed += line.length + 1;
    }
    if (!done && !final) {
      const arriving = lines.at(-1) ?? "";
      const whole = fields.has("HEARD") && fields.has("LANG") && fields.has("NEXT");
      const tagNext = maybeHeader(arriving) || HEADER_START.test(arriving); // a stray DO:, or another tag
      if ((!whole || tagNext) && buf.length < 600) return;
    }
    pending = buf.slice(consumed).replace(/^\s+/, "");
    // Tags the model squeezed onto one line ("LANG: de NEXT: hangup Alles klar…") or into the reply.
    for (const [, v] of (fields.get("LANG") ?? "").matchAll(/\bNEXT\s*:\s*([a-z]+)/gi)) fields.set("NEXT", v);
    let m;
    while ((m = pending.match(/^(LANG|NEXT|DO)\s*:\s*([a-z]+)\b[ \t]*\n?\s*/i))) {
      fields.set(m[1].toUpperCase(), m[2]);
      pending = pending.slice(m[0].length);
    }
    heard = fields.get("HEARD") ?? "";
    const id = (fields.get("LANG") ?? "").trim().toLowerCase().match(/^[a-z]{2,3}/)?.[0] ?? "";
    lang = id && (!langs || langs.includes(id)) ? id : "";
    const n = (fields.get("NEXT") ?? "").toLowerCase().match(/[a-z]+/)?.[0];
    next = NEXT_VALUES.find(v => v === n) ?? "listen";
    headerDone = true;
    onHeader({ heard, lang, next, present: true });
  };

  return {
    push(text) {
      if (!headerDone) {
        buf += text;
        readHeader(false);
        if (headerDone) emitSentences(false);
        return;
      }
      pending += text;
      emitSentences(false);
    },
    flush() {
      if (!headerDone) readHeader(true);
      emitSentences(true);
    },
    end() {
      if (!headerDone) readHeader(true);
      emitSentences(true);
      return { heard, lang, next };
    },
  };
}

// First ", " at or after `min` characters (a clause break good enough to start speaking).
function firstComma(text: string, min: number): number {
  const i = text.indexOf(", ", min);
  return i >= 0 ? i + 2 : -1;
}

// End of the last complete sentence: . ! ? … then whitespace, or a line break.
function lastBoundary(text: string): number {
  const re = /[.!?…]+["»”')]*\s|\n/g;
  let end = -1;
  let m;
  while ((m = re.exec(text))) end = m.index + m[0].length;
  return end;
}

// A tool call written out as text instead of made ("default_api:quote_send{…}",
// "quote_send(items=…)"): Gemini does that now and then. Speech has no braces or snake_case.
const TOOL_CALL_TEXT = /default_api|[{}]|\b[a-z]+_[a-z_]+\s*[:({=]/i;
export const isToolCallText = (sentence: string | null | undefined): boolean => TOOL_CALL_TEXT.test(String(sentence ?? ""));

// Spoken text only: no markdown, no emoji, one line.
export function clean(text: string): string {
  return text
    .replace(/[*_#`>]+/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
