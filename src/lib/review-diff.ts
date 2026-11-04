/** Right-side line numbers GitHub will accept as pull-review comments. */

/**
 * One changed file's block of the PR diff exactly as a live snapshot carries it (github.server
 * fetchPullSnapshot): a `--- <path>` line, then the GitHub patch (hunks only — no `diff --git` or
 * `+++` header). Blocks are joined with SNAPSHOT_DIFF_SEP. Every diff reader must accept this compact
 * shape as well as `git diff` output (diffFileBlocks).
 */
export function snapshotDiffBlock(path: string, patch: string): string {
  return `--- ${path}\n${patch}`;
}
export const SNAPSHOT_DIFF_SEP = "\n\n";

/** One file of a unified diff: its path (the new side; the old path for a deletion) and its hunk lines
 * from its first `@@` header on (hunk headers included, file header lines excluded). */
export type DiffFileBlock = { path: string; lines: string[] };

const HUNK_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * Split a unified diff into its files. Accepts both shapes a SamplePr.diff can have:
 *   - `git diff` output: `diff --git a/x b/x`, `--- a/x` / `+++ b/x` (or /dev/null), then hunks;
 *   - the live snapshot's compact shape (snapshotDiffBlock): `--- x` then hunks, no `+++` line. The
 *     path is taken verbatim (a real path may begin with `a/`).
 * A `--- ` line inside a hunk can be a removed line (`-- x` in SQL/Lua): it is read as a file header
 * only when followed by a `+++ ` line (git), or when followed by a hunk header (or nothing: a file
 * with no patch) while the current hunk's line counts are used up or a blank line precedes it (the
 * separator between snapshot blocks; a hunk line is never empty).
 */
export function diffFileBlocks(diff: string): DiffFileBlock[] {
  const lines = String(diff ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: DiffFileBlock[] = [];
  let headerOpen = false; // between a file header and the file's first hunk
  let gitHeader = false; // ...and that header began with `diff --git`
  let oldLeft = 0;
  let newLeft = 0;
  const current = (): DiffFileBlock | undefined => out[out.length - 1];
  const start = (path: string, git = false) => {
    out.push({ path, lines: [] });
    headerOpen = true;
    gitHeader = git;
    oldLeft = 0;
    newLeft = 0;
  };
  const clean = (p: string) => p.replace(/\t.*$/, "").trim();
  const strip = (p: string, prefix: "a/" | "b/") => (p.startsWith(prefix) ? p.slice(2) : p);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const next = lines[i + 1] ?? "";
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (git) {
      start(clean(git[2]), true);
      continue;
    }
    const cur = current();
    if (raw.startsWith("--- ")) {
      const oldPath = clean(raw.slice(4));
      if (next.startsWith("+++ ")) {
        // git header pair: the new path names the file; a deletion (+++ /dev/null) keeps the old one.
        const newPath = clean(next.slice(4));
        const path = newPath === "/dev/null" ? strip(oldPath, "a/") : strip(newPath, "b/");
        if (cur && gitHeader && headerOpen) cur.path = path;
        else start(path);
        i += 1;
        continue;
      }
      if (gitHeader && headerOpen) continue; // `diff --git` already named the file
      const boundary = i === 0 || lines[i - 1] === "" || (oldLeft <= 0 && newLeft <= 0);
      if (oldPath && oldPath !== "/dev/null" && boundary && (HUNK_RE.test(next) || next === "")) {
        start(oldPath);
        continue;
      }
    }
    if (raw.startsWith("+++ ") && headerOpen && cur) {
      const p = clean(raw.slice(4));
      if (p !== "/dev/null") cur.path = strip(p, "b/");
      continue;
    }
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      if (!cur) continue;
      headerOpen = false;
      gitHeader = false;
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      cur.lines.push(raw);
      continue;
    }
    if (!cur || headerOpen) continue; // git extended headers (index, mode, rename) and stray text
    const marker = raw[0];
    if (marker === " ") {
      oldLeft -= 1;
      newLeft -= 1;
    } else if (marker === "-") oldLeft -= 1;
    else if (marker === "+") newLeft -= 1;
    else if (marker !== "\\") continue;
    cur.lines.push(raw);
  }
  return out;
}

/** A diff in the live snapshot's compact shape (snapshotDiffBlock per file), whatever shape it came in. */
export function toSnapshotDiff(diff: string): string {
  return diffFileBlocks(diff)
    .map((b) => snapshotDiffBlock(b.path, b.lines.join("\n")))
    .join(SNAPSHOT_DIFF_SEP);
}

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
