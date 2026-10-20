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

/** `slice` with the escapes JSON forbids made literal, for a model that wrote LaTeX or regex text into a
 * string (live 2026-10-20, Grok: a LaTeX ldots command inside a review string, "Invalid \escape"). Only
 * inside strings: a backslash that does not start one of JSON's escapes (quote, backslash, slash, b, f, n,
 * r, t, uXXXX) is doubled, so the text keeps its backslash; every raw control character U+0000-U+001F in
 * a string is escaped (\b \f \n \r \t, else \uXXXX). Applied only after the strict parse failed.
 * Mirrors extension/json.js repairJsonEscapes. */
export function repairJsonEscapes(slice: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < slice.length; i += 1) {
    const c = slice[i];
    if (!inStr) { out += c; if (c === '"') inStr = true; continue; }
    if (c === '"') { out += c; inStr = false; continue; }
    if (c === "\\") {
      const n = slice[i + 1];
      if (n !== undefined && '"\\/bfnrt'.includes(n)) { out += c + n; i += 1; continue; }
      if (n === "u" && /^[0-9a-fA-F]{4}$/.test(slice.slice(i + 2, i + 6))) { out += slice.slice(i, i + 6); i += 5; continue; }
      out += "\\\\";
      continue;
    }
    // Every raw control character (U+0000-U+001F) is invalid inside a JSON string.
    if (c < " ") {
      const short: Record<string, string> = {"\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t"};
      out += short[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }
    out += c;
  }
  return out;
}

/** Slice of `text` that is the last balanced JSON object `accept` validates, with offsets. */
export type JsonObjectSlice = { json: string; start: number; end: number }; // end exclusive

/**
 * Walk backward from each closing brace so thinking traces with extra `{` cannot swallow
 * the payload, returning the last balanced JSON object slice that `accept` validates
 * (and its start/end offsets into `text`). Shared by the review extractor and the
 * fix-agent extractor (design §6 mechanism A).
 */
export function lastJsonObjectRange(text: string, accept: (value: unknown) => boolean, repair = false): JsonObjectSlice | null {
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
            // Strict parse failed: a review (only) is read again with invalid escapes made literal.
            if (repair) {
              const fixed = repairJsonEscapes(slice);
              try {
                if (fixed !== slice && accept(JSON.parse(fixed))) return { json: fixed, start: i, end: end + 1 };
              } catch { /* not valid JSON even repaired; keep walking */ }
            }
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
  return lastJsonObjectRange(text, isReviewObject, true)?.json ?? null;
}

// ---- A review cut off mid-answer (live 2026-10-20: all 24 raw captures ended inside `coverage`) ----

/** Where the last review object starts in `text`: its opening brace, before a review key. Whatever sits
 * before it (a "JSON" / "Grok" / "×N" label, an unclosed ```json fence, an `<escape>` tag, prose) is not
 * part of the object and is never read. -1 when none. */
export function lastReviewStart(text: string): number {
  const re = /\{\s*"(?:merge_recommendation|findings|highest_risk|investigated_safe|assumptions|coverage|keep)"\s*:/g;
  const s = String(text || "");
  let last = -1, objectEnd = -1;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    // A review key opening an object INSIDE the review being read (a nested `{"coverage": ...}`) is not
    // another review: only an object that starts after the previous one ended can be the last review.
    if (m.index < objectEnd) continue;
    last = m.index;
    const scan = scanReview(s.slice(m.index));
    objectEnd = scan.rootEnd >= 0 ? m.index + scan.rootEnd : Infinity;
  }
  return last;
}

type ReviewScan = { complete: boolean; inString: boolean; findingsEnd: number; coverageObjectAt: number; rootEnd: number; cuts: { end: number; closers: string }[] };

/** One forward pass over a review slice: whether its root closed, where the top-level `findings` array
 * ended (-1: it did not), and every place it could be cut cleanly with the closers that would finish it. */
