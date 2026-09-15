export function policyPathsFor(changed: string[]): string[] {
  const policy = new Set<string>(["AGENTS.md", "code_review.md"]);
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

export function isSafeRepoPath(path: string) {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || p.includes("..") || p.includes("./")) return false;
  return p;
}
