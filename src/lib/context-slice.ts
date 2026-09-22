// Hunk-anchored context extraction for the reviewer snapshot attachment.
// WHY: the old snapshot sent the first 20K chars of each changed file, which
// missed the changed functions in large files. Instead, emit the head text that
// *encloses* every changed hunk (plus the import block) with line-number gutters
// so the model can cite exact RIGHT-side lines. Boundaries are detected by
// Prettier-style indentation, never by brace counting (strings/regex break that).
import { DEFAULT_EXPORT, NAMESPACE_EXPORT, importGraph, reExportsOf } from "./import-resolve.ts";

export type HunkRange = { newStart: number; newLines: number };
export type SliceRange = { start: number; end: number; reason: string };
export type SliceResult = { ranges: SliceRange[]; text: string };

const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "else", "do"]);
// A 2-space-indented class member signature: modifiers* name (generics)? (
const CLASS_MEMBER = /^ {2}(?:(?:private|protected|public|static|async|readonly|get|set|override|abstract)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const TOP_FN = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\b/;
const TOP_VAR = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+/;
const CLASS_DECL = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\b/;
const CALL_RE = /(?:this\.)?([A-Za-z_$][\w$]*)\s*\(/g;
const PROP_DECL_RE = /^\s*([A-Za-z_$][\w$]*)\??\s*:/;
const IGNORE_1HOP = new Set([
  ...KEYWORDS,
  "function", "constructor", "super", "require", "import", "typeof", "await", "new", "void", "yield", "delete", "in", "of",
  "Number", "String", "Boolean", "Array", "Object", "Set", "Map", "Promise", "JSON", "Math", "console", "RegExp", "Error", "Date",
]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractAddedLines(patch: string): string[] {
  return String(patch || "")
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1));
}

/** All hunk body lines (added + surrounding context), stripped of the +/space marker; diff/hunk
 * headers excluded. Cross-file lookup uses this so a multi-line call whose NAME sits on a context
 * line (only an argument changed) still contributes its callee identifier. */
function extractHunkLines(patch: string): string[] {
  return String(patch || "")
    .split("\n")
    .filter((l) => ((l.startsWith("+") && !l.startsWith("+++")) || l.startsWith(" ")) && !l.startsWith("@@"))
    .map((l) => l.slice(1));
}

/** Collect identifiers matched by `re` (global or not) across added lines, minus builtins. */
function collectNames(added: string[], re: RegExp, group: number): string[] {
  const names = new Set<string>();
  for (const line of added) {
    if (re.global) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        if (m[group] && !IGNORE_1HOP.has(m[group])) names.add(m[group]);
      }
    } else {
      const m = re.exec(line);
      if (m && m[group] && !IGNORE_1HOP.has(m[group])) names.add(m[group]);
    }
  }
  return [...names];
}

/** First line (1-based) that DEFINES `name` in this file (member sig / function / const), else 0. */
function findDefinitionLine(lines: string[], name: string, requireExport = false): number {
  const n = escapeRe(name);
  // requireExport (cross-file lookup): the requested name must be an EXPORTED top-level declaration —
  // a private same-named declaration must not shadow a re-export of that name. Members are never a
  // direct named import, so they are excluded in that mode.
  const exp = requireExport ? "export\\s+" : "(?:export\\s+)?";
  const memberRe = new RegExp(`^ {2}(?:(?:private|protected|public|static|async|readonly|get|set|override|abstract)\\s+)*${n}\\s*(?:<[^>]*>)?\\s*\\(`);
  const fnRe = new RegExp(`^${exp}(?:default\\s+)?(?:async\\s+)?function\\s+${n}\\b`);
  const varRe = new RegExp(`^${exp}(?:const|let|var)\\s+${n}\\b`);
  for (let i = 1; i <= lines.length; i += 1) {
    const l = lines[i - 1] ?? "";
    if ((!requireExport && memberRe.test(l)) || fnRe.test(l) || varRe.test(l)) return i;
  }
  return 0;
}

/** Lines (1-based) that reference `.name`, capped. */
function findReferenceLines(lines: string[], name: string, cap: number): number[] {
  const re = new RegExp(`\\.${escapeRe(name)}\\b`);
  const out: number[] = [];
  for (let i = 1; i <= lines.length && out.length < cap; i += 1) {
    if (re.test(lines[i - 1] ?? "")) out.push(i);
  }
  return out;
}

