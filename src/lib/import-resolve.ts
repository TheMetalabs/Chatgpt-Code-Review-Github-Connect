// Pure import-graph helpers for cross-file reference fetching. No I/O, no relative-module deps, so
// they are unit-testable in isolation and reusable by both the snapshot fetcher and any caller.

const IMPORT_FROM_RE = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;

const NAMED_IMPORT_RE = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const DEFAULT_IMPORT_RE = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*))?\s*from\s*['"]([^'"]+)['"]/g;
const BINDING_RE = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/;

/** DEFAULT for a default import's exported name — the module declares it under an arbitrary name. */
export const DEFAULT_EXPORT = "\0default";

export type ImportBinding = { local: string; exported: string; candidates: string[] };

/**
 * Per-name import graph for a file: each imported LOCAL name mapped to its EXPORTED name and the
 * candidate repo paths of the module it comes from. This lets a cross-file lookup follow the exact
 * import that binds a called name — resolving aliases (`X as Y`) and default imports, and looking a
 * name up ONLY in its own module (not every module that happens to export the same name). Package
 * imports (no leading ".") are skipped. `exported` is DEFAULT_EXPORT for a default import.
 */
export function importGraph(fromPath: string, content: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  const text = String(content || "");
  NAMED_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NAMED_IMPORT_RE.exec(text)) !== null) {
    const candidates = resolveRelativeImport(fromPath, m[2]);
    if (!candidates.length) continue;
    for (const raw of m[1].split(",")) {
      const b = BINDING_RE.exec(raw.trim());
      if (b) out.push({ local: b[2] || b[1], exported: b[1], candidates });
    }
  }
  DEFAULT_IMPORT_RE.lastIndex = 0;
  while ((m = DEFAULT_IMPORT_RE.exec(text)) !== null) {
    if (m[1] === "type") continue; // `import type { X }` is not a default binding
    const candidates = resolveRelativeImport(fromPath, m[2]);
    if (candidates.length) out.push({ local: m[1], exported: DEFAULT_EXPORT, candidates });
  }
  return out;
}

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
  // Explicit-extension specifier (NodeNext / explicit ESM): the extension is already in `base`, so
  // appending ".ts" would fetch a nonexistent "foo.ts.ts". Use the path as-is. A ".js"/".jsx"/".mjs"/
  // ".cjs" specifier in a TS project resolves to the TS source, so try those too.
  const ext = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.exec(base);
  if (ext) {
    const noExt = base.slice(0, -ext[0].length);
    const alt: Record<string, string[]> = {
      js: [".ts", ".tsx"],
      jsx: [".tsx"],
      mjs: [".mts", ".ts"],
      cjs: [".cts", ".ts"],
    };
    return [...new Set([base, ...(alt[ext[1]] ?? []).map((e) => noExt + e)])];
  }
  return [
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
}
