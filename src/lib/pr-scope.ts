/** The PR author's statement of what the PR covers and excludes, read from the PR body for the
 * review and fix prompts (live aicc #457: a bot fix re-added work the body put out of scope). */

export const PR_SCOPE_MAX_CHARS = 2000;

const SCOPE_HEADING = /^ {0,3}(#{1,6})\s+(?:.*\b(?:scope|non-goals?)\b|(?:.*[\s(])?(?:범위|제외)(?=$|[\s:)]))/i;
const SCOPE_LINE = /\bout[\s-]of[\s-]scope\s*:|\bnon-goals?\b|범위\s*(?:밖|외)|추가\s*금지/i;

/** The scope sections of `body` (a heading naming scope/non-goals/범위/제외, up to the next heading of
 * the same or higher level) and any out-of-scope line outside them, in order, bounded to
 * PR_SCOPE_MAX_CHARS. Fenced code is never read. "" when the body states no scope. */
export function prScopeSection(body: string): string {
  const out: string[] = [];
  let level = 0; // inside a scope section while > 0
  let fence = ""; // the open fence's marker, "" outside fenced code
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && (!fence || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence ? "" : marker;
      if (level) out.push(line);
      continue;
    }
    const fenced = Boolean(fence);
    if (fenced) {
      if (level) out.push(line);
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+/.exec(line);
    if (heading && level && heading[1].length <= level) level = 0;
    const scope = SCOPE_HEADING.exec(line);
    if (!level && scope) level = scope[1].length;
    if (level || SCOPE_LINE.test(line)) out.push(line);
  }
  const text = out.join("\n").trim();
  if (text.length <= PR_SCOPE_MAX_CHARS) return text;
  // Cut on a line boundary and say so: a half line ("X out of scope except Y" cut after X) would
  // read as a broader exclusion than the author wrote.
  const mark = "\n(scope section truncated)";
  const cut = text.lastIndexOf("\n", PR_SCOPE_MAX_CHARS - mark.length);
  return `${text.slice(0, cut > 0 ? cut : PR_SCOPE_MAX_CHARS - mark.length)}${mark}`;
}
