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

/**
 * Walk backward from each closing brace so thinking traces with extra `{` cannot swallow
 * the payload, returning the last balanced JSON object slice that `accept` validates.
 * Shared by the review extractor and the fix-agent extractor (design §6 mechanism A).
 */
export function lastJsonObject(text: string, accept: (value: unknown) => boolean): string | null {
  const s = String(text || "");
  const span = lastJsonObjectSpan(s, accept);
  return span ? s.slice(span.start, span.end) : null;
}

/** Where lastJsonObject's slice sits in `s`: [start, end). */
function lastJsonObjectSpan(s: string, accept: (value: unknown) => boolean): { start: number; end: number } | null {
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
            if (accept(JSON.parse(slice))) return { start: i, end: end + 1 };
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

/** Walk backward from each closing brace so thinking traces with extra `{` cannot swallow the payload. */
export function lastReviewJson(text: string): string | null {
  return lastJsonObject(text, isReviewObject);
}

export function extractChatJson(text: string): string | null {
  return extractChatJsonParts(text)?.json ?? null;
}

/** extractChatJson plus what canonicalizing the reply to that object discards: the text the model
 * wrote around it, verbatim, without the one complete code fence wrapping the object or surrounding
 * whitespace. Empty when the reply was only the object (fenced or not); anything else is text the
 * accepted JSON does not carry. */
export function extractChatJsonParts(text: string): { json: string; residual: string } | null {
  const s = String(text || "");
  if (!s.trim()) return null;
  // Scan the entire transcript from the end; an earlier fenced example is not the final answer.
  const span = lastJsonObjectSpan(s, isReviewObject);
  if (!span) return null;
  const around = unwrapFence(s.slice(0, span.start), s.slice(span.end));
  return { json: s.slice(span.start, span.end), residual: `${around.before}\n${around.after}`.trim() };
}

/** Remove the complete code fence directly around the accepted object, and nothing else: an opening
 * run of three or more backticks (or tildes), at a line start, with an optional info string, right
 * before it, and a closing run of the same character at least as long (CommonMark) right after it.
 * Any fence length counts, so a four-backtick fence is not left behind as residual text; a lone or
 * mismatched marker is not a fence pair and stays, as does every fence marker elsewhere in the reply. */
function unwrapFence(before: string, after: string): { before: string; after: string } {
  const head = before.trimEnd();
  const lineStart = head.lastIndexOf("\n") + 1;
  const open = /^[ \t]*(`{3,}|~{3,})[ \t]*[\w-]*$/.exec(head.slice(lineStart));
  if (!open) return { before, after };
  const tail = after.trimStart();
  const close = new RegExp(`^${open[1][0]}{${open[1].length},}[ \\t]*(?=\\r?\\n|$)`).exec(tail);
  if (!close) return { before, after };
  return { before: head.slice(0, lineStart), after: tail.slice(close[0].length) };
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
  return JSON.stringify({ findings: [], merge_recommendation: "COMMENT", raw_review: (header + s).slice(0, 60_000) });
}

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