/**
 * Deterministic scope guard for a fix candidate (P0: aicc PR #439, f02ec26c +155/-1046 — a one-clause
 * fix that also deleted 492 WHY comments, reformatted a file and removed a regression test).
 *
 * Runs on the resulting per-file diff (head content → candidate content) before anything is
 * committed, and rejects a candidate that:
 *   - removes comment lines outside the flagged lines (± FLAG_MARGIN);
 *   - removes or renames an existing test block (it / test / describe and their variants);
 *   - changes more than REFORMAT_MAX_LINES lines outside the flagged lines only in whitespace or
 *     quote style (a reformat);
 *   - deletes far more than it adds (deleted > DELETION_RATIO × added + DELETION_SLACK), unless every
 *     deleted line is inside a flagged range.
 * A new file (no head content) is not guarded. The rejection names the file, the rule and the first
 * offending line, so the retry feedback tells the model exactly what to keep.
 *
 * NON-GOALS: semantic review of the change (the review loop and CI own that); a comment appended to
 * a code line (only whole comment lines are tracked); comment syntax inside string literals.
 */

export interface FlaggedLine {
  path: string;
  line: number;
}

export interface FileChange {
  path: string;
  /** Head content; undefined for a new file. */
  before?: string;
  after: string;
}

/** Lines on either side of a flagged line that the fix may freely rewrite. */
export const FLAG_MARGIN = 15;
/** Whitespace/quote-only line changes allowed outside the flagged lines. */
export const REFORMAT_MAX_LINES = 10;
export const DELETION_RATIO = 3;
export const DELETION_SLACK = 20;
/** Past this edit distance the diff stops searching and counts the rest as rewritten. */
const MAX_DIFF_DISTANCE = 2500;

export type ScopeCheck = { ok: true } | { ok: false; error: string };

// ---------- line diff (Myers, common prefix/suffix trimmed) ----------

export interface LineDiff {
  /** 0-based indices into the old lines. */
  deleted: number[];
  /** 0-based indices into the new lines. */
  added: number[];
}

export function diffLines(a: readonly string[], b: readonly string[]): LineDiff {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo += 1;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1] === b[eb - 1]) {
    ea -= 1;
    eb -= 1;
  }
  const n = ea - lo;
  const m = eb - lo;
  const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
  if (n === 0 || m === 0) return { deleted: range(lo, ea), added: range(lo, eb) };
  const max = Math.min(n + m, MAX_DIFF_DISTANCE);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[lo + x] === b[lo + y]) {
        x += 1;
        y += 1;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, d, n, m, lo);
    }
  }
  // Too far apart to align cheaply: the whole middle counts as rewritten (it effectively is).
  return { deleted: range(lo, ea), added: range(lo, eb) };
}

function backtrack(trace: Int32Array[], dEnd: number, n: number, m: number, lo: number): LineDiff {
  const deleted: number[] = [];
  const added: number[] = [];
  let x = n;
  let y = m;
  for (let d = dEnd; d > 0; d -= 1) {
    const vd = trace[d]; // v before step d, stored for k in [-d-1, d+1] at index k + d + 1
    const at = (k: number) => vd[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
    }
    if (prevK === k + 1) added.push(lo + prevY);
    else deleted.push(lo + prevX);
    x = prevX;
    y = prevY;
  }
  return { deleted: deleted.reverse(), added: added.reverse() };
}

// ---------- comment detection by language ----------

interface CommentSyntax {
  line: string[];
  blocks: Array<[string, string]>;
}

