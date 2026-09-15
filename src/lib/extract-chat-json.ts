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
    let esc = false;
    for (let i = end; i >= 0; i -= 1) {
      const c = s[i];
      if (inStr) {
        if (esc) {
          esc = false;
          continue;
        }
        if (c === "\\") {
          esc = true;
          continue;
        }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
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
  const fences = [...s.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fences.length - 1; i >= 0; i -= 1) {
    const hit = lastReviewJson(fences[i][1] || "") || parseReviewSlice((fences[i][1] || "").trim());
    if (hit) return hit;
  }
  const dangling = s.match(/```(?:json)?\s*([\s\S]+)$/i);
  if (dangling) {
    const hit = lastReviewJson(dangling[1] || "");
    if (hit) return hit;
  }
  return lastReviewJson(s);
}