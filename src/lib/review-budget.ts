// Pure ranking + whole-file budget for reviewer prompt attachments.
// WHY: split out of github.server.ts (network) so ordering/budget is unit-testable
// and so the prompt drops whole low-priority files instead of truncating mid-hunk.

const CODE_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".java", ".kt", ".rb", ".php", ".cs", ".rs", ".sql", ".vue", ".svelte"];
const CONFIG_EXT = [".json", ".yml", ".yaml", ".toml"];
const DOC_EXT = [".md", ".mdx", ".txt"];

function isTestPath(p: string): boolean {
  return /\.spec\.|\.test\.|__tests__|\/tests?\//.test(p);
}

function hasExt(p: string, exts: string[]): boolean {
  return exts.some((e) => p.endsWith(e));
}

/** 0 code · 1 test · 2 config · 3 doc/other. Lower rank = higher prompt priority. */
export function rankChangedFile(path: string): 0 | 1 | 2 | 3 {
  const p = String(path || "").toLowerCase();
  if (isTestPath(p)) return 1;
  // locales/changelog are doc-priority even when stored as .json
  if (p.includes("/locales/") || p.includes("changelog")) return 3;
  if (hasExt(p, CODE_EXT)) return 0;
  if (hasExt(p, CONFIG_EXT)) return 2;
  if (hasExt(p, DOC_EXT)) return 3;
  return 3;
}

/** Stable order: rank ascending, then path ascending. Input order breaks final ties. */
export function orderFiles<T extends { path: string }>(items: T[]): T[] {
  return items
    .map((item) => ({ item, rank: rankChangedFile(item.path) }))
    .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.item.path < b.item.path ? -1 : a.item.path > b.item.path ? 1 : 0))
    .map((x) => x.item);
}

/**
 * Keep whole files in priority order while the cumulative size fits `maxChars`.
 * Never splits a file (no mid-hunk truncation) and never guarantees a minimum:
 * a single file larger than the budget is dropped and recorded by the caller.
 * `maxChars <= 0` disables the budget (keep everything).
 */
export function applyBudget<T extends { path: string; size: number }>(
  items: T[],
  maxChars: number,
): { kept: T[]; dropped: T[] } {
  const ordered = orderFiles(items);
  if (maxChars <= 0) return { kept: ordered, dropped: [] };
  const kept: T[] = [];
  const dropped: T[] = [];
  let used = 0;
  for (const item of ordered) {
    const size = Math.max(0, item.size);
    if (used + size <= maxChars) {
      kept.push(item);
      used += size;
    } else {
      dropped.push(item);
    }
  }
  return { kept, dropped };
}
