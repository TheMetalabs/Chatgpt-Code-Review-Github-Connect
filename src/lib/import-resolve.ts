// Pure import-graph helpers for cross-file reference fetching. No I/O, no relative-module deps, so
// they are unit-testable in isolation and reusable by both the snapshot fetcher and any caller.

const IMPORT_FROM_RE = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;

/** Module specifiers a source file imports/re-exports from (ESM `... from '...'` only). */
export function importSpecifiers(content: string): string[] {
  const out = new Set<string>();
  IMPORT_FROM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_FROM_RE.exec(String(content || ""))) !== null) out.add(m[1]);
  return [...out];
}

/**
 * Candidate repo-relative paths a RELATIVE import could resolve to. Package imports (no leading ".")
 * return [] — they live in node_modules, which the review never fetches. An import that escapes above
 * the importing file's own tree also returns [] (not a resolvable in-repo path). Results never contain
 * a ".." segment.
 */
export function resolveRelativeImport(fromPath: string, spec: string): string[] {
  if (!spec.startsWith(".")) return [];
  const dir = fromPath.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "..") {
      if (!dir.length) return [];
      dir.pop();
    } else if (part && part !== ".") {
      dir.push(part);
    }
  }
  const base = dir.join("/");
  if (!base) return [];
  return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`, `${base}.js`, `${base}.jsx`];
}
