import type { Finding, Job, ReviewProvider, Severity } from "./types.ts";
import { OUTCOME_SHAPE, postedOutcome, rawCauseText, skippedNotes, type OutcomeJob, type PostedOutcome } from "./review-outcome.ts";

const BADGE: Record<Severity, string> = {
  P0: "https://img.shields.io/badge/P0-red?style=flat",
  P1: "https://img.shields.io/badge/P1-orange?style=flat",
  P2: "https://img.shields.io/badge/P2-yellow?style=flat",
};

export const REVIEW_SUMMARY_MARK = "<!-- ashlar-review-summary -->";

/** Clean-pass review body. Loop scripts match this string. */
export const CLEAN_REVIEW_BODY = "Didn't find any major issues.";
/** First line of a verify-clean result whose local verification did not complete. Must never contain
 * the CLEAN_REVIEW_BODY sentinel (case-insensitively): it is not a clean pass. */
export const UNVERIFIED_CLEAN_REVIEW_BODY = "Chat found no major issues, but local verification did not complete — this is not a clean pass.";

// Delimiters bracketing the verbatim salvaged reply inside a review body, so the public snapshot can
// strip it (it may echo private PR source) while the full body still posts to the auth-gated PR.
export const REVIEW_RAW_START = "<!-- ashlar-raw:start -->";
export const REVIEW_RAW_END = "<!-- ashlar-raw:end -->";
const MAX_REVIEW_BODY = 65_000; // under GitHub's 65,535-char review-body limit, with room for scaffolding

/** Remove the verbatim salvaged block from a review body for the UNAUTHENTICATED public snapshot.
 * The real wrapper is emitted last (after any structured findings), so anchor on the LAST start
 * marker — a finding rendered earlier cannot forge a decoy pair that hides the genuine block. */