/** Parse `@@ -a,b +c,d @@` headers from a single file's patch → RIGHT-side ranges. */
export function parseHunks(patch: string): HunkRange[] {
  const hunks: HunkRange[] = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(patch || ""))) !== null) {
    const newStart = Number(m[1]);
    const newLines = m[2] === undefined ? 1 : Number(m[2]);
    if (Number.isFinite(newStart)) {
      hunks.push({ newStart, newLines: Number.isFinite(newLines) ? Math.max(0, newLines) : 1 });
    }
  }
  return hunks;
}

/** Last line (1-based) of the leading import/comment block, or 0 if none. */
function importBlockEnd(lines: string[]): number {
  let end = 0;
  const max = Math.min(lines.length, 200);
  for (let i = 1; i <= max; i += 1) {
    const l = (lines[i - 1] ?? "").trim();
    const importish =
      l === "" ||
      l.startsWith("//") ||
      l.startsWith("/*") ||
      l.startsWith("*") ||
      l.startsWith("import ") ||
      l.startsWith("import{") ||
      l.startsWith("import(") ||
      /^export\s+(?:type\s+)?\{[^}]*\}\s+from\b/.test(l);
    if (importish) {
      end = i;
      continue;
    }
    break;
  }
  return end;
}

/** Enclosing function/member range for a hunk, by indentation. Falls back to a padded window. */
function enclosingRange(lines: string[], hunkStart: number, hunkEnd: number, pad: number): SliceRange {
  const window = (): SliceRange => ({
    start: Math.max(1, hunkStart - pad),
    end: Math.min(lines.length, hunkEnd + pad),
    reason: "window",
  });
  for (let i = Math.min(hunkStart, lines.length); i >= 1; i -= 1) {
    const line = lines[i - 1] ?? "";
    // Reached the class declaration without a member start → don't grab the whole class.
    if (CLASS_DECL.test(line)) return window();
    const cm = CLASS_MEMBER.exec(line);
    if (cm && !KEYWORDS.has(cm[1])) {
      // One-line member (`foo() { return 1; }`) closes on its own line — capture just that line.
      if (/[;}]\s*(?:\/\/[^\n]*)?$/.test(line)) return { start: i, end: i, reason: "member" };
      for (let j = Math.max(i, hunkEnd); j <= lines.length; j += 1) {
        if (/^ {2}\}/.test(lines[j - 1] ?? "")) return { start: i, end: j, reason: "member" };
      }
      return { start: i, end: lines.length, reason: "member" };
    }
    if (TOP_FN.test(line) || TOP_VAR.test(line)) {
      // A statement that ends on its own line (expression-bodied `export const f = () => 1;`, inline
      // `export function f() { return 1; }`, or any one-line declaration) has no later column-zero
      // closing delimiter — capture just that line. Match a trailing `;` or `}` (with an optional line
      // comment) only at the line's end, so a `//` inside a string does not trigger a false scan.
      if (/[;}]\s*(?:\/\/[^\n]*)?$/.test(line)) return { start: i, end: i, reason: "toplevel" };
      for (let j = Math.max(i, hunkEnd); j <= lines.length; j += 1) {
        const l = lines[j - 1] ?? "";
        // Stop at a column-zero closing delimiter, but not one that immediately re-opens a block
        // (e.g. `) => {` closing multi-line params before the arrow body) — keep scanning to the body.
        if (/^[\])}]/.test(l) && !/[([{]\s*$/.test(l)) return { start: i, end: j, reason: "toplevel" };
      }
      return { start: i, end: lines.length, reason: "toplevel" };
    }
  }
  return window();
}

