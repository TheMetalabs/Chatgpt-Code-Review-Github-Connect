import type { Finding, Job, ReviewProvider, Severity } from "./types.ts";

const BADGE: Record<Severity, string> = {
  P0: "https://img.shields.io/badge/P0-red?style=flat",
  P1: "https://img.shields.io/badge/P1-orange?style=flat",
  P2: "https://img.shields.io/badge/P2-yellow?style=flat",
};

export const REVIEW_SUMMARY_MARK = "<!-- ashlar-review-summary -->";

/** Exact Codex clean-pass copy. Review-loop scripts match this string. */
export const CODEX_CLEAN_REVIEW = "Codex Review: Didn't find any major issues.";

export function severityBadgeMarkdown(severity: Severity): string {
  return `**<sub><sub>![${severity} Badge](${BADGE[severity]})</sub></sub>**`;
}

export function inlineFindingComment(finding: Finding, opts?: { owner?: string; repo?: string; headSha?: string }): string {
  const ref =
    opts?.owner && opts?.repo && opts?.headSha && finding.file
      ? `\n\nReference: [\`${finding.file}:L${finding.line}\`](https://github.com/${opts.owner}/${opts.repo}/blob/${opts.headSha}/${finding.file}#L${finding.line})`
      : "";
  const bits = [finding.failureScenario, finding.rootCause, finding.evidence ? `Evidence: ${finding.evidence}` : "", finding.recommendedFix ? `Fix: ${finding.recommendedFix}` : "", finding.recommendedTest ? `Test: ${finding.recommendedTest}` : ""]
    .map((s) => s.trim())
    .filter(Boolean);
  return `${severityBadgeMarkdown(finding.severity)}  **${finding.title}**

${bits.join("\n\n")}${ref}

Useful? React with 👍 / 👎.`;
}

function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const n: Record<Severity, number> = { P0: 0, P1: 0, P2: 0 };
  for (const f of findings) n[f.severity] += 1;
  return n;
}

export function reviewSummaryBody(job: Pick<Job, "headSha" | "reviewProviders" | "assumptions">, findings: Finding[], username: string): string {
  const sha = job.headSha.slice(0, 7);
  const n = countBySeverity(findings);
  const skipped = (job.assumptions ?? []).filter((a) => /skipped/i.test(a)).slice(0, 4);
  const providers = (job.reviewProviders ?? []) as ReviewProvider[];
  const chat = providers.filter((p) => p === "chatgpt" || p === "grok");
  const local = providers.includes("local");
  if (!findings.length) {
    return CODEX_CLEAN_REVIEW;
  }
  return `${REVIEW_SUMMARY_MARK}

### 💡 Ashlar Review

Here are some automated review suggestions for this pull request.

**Reviewed commit:** \`${sha}\`

| Severity | Count |
| --- | --- |
| P0 | ${n.P0} |
| P1 | ${n.P1} |
| P2 | ${n.P2} |

${chat.length ? `${chat.join(" + ")} ran in parallel.` : ""}${local ? " Local LLM is optional and never blocks." : ""}
${skipped.length ? skipped.map((s) => `- ${s}`).join("\n") : ""}

<details>
<summary>ℹ️ About Ashlar</summary>

Inline comments use P0 / P1 / P2 badges. Failures in one reviewer are skipped; remaining reviewers still post.

</details>

— ${username}
`;
}
