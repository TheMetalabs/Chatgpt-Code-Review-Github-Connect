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

/**
 * Extract the review-rules section of a policy file: from a heading matching
 * code review / review rules / severity / reviewer until the next same-or-higher
 * heading. If no such heading, return the first 32 KiB. Cap the result at 32 KiB.
 */
export function extractReviewPolicy(content: string): string {
  const CAP = 32 * 1024;
  const text = String(content || "");
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
    return out.join("\n").slice(0, CAP);
  }
  return text.slice(0, CAP);
}

export function isSafeRepoPath(path: string) {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || p.includes("..") || p.includes("./")) return false;
  return p;
}