function mergeRanges(ranges: (SliceRange & { priority: number })[]): (SliceRange & { priority: number })[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: (SliceRange & { priority: number })[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
      last.priority = Math.min(last.priority, r.priority);
      if (!last.reason.split("+").includes(r.reason)) last.reason = `${last.reason}+${r.reason}`;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function rangeText(path: string, r: SliceRange, lines: string[]): string {
  const body: string[] = [];
  for (let n = r.start; n <= r.end; n += 1) body.push(`${n}| ${lines[n - 1] ?? ""}`);
  return `--- ${path} (L${r.start}-L${r.end})\n${body.join("\n")}`;
}

/** Drop whole ranges (lowest priority first) until the serialized text fits maxChars. */
function budgetRanges(
  merged: (SliceRange & { priority: number })[],
  lines: string[],
  path: string,
  maxChars: number,
): (SliceRange & { priority: number })[] {
  if (maxChars <= 0) return merged;
  const byPriority = [...merged].sort((a, b) => a.priority - b.priority);
  const kept = new Set<SliceRange>();
  let used = 0;
  for (const r of byPriority) {
    const size = rangeText(path, r, lines).length + 2;
    if (used + size <= maxChars) {
      kept.add(r);
      used += size;
    }
  }
  return merged.filter((r) => kept.has(r));
}

/**
 * Slice `content` down to the head text enclosing every hunk, plus the import block,
 * with line-number gutters. `mode: "head"` reproduces the legacy first-maxChars behavior.
 * Never throws: a boundary miss degrades to a padded window recorded as "window".
 */
export function sliceContext(opts: {
  path: string;
  content: string;
  hunks: HunkRange[];
  padLines: number;
  maxChars: number;
  mode?: "hunks" | "head";
  patch?: string;
}): SliceResult {
  const lines = String(opts.content ?? "").split("\n");
  const total = lines.length;
  if (opts.mode === "head") {
    const body = String(opts.content ?? "").slice(0, Math.max(0, opts.maxChars));
    return { ranges: [{ start: 1, end: total, reason: "head" }], text: `--- ${opts.path}\n${body}` };
  }
  const pad = Math.max(0, opts.padLines || 0);
  const collected: (SliceRange & { priority: number })[] = [];
  const importEnd = importBlockEnd(lines);
  if (importEnd > 0) collected.push({ start: 1, end: Math.min(importEnd, 80), reason: "imports", priority: 2 });
  for (const h of opts.hunks) {
    const hunkStart = Math.max(1, h.newStart);
    const hunkEnd = Math.min(total, Math.max(hunkStart, h.newStart + Math.max(0, h.newLines - 1)));
    try {
      collected.push({ ...enclosingRange(lines, hunkStart, hunkEnd, pad), priority: 1 });
    } catch {
      collected.push({
        start: Math.max(1, hunkStart - pad),
        end: Math.min(total, hunkEnd + pad),
        reason: "heuristic fallback",
        priority: 1,
      });
    }
  }
  // 1-hop (same file only): helpers the added lines call, and readers of added properties.
  // Cross-file symbols are skipped (no repo clone) — recorded by neither, to avoid noise.
  if (opts.patch) {
    const added = extractAddedLines(opts.patch);
    const callees = collectNames(added, CALL_RE, 1).slice(0, 40);
    let defs = 0;
    for (const name of callees) {
      if (defs >= 12) break;
      const defLine = findDefinitionLine(lines, name);
      if (defLine > 0) {
        collected.push({ ...enclosingRange(lines, defLine, defLine, 0), priority: 3, reason: `def:${name}` });
        defs += 1;
      }
    }
    const props = collectNames(added, PROP_DECL_RE, 1).slice(0, 20);
    let readers = 0;
    for (const name of props) {
      if (readers >= 12) break;
      for (const refLine of findReferenceLines(lines, name, 12)) {
        collected.push({ ...enclosingRange(lines, refLine, refLine, 0), priority: 4, reason: `reader:${name}` });
        readers += 1;
        if (readers >= 12) break;
      }
    }
  }
  if (!collected.length) return { ranges: [], text: "" };
  const merged = mergeRanges(collected);
  const budgeted = budgetRanges(merged, lines, opts.path, opts.maxChars);
  return {
    ranges: budgeted.map(({ start, end, reason }) => ({ start, end, reason })),
    text: budgeted.map((r) => rangeText(opts.path, r, lines)).join("\n\n"),
  };
}

/**
 * Cross-file helper definitions for the one-shot reviewer. For symbols the changed hunks CALL or
 * construct, pull their definitions out of the fetched reference files (imported modules that are not
 * themselves changed) with line-number gutters. This gives the browser reviewer the "read the helper
 * it calls" reach the multi-turn loop gets from tools — bounded by budget and count. It extends the
 * same-file 1-hop rule in sliceContext across files; the multi-turn loop still goes further by pulling
 * definitions it only reasons about (not just ones it syntactically calls).
 */
/** Line (1-based) of a top-level class/enum/interface/type declaration named `name`, else 0.
 * findDefinitionLine only knows functions/vars/members, so a `new X()` whose X is a class/entity
 * needs this to reach its definition across files. */
function findTypeDeclLine(lines: string[], name: string, requireExport = false): number {
  const exp = requireExport ? "export\\s+" : "(?:export\\s+)?";
  const re = new RegExp(`^${exp}(?:default\\s+)?(?:abstract\\s+)?(?:class|enum|interface|type)\\s+${escapeRe(name)}\\b`);
  for (let i = 0; i < lines.length; i += 1) if (re.test(lines[i] ?? "")) return i + 1;
  return 0;
}

/** Range of a top-level declaration: from its line to the line that closes it at column 0, bounded.
 * A one-line declaration ending in a semicolon (e.g. `export default () => 1;`, `export type T = X;`)
 * has no later column-zero closing delimiter, so it is captured as a single line. */
function declBlockRange(lines: string[], start: number): SliceRange {
  // Self-closing one-liner: ends in `;` (type alias, expr default) or `}` (inline `class X {}`), with
  // an optional trailing comment. Matched only at the line tail so a `//` in a string does not misfire.
  if (/[;}]\s*(?:\/\/[^\n]*)?$/.test(lines[start - 1] ?? "")) return { start, end: start, reason: "decl" };
  for (let j = start; j <= lines.length; j += 1) {
    if (/^[})\]]/.test(lines[j - 1] ?? "")) return { start, end: j, reason: "decl" };
  }
  return { start, end: Math.min(lines.length, start + 200), reason: "decl" };
}

