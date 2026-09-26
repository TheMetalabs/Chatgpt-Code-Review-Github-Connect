/** The PR author's statement of what the PR covers and excludes, read from the PR body for the
 * review and fix prompts (live aicc #457: a bot fix re-added work the body put out of scope). */

export const PR_SCOPE_MAX_CHARS = 2000;

const SCOPE_HEADING = /^(#{1,6})\s+.*(?:scope|non-goals?|범위|제외)/i;
const SCOPE_LINE = /out[\s-]of[\s-]scope|non-goals?|범위\s*(?:밖|외)|추가\s*금지/i;

/** The scope sections of `body` (a heading naming scope/non-goals/범위/제외, up to the next heading of
 * the same or higher level) and any out-of-scope line outside them, in order, bounded to
 * PR_SCOPE_MAX_CHARS. Fenced code is never read. "" when the body states no scope. */
export function prScopeSection(body: string): string {
  const out: string[] = [];
  let level = 0; // inside a scope section while > 0
  let fenced = false;
  for (const line of String(body ?? "").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      if (level) out.push(line);
      continue;
    }
    if (fenced) {
      if (level) out.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+/.exec(line);
    if (heading && level && heading[1].length <= level) level = 0;
    const scope = SCOPE_HEADING.exec(line);
    if (!level && scope) level = scope[1].length;
    if (level || SCOPE_LINE.test(line)) out.push(line);
  }
  return out.join("\n").trim().slice(0, PR_SCOPE_MAX_CHARS);
}
