import type { Finding, Job, ReviewProvider, Severity } from "./types.ts";

const BADGE: Record<Severity, string> = {
  P0: "https://img.shields.io/badge/P0-red?style=flat",
  P1: "https://img.shields.io/badge/P1-orange?style=flat",
  P2: "https://img.shields.io/badge/P2-yellow?style=flat",
};

export const REVIEW_SUMMARY_MARK = "<!-- ashlar-review-summary -->";

/** Clean-pass review body. Loop scripts match this string. */
export const CLEAN_REVIEW_BODY = "Didn't find any major issues.";

// Delimiters bracketing the verbatim salvaged reply inside a review body, so the public snapshot can
// strip it (it may echo private PR source) while the full body still posts to the auth-gated PR.
export const REVIEW_RAW_START = "<!-- ashlar-raw:start -->";
export const REVIEW_RAW_END = "<!-- ashlar-raw:end -->";
const MAX_REVIEW_BODY = 65_000; // under GitHub's 65,535-char review-body limit, with room for scaffolding

/** Remove the verbatim salvaged block from a review body for the UNAUTHENTICATED public snapshot. */
export function redactSalvagedReviewBody(body: string): string {
  const s = String(body || "");
  const start = s.indexOf(REVIEW_RAW_START);
  if (start < 0) return s;
  const endMark = s.indexOf(REVIEW_RAW_END, start);
  const end = endMark < 0 ? s.length : endMark + REVIEW_RAW_END.length;
  return `${s.slice(0, start)}_(verbatim salvaged review redacted from the public snapshot; posted to the PR)_${s.slice(end)}`;
}

/** Keep the rendered body under GitHub's limit, preserving the trailing findings marker. */
function capReviewBody(body: string): string {
  if (body.length <= MAX_REVIEW_BODY) return body;
  const markerAt = body.lastIndexOf("<!-- ashlar-findings");
  const marker = markerAt >= 0 ? body.slice(markerAt) : "";
  const note = "\n\n…(review body truncated to fit GitHub's limit; full details in review history)\n";
  return body.slice(0, Math.max(0, MAX_REVIEW_BODY - marker.length - note.length)) + note + marker;
}

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

export function reviewSummaryBody(job: Pick<Job, "headSha" | "reviewProviders" | "assumptions" | "coverage" | "rawReview">, findings: Finding[], username: string, unanchored: Finding[] = []): string {
  const sha = job.headSha.slice(0, 7);
  const n = countBySeverity(findings);
  const skipped = (job.assumptions ?? []).filter((a) => /skipped/i.test(a)).slice(0, 4);
  const providers = (job.reviewProviders ?? []) as ReviewProvider[];
  const chat = providers.filter((p) => p === "chatgpt" || p === "grok");
  const local = providers.includes("local");
  // Neutralize any clean-pass sentinel embedded in the verbatim reply (e.g. the model's whole answer
  // was "Didn't find any major issues.") so a body consumer matching CLEAN_REVIEW_BODY — including the
  // loop poller's `Didn.t find any major issues` regex — cannot converge on a deliberately non-clean body.
  const rawReview = (job.rawReview ?? "")
    .trim()
    // Neutralize the loop poller's clean-pass sentinel (so a salvaged body can't read as clean)…
    .replace(/didn['’]t find any major issues\.?/gi, "(the model reported no major issues)")
    // …and HTML-comment markers, so model-controlled text cannot forge/break the raw delimiters or
    // the findings marker (which would let injected text escape the public redaction). Entities still
    // render as `<!--` / `-->` in the GitHub body but are inert to the delimiter/marker parsers.
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;");
  const rawBlock = rawReview
    ? `\n**⚠️ Review posted verbatim — the reply was not parseable JSON and local repair is off.** Structured findings/inline anchors are unavailable; the fixing agent should read the original review below and judge it:\n\n${REVIEW_RAW_START}\n${rawReview}\n${REVIEW_RAW_END}\n`
    : "";
  // A salvaged verbatim review is NOT a clean pass: keep the clean marker/string out so the loop
  // poller does not converge, and surface the raw text for the agent.
  if (rawReview && !findings.length) {
    // Surface skipped-provider warnings here too, so a raw-only body is not mistaken for complete
    // multi-provider coverage when another enabled reviewer failed or hit quota.
    const skipNote = skipped.length ? `\n${skipped.map((s) => `- ${s}`).join("\n")}\n` : "";
    return capReviewBody(`${REVIEW_SUMMARY_MARK}
${rawBlock}${skipNote}
**Reviewed commit:** \`${sha}\`
<!-- ashlar-findings total=1 inline=0 body=1 raw=1 p0=0 p1=0 p2=0 -->`);
  }
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
    return `${CLEAN_REVIEW_BODY}\n\nReviewed commit: \`${sha}\`\n<!-- ashlar-coverage cleared=${clearedCount}/${cov.length} not_cleared=${notCleared.join(",") || "none"} -->\n<!-- ashlar-findings total=0 inline=0 body=0 p0=0 p1=0 p2=0 -->`;
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
  return capReviewBody(`${REVIEW_SUMMARY_MARK}

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
${unanchoredBlock}${rawBlock}
<details>
<summary>ℹ️ About Ashlar</summary>

Inline comments use P0 / P1 / P2 badges. Failures in one reviewer are skipped; remaining reviewers still post.

</details>

— ${username}
<!-- ashlar-findings total=${findings.length} inline=${findings.length - unanchored.length} body=${unanchored.length} p0=${n.P0} p1=${n.P1} p2=${n.P2} -->
`);
}
