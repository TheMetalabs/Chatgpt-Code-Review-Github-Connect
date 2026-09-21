export function isSandboxPolicyFile(content: string): boolean {
  return /App Builder Workspace|Grok Build, in an isolated Linux sandbox|imagine_\*/.test(String(content || ""));
}

export function policyPathsFor(changed: string[]): string[] {
  // Root AGENTS.md is included as policy (base-read); sandbox AGENTS.md is dropped
  // later by content via isSandboxPolicyFile, so real review rules still reach the model.
  const policy = new Set<string>(["code_review.md", "AGENTS.md"]);
  for (const path of changed) {
    const parts = path.replace(/\\/g, "/").split("/").filter((p) => p && p !== "." && p !== "..");
    while (parts.length > 1) {
      parts.pop();
      policy.add([...parts, "AGENTS.md"].join("/"));
    }
  }
  return [...policy];
}

export function snapshotFileRef(path: string, policyPaths: Iterable<string>, baseSha: string, headSha: string) {
  return new Set(policyPaths).has(path) ? baseSha : headSha;
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
export function extractReviewPolicy(content: string): string {
  const CAP = 32 * 1024;
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
