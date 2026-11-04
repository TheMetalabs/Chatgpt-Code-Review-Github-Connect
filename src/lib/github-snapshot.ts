export function isSandboxPolicyFile(content: string): boolean {
  return /App Builder Workspace|Grok Build, in an isolated Linux sandbox|imagine_\*/.test(String(content || ""));
}

/** Module instruction files read as repository policy at every directory level of a changed path.
 * CLAUDE.md sits beside AGENTS.md: many repositories keep their module contracts (intended designs,
 * retry semantics, feature flags) only there, and a reviewer that never sees them reports the
 * documented design as a defect. */
export const MODULE_DOC_NAMES = ["AGENTS.md", "CLAUDE.md"] as const;

function pathParts(path: string): string[] {
  return String(path || "").replace(/\\/g, "/").split("/").filter((p) => p && p !== "." && p !== "..");
}

/** True for a path policyPathsFor can produce (a module doc at any level, or the root code_review.md). */
export function isPolicyDocPath(path: string): boolean {
  const parts = pathParts(path);
  const name = parts[parts.length - 1] ?? "";
  return (MODULE_DOC_NAMES as readonly string[]).includes(name) || (parts.length === 1 && name === "code_review.md");
}

export function policyPathsFor(changed: string[]): string[] {
  // Root AGENTS.md/CLAUDE.md are included as policy (base-read); sandbox AGENTS.md is dropped
  // later by content via isSandboxPolicyFile, so real review rules still reach the model.
  const policy = new Set<string>(["code_review.md", ...MODULE_DOC_NAMES]);
  for (const path of changed) {
    const parts = pathParts(path);
    while (parts.length > 1) {
      parts.pop();
      for (const name of MODULE_DOC_NAMES) policy.add([...parts, name].join("/"));
    }
  }
  return [...policy];
}

export function snapshotFileRef(path: string, policyPaths: Iterable<string>, baseSha: string, headSha: string) {
  return new Set(policyPaths).has(path) ? baseSha : headSha;
}

/** Changed paths that are also policy paths. The snapshot reads each twice: at BASE as the policy
 * authority (SamplePr.basePolicyFiles — a PR cannot rewrite the rules it is reviewed by) and at HEAD as
 * the changed file it is (SamplePr.files), so the reviewer sees what the PR itself documents. */
export function changedPolicyDocs(changed: string[], policyPaths: Iterable<string>): string[] {
  const policy = new Set(policyPaths);
  return changed.filter((p) => policy.has(p));
}

/** The module docs of one changed path below the root, one entry per directory level, nearest
 * (deepest) first. */
function moduleDocLevels(path: string): string[][] {
  const parts = pathParts(path);
  const levels: string[][] = [];
  while (parts.length > 1) {
    parts.pop();
    levels.push(MODULE_DOC_NAMES.map((name) => [...parts, name].join("/")));
  }
  return levels;
}
const ROOT_POLICY = [...MODULE_DOC_NAMES, "code_review.md"];

/**
 * Policy files in allocation order: NEAREST FIRST PER CHANGED MODULE. Round-robin over directory
 * levels — the nearest existing module doc of every changed area comes before any area's second-nearest
 * one, and root docs come last — so one large doc of one area is never served ahead of another area's
 * own module doc. Paths in `available` that no changed path reaches are appended in path order.
 */
