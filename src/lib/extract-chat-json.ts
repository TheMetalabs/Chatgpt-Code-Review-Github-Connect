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

/** Walk backward from each closing brace so thinking traces with extra `{` cannot swallow the payload. */
export function lastReviewJson(text: string): string | null {
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
          const hit = parseReviewSlice(s.slice(i, end + 1));
          if (hit) return hit;
          break;
        }
      }
    }
  }
  return null;
}

export function extractChatJson(text: string): string | null {
  const s = String(text || "");
  if (!s.trim()) return null;
  // Scan the entire transcript from the end; an earlier fenced example is not the final answer.
  return lastReviewJson(s);
}

/** Matches a P0/P1/P2 severity marker written as a shields badge (`![P1 Badge]`), bold, or bare. */
const SEVERITY_MARKER = /(?:!\[\s*)?\b(P[0-2])\b(?:\s*Badge\s*\])?/g;

/**
 * Build a postable review JSON when the model's reply is NOT parseable review JSON and local JSON
 * repair is unavailable — so the job resolves instead of pending forever. Recall over precision: the
 * verbatim reply is preserved in `raw_review` (surfaced in the review body) for the fixing agent to
 * interpret. When P0/P1/P2 markers are present the text is split into per-severity sections so the
 * salvaged findings stay legible; otherwise the whole reply is kept as-is. Never throws; always
 * returns a valid review-JSON string with zero structured findings (COMMENT, non-blocking).
 */
export function salvageReviewJson(text: string): string {
  const s = String(text || "").trim();
  const matches = [...s.matchAll(SEVERITY_MARKER)];
  let body: string;
  if (matches.length) {
    const parts: string[] = [];
    const preamble = s.slice(0, matches[0].index ?? 0).trim();
    if (preamble) parts.push(preamble);
    for (let i = 0; i < matches.length; i += 1) {
      const m = matches[i];
      const start = (m.index ?? 0) + m[0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index ?? s.length : s.length;
      const chunk = s.slice(start, end).replace(/^[\s:.)\]-]+/, "").trim();
      parts.push(`**${m[1]}** ${chunk}`.trim());
    }
    body = parts.join("\n\n");
  } else {
    body = s;
  }
  return JSON.stringify({ findings: [], merge_recommendation: "COMMENT", raw_review: body.slice(0, 60_000) });
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