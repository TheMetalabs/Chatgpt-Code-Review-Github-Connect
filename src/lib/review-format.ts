import type { Finding, Job, ReviewProvider, Severity } from "./types.ts";

const BADGE: Record<Severity, string> = {
  P0: "https://img.shields.io/badge/P0-red?style=flat",
  P1: "https://img.shields.io/badge/P1-orange?style=flat",
  P2: "https://img.shields.io/badge/P2-yellow?style=flat",
};

export const REVIEW_SUMMARY_MARK = "<!-- ashlar-review-summary -->";

/** Clean-pass review body. Loop scripts match this string. */
export const CLEAN_REVIEW_BODY = "Didn't find any major issues.";

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

export function reviewSummaryBody(job: Pick<Job, "headSha" | "reviewProviders" | "assumptions" | "coverage">, findings: Finding[], username: string, unanchored: Finding[] = []): string {
  const sha = job.headSha.slice(0, 7);
  const n = countBySeverity(findings);
  const skipped = (job.assumptions ?? []).filter((a) => /skipped/i.test(a)).slice(0, 4);
  const providers = (job.reviewProviders ?? []) as ReviewProvider[];
  const chat = providers.filter((p) => p === "chatgpt" || p === "grok");
  const local = providers.includes("local");
  if (!findings.length) {
    if (skipped.length) {
      return `${REVIEW_SUMMARY_MARK}
ChatGPT/Grok did not finish a full review.

${skipped.map((s) => `- ${s}`).join("\n")}

Not a clean pass — remaining reviewers did not run.`;
    }
    // First line stays exactly CLEAN_REVIEW_BODY so the loop poller's partial match
    // still detects a clean pass; the appended sha lets it catch stale-clean reviews.
    const cov = job.coverage ?? [];
    const clearedCount = cov.filter((c) => c.status === "cleared").length;
    const notCleared = cov.filter((c) => c.status === "not_cleared").map((c) => c.file);
    return `${CLEAN_REVIEW_BODY}\n\nReviewed commit: \`${sha}\`\n<!-- ashlar-coverage cleared=${clearedCount}/${cov.length} not_cleared=${notCleared.join(",") || "none"} -->`;
  }
  const unanchoredBlock = unanchored.length
    ? `\n**Findings without an inline anchor** — the reported line could not be matched to this PR's diff, so they are surfaced here instead of being dropped:\n\n${unanchored
        .map((f) => {
          const detail = [f.failureScenario, f.rootCause, f.evidence ? `Evidence: ${f.evidence}` : "", f.recommendedFix ? `Fix: ${f.recommendedFix}` : ""]
            .map((s) => s.trim())
            .filter(Boolean)
            .join(" — ");
          return `- ${severityBadgeMarkdown(f.severity)} \`${f.file}:${f.line}\` — **${f.title}**${detail ? `\n  ${detail}` : ""}`;
        })
        .join("\n")}\n`
    : "";
  return `${REVIEW_SUMMARY_MARK}

### 💡 Ashlar Review

Here are some automated review suggestions for this pull request.

**Reviewed commit:** \`${sha}\`

| Severity | Count |
| --- | --- |
| P0 | ${n.P0} |
| P1 | ${n.P1} |
| P2 | ${n.P2} |

${chat.length ? `${chat.join(" + ")} ran in parallel.` : ""}${local ? " Local LLM is fallback if Chrome does not return." : ""}
${skipped.length ? skipped.map((s) => `- ${s}`).join("\n") : ""}
${unanchoredBlock}
<details>
<summary>ℹ️ About Ashlar</summary>

Inline comments use P0 / P1 / P2 badges. Failures in one reviewer are skipped; remaining reviewers still post.

</details>

— ${username}
`;
}
