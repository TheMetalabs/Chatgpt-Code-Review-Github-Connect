/** Right-side line numbers GitHub will accept as pull-review comments. */

/** One RIGHT-side (added or context) diff line: its new-file line number and content (marker stripped). */
export type RightLine = { line: number; content: string };

/**
 * Parse a unified diff into the RIGHT-side lines GitHub can anchor an inline comment on —
 * added (`+`) and context (` `) lines, each with its new-file line number and marker-stripped
 * content, in file order. Deleted (`-`) lines are excluded (no RIGHT-side position).
 */
export function rightSideLines(diff: string): Map<string, RightLine[]> {
  const map = new Map<string, RightLine[]>();
  let file = "";
  let right = 0;
  const ensure = (f: string): RightLine[] => {
    let arr = map.get(f);
    if (!arr) {
      arr = [];
      map.set(f, arr);
    }
    return arr;
  };
  for (const raw of String(diff || "").split("\n")) {
    const plusPlus = raw.match(/^\+\+\+ b\/(.+)$/);
    if (plusPlus) {
      file = plusPlus[1].trim();
      ensure(file);
      continue;
    }
    const dashed = raw.match(/^--- ([^\s]+)/);
    if (dashed && !raw.startsWith("--- a/") && !raw.startsWith("--- /dev/null")) {
      const name = dashed[1].replace(/^b\//, "").trim();
      if (name && name !== "/dev/null") {
        file = name;
        ensure(file);
      }
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      right = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("-") && !raw.startsWith("---")) continue;
    if (raw.startsWith("+") || raw.startsWith(" ")) {
      ensure(file).push({ line: right, content: raw.slice(1) });
      right += 1;
    }
  }
  return map;
}

export function commentableRightLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [file, lines] of rightSideLines(diff)) {
    out.set(
      file,
      new Set(lines.map((l) => l.line)),
    );
  }
  return out;
}

/** Trim, then drop a single leading diff marker, then trim again — so target and diff lines compare equal. */
function normalizeForMatch(s: string): string {
  let t = s.trim();
  if (t.startsWith("+") || t.startsWith("-")) t = t.slice(1);
  return t.trim();
}

/**
 * A single-line snippet is only trustworthy when it carries enough identity to pin one location —
 * a lone `}` / `);` or a short fragment is too easy to match by accident. Multi-line snippets are
 * exempt (the caller passes them through). Rejected snippets fall back to the model's line number.
 */
function isSpecificLine(s: string): boolean {
  return s.length >= 12 && /[A-Za-z0-9_]{3,}/.test(s);
}

/**
 * Resolve the RIGHT-side line a verbatim code `snippet` points to, computed from the diff rather
 * than trusted from the model's (often drifted) line number. Returns the line ONLY on a single,
 * specific, unambiguous match:
 *
 *   - the snippet's normalized line(s) must match one consecutive run of RIGHT-side diff lines;
 *   - a second match anywhere makes it ambiguous → declines (never guesses between duplicates);
 *   - a lone trivial line (short / punctuation-only) is too weak → declines.
 *
 * A decline returns null, and the caller keeps its existing behavior — so this can only improve a
 * finding's location, never drop the finding or move it to a worse spot than the model's own line.
 */
export function resolveLineFromSnippet(
  file: string,
  snippet: string,
  rightLines: Map<string, RightLine[]>,
): number | null {
  const lines = rightLines.get(file);
  if (!lines || !lines.length) return null;
  const targets = snippet.split("\n").map(normalizeForMatch).filter(Boolean);
  if (!targets.length) return null;
  if (targets.length === 1 && !isSpecificLine(targets[0])) return null;

  let found = -1;
  for (let i = 0; i + targets.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < targets.length; j += 1) {
      if (normalizeForMatch(lines[i + j].content) !== targets[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (found !== -1) return null; // 2+ matches — ambiguous, decline rather than guess
    found = lines[i].line;
  }
  return found === -1 ? null : found;
}

export function snapToCommentableLine(file: string, line: number, map: Map<string, Set<number>>): number | null {
  const set = map.get(file);
  if (!set || !set.size) return null;
  if (set.has(line)) return line;
  for (let d = 1; d <= 8; d += 1) {
    if (set.has(line + d)) return line + d;
    if (set.has(line - d)) return line - d;
  }
  return null;
}

export function isReviewLineError(text: string): boolean {
  return /pull_request_review_thread\.line must be part of the diff|line must be part of the diff|Path is invalid|could not comment/i.test(
    String(text || ""),
  );
}
