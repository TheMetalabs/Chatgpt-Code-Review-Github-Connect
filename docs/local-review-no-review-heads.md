# Heads left without a review, and vendored code (2026-11-05)

Live reports from the convergence driver (WalkieBoard #523/#524/#530/#531) showed that a head can be left with
no review at all, while vendored code can hold the local model. This document records what Ashlar now does in
each case.

## 1. A local reply that is no review gets one more chance

| Where | Reply | What happens now |
|---|---|---|
| Single-turn leg | `findings: []` with no `investigated_safe` (#524) | The leg escalates once to the multi-turn loop under the same lease. The loop reads files with tools. |
| Single-turn leg | No review JSON after its one JSON correction | Same escalation. Every completed reply stays evidence. |
| Loop group (#530/#531) | A completed reply with no review JSON | One JSON-only reformat turn with no tools. |
| Loop group | A reply cut off at the output limit | One retry asking for a short JSON. The cut-off reply is not sent back. |
| Loop group | Review JSON with no complete finding and no `investigated_safe` | One retry asking for findings or `investigated_safe`. |

The retry happens exactly once.

- It is never sent after `task_done FAILED` or a content-filtered reply.
- If keeping the unusable reply would push the conversation past the loop's context cap, that reply is dropped from the retry. The retry is therefore never larger than the turn it repeats, which matters for the ~30K local window.
- A completed non-JSON reply that a retry replaced stays evidence (`unparsedText`). So does a single-turn reply that an escalation replaced. In either case the leg is never read as a complete, clean verdict.

## 2. A job with no review is a failed attempt, not a skip

When no reviewer produced a review (`no valid review JSON`), the job is marked `noReviewAttempt` and its ops comment reads **Status: failed**. The comment ends with:

```
<!-- ashlar-attempt failed head=<sha> -->
```

A driver that budgets re-requests per head can read this marker and not count the job as that head's review. The budgeting itself lives in the driver, not in Ashlar. Ashlar has no per-head limit: every explicit request is new work (`ingress.ts`).

## 3. Re-reviewing a head without a new commit

There are two ways:

- **Comment** `@ashlar-bot review` on the PR. This works at any head, including one already skipped or posted.
- **Operator re-run**: the **Re-run review** button on the Job page, or `POST /api/harbor {"action":"rerun","jobId":"…"}` (same-origin). Either one starts a new review of an ended GitHub job's PR at its **live** head. It follows the same ingress rules as a mention (fork, draft), supersedes any live job of that PR, and never carries a `/review-loop` directive over.

## 4. Vendored and generated paths (Settings `finding_precision.skip_vendored`, on by default)

Ashlar reads the root `.gitattributes` at the PR's head. Base rules are never inherited, so a rule the PR removes or narrows no longer applies. Paths marked `linguist-vendored` or `linguist-generated` are left out before anything is fetched: no diff, no context, no local loop group, and no finding is posted on them. The rules follow gitattributes(5), and a later line or `-attr` unsets an earlier one. A change to a `.gitattributes` file is itself always reviewed, because that is how a PR would hide its own code.

- The ops comment lists how many paths were left out.
- A PR whose changed paths are all vendored or generated starts no reviewer. Its job is skipped with that reason; this is not a failed attempt.

Not done here:

- **Byte-for-byte check against the upstream commit in `VENDORED.md`.** It needs network access to the upstream repository.
- **A wall-clock budget.** `ASHLAR_LOCAL_REVIEW_DEADLINE_MS` exists but is off by default, per the no-deadline policy in `unbounded-review-waits.md`. Turning it on is the owner's decision.
