// Parses the assistant's streamed answer as it arrives. The model starts with
// header lines, then speaks:
//   HEARD: <what the caller said, word for word>
//   LANG: de | en
//   NEXT: listen | confirm | hangup
//   <blank line>
//   <spoken reply>
// Headers come out once; the reply comes out one sentence at a time so each
// sentence can go to the voice while the next is still being written.
// (Adapted from mano-games/tools/buddy-lab/src/reply.mjs.)

const MIN_SENTENCE = 24; // shorter pieces ride along with the next sentence
const NEXT_VALUES = new Set(["listen", "confirm", "hangup"]);

export function createReplyParser({ onHeader, onSentence }) {
  let buf = "";
  let headerDone = false;
  let heard = "";
  let lang = "";
  let next = "listen";
  let pending = "";

  let emitted = 0;
  const emitSentences = final => {
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

  // Header lines (HEARD, LANG, NEXT, any order) end at the first other line.
  const readHeader = final => {
    if (!/^\s*HEARD/i.test(buf)) {
      // Model skipped the header: treat everything as reply rather than go silent.
      if (final || buf.length > 40) {
        pending = buf.replace(/^\s*(HEARD|LANG|NEXT):.*\n?/gim, "");
        headerDone = true;
        onHeader({ heard, lang, next });
      }
      return;
    }
    const lines = buf.split("\n");
    const complete = final ? lines : lines.slice(0, -1); // the last line may still be arriving
    const fields = {};
    let consumed = 0;
    let done = false;
    for (const line of complete) {
      const m = line.match(/^\s*(HEARD|LANG|NEXT):[ \t]*(.*)$/i);
      if (!m) { done = true; break; }
      fields[m[1].toUpperCase()] = m[2].trim();
      consumed += line.length + 1;
      if ("HEARD" in fields && "LANG" in fields && "NEXT" in fields) { done = true; break; }
    }
    if (!done && !final && buf.length < 600) return;
    heard = fields.HEARD ?? "";
    lang = /^(de|en)/i.test(fields.LANG ?? "") ? fields.LANG.slice(0, 2).toLowerCase() : "";
    const n = (fields.NEXT ?? "").toLowerCase().match(/[a-z]+/)?.[0];
    next = NEXT_VALUES.has(n) ? n : "listen";
    pending = buf.slice(consumed).replace(/^\s+/, "");
    headerDone = true;
    onHeader({ heard, lang, next });
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
    end() {
      if (!headerDone) readHeader(true);
      emitSentences(true);
      return { heard, lang, next };
    },
  };
}

// First ", " at or after `min` characters (a clause break good enough to start speaking).
function firstComma(text, min) {
  const i = text.indexOf(", ", min);
  return i >= 0 ? i + 2 : -1;
}

// End of the last complete sentence: . ! ? … then whitespace, or a line break.
function lastBoundary(text) {
  const re = /[.!?…]+["»”')]*\s|\n/g;
  let end = -1;
  let m;
  while ((m = re.exec(text))) end = m.index + m[0].length;
  return end;
}

// Spoken text only: no markdown, no emoji, one line.
export function clean(text) {
  return text
    .replace(/[*_#`>]+/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