/** Line (1-based) of a module's `export default ...` declaration, else 0. */
function findDefaultExportLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i += 1) if (/^export\s+default\b/.test(lines[i] ?? "")) return i + 1;
  return 0;
}

/** Local name mapped to the default via an export list (`export { helper as default };`), or "".
 * A `... from '...'` clause is a re-export (handled by reExportsOf), not a local default. */
function findLocalDefaultAliasName(lines: string[]): string {
  for (const line of lines) {
    if (/\bfrom\b/.test(line)) continue;
    const m = /export\s*\{[^}]*\b([A-Za-z_$][\w$]*)\s+as\s+default\b/.exec(line);
    if (m) return m[1];
  }
  return "";
}

/** Definition range of an exported symbol in a module's lines, or null if not found. `exported` may be
 * DEFAULT_EXPORT to locate the module's default export. */
function definitionRange(lines: string[], exported: string, requireExport = false): SliceRange | null {
  if (exported === DEFAULT_EXPORT) {
    const dl = findDefaultExportLine(lines);
    if (dl > 0) {
      // Indirect default (`const helper = ...; export default helper;`): follow the identifier to its
      // real declaration rather than attaching the bare `export default X;` line.
      const indirect = /^export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/.exec(lines[dl - 1] ?? "");
      if (indirect) {
        const inner = definitionRange(lines, indirect[1]);
        if (inner) return inner;
      }
      return declBlockRange(lines, dl); // inline `export default function/class/{...}`
    }
    // Default via a local export list (`const helper = ...; export { helper as default };`).
    const localDefault = findLocalDefaultAliasName(lines);
    return localDefault ? definitionRange(lines, localDefault) : null;
  }
  const defLine = findDefinitionLine(lines, exported, requireExport);
  if (defLine > 0) return enclosingRange(lines, defLine, defLine, 0);
  const declLine = findTypeDeclLine(lines, exported, requireExport);
  return declLine > 0 ? declBlockRange(lines, declLine) : null;
}

/**
 * Cross-file helper definitions for the one-shot chat reviewer: for symbols the changed hunks call or
 * construct, attach the definitions from the modules they are imported from — the file-attachment
 * analog of the multi-turn loop's on-demand file_read.
 *
 * SCOPE (deliberate, best-effort, strictly ADDITIVE): covers RELATIVE ESM imports — named, aliased,
 * and default — of functions/vars/members and class/enum/interface/type declarations. That is the
 * overwhelming common case in this codebase. Intentionally OUT OF SCOPE, because fully reimplementing
 * TS/JS module resolution here is an unbounded long tail: barrel/`export … from` re-exports, namespace
 * imports (`import * as ns` + `ns.member()`), CommonJS `require()`, dynamic `import()`, and tsconfig
 * path aliases. A miss is not a defect — the reviewer simply falls back to the diff + hunk snapshot
 * (no worse than before this feature), and the LOCAL reviewer's on-demand pull (readFileAtHead) is the
 * complete-coverage path for anything this static approximation does not resolve.
 */
/** Find an exported symbol's definition across candidate modules, following barrel re-exports
 * (`export { X } from './real'`, `export * from './real'`) to the module that actually declares it.
 * Depth-capped so a re-export cycle cannot loop. */
