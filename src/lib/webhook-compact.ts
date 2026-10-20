/** Bounds the free text of a VERIFIED webhook payload before it is parsed, stored or prompted.
 * Runs only after the HMAC check on the exact raw body (routes/api/webhook.ts): truncating first
 * would make every large delivery fail verification.
 *
 * Trigger text — the comment of a comment event, the PR body (and its previous version) of a
 * pull_request event — is what mention / loop-directive parsing reads, so it is kept up to
 * GitHub's own 65,536-character body limit (a no-op for any real delivery). Context-only text the
 * parser never reads — e.g. the PR description GitHub embeds as `issue.body` in every
 * issue_comment — is cut to a short preview with a marker. */
export const TRIGGER_TEXT_MAX = 65_536;
export const CONTEXT_TEXT_MAX = 8_192;

export const truncationMarker = (dropped: number, total: number) =>
  `\n\n[ashlar: truncated ${dropped} of ${total} characters]`;

type Field = { path: readonly string[]; max: number };

const CONTEXT_FIELDS: readonly (readonly string[])[] = [
  ["issue", "body"],
  ["pull_request", "body"],
  ["review", "body"],
  ["comment", "body"],
  ["changes", "body", "from"],
  ["changes", "title", "from"],
];

/** The fields each event's trigger parsing reads (github-payload.ts). */
const TRIGGER_FIELDS: Record<string, readonly (readonly string[])[]> = {
  pull_request: [["pull_request", "body"], ["changes", "body", "from"]],
  issue_comment: [["comment", "body"], ["changes", "body", "from"]],
  pull_request_review_comment: [["comment", "body"], ["changes", "body", "from"]],
};

function fieldsFor(event: string): Field[] {
  const trigger = TRIGGER_FIELDS[event] ?? [];
  const isTrigger = (p: readonly string[]) => trigger.some((t) => t.join(".") === p.join("."));
  return CONTEXT_FIELDS.map((path) => ({ path, max: isTrigger(path) ? TRIGGER_TEXT_MAX : CONTEXT_TEXT_MAX }));
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  // Never split a surrogate pair at the cut.
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end) + truncationMarker(text.length - end, text.length);
}

export type CompactResult = { payload: unknown; truncated: string[] };

/** Returns a copy with over-long free-text fields cut; the input is not mutated. */
export function compactWebhookPayload(event: string, payload: unknown): CompactResult {
  if (!payload || typeof payload !== "object") return { payload, truncated: [] };
  let out = payload as Record<string, unknown>;
  const truncated: string[] = [];
  for (const { path, max } of fieldsFor(event)) {
    const parents: Record<string, unknown>[] = [out];
    for (const key of path.slice(0, -1)) {
      const next = parents[parents.length - 1][key];
      if (!next || typeof next !== "object" || Array.isArray(next)) break;
      parents.push(next as Record<string, unknown>);
    }
    if (parents.length !== path.length) continue;
    const leaf = path[path.length - 1];
    const value = parents[parents.length - 1][leaf];
    if (typeof value !== "string" || value.length <= max) continue;
    // Copy along the path so the caller's object is untouched.
    let replaced: unknown = clip(value, max);
    for (let i = path.length - 1; i >= 0; i--) {
      replaced = { ...parents[i], [path[i]]: replaced };
    }
    out = replaced as Record<string, unknown>;
    truncated.push(path.join("."));
  }
  return { payload: out, truncated };
}
