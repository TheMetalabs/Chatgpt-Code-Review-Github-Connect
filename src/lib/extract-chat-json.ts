/** Pull the last review JSON object out of a ChatGPT/Grok transcript. */

function isReviewObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return "findings" in o || "merge_recommendation" in o || "keep" in o;
}

function parseReviewSlice(slice: string): string | null {
  try {
    const parsed: unknown = JSON.parse(slice);
    return isReviewObject(parsed) ? slice : null;
  } catch {
    return null;
  }
}

/** Slice of `text` that is the last balanced JSON object `accept` validates, with offsets. */
export type JsonObjectSlice = { json: string; start: number; end: number }; // end exclusive

/**
 * Walk backward from each closing brace so thinking traces with extra `{` cannot swallow
 * the payload, returning the last balanced JSON object slice that `accept` validates
 * (and its start/end offsets into `text`). Shared by the review extractor and the
 * fix-agent extractor (design §6 mechanism A).
 */
export function lastJsonObjectRange(text: string, accept: (value: unknown) => boolean): JsonObjectSlice | null {
  const s = String(text || "");
  for (let end = s.lastIndexOf("}"); end >= 0; end = s.lastIndexOf("}", end - 1)) {
    let depth = 0;
    let inStr = false;
    for (let i = end; i >= 0; i -= 1) {
      const c = s[i];
      if (c === '"') {
        let slashes = 0;
        for (let j = i - 1; j >= 0 && s[j] === "\\"; j -= 1) slashes += 1;
        if (slashes % 2 === 0) inStr = !inStr;
        continue;
      }
      if (inStr) continue;
      if (c === "}") depth += 1;
      else if (c === "{") {
        depth -= 1;
        if (depth === 0) {
          const slice = s.slice(i, end + 1);
          try {
            if (accept(JSON.parse(slice))) return { json: slice, start: i, end: end + 1 };
          } catch {
            /* not valid JSON at this slice; keep walking */
          }
          break;
        }
      }
    }
  }
  return null;
}

/** Same walk as lastJsonObjectRange, returning only the accepted slice string. */
export function lastJsonObject(text: string, accept: (value: unknown) => boolean): string | null {
  return lastJsonObjectRange(text, accept)?.json ?? null;
}

/** Walk backward from each closing brace so thinking traces with extra `{` cannot swallow the payload. */
export function lastReviewJson(text: string): string | null {
  return lastJsonObject(text, isReviewObject);
}

/** ChatGPT's citation marker (live aicc #455/#457): the model writes
 * `:chatgpt-content-reference{index="0"}` inside a JSON string, and its bare quotes break the JSON.
 * It cites an attachment and is never part of a review or a fix. */
export const CHAT_CITATION_MARKER = /[ \t]*:chatgpt-content-reference\{[^{}\n]*\}/g;

/** `text` without the chat's citation markers, or null when it has none. */
export function withoutCitationMarkers(text: string): string | null {
  return text.search(CHAT_CITATION_MARKER) >= 0 ? text.replace(CHAT_CITATION_MARKER, "") : null;
}

/**
 * Last review JSON in `text` with its start/end offsets into that same string.
 * When citation markers must be stripped first, offsets are remapped by locating
 * the cleaned slice at its last occurrence in the original (markers sit outside
 * the review object for cases this recovers). Returns null offsets only when the
 * accepted JSON exists solely in the cleaned form.
 */
export function extractChatJsonRange(text: string): JsonObjectSlice | null {
  const s = String(text || "");
  if (!s.trim()) return null;
  // Scan the entire transcript from the end; an earlier fenced example is not the final answer.
  const plain = lastJsonObjectRange(s, isReviewObject);
  if (plain) return plain;
  // Only a transcript that yields nothing as written is read again without citation markers.
  const cleaned = withoutCitationMarkers(s);
  if (!cleaned) return null;
  const fromCleaned = lastJsonObjectRange(cleaned, isReviewObject);
  if (!fromCleaned) return null;
  const idx = s.lastIndexOf(fromCleaned.json);
  if (idx < 0) return { json: fromCleaned.json, start: -1, end: -1 };
  return { json: fromCleaned.json, start: idx, end: idx + fromCleaned.json.length };
}

export function extractChatJson(text: string): string | null {
  return extractChatJsonRange(text)?.json ?? null;
}

/** extractChatJson plus what canonicalizing the reply to that object discards: the text the model
 * wrote around it, verbatim, without the one complete code fence wrapping the object or surrounding
 * whitespace. Empty when the reply was only the object (fenced or not); anything else is text the
 * accepted JSON does not carry. Built on lastJsonObjectRange so it coexists with extractChatJsonRange. */