function scanReview(s: string): ReviewScan {
  const stack: string[] = [];
  const cuts: { end: number; closers: string }[] = [];
  let inStr = false, esc = false, strStart = -1;
  let findingsEnd = -1, afterFindingsKey = false, findingsActive = false, rootClosed = false, coverageObjectAt = -1, rootEnd = -1;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') {
        inStr = false;
        if (stack.length === 1 && stack[0] === "{") {
          let j = i + 1;
          while (j < s.length && /\s/.test(s[j])) j += 1;
          if (s[j] === ":") {
            let key = "";
            try { key = JSON.parse(s.slice(strStart, i + 1)) as string; } catch { key = ""; }
            afterFindingsKey = key === "findings";
            // The ROOT object's `coverage` whose value is an object, not an array (a missing `[`).
            let k = j + 1;
            while (k < s.length && /\s/.test(s[k])) k += 1;
            if (key === "coverage" && s[k] === "{") coverageObjectAt = k;
          }
        }
      }
      continue;
    }
    if (c === '"') { inStr = true; strStart = i; continue; }
    if (c === "{" || c === "[") {
      if (c === "[" && afterFindingsKey && stack.length === 1) findingsActive = true;
      afterFindingsKey = false;
      stack.push(c);
    } else if (c === "}" || c === "]") {
      stack.pop();
      if (stack.length === 0) { rootClosed = true; rootEnd = i + 1; break; }
      if (c === "]" && findingsActive && stack.length === 1) { findingsEnd = i + 1; findingsActive = false; }
      // A cut is only clean where a whole element ends: a root-level value (stack length 1: the findings
      // array, a root array or object) or one element of a root-level array such as `coverage` (length 2,
      // inside `[`). A delimiter deeper than that closes the INNER part of an element that is still open
      // (a nested object or array of a half-written coverage entry): cutting there would keep a partial entry.
      if (stack.length === 1 || (stack.length === 2 && stack[1] === "[")) {
        cuts.push({ end: i + 1, closers: [...stack].reverse().map((open) => (open === "{" ? "}" : "]")).join("") });
      }
    }
  }
  return { complete: rootClosed && !inStr, inString: inStr, findingsEnd, coverageObjectAt, rootEnd, cuts };
}

/** A review whose text stopped before it finished, recovered ONLY when everything the verdict rests on
 * arrived: `merge_recommendation` and the whole `findings` array. What follows (coverage, notes) is kept
 * up to its last complete element and the open string, array and object are closed there; the result
 * carries `truncated: true` so nothing downstream reads it as a full, clean review. A reply cut inside
 * `findings`, or one that never reached `merge_recommendation`, is not recovered (null): a dropped
 * finding is worse than a missing one. A missing `[` after `"coverage":` (Grok's page text) is supplied. */
export function recoverTruncatedReviewJson(text: string): string | null {
  const s = String(text || "");
  const start = lastReviewStart(s);
  if (start < 0) return null;
  let slice = s.slice(start);
  let scan = scanReview(slice);
  // The `[` a page's text left out after the root's "coverage": is supplied there only (string-aware: found
  // by the structural scan at the root object, never by a pattern over the text).
  if (scan.coverageObjectAt >= 0) {
    slice = `${slice.slice(0, scan.coverageObjectAt)}[${slice.slice(scan.coverageObjectAt)}`;
    scan = scanReview(slice);
  }
  if (scan.complete || scan.findingsEnd < 0) return null;
  for (let n = scan.cuts.length - 1, tried = 0; n >= 0 && tried < 400; n -= 1, tried += 1) {
    const cut = scan.cuts[n];
    if (cut.end < scan.findingsEnd) break;
    const candidate = slice.slice(0, cut.end) + cut.closers;
    for (const body of [candidate, repairJsonEscapes(candidate)]) {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (Array.isArray(parsed.findings) && typeof parsed.merge_recommendation === "string") return JSON.stringify({ ...parsed, truncated: true });
      } catch { /* try the escape-repaired form, then an earlier cut */ }
    }
  }
  return null;
}

export type ReviewTextStatus = "complete" | "recovered-truncated" | "truncated" | "invalid" | "none";
export type ReviewTextClass = { status: ReviewTextStatus; json?: string };

/** What a captured reply is, never a silent null: "complete" (a whole review object, invalid escapes
 * made literal when the strict parse failed), "recovered-truncated" (cut off but its verdict and
 * findings intact: json carries `truncated: true`), "truncated" (cut off before its findings finished:
 * nothing to recover, the reply is partial), "invalid" (a review object that closed but does not
 * parse) or "none" (no review object in the text). */
export function classifyReviewText(text: string): ReviewTextClass {
  const strict = lastReviewJson(text);
  if (strict) return { status: "complete", json: strict };
  const recovered = recoverTruncatedReviewJson(text);
  if (recovered) return { status: "recovered-truncated", json: recovered };
  const start = lastReviewStart(text);
  if (start < 0) return { status: "none" };
  return { status: scanReview(String(text).slice(start)).complete ? "invalid" : "truncated" };
}

/** extractChatJson, then a truncated review recovered by recoverTruncatedReviewJson. */
export function extractChatJsonRecovering(text: string): string | null {
  return extractChatJson(text) ?? recoverTruncatedReviewJson(text);
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
  const plain = lastJsonObjectRange(s, isReviewObject, true);
  if (plain) return plain;
  // Only a transcript that yields nothing as written is read again without citation markers.
  const cleaned = withoutCitationMarkers(s);
  if (!cleaned) return null;
  const fromCleaned = lastJsonObjectRange(cleaned, isReviewObject, true);
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
    const span = lastJsonObjectRange(src, isReviewObject, true);
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