const C_BLOCK: [string, string] = ["/*", "*/"];
const HTML_BLOCK: [string, string] = ["<!--", "-->"];
const C_LIKE = ".ts .tsx .js .jsx .mjs .cjs .mts .cts .java .kt .kts .go .rs .c .h .cc .cpp .hpp .cs .swift .scala .dart .php .groovy .gradle .proto".split(" ");
const CSS = ".css .scss .less".split(" ");
const HASH = ".py .rb .sh .bash .zsh .yml .yaml .toml .r .pl .tf .ini .cfg .conf .env .properties".split(" ");
const MARKUP = ".html .htm .xml .svg .md .mdx".split(" ");
const HASH_NAMES = new Set(["dockerfile", "makefile", ".gitignore", ".dockerignore", ".env"]);

function syntaxFor(path: string): CommentSyntax | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot) : "";
  if (C_LIKE.includes(ext)) return { line: ["//"], blocks: [C_BLOCK] };
  if (CSS.includes(ext)) return { line: ext === ".css" ? [] : ["//"], blocks: [C_BLOCK] };
  if (ext === ".vue" || ext === ".svelte") return { line: ["//"], blocks: [C_BLOCK, HTML_BLOCK] };
  if (ext === ".sql") return { line: ["--"], blocks: [C_BLOCK] };
  if (HASH.includes(ext) || HASH_NAMES.has(base) || base.startsWith("dockerfile")) return { line: ["#"], blocks: [] };
  if (MARKUP.includes(ext)) return { line: [], blocks: [HTML_BLOCK] };
  return null;
}

/** Per line: whether it is a whole comment line (line comment, block comment or JSDoc body). A block
 * is entered only from a line that STARTS with its opener, so a glob like "src/**" in a string never
 * turns the following code into "comments". */
export function commentLines(path: string, lines: readonly string[]): boolean[] {
  const syn = syntaxFor(path);
  if (!syn) return lines.map(() => false);
  let close: string | null = null;
  return lines.map((raw) => {
    const t = raw.trim();
    if (close) {
      if (t.includes(close)) close = null;
      return true;
    }
    if (syn.line.some((tok) => t.startsWith(tok))) return true;
    const block = syn.blocks.find(([open]) => t.startsWith(open));
    if (!block) return false;
    if (!t.slice(block[0].length).includes(block[1])) close = block[1];
    return true;
  });
}

/** A comment line worth keeping: it says something (a letter or digit), not just a delimiter. */
const hasWords = (line: string) => /[\p{L}\p{N}]/u.test(line);

// ---------- test blocks ----------

const TEST_CALL_RE = /(?<![\w.$])[xf]?(it|test|describe)(?:\.(?:skip|only|todo|concurrent|each\s*(?:\([^)]*\)|`[^`]*`)))*\s*\(\s*(["'`])((?:\\.|(?!\2)[^\\\n])*)\2/g;
const PY_TEST_RE = /^[ \t]*(?:async[ \t]+)?def[ \t]+(test_\w+)/gm;

/** Every test block's identity (kind + title) in `content`, with multiplicity. */
export function testBlocks(path: string, content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(TEST_CALL_RE)) out.push(`${m[1]}(${JSON.stringify(m[3])})`);
  if (path.endsWith(".py")) for (const m of content.matchAll(PY_TEST_RE)) out.push(`def ${m[1]}`);
  return out;
}

function missingFrom(before: string[], after: string[]): string[] {
  const left = new Map<string, number>();
  for (const k of after) left.set(k, (left.get(k) ?? 0) + 1);
  const missing: string[] = [];
  for (const k of before) {
    const n = left.get(k) ?? 0;
    if (n > 0) left.set(k, n - 1);
    else missing.push(k);
  }
  return missing;
}

// ---------- the guard ----------