export function nearestPolicyOrder(changed: string[], available: Iterable<string>): string[] {
  const have = new Set(available);
  const chains: string[][][] = [];
  const seenDirs = new Set<string>();
  for (const path of changed) {
    const dir = pathParts(path).slice(0, -1).join("/");
    if (seenDirs.has(dir)) continue; // one chain per directory
    seenDirs.add(dir);
    chains.push(moduleDocLevels(path).map((level) => level.filter((p) => have.has(p))).filter((level) => level.length));
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const take = (p: string) => {
    if (seen.has(p) || !have.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  for (let k = 0; chains.some((c) => k < c.length); k += 1) for (const c of chains) for (const p of c[k] ?? []) take(p);
  for (const p of ROOT_POLICY) take(p);
  for (const p of [...have].sort()) take(p);
  return out;
}

const POLICY_SEP = 2; // "\n\n" between policy blocks

/**
 * The ashlar-policy.md body: `files` (already in nearestPolicyOrder) within `maxChars`, each FAIRLY.
 * WHY: the old deepest-first greedy fill let one oversized module doc take the whole budget, so every
 * other changed area's module doc and the root rules arrived empty. Now:
 *   - a file whose text repeats an earlier one (a CLAUDE.md mirroring its AGENTS.md) is sent once;
 *   - when everything fits, every file goes whole, in order;
 *   - otherwise each file gets a fair share of what is left (remaining / files left), reduced by
 *     extractReviewPolicy (its review-rules section first, then the head of the file, where domain
 *     invariants live); a file smaller than its share frees the rest for later files;
 *   - leftover budget then re-extracts the truncated files in order, nearest first.
 */
export function allocatePolicyText(files: { path: string; content: string }[], maxChars: number): string {
  const budget = Math.max(0, maxChars);
  const seenText = new Set<string>();
  const rows = files
    .map((f) => ({ path: f.path, text: String(f.content || "").trim() }))
    .filter((f) => {
      if (!f.text || seenText.has(f.text)) return false;
      seenText.add(f.text);
      return true;
    })
    .map((f) => ({ ...f, whole: `--- ${f.path}\n${f.text}`, block: "" }));
  if (!rows.length || budget <= 0) return "";
  const sepFor = (n: number) => (n > 1 ? POLICY_SEP * (n - 1) : 0);
  const wholeLen = rows.reduce((n, r) => n + r.whole.length, 0) + sepFor(rows.length);
  if (wholeLen <= budget) return rows.map((r) => r.whole).join("\n\n");
  const render = (r: (typeof rows)[number], cap: number): string => {
    const header = `--- ${r.path}\n`;
    if (cap <= header.length) return "";
    const rules = extractReviewPolicy(r.text, cap - header.length).trim();
    return rules ? `${header}${rules}`.slice(0, cap) : "";
  };
  const used = () => {
    const kept = rows.filter((r) => r.block);
    return kept.reduce((n, r) => n + r.block.length, 0) + sepFor(kept.length);
  };
  for (let i = 0; i < rows.length; i += 1) {
    const sep = rows.some((r) => r.block) ? POLICY_SEP : 0;
    const remaining = budget - used() - sep;
    if (remaining <= 0) break;
    rows[i].block = render(rows[i], Math.floor(remaining / (rows.length - i)));
  }
  for (const r of rows) {
    if (r.block === r.whole) continue;
    const sep = !r.block && rows.some((x) => x.block) ? POLICY_SEP : 0;
    const avail = budget - used() + r.block.length - sep;
    if (avail <= r.block.length) continue;
    const next = render(r, avail);
    if (next.length > r.block.length) r.block = next;
  }
  return rows.filter((r) => r.block).map((r) => r.block).join("\n\n");
}

/** The explicit review-rules section (heading matching code review / review rules / severity /
 * reviewer, until the next same-or-higher heading), or "" if the file has no such heading. */
function reviewRulesSection(text: string): string {
  const lines = text.split("\n");
  const headingRe = /^(#{2,})\s+.*(?:code review|review rules|severity|reviewer)/i;
  for (let i = 0; i < lines.length; i += 1) {
    const m = headingRe.exec(lines[i]);
    if (!m) continue;
    const level = m[1].length;
    const out = [lines[i]];
    for (let j = i + 1; j < lines.length; j += 1) {
      const h = /^(#{1,6})\s+/.exec(lines[j]);
      if (h && h[1].length <= level) break;
      out.push(lines[j]);
    }
    return out.join("\n");
  }
  return "";
}

/**
 * Policy text for the reviewer, capped at 32 KiB.
 *
 * Curated policy files (AGENTS.md / code_review.md) are small, so return the WHOLE file when it fits:
 * a reviewer must check DOMAIN invariants/contracts (e.g. an expiry/revenue rule), not only a section
 * titled "Code Review". The old behavior sliced to the review-rules heading and silently DROPPED the
 * domain contracts above it — the reviewer then could not detect contract-compliance bugs it had no
 * way to know existed. Only when a policy file exceeds the budget do we prioritize: keep the
 * review-rules section wherever it sits, and fill the rest from the top, where domain invariants live.
 */
export function extractReviewPolicy(content: string, maxChars = 32 * 1024): string {
  const CAP = Math.max(0, maxChars);
  const text = String(content || "");
  if (text.length <= CAP) return text;
  const section = reviewRulesSection(text).slice(0, CAP);
  if (!section) return text.slice(0, CAP);
  const headBudget = Math.max(0, CAP - section.length - 1);
  const head = text.slice(0, headBudget);
  // Avoid duplicating the section when it already falls within the retained head.
  return head.includes(section) ? head.slice(0, CAP) : `${head}\n${section}`.slice(0, CAP);
}

export function isSafeRepoPath(path: string) {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || p.includes("..") || p.includes("./")) return false;
  return p;
}