function lookupCrossDef(
  corpus: Map<string, string>,
  candidates: string[],
  exported: string,
  excludePath: string,
  depth: number,
): { path: string; range: SliceRange } | null {
  if (depth > 2) return null;
  for (const path of candidates) {
    if (path === excludePath || !corpus.has(path)) continue;
    const content = corpus.get(path) ?? "";
    const range = definitionRange(content.split("\n"), exported, true);
    if (range) return { path, range };
    if (exported === NAMESPACE_EXPORT) continue; // a namespace object has no single declaration to follow
    // Barrel: the module re-exports the name from elsewhere — follow to the defining module. A default
    // import follows a `{ default }` / `{ X as default }` re-export (recorded under the name "default");
    // `export *` re-exports named symbols but never the default, so it cannot satisfy a default import.
    const wantName = exported === DEFAULT_EXPORT ? "default" : exported;
    for (const re of reExportsOf(path, content)) {
      if (re.name === "*" ? exported === DEFAULT_EXPORT : re.name !== wantName) continue;
      const nextName = re.name === "*" ? exported : re.source;
      const hit = lookupCrossDef(corpus, re.candidates, nextName, path, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function crossFileDefs(
  changed: { path: string; content: string; patch: string }[],
  referenceFiles: { path: string; content: string }[],
  maxChars: number,
): string {
  if (maxChars <= 0 || !changed?.length) return "";
  // Corpus keyed by path: unchanged imported modules AND the changed files themselves (a changed file
  // can define a helper another changed file calls whose def sits outside its own hunk slice).
  const corpus = new Map<string, string>();
  for (const f of referenceFiles) corpus.set(f.path, f.content);
  for (const c of changed) if (!corpus.has(c.path)) corpus.set(c.path, c.content);
  const blocks: string[] = [];
  const seen = new Set<string>(); // path:defLine — never emit the same definition twice
  let remaining = maxChars;
  let count = 0;
  const MAX_DEFS = 24;
  const emit = (hit: { path: string; range: SliceRange }): void => {
    const key = `${hit.path}:${hit.range.start}`;
    if (seen.has(key)) return;
    const text = rangeText(hit.path, hit.range, String(corpus.get(hit.path) ?? "").split("\n"));
    if (text.length + 2 > remaining) return;
    seen.add(key);
    blocks.push(text);
    remaining -= text.length + 2;
    count += 1;
  };
  // Attribute called names to the file they are called FROM, follow the exact import that binds each
  // name to its module (resolving aliases, default, namespace, and CJS require; following barrels),
  // and look the def up ONLY in that module. The origin file is skipped (its own defs are already in
  // the hunk snapshot's same-file 1-hop).
  for (const origin of changed) {
    if (remaining <= 0 || count >= MAX_DEFS) break;
    const bindings = new Map(importGraph(origin.path, origin.content).map((b) => [b.local, b]));
    if (!bindings.size) continue;
    const hunkText = extractHunkLines(origin.patch).join("\n");
    // Plain calls / constructions: `helper(`, `new Entity(`. The negative lookbehind excludes member
    // calls (`items.map(`, `this.run(`) so a receiver method is not mistaken for a same-named import.
    const plain = new Set<string>(collectNames([hunkText], /(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g, 1));
    for (const n of collectNames([hunkText], /\bnew\s+([A-Za-z_$][\w$]*)/g, 1)) plain.add(n);
    for (const n of collectNames([hunkText], /<([A-Z][\w$]*)/g, 1)) plain.add(n); // JSX component invocation
    for (const name of plain) {
      if (remaining <= 0 || count >= MAX_DEFS) break;
      const b = bindings.get(name);
      if (!b || b.kind === "namespace") continue; // namespace members handled via qualified calls below
      const hit = lookupCrossDef(corpus, b.candidates, b.exported, origin.path, 0);
      if (hit) emit(hit);
    }
    // Qualified calls `X.member(`: a namespace member (`import * as ns; ns.member()`) looks the member
    // up in the namespace module; a static/object member on a named or default import
    // (`import { Parser }; Parser.parse()`) attaches the receiver's own definition (the class/object).
    for (const q of hunkText.matchAll(/([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (remaining <= 0 || count >= MAX_DEFS) break;
      const b = bindings.get(q[1]);
      if (!b) continue;
      const hit =
        b.kind === "namespace"
          ? lookupCrossDef(corpus, b.candidates, q[2], origin.path, 0)
          : lookupCrossDef(corpus, b.candidates, b.exported, origin.path, 0);
      if (hit) emit(hit);
    }
  }
  return blocks.join("\n\n");
}
