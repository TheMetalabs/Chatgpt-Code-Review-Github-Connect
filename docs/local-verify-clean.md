# Local verification of clean chat reviews (`localReviewRole=verify-clean`)

Opt-in. The default role is `race` (local runs alongside the chat reviewers), and nothing here
changes a race job. With `verify-clean` the chat reviewers run first and the local leg is held
back. It is released either as a **verification round** (the merged chat result is clean) or as the
**fallback** (chat produced nothing usable). The role is pinned on the job at snapshot
(`Job.localReviewRole`), so a later settings change never alters a review in flight.

## §1 Review outcome — one closed enum

`reviewOutcome(job, findings)` in `src/lib/review-outcome.ts` is the only place a merged, gated
result is classified. Harbor calls it to decide between holding the post (`verify`) and posting.
`reviewSummaryBody` calls it (through the `postedOutcome` render guard) and derives from the kind
alone: the body's first line, the raw block header, the trailing `ashlar-findings` marker, and so
the loop's CONVERGED signal. No other code reads `localVerified`, `rawReview` or the skipped notes
to decide any of these.

`findings` is the publish-gated count. A job is a *verifier* when its role is `verify-clean`, both a
chat reviewer and local are enabled, and local did not run as the fallback. An FP round merges as
race.

| Kind | When | First line | Marker | CONVERGED |
| --- | --- | --- | --- | --- |
| `verify` | verifier, round not started, 0 findings, no raw | (not posted: local verification round starts) | — | — |
| `findings` | any structured finding | summary mark | `total=N inline=… body=… p0 p1 p2` | no |
| `raw` | a salvaged (unparseable) reply, not a verifier's | summary mark | `total=1 inline=0 body=1 raw=1 p0=0 p1=0 p2=0` | no |
| `raw-unverified` | verification round, local's reply unparseable | summary mark + note | raw marker + ` unverified=1` | no |
| `incomplete` | 0 findings, no raw, a reviewer was skipped | summary mark | none | no |
| `clean` | not a verifier, 0 findings, nothing skipped | `Didn't find any major issues.` | `total=0 …` | **yes** |
| `verified-clean` | verification round, local returned a structured clean result | `Didn't find any major issues.` | `total=0 …` | **yes** |
| `unverified-clean` | verification round, local failed / timed out / offline | `Chat found no major issues, but local verification did not complete …` | `total=0 … unverified=1` | no |

Rules the table encodes:

- `unverified=1` is never CONVERGED, and only `clean` / `verified-clean` print the clean sentinel.
  `postedOutcome` renders a `verify` that somehow reaches the poster as `unverified-clean`.
- Local as the chat-down fallback is an ordinary reviewer: chat unusable + local clean posts
  `clean`, the same as race.
- `OUTCOME_SHAPE` is a `Record` over the enum: adding a kind without deciding whether it converges
  fails the typecheck, and `review-outcome.test.ts` iterates `REVIEW_OUTCOMES` so it fails without
  a render row.
