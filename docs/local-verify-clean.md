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
| `raw-unverified` | verification round, local's reply could not be used as a review (below) | summary mark + note | raw marker + ` unverified=1` | no |
| `incomplete` | 0 findings, no raw, a reviewer was skipped | summary mark (+ note in a verification round: agreed / did not complete) | none | no |
| `clean` | not a verifier, 0 findings, nothing skipped | `Didn't find any major issues.` | `total=0 …` | **yes** |
| `verified-clean` | verification round, local returned a structured clean result | `Didn't find any major issues.` | `total=0 …` | **yes** |
| `unverified-clean` | verification round, local failed / timed out / offline | `Chat found no major issues, but local verification did not complete …` | `total=0 … unverified=1` | no |

Rules the table encodes:

- A reply that could not be parsed is **evidence, never discarded**. Every leg's salvaged text is
  combined into the raw block (`salvagedReview`, which has no role or provider filter). A released
  held local leg that completes with a non-JSON reply becomes a salvaged leg (`heldLocalSalvage`)
  instead of "Skipped local", so in the verification round it posts as `raw-unverified` with its own
  header and a real finding in it reaches the fixing agent. Every completed reply counts: when the
  one JSON correction itself fails (HTTP 500, transport error, liveness or deadline abort), the first
  reply is still salvaged, and the multi-turn tool loop (`localReviewMode=multiturn`, or `auto` on a
  large PR) returns each failed group's completed reply the same way. A failure with no completed
  reply (HTTP 500, transport error, offline) stays a failure: `unverified-clean`.
- A released held local leg's reply counts as a verdict only when it passes the gate on its own with
  every finding it reported intact (`LiveGateResult.malformed` is 0), and no completed reply was set
  aside to get it: the one JSON correction never sees the first reply, so a clean correction says
  nothing about the finding that first reply may carry (`unparsedText`). A reply the gate rejects (for
  example a `findings` that is not a list, or an empty result without `investigated_safe`) or one
  that lost a finding for its shape is gated as evidence instead (`heldLocalEvidence` in
  `submitHarborChat`): whatever parsed, plus every completed reply verbatim as the raw block. So a
  verifier whose P1 the gate dropped never reads as "local verification agreed", and the note names
  why the reply could not be used.
- `unverified=1` is never CONVERGED, and only `clean` / `verified-clean` print the clean sentinel.
  `postedOutcome` renders a `verify` that somehow reaches the poster as `unverified-clean`.
- Local as the chat-down fallback is an ordinary reviewer: chat unusable + local clean posts
  `clean`, the same as race.
- `OUTCOME_SHAPE` is a `Record` over the enum: adding a kind without deciding whether it converges
  fails the typecheck, and `review-outcome.test.ts` iterates `REVIEW_OUTCOMES` so it fails without
  a render row.

## §2 Releasing the held local leg — only on an explicit terminal signal

`releaseHeldLocal(jobId, token, release, plan, legs)` in `harbor.server.ts` is the single release
point. It releases once (it sets `localVerifyStartedAt` or `localFallbackAt`, and does nothing when
either is already set), returns the job to `awaiting_chat` with the chat legs kept, starts the
local leg and makes sure a reviewer watcher waits for it.

It is called only on an **explicit terminal signal** of the chat round:

| Signal | Release | Caller |
| --- | --- | --- |
| The merged chat result is `verify` (§1: structured, 0 findings, no raw) | verification round (`localVerifyChat` = the chat reviewers whose structured result was clean) | `submitHarborChat` |
| Every chat leg finished without a usable payload (no valid JSON) | fallback | `submitHarborChat` |
| Every chat leg reached an explicit terminal outcome (quota, empty, tab closed, error) with no payload | fallback | watcher |
| The Chrome bridge reports disconnected for at least `BRIDGE_CONNECTED_MS`, measured from the disconnect, with no chat progress | fallback | watcher (`chatStalled`) |

What never releases it:

- job age or any timer on the job;
- `BRIDGE_CLAIM_MS` lease expiry — it is an ownership lease, not a reviewer deadline, and a bridge
  that stays connected keeps local held however long chat takes;
- a stale `generating` flag, or a `disconnected` provider error while the bridge is still connected.

Chat findings (or a chat raw reply) never release local at all: the chat result posts and the job's
terminal cleanup (§3) frees the snapshot. `tests/review/local-verify-lifecycle.e2e.mjs` rows L10–L12
pin the watcher signals, including a claim lease expiring under a connected bridge.

## §3 Terminal cleanup — one writer, one edge

`transitionJob(id, next)` in `harbor.server.ts` is the only writer of an existing job record. Every
path that ends a job goes through it: the watcher and merge paths, the posted write in `finishJob`,
operator cancel (`cancelHarborJob`) and supersession by a newer request for the same PR. The only
other job-array writes are `resetHarbor` (drops every job) and inserting a new job (`trimJobs`);
`tests/review/job-writer.test.mjs` pins that.

On the live → terminal edge it calls `releaseTerminalJob` once. A terminal status is an explicit
terminal signal:

- The local snapshot is freed, unless a local leg is in flight (that leg holds its own reference and
  frees the entry in its `finally`). A verify-clean job whose local leg never ran would otherwise keep
  it forever.
- Only `cancelled` (operator or supersession) aborts the in-flight local request and clears its
  activity and liveness state. `posted`, `skipped` and `dlq` never abort local generation, so race
  behavior is unchanged.
- The reviewer watcher is not stopped here: it exits on its next tick that sees a terminal status.

`tests/review/local-verify-lifecycle.e2e.mjs` has one row per terminal path (posted, cancelled while
held or while local runs, superseded while held or while local runs, dlq, skipped fallback, race)
asserting status, local requests, snapshot release, reviews, watcher exit and abort.