export function extractChatJsonParts(text: string): { json: string; residual: string } | null {
  const s = String(text || "");
  if (!s.trim()) return null;
  const tryParts = (src: string): { json: string; residual: string } | null => {
    const span = lastJsonObjectRange(src, isReviewObject);
    if (!span) return null;
    const around = unwrapFence(src.slice(0, span.start), src.slice(span.end));
    return { json: span.json, residual: `${around.before}\n${around.after}`.trim() };
  };
  // Scan the entire transcript from the end; an earlier fenced example is not the final answer.
  const plain = tryParts(s);
  if (plain) return plain;
  // Only a transcript that yields nothing as written is read again without citation markers.
  const cleaned = withoutCitationMarkers(s);
  return cleaned ? tryParts(cleaned) : null;
}

/** Remove the complete code fence directly around the accepted object, and nothing else: an opening
 * run of three or more backticks (or tildes), at a line start indented at most three spaces, with an
 * optional info string, right before it, and a closing run of the same character at least as long
 * (CommonMark) right after it.
 * The info string is whatever CommonMark allows (`application/json`, `json title="review"`): any text
 * after a tilde run, and any text without a backtick after a backtick run (a backtick there makes the
 * line inline code, not a fence). It is the rest of the opener's line, so the block starts on the next
 * line: text between the marker run and an object on the marker's own line is that line's info
 * string, the object is not inside the block, and the line stays as residual text (prose there may be
 * a finding). Only a bare marker glued to the object is read as its fence. A line indented four or
 * more spaces (or a tab) is an indented code line, not a fence, and stays too.
 * Any fence length counts, so a four-backtick fence is not left behind as residual text. An opening
 * fence with only whitespace after the object is complete too: CommonMark closes an unclosed fence at
 * the end of the document, so that block holds the object alone. A bare fence line (no info string)
 * that is the only text after the object opens an empty block and carries nothing either. A
 * mismatched marker with other text after the object is not a fence pair and stays, as does every
 * fence marker elsewhere in the reply. */
function unwrapFence(before: string, after: string): { before: string; after: string } {
  const head = before.trimEnd();
  const lineStart = head.lastIndexOf("\n") + 1;
  const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(head.slice(lineStart));
  const sameLine = !before.slice(head.length).includes("\n");
  if (!open || (open[1][0] === "`" && open[2].includes("`")) || (sameLine && open[2].trim())) return { before, after: bareFenceOnly(after) ? "" : after };
  const tail = after.trimStart();
  if (!tail) return { before: head.slice(0, lineStart), after: "" };
  const close = new RegExp(`^${open[1][0]}{${open[1].length},}[ \\t]*(?=\\r?\\n|$)`).exec(tail);
  if (!close) return { before, after };
  const rest = tail.slice(close[0].length);
  return { before: head.slice(0, lineStart), after: bareFenceOnly(rest) ? "" : rest };
}

/** One fence marker line with no info string, and nothing else. */
function bareFenceOnly(text: string): boolean {
  return /^\s*(?:`{3,}|~{3,})\s*$/.test(text);
}

/**
 * Build a postable review JSON when the model's reply is NOT parseable/valid review JSON and local
 * JSON repair is unavailable — so the job resolves instead of pending forever. Recall over precision:
 * the reply is kept **verbatim** in `raw_review` (it is the only evidence from an unparseable review,
 * so no character is deleted or reflowed) and surfaced in the review body for the fixing agent. A
 * non-destructive scan notes which P0/P1/P2 severity markers appear, without altering the text.
 * Never throws; always returns valid review JSON with zero structured findings (COMMENT, non-blocking).
 */
export function salvageReviewJson(text: string): string {
  const s = String(text || "").trim();
  const severities = [...new Set(s.match(/\bP[0-2]\b/g) ?? [])].sort();
  const header = severities.length ? `Detected severity markers: ${severities.join(", ")}.\n\n` : "";
  const full = header + s;
  const raw = full.length > SALVAGE_MAX_CHARS ? full.slice(0, SALVAGE_MAX_CHARS - SALVAGE_TRUNCATED_MARK.length) + SALVAGE_TRUNCATED_MARK : full;
  return JSON.stringify({ findings: [], merge_recommendation: "COMMENT", raw_review: raw });
}

export const SALVAGE_MAX_CHARS = 60_000;
export const SALVAGE_TRUNCATED_MARK = "\n\n…(reply truncated to 60,000 characters; the full original is retained in review history)";

/** ChatGPT renders the review as a markdown <p> with <br>, not a JSON API body. */
export function htmlChatToText(html: string): string {
  const quot = String.fromCharCode(34);
  const apos = String.fromCharCode(39);
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<button[\s\S]*?<\/button>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<span[^>]*data-content-reference[\s\S]*?<\/span>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/"/gi, quot)
    .replace(/&#39;/gi, apos)
    .replace(/</gi, "<")
    .replace(/>/gi, ">")
    .replace(/&/gi, "&")
    .trim();
}