const normalizeFormat = (line: string) => line.replace(/\s+/g, "").replace(/["`]/g, "'");
const quote = (s: string) => JSON.stringify(s.trim().slice(0, 80));

function inFlagged(ranges: Array<[number, number]>, oldIndex: number): boolean {
  const line = oldIndex + 1;
  return ranges.some(([from, to]) => line >= from && line <= to);
}

/** The violations of one changed file, in rule order (empty = in scope). */
export function fileViolations(change: FileChange, flagged: readonly FlaggedLine[]): string[] {
  if (change.before === undefined) return []; // a new file has nothing to preserve
  const oldLines = change.before.split("\n");
  const newLines = change.after.split("\n");
  const { deleted, added } = diffLines(oldLines, newLines);
  const ranges = flagged.filter((f) => f.path === change.path).map((f): [number, number] => [f.line - FLAG_MARGIN, f.line + FLAG_MARGIN]);
  const outside = deleted.filter((i) => !inFlagged(ranges, i));
  const out: string[] = [];

  // 1) comment lines removed (a comment that reappears verbatim elsewhere was moved, not removed)
  const isComment = commentLines(change.path, oldLines);
  const addedText = new Map<string, number>();
  for (const j of added) addedText.set(newLines[j].trim(), (addedText.get(newLines[j].trim()) ?? 0) + 1);
  const removedComments = outside.filter((i) => {
    if (!isComment[i] || !hasWords(oldLines[i])) return false;
    const key = oldLines[i].trim();
    const n = addedText.get(key) ?? 0;
    if (n > 0) {
      addedText.set(key, n - 1);
      return false;
    }
    return true;
  });
  if (removedComments.length) {
    const first = removedComments[0];
    out.push(`${change.path}: ${removedComments.length} comment line(s) removed outside the flagged lines (first at line ${first + 1}: ${quote(oldLines[first])}); keep every existing comment`);
  }

  // 2) test blocks removed or renamed
  const lostTests = missingFrom(testBlocks(change.path, change.before), testBlocks(change.path, change.after));
  if (lostTests.length) {
    out.push(`${change.path}: ${lostTests.length} existing test block(s) removed or renamed (${lostTests.slice(0, 3).join(", ")}); keep every existing test`);
  }

  // 3) reformat: outside the flagged lines, a deleted line whose only change is whitespace/quotes
  const exact = new Map<string, number>();
  const loose = new Map<string, number>();
  for (const j of added) exact.set(newLines[j], (exact.get(newLines[j]) ?? 0) + 1);
  const unmatched = outside.filter((i) => {
    const n = exact.get(oldLines[i]) ?? 0;
    if (n > 0) {
      exact.set(oldLines[i], n - 1); // moved verbatim: not a reformat
      return false;
    }
    return true;
  });
  for (const [line, n] of exact) if (n > 0) loose.set(normalizeFormat(line), (loose.get(normalizeFormat(line)) ?? 0) + n);
  const reformatted = unmatched.filter((i) => {
    const key = normalizeFormat(oldLines[i]);
    const n = key ? (loose.get(key) ?? 0) : 0;
    if (n > 0) loose.set(key, n - 1);
    return n > 0;
  });
  if (reformatted.length > REFORMAT_MAX_LINES) {
    const first = reformatted[0];
    out.push(`${change.path}: ${reformatted.length} line(s) outside the flagged lines changed only in whitespace or quote style (max ${REFORMAT_MAX_LINES}; first at line ${first + 1}: ${quote(oldLines[first])}); never reformat`);
  }

  // 4) deletions far beyond additions
  if (deleted.length > DELETION_RATIO * added.length + DELETION_SLACK && outside.length > 0) {
    out.push(`${change.path}: deletes ${deleted.length} line(s) but adds ${added.length} (limit ${DELETION_RATIO}x added + ${DELETION_SLACK} unless every deleted line is within ${FLAG_MARGIN} lines of a finding); change only the lines the fix needs`);
  }
  return out;
}

/** Guard a whole candidate: ok, or one error naming every violation (most specific first). */
export function checkFixScope(changes: readonly FileChange[], flagged: readonly FlaggedLine[]): ScopeCheck {
  const violations = changes.flatMap((c) => fileViolations(c, flagged));
  if (violations.length === 0) return { ok: true };
  return { ok: false, error: `scope guard: ${violations.join("; ")}` };
}
