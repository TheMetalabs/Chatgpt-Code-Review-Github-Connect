/** "owner/repo#pr " for a webhook payload that names a pull request (issue comments on PRs, reviews,
 * review comments, pull_request events), "owner/repo " when only the repository is known (a push),
 * else "". Untrusted input: only well-formed names and a positive integer are used. */
export function ignoredTarget(payload: unknown): string {
  const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, any>;
  const full = typeof p.repository?.full_name === "string" && /^[\w.-]+\/[\w.-]+$/.test(p.repository.full_name) ? p.repository.full_name : "";
  if (!full) return "";
  const n = p.pull_request?.number ?? (p.issue?.pull_request ? p.issue?.number : undefined);
  return Number.isSafeInteger(n) && n > 0 ? `${full}#${n} ` : `${full} `;
}
