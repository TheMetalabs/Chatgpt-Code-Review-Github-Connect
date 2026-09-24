import { describeEnabledReviewers, type Job, type LocalReviewRole, type ReviewProvider, type Trigger } from "./types.ts";

export type OpsPhase = "running" | "blocked" | "posted" | "skipped" | "failed";

export type OpsCommentInput = {
  phase: OpsPhase;
  providers: ReviewProvider[];
  /** The job's pinned local role; "verify-clean" reads "local verifies a clean result". */
  role?: LocalReviewRole;
  notes: string[];
};

export const OPS_COMMENT_MARK = "<!-- ashlar-ops -->";

/** Only admitted explicit requests, including PR-body mentions, get status comments. */
export function opsCommentAllowed(job: { trigger: Trigger }): boolean {
  return job.trigger === "issue_comment.mention" || job.trigger === "pull_request_review_comment.followup" ||
    job.trigger === "pull_request.body_mention";
}

/** ChatGPT / Local / bridge LLM work only on explicit mention (or documented mention token / follow-up). */
export function llmWorkAllowed(job: { trigger: Trigger }): boolean {
  return opsCommentAllowed(job);
}

export function buildOpsComment(input: OpsCommentInput): string {
  const reviewers = describeEnabledReviewers(input.providers, input.role);
  const status =
    input.phase === "blocked"
      ? "blocked — a reviewer is unavailable; others continue"
      : input.phase === "posted"
        ? "review posted"
        : input.phase === "skipped"
          ? "skipped"
          : input.phase === "failed"
            ? "failed"
            : "running";
  const notes = input.notes.map((n) => n.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 8);
  const noteLines = notes.length ? notes.map((n) => `- ${n}`).join("\n") : "- No blockers. Failures are skipped; remaining reviewers continue.";
  return `${OPS_COMMENT_MARK}

## Ashlar

Reviewers: ${reviewers || "none configured"}.

**Status:** ${status}

${noteLines}
`;
}

// WHY: make the "review posted" comment show what the reviewer actually saw —
// reviewed sha (+ whether HEAD moved), prompt sizes, deterministic + model
// coverage, and precision-dropped count. Pure/read-only; never affects the verdict.
export function reviewPostedNotes(
  job: Pick<Job, "headSha" | "headMovedTo" | "promptStats" | "coverage" | "coverageDeterministic" | "droppedCount">,
  returnedFindings: number,
  unanchoredInBody = 0,
): string[] {
  const notes: string[] = [];
  const sha = job.headSha.slice(0, 7);
  const moved = job.headMovedTo && job.headMovedTo.slice(0, 7) !== sha ? ` (HEAD moved to ${job.headMovedTo.slice(0, 7)})` : "";
  notes.push(`Reviewed ${sha}${moved}`);
  const ps = job.promptStats;
  if (ps) {
    notes.push(`Prompt: diff ${ps.diffChars} chars (${ps.diffFilesFull}/${ps.diffFilesTotal} files full), context ${ps.contextChars} chars, policy ${ps.policyChars} chars`);
  }
  const det = job.coverageDeterministic ?? [];
  if (det.length) {
    const full = det.filter((d) => d.inDiff).length;
    const ctx = det.filter((d) => d.inContext).length;
    notes.push(`Coverage (deterministic): ${full}/${det.length} code files with full diff, ${ctx}/${det.length} with context`);
  }
  const cov = job.coverage ?? [];
  if (cov.length) {
    const nc = cov.filter((c) => c.status === "not_cleared").map((c) => c.file);
    notes.push(`Coverage (model): not_cleared = ${nc.join(", ") || "none"}`);
  }
  if (typeof job.droppedCount === "number") {
    notes.push(`Findings: ${returnedFindings} returned${unanchoredInBody ? ` (${unanchoredInBody} in body — no inline anchor)` : ""}, ${job.droppedCount} dropped by precision policy`);
  }
  return notes.map((n) => n.slice(0, 200)).slice(0, 8);
}
