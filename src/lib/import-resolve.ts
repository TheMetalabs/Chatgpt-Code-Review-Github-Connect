// Pure import-graph helpers for cross-file reference fetching. No I/O, no relative-module deps, so
// they are unit-testable in isolation and reusable by both the snapshot fetcher and any caller.

const IMPORT_FROM_RE = /^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm;
const REQUIRE_RE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;

const NAMED_IMPORT_RE = /import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const DEFAULT_IMPORT_RE = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*))?\s*from\s*['"]([^'"]+)['"]/g;
const NAMESPACE_IMPORT_RE = /\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g;
const CJS_DESTRUCTURE_RE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
const CJS_WHOLE_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
const REEXPORT_NAMED_RE = /export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
const REEXPORT_STAR_RE = /export\s*\*\s*(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/g;
const BINDING_RE = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/;
const CJS_BINDING_RE = /^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/;

/** Strip block and line comments before import parsing, so a commented-out import (or a real import
 * followed by a commented one) is not treated as a live binding. `//` after `:` or a quote is left
 * alone to avoid eating `http://` or a `//` inside a short string on an import line. */
function withoutComments(text: string): string {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** DEFAULT for a default import's exported name — the module declares it under an arbitrary name. */
export const DEFAULT_EXPORT = "\0default";
/** NAMESPACE for `import * as ns` / `const ns = require(...)` — the member call names the export. */
export const NAMESPACE_EXPORT = "\0namespace";

export type ImportKind = "named" | "default" | "namespace";
export type ImportBinding = { local: string; exported: string; candidates: string[]; kind: ImportKind };

/**
 * Per-name import graph for a file: each imported LOCAL name mapped to its EXPORTED name, its module's
 * candidate repo paths, and its kind. Covers named + aliased + default + namespace ESM imports and
 * CommonJS `require` (destructured and whole). A cross-file lookup follows the exact import that binds
 * a called name and looks it up ONLY in its own module. Package imports (no leading ".") are skipped.
 */
export function importGraph(fromPath: string, content: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  const text = withoutComments(content);
  const add = (local: string, exported: string, spec: string, kind: ImportKind) => {
    const candidates = resolveRelativeImport(fromPath, spec);
    if (candidates.length) out.push({ local, exported, candidates, kind });
  };
  const eachNamed = (list: string, spec: string, re: RegExp) => {
    // re is non-global (anchored ^...$), so exec always starts at 0 — no lastIndex bookkeeping.
    for (const raw of list.split(",")) {
      const b = re.exec(raw.trim());
      if (b) add(b[2] || b[1], b[1], spec, "named"); // local = alias || name, exported = name
    }
  };
  let m: RegExpExecArray | null;
  NAMED_IMPORT_RE.lastIndex = 0;
  while ((m = NAMED_IMPORT_RE.exec(text)) !== null) eachNamed(m[1], m[2], BINDING_RE);
  DEFAULT_IMPORT_RE.lastIndex = 0;
  while ((m = DEFAULT_IMPORT_RE.exec(text)) !== null) if (m[1] !== "type") add(m[1], DEFAULT_EXPORT, m[2], "default");
  NAMESPACE_IMPORT_RE.lastIndex = 0;
  while ((m = NAMESPACE_IMPORT_RE.exec(text)) !== null) add(m[1], NAMESPACE_EXPORT, m[2], "namespace");
  CJS_DESTRUCTURE_RE.lastIndex = 0;
  while ((m = CJS_DESTRUCTURE_RE.exec(text)) !== null) eachNamed(m[1], m[2], CJS_BINDING_RE);
  CJS_WHOLE_RE.lastIndex = 0;
  while ((m = CJS_WHOLE_RE.exec(text)) !== null) add(m[1], NAMESPACE_EXPORT, m[2], "namespace");
  return out;
}

/** A module's barrel re-exports: `export { X as Y } from './m'` ({name:Y, source:X}) and
 * `export * from './m'` ({name:"*"}). Lets a lookup that misses in a barrel follow to the module that
 * actually defines the symbol. */
export type ReExport = { name: string; source: string; candidates: string[] };
export function reExportsOf(fromPath: string, content: string): ReExport[] {
  const out: ReExport[] = [];
  const text = withoutComments(content);
  let m: RegExpExecArray | null;
  REEXPORT_NAMED_RE.lastIndex = 0;
  while ((m = REEXPORT_NAMED_RE.exec(text)) !== null) {
    const candidates = resolveRelativeImport(fromPath, m[2]);
    if (!candidates.length) continue;
    for (const raw of m[1].split(",")) {
      const b = BINDING_RE.exec(raw.trim());
      // `export { default as Widget } from './w'` re-exports the target's DEFAULT under the name
      // Widget, so a follow-through must look up the default export, not a symbol named "default".
      if (b) out.push({ name: b[2] || b[1], source: b[1] === "default" ? DEFAULT_EXPORT : b[1], candidates });
    }
  }
  REEXPORT_STAR_RE.lastIndex = 0;
  while ((m = REEXPORT_STAR_RE.exec(text)) !== null) {
    const candidates = resolveRelativeImport(fromPath, m[2]);
    if (!candidates.length) continue;
    // `export * as ns from './m'` is a NAMED re-export (of the namespace) — record its name so it is
    // only followed for that name, not treated as a blanket star that satisfies every wanted name.
    out.push(m[1] ? { name: m[1], source: m[1], candidates } : { name: "*", source: "*", candidates });
  }
  return out;
}

const IDENT_RE = /[A-Za-z_$][\w$]*/g;
/** Identifiers appearing in a patch's hunk body (added + context lines). Used to prioritize fetching
 * the modules whose bindings the changed hunk actually references. */
export function hunkReferencedNames(patch: string): Set<string> {
  const out = new Set<string>();
  for (const line of String(patch || "").split("\n")) {
    if (!((line.startsWith("+") && !line.startsWith("+++")) || line.startsWith(" "))) continue;
    IDENT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = IDENT_RE.exec(line.slice(1))) !== null) out.add(m[0]);
  }
  return out;
}

/** Module specifiers a source file imports/re-exports from — ESM `... from '...'` and CJS
 * `require('...')` — so both dependency styles are fetched. */
export function importSpecifiers(content: string): string[] {
  const out = new Set<string>();
  const text = withoutComments(content);
  IMPORT_FROM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IMPORT_FROM_RE.exec(text)) !== null) out.add(m[1]);
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(text)) !== null) out.add(m[1]);
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
  // Explicit NON-code asset (./styles.css, ./config.json, ...) — no code definition to extract, and
  // treating the suffix as part of an extensionless name would fetch impossible paths (styles.css.ts).
  if (/\.(?:css|scss|sass|less|json|svg|png|jpe?g|gif|webp|avif|md|mdx|txt|ya?ml|graphql|gql|wasm|node|html)$/i.test(base)) {
    return [];
  }
  // Extensionless specifier (including unknown-suffix dotted names like ./my.util -> my.util.ts): try
  // every supported module extension as a file, then as a directory index. Common (.ts) first so the
  // usual case resolves on the first fetch; the caller breaks on the first candidate that exists, so
  // rarer extensions add cost only for genuinely unresolved imports.
  const exts = ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"];
  return [...exts.map((e) => `${base}.${e}`), ...exts.map((e) => `${base}/index.${e}`)];
}
