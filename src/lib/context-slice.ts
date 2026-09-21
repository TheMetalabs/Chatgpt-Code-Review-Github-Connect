// Hunk-anchored context extraction for the reviewer snapshot attachment.
// WHY: the old snapshot sent the first 20K chars of each changed file, which
// missed the changed functions in large files. Instead, emit the head text that
// *encloses* every changed hunk (plus the import block) with line-number gutters
// so the model can cite exact RIGHT-side lines. Boundaries are detected by
// Prettier-style indentation, never by brace counting (strings/regex break that).
import { importBindings } from "./import-resolve.ts";

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
function findDefinitionLine(lines: string[], name: string): number {
  const n = escapeRe(name);
  const memberRe = new RegExp(`^ {2}(?:(?:private|protected|public|static|async|readonly|get|set|override|abstract)\\s+)*${n}\\s*(?:<[^>]*>)?\\s*\\(`);
  const fnRe = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+${n}\\b`);
  const varRe = new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+${n}\\b`);
  for (let i = 1; i <= lines.length; i += 1) {
    const l = lines[i - 1] ?? "";
    if (memberRe.test(l) || fnRe.test(l) || varRe.test(l)) return i;
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
      for (let j = Math.max(i, hunkEnd); j <= lines.length; j += 1) {
        if (/^ {2}\}/.test(lines[j - 1] ?? "")) return { start: i, end: j, reason: "member" };
      }
      return { start: i, end: lines.length, reason: "member" };
    }
    if (TOP_FN.test(line) || TOP_VAR.test(line)) {
      for (let j = Math.max(i, hunkEnd); j <= lines.length; j += 1) {
        if (/^[\])}]/.test(lines[j - 1] ?? "")) return { start: i, end: j, reason: "toplevel" };
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
function findTypeDeclLine(lines: string[], name: string): number {
  const re = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:class|enum|interface|type)\\s+${escapeRe(name)}\\b`);
  for (let i = 0; i < lines.length; i += 1) if (re.test(lines[i] ?? "")) return i + 1;
  return 0;
}

/** Range of a top-level declaration: from its line to the line that closes it at column 0, bounded. */
function declBlockRange(lines: string[], start: number): SliceRange {
  for (let j = start; j <= lines.length; j += 1) {
    if (/^[})\]]/.test(lines[j - 1] ?? "")) return { start, end: j, reason: "decl" };
  }
  return { start, end: Math.min(lines.length, start + 200), reason: "decl" };
}

export function crossFileDefs(
  changed: { path: string; content: string; patch: string }[],
  referenceFiles: { path: string; content: string }[],
  maxChars: number,
): string {
  if (maxChars <= 0 || !changed?.length) return "";
  // Search corpus: unchanged imported modules AND the changed files themselves — a changed file can
  // define a helper another changed file calls whose definition sits outside its own hunk slice.
  const corpus = [...referenceFiles, ...changed.map((c) => ({ path: c.path, content: c.content }))];
  const blocks: string[] = [];
  const seen = new Set<string>(); // path:defLine — never emit the same definition twice
  let remaining = maxChars;
  let count = 0;
  const MAX_DEFS = 24;
  // Attribute called names to the file they are called FROM, so per-file import aliases resolve and the
  // origin file is skipped (its own defs are already in the hunk snapshot's same-file 1-hop).
  for (const origin of changed) {
    if (remaining <= 0 || count >= MAX_DEFS) break;
    const added = extractAddedLines(origin.patch);
    const names = new Set<string>(collectNames(added, CALL_RE, 1));
    for (const n of collectNames(added, /\bnew\s+([A-Za-z_$][\w$]*)/g, 1)) names.add(n);
    if (!names.size) continue;
    // Aliased imports: a hunk may call the LOCAL name (`import { addCalendarMonths as addMonths }`),
    // but the module declares the EXPORTED name. Map local -> exported so the lookup finds the def.
    const exported = new Map<string, string>();
    for (const [local, exp] of importBindings(origin.content)) if (local !== exp) exported.set(local, exp);
    for (const f of corpus) {
      if (f.path === origin.path) continue; // same-file defs are already in the snapshot
      if (remaining <= 0 || count >= MAX_DEFS) break;
      const lines = String(f.content ?? "").split("\n");
      for (const name of names) {
        if (remaining <= 0 || count >= MAX_DEFS) break;
        const lookup = exported.get(name) ?? name;
        // Functions/vars/members via findDefinitionLine; classes/enums/interfaces (constructed or
        // referenced) via findTypeDeclLine so `new Membership(...)` reaches the entity definition.
        const defLine = findDefinitionLine(lines, lookup);
        const declLine = defLine > 0 ? 0 : findTypeDeclLine(lines, lookup);
        if (defLine <= 0 && declLine <= 0) continue;
        const r = defLine > 0 ? enclosingRange(lines, defLine, defLine, 0) : declBlockRange(lines, declLine);
        const key = `${f.path}:${r.start}`;
        if (seen.has(key)) continue;
        const text = rangeText(f.path, r, lines);
        if (text.length + 2 > remaining) continue;
        seen.add(key);
        blocks.push(text);
        remaining -= text.length + 2;
        count += 1;
      }
    }
  }
  return blocks.join("\n\n");
}