export function redactSalvagedReviewBody(body: string): string {
  const s = String(body || "");
  const start = s.lastIndexOf(REVIEW_RAW_START);
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

/** Render model/operator-controlled text inert to the body's HTML-comment delimiters and markers so
 * it cannot forge or break the raw wrapper or the findings marker. Entities still display as `<!--` /
 * `-->` in the GitHub body. Applied to EVERY interpolated field (never to the literal wrapper the code
 * emits), so exactly one genuine raw pair exists and public redaction is unambiguous. */
function neutralizeMarkers(s: string): string {
  return String(s ?? "").replace(/<!--/g, "&lt;!--").replace(/-->/g, "--&gt;");
}

type SummaryJob = OutcomeJob & Pick<Job, "headSha" | "coverage"> & Partial<Pick<Job, "localVerifyNote" | "rawCauses">>;

/** Everything a body helper reads, computed once so every kind renders the same fields the same way. */
type SummaryParts = {
  outcome: PostedOutcome;
  sha: string;
  /** The verification note line (empty outside a verify-clean round), marker-neutralized. */
  noteLine: string;
  skipped: string[];
  raw: string;
  /** Why the raw block is posted (rawCauseText): fixed text from the merge's stamped causes. */
  rawWhy: string;
};

export function reviewSummaryBody(job: SummaryJob, findings: Finding[], username: string, unanchored: Finding[] = []): string {
  const outcome = postedOutcome(job, findings.length);
  const parts: SummaryParts = {
    outcome,
    sha: job.headSha.slice(0, 7),
    noteLine: job.localVerifyNote ? `\n${neutralizeMarkers(job.localVerifyNote)}\n` : "",
    skipped: skippedNotes(job).slice(0, 4).map(neutralizeMarkers),
    // Neutralize the loop poller's clean-pass sentinel (matching the SAME separator set it accepts,
    // `Didn.t …` — any single char, so `Didnʼt`/backtick variants are covered) so a salvaged body can't
    // read as clean, then neutralize markers so the reply can't forge/break the raw wrapper or marker.
    raw: neutralizeMarkers((job.rawReview ?? "").trim().replace(/didn.t find any major issues\.?/gi, "(the model reported no major issues)")),
    rawWhy: rawCauseText(job.rawCauses),
  };
  switch (outcome) {
    case "findings":
      return findingsBody(job, parts, findings, username, unanchored);
    case "raw":
    case "raw-unverified":
      return rawOnlyBody(parts);
    case "clean":
    case "verified-clean":
    case "unverified-clean":
      return cleanBody(job, parts);
    case "incomplete":
      return incompleteBody(parts);
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
}

/** The trailing machine marker (the loop's CONVERGED side); an incomplete review carries none. */
export function findingsMarker(outcome: PostedOutcome, findings: Finding[], unanchored: Finding[]): string {
  const flag = OUTCOME_SHAPE[outcome].unverified ? " unverified=1" : "";
  if (outcome === "incomplete") return "";
  if (outcome === "raw" || outcome === "raw-unverified") return `<!-- ashlar-findings total=1 inline=0 body=1 raw=1 p0=0 p1=0 p2=0${flag} -->`;
  if (outcome !== "findings") return `<!-- ashlar-findings total=0 inline=0 body=0 p0=0 p1=0 p2=0${flag} -->`;
  const n = countBySeverity(findings);
  return `<!-- ashlar-findings total=${findings.length} inline=${findings.length - unanchored.length} body=${unanchored.length} p0=${n.P0} p1=${n.P1} p2=${n.P2}${flag} -->`;
}

/** The verbatim salvaged block. Its header says whose reply it is: an unverified local
 * verification reply is never presented as an ordinary (chat) salvage. Otherwise it says why, from
 * the causes the merge stamped: a reply that parsed but had rows the gate did not read is not called
 * unparseable. */
function rawBlock(p: SummaryParts): string {
  if (!p.raw) return "";
  const header = p.outcome === "raw-unverified"
    ? "**⚠️ Local verification reply posted verbatim — it could not be used as a review.**"
    : `**⚠️ Review posted verbatim — ${p.rawWhy}.**`;
  return `\n${header} Structured findings/inline anchors are unavailable; the fixing agent should read the original review below and judge it:\n\n${REVIEW_RAW_START}\n${p.raw}\n${REVIEW_RAW_END}\n`;
}

/** A salvaged verbatim review is NOT a clean pass: the clean marker/string stays out so the loop
 * poller does not converge, and the raw text is surfaced for the agent. Skipped-provider warnings
 * are listed too, so a raw-only body is not mistaken for complete multi-provider coverage. */
function rawOnlyBody(p: SummaryParts): string {
  const skipNote = p.skipped.length ? `\n${p.skipped.map((s) => `- ${s}`).join("\n")}\n` : "";
  return capReviewBody(`${REVIEW_SUMMARY_MARK}
${p.noteLine}${rawBlock(p)}${skipNote}
**Reviewed commit:** \`${p.sha}\`
${findingsMarker(p.outcome, [], [])}`);
}

function incompleteBody(p: SummaryParts): string {
  return `${REVIEW_SUMMARY_MARK}
ChatGPT/Grok did not finish a full review.
${p.noteLine}
${p.skipped.map((s) => `- ${s}`).join("\n")}

Not a clean pass — remaining reviewers did not run.`;
}

/** First line stays exactly CLEAN_REVIEW_BODY so the loop poller's partial match still detects a
 * clean pass; the appended sha lets it catch stale-clean reviews. An unverified clean result must
 * NOT carry the sentinel: substring-based consumers would treat it as converged. */
function cleanBody(job: SummaryJob, p: SummaryParts): string {
  const first = OUTCOME_SHAPE[p.outcome].converged ? CLEAN_REVIEW_BODY : UNVERIFIED_CLEAN_REVIEW_BODY;
  const cov = job.coverage ?? [];
  const clearedCount = cov.filter((c) => c.status === "cleared").length;
  const notCleared = cov.filter((c) => c.status === "not_cleared").map((c) => c.file);
  return `${first}\n\nReviewed commit: \`${p.sha}\`\n${p.noteLine}<!-- ashlar-coverage cleared=${clearedCount}/${cov.length} not_cleared=${notCleared.join(",") || "none"} -->\n${findingsMarker(p.outcome, [], [])}`;
}

function unanchoredBlock(unanchored: Finding[]): string {
  if (!unanchored.length) return "";
  const rows = unanchored.map((f) => {
    const detail = neutralizeMarkers([f.failureScenario, f.rootCause, f.evidence ? `Evidence: ${f.evidence}` : "", f.recommendedFix ? `Fix: ${f.recommendedFix}` : ""]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" — "));
    return `- ${severityBadgeMarkdown(f.severity)} \`${neutralizeMarkers(f.file)}:${f.line}\` — **${neutralizeMarkers(f.title)}**${detail ? `\n  ${detail}` : ""}`;
  });
  return `\n**Findings without an inline anchor** — the reported line could not be matched to this PR's diff, so they are surfaced here instead of being dropped:\n\n${rows.join("\n")}\n`;
}

/** Which role local actually had in this job: a verify-clean job released as the chat-down fallback
 * (localFallbackAt) ran local as an ordinary reviewer, never as a verifier of a clean chat result,
 * so the release state wins over the configured role (as in reviewOutcome). */
function reviewersLine(job: SummaryJob): string {
  const providers = (job.reviewProviders ?? []) as ReviewProvider[];
  const chat = providers.filter((p) => p === "chatgpt" || p === "grok");
  const local = !providers.includes("local")
    ? ""
    : job.localFallbackAt
      ? " Local LLM ran as the fallback."
      : job.localReviewRole === "verify-clean" && chat.length
        ? " Local LLM verifies a clean chat result."
        : " Local LLM is fallback if Chrome does not return.";
  return `${chat.length ? `${chat.join(" + ")} ran in parallel.` : ""}${local}`;
}

function findingsBody(job: SummaryJob, p: SummaryParts, findings: Finding[], username: string, unanchored: Finding[]): string {
  const n = countBySeverity(findings);
  return capReviewBody(`${REVIEW_SUMMARY_MARK}

### 💡 Ashlar Review

Here are some automated review suggestions for this pull request.

**Reviewed commit:** \`${p.sha}\`

| Severity | Count |
| --- | --- |
| P0 | ${n.P0} |
| P1 | ${n.P1} |
| P2 | ${n.P2} |

${reviewersLine(job)}
${p.noteLine}${p.skipped.length ? p.skipped.map((s) => `- ${s}`).join("\n") : ""}
${unanchoredBlock(unanchored)}${rawBlock(p)}
<details>
<summary>ℹ️ About Ashlar</summary>

Inline comments use P0 / P1 / P2 badges. Failures in one reviewer are skipped; remaining reviewers still post.

</details>

— ${neutralizeMarkers(username)}
${findingsMarker(p.outcome, findings, unanchored)}
`);
}
