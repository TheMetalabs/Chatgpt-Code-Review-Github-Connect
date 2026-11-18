# Staged local review (Settings `local_review.pipeline`, on by default)

## Why

The 2026-11 false-positive eval used aicc-center 4 PRs; the clearest comparison is #1251, where each reviewer ran on the same PR:

| Reviewer | Reviews | Posted findings | Per review |
|---|---|---|---|
| Grok (Chrome) | 5 | 2 | 0.4 |
| ChatGPT (Chrome) | 7 | 7 | 1.0 |
| Local, grouped tool loop | 4 | 26 | 6.5 |

All 40 judged findings came from local-only jobs: 34 were false positives, 3 valid and 3 unclear.

Three structural causes in the grouped loop explain most of the false positives:

1. **A group saw only its own files.** A guard in a sibling group's file read as "missing". This is "out-of-diff speculation", 12 of 34.
2. **No room to verify.** The first turn took 75% of the 24K loop cap. That left about 6K tokens, which is roughly one 400-line `file_read`. When the cap was reached the model was told "answer with what you have". This produced factual errors and unverified claims.
3. **Nothing ranked findings across the PR.** Each group added its own findings, so a review filled up to the 8-finding cap.

The chat reviewers do not have these problems. They see the whole PR in one turn, reason before they answer, and pick a few findings in that one answer. The pipeline gives the local model the same three properties: the whole-PR view, a chance to refute each finding, and a final pick. It does this as separate turns that each fit the local window.

## Stages

Every turn is a **fresh request**; nothing accumulates across turns. Each turn's prompt is sized to the local first-turn budget (`localFirstTurnBudgetTokens`), so it always fits the ~30K window with room left for the reply.

| Stage | Turns | Input | Output |
|---|---|---|---|
| 1. PR map | 1 per batch of ≤12 files | each file's diff (≤8K chars each) | one factual line per file: summary, guards, effects, plus the diff stat and changed exports Ashlar computes itself |
| 2. Features | 1 per feature group | the review instructions, the feature's diff and context (`buildChatParts` local budget), the **PR map of every other file**, the PR description and policy docs | candidate findings, at most 4 per feature, each failure written as "if <trigger>, <wrong result>" from the quoted code and evidence only |
| 3. Refute | 1 per candidate, after the deterministic gate (at most 12) | the candidate plus evidence Ashlar collects itself: the cited code ±30 lines, the code each evidence step cites, definitions of the symbols the finding names, their uses in other changed files, the module docs for the file, the PR description, and PR map lines | `confirmed` / `refuted` / `uncertain`, a proof quote and a severity; for a confirmation, whether the reported reason is the one found and, if not, the verifier's own title, failure and fix |
| 4. Select | 1 (skipped for ≤1 survivor) | the PR map and the confirmed findings | at most `local_review.pipeline_max_findings` (default 3), with duplicates merged |

**Feature groups.**
- Files linked by a relative import, or a test and its subject (same stem), form one group.
- A linked set larger than the group budget is cut along a breadth-first walk of its imports.
- Unlinked files are packed with their directory neighbours.
- Every reviewable changed file belongs to exactly one group.

**Refute rules.**
- A confirmation counts only when its proof quote is real code from the evidence's CODE section (`quoteInCode`). The PR description and the docs do not count as proof.
- The verifier may lower a severity, never raise it.
- With `local_review.pipeline_verify_votes` = 2 or 3, every vote must confirm.
- A verification that cannot run (transport error, or no verdict after one retry) and a candidate past the verify cap are counted in assumptions. When verified findings exist, these unjudged ones are not posted next to them; when none exist, they are kept as reported, severity unchanged. A failure never becomes a clean result.

**Sampling.**
- Feature turns use the configured local sampling.
- Map, refute and select turns use temperature 0.1 and presence penalty 0. Votes after the first use temperature 0.4.
- Override with `ASHLAR_LOCAL_PIPELINE_STRICT_TEMPERATURE` and `ASHLAR_LOCAL_PIPELINE_VOTE_TEMPERATURE`.

**Small PRs.** A PR that fits one request still runs single-turn. Stages 3 and 4 then run on its findings (`verifySingleTurn`).

**Unchanged semantics.**
- A feature whose reply never becomes review JSON is `unreviewed_paths`. Its replies are kept as evidence (`unparsedText`).
- If every feature fails, the leg fails.
- When every candidate is refuted, the review still lists `investigated_safe`.

**Ops comment.** The comment adds one line, for example `Local pipeline: 5 feature group(s), 14 candidate(s), 9 past the gate, 2 confirmed, 7 refuted, 2 posted (31 turns)`.

## Recall (2026-11-06)

After the pipeline shipped, precision was in hand but the local reviewer found almost nothing. On the same commit, Codex caught three defects that were later fixed: aicc-center #1473, #1462 and #1468. All three were small PRs, and each local review came back `findings: []`. No candidate reached the refute stage, so the loss happened at generation. Generation used the chat precision rules ("never report anything unverified, conditional or possible…", "delete a finding that…"), and with those rules a small model reports nothing.

Precision is enforced by the refute stage, so generation is now tuned for recall:

**Candidate generation**
- Candidate turns use `HUNT_INSTRUCTIONS` instead of `REVIEW_INSTRUCTIONS`. They are told to report every defect they can tie to a changed line, with that line quoted, because a verifier checks each candidate. Style, docs, naming, log wording and test advice are still not findings.
- A PR reviewed in one turn gets one candidate pass per lens (`local_review.pipeline_lenses`, default 3). A PR split into features gets one combined pass per feature (see Speed and precision below):
  - failure paths (catch / retry / async / partial failure, e.g. #1462's stale profile after a failed refresh);
  - data identity and invariants (key collisions, null, boundaries, e.g. #1468's same-name rows);
  - contracts (callers, callees, status codes, a test's expectation versus the implementation, e.g. #1473).
- The candidates from all passes are merged, and duplicates are removed (`dedupeCandidates`): a similar title on the same line, or a near-identical title whose evidence quotes the same code. A similar title alone never merges two locations.
- A file a reply marks in `unreviewed_paths` stays unreviewed, so an explicitly partial review is never a clean one.
- A PR whose diff fits one turn is reviewed as **one whole-PR feature** with no map, so the turn sees the whole change, as ChatGPT does.

**Gate**
- The gate's soft drops (`speculative`, `evidence_unverified`, `evidence_unavailable`) go to the refute stage instead of being dropped unread.
- Its hard drops still apply: already reported, self-retracted, contradicted by the diff or by the reply itself.
- Its note routing (docs, style, i18n, log, test advice) still applies, including to a soft drop: a hedged style remark is a note, not a candidate.

**Refute stage**
- A verdict is `confirmed`, `refuted` or `uncertain`.
- A refutation must quote the code or doc text that prevents the defect. One without such a quote counts as uncertain.
- A quote that is not verbatim still matches when its identifiers, literals and operators appear on one line of the code as one contiguous run, in order and with their case. Brackets, separators, string quotes and whitespace may differ. A different identifier, a changed case or an added or removed operator (`!isAdmin` for `isAdmin`) never matches.
- An uncertain candidate is posted at P2 only when `local_review.pipeline_keep_uncertain` is on (default off since 2026-11-09) and its own evidence quotes real code.

**Downstream gate**
- The posted findings the verifier confirmed, or kept as uncertain, are handed to the leg gate as **trusted verified keys** (`FindingGateExtras.verifiedKeys`), and the gate does not re-judge their hedges and evidence.
- The keys are set only by Ashlar for its own local leg, never from model JSON.
- The hard drops and the note routing still run.

**Posting cap.** The posting cap default is now 5.

## Speed and precision (2026-11-07)

WalkieBoard #566 (26 Swift files, 224K diff chars) took 2 and 4.5 hours for 84 and 87 turns, against 9–25 minutes for PRs of a similar size before the pipeline. It posted 5 false positives out of 9 findings, and 4 of the 5 carried "Verified against the code".

| Cause | Change |
|---|---|
| 15 features × 3 lenses = 45 candidate turns | Lenses only for a PR reviewed in one turn; one combined pass per feature otherwise. |
| 59 candidates for 16 verify slots | A feature of a larger PR asks for at most 3 candidates (a whole-PR turn: 6). |
| 40 unverified candidates reached the selection, listed as verified | Next to verified findings, an unverified one is not posted; the assumptions say how many. With none verified they are kept as reported, and labelled as not verified. |
| The verifier confirmed on a real quote alone | `VERIFY_RULES`: the report is presumed wrong until the code says otherwise; five checks (is the line changed, does the type allow it, is it handled, is it documented as intended, work the numbers through); the reply writes `trace` and `blocking_code` before `verdict`; "when in doubt, uncertain". |
| The verifier saw the head code, not the change | The evidence carries the cited line's diff hunk, or says the PR does not change that line. |
| Swift helpers were never found | The definition search knows `func`, `struct`, `protocol`, `extension`, `actor` (and Kotlin, Go, Rust forms). |
| TypeScript habits applied to Swift (`TaskCancelledError`) | `LANGUAGE_NOTES` per file extension in candidate and verify turns. |
| Claims about what a line "was" | Candidate turns tie a finding to a `+` line and may describe an old line only when its `-` line is in the diff. |
| Swift sources ranked as docs (`review-budget.ts` had no `.swift`) | `.swift`, `.m`, `.mm`, `.h`, `.c`, `.cc`, `.cpp`, `.hpp`, `.kts`, `.scala`, `.dart` are code, and a root `Tests/` folder is tests. A feature turn now carries its own source with line numbers; this also changes the chat reviewers' context for such repositories. |
| Every feature turn padded with ~24K chars of the PR's other files (tests, `Localizable.xcstrings`) | A feature of a split PR carries at most `PART_NON_CODE_MAX_CHARS` (6,000) of changed non-code files, prose docs (`.md`, `.txt`, …) first. |
| The verifier could not see the design doc the PR edits | Its evidence adds `CHANGED_DOCS` (the PR's prose docs, up to 10% of its budget). They are never proof code. |

Measured on #566's real diff with a mock model (turns and prompt characters; quality needs the real model):

| | Turns | Prompt chars | Candidate turns |
|---|---|---|---|
| Before (#181, 3 lenses) | 62 | 2.60M | 42 × ~53K |
| This change | 34 | 1.09M | 14 × ~45K, each with its own code context |

Production adds retry turns on top (84–87 turns before).

**Prompt prefix cache.** The local server (oMLX) reuses the KV cache of a prompt prefix it has already processed; on 2026-11-07 a request reused 8,192 of its 12,512 input tokens. The turns are ordered so that a PR's turns share as long a beginning as possible:

- a verify turn: the fixed `VERIFY_RULES`, then the PR description and the PR's changed docs (the same for every candidate), then the language notes, the candidate and its own evidence;
- a feature turn of a split PR: the instructions, PR description and reply shape (no per-feature `Changed:` line; FEATURE_GROUP names the files), then the repository rules, then the capped changed non-code files, then the feature's own code context, diff, PR map and feature block.

On #566's diff the prefix a turn shares with an earlier one went from 86K to 325K chars (7% → 28% of all prompt text, before the PR description is counted). A whole-PR turn keeps the usual order.

The verify turn now starts with its fixed rules, so every verify request shares the same prefix; a local server with prompt (prefix) caching reuses it. The ops line adds the elapsed minutes, for example `… 5 posted (41 turns, 52 min)`, and is no longer cut at 200 characters.

## Timing defects and failed feature turns (2026-11-07)

On WalkieBoard #569 Codex found one valid defect: `roomToRun` checks its deadline before each sleep but never after waking, so a late wake starts work past the deadline. The local review (#182 code, 27 turns, 37 min) never raised it. Its feature turn for that file succeeded and looked at the same line, but asked which errors `sleep` throws, and the verifier rightly refuted that. In the same run, 3 of 9 feature turns returned no usable review, leaving 12 files unreviewed.

- The general and failure lenses now ask for a deadline, timeout, cancellation or other state checked before an await, sleep, lock or retry and relied on after it without being checked again.
- `VERIFY_RULES` check 3: a guard prevents a failure only if it runs on the failing path after the state it checks could change; a check before a wait does not cover what happens during it.
- A multi-file feature group that returns no usable review (after its own retry) is retried one file at a time, up to `MAX_SPLIT_RETRY_FILES` (8) files per review. Files that still fail are unreviewed, and the ops line names them, for example `(1 failed, 3 file(s) retried alone, unreviewed: A.swift, B.swift)`.

## Context from other files, coverage, uncertain findings (2026-11-09)

After #183, aicc-center and WalkieBoard got 17 posted local findings, and none was valid. 10 were false positives, and 8 of those were refuted by code in another file: a callee (for example `revert(in:)`, or a request helper's signature), a caller that only renders a component for an existing row, a DTO length limit, a registry list, and the database collation. At least 4 posted findings were verifier-"uncertain". The model also marked nearly every file not_cleared (7 of 7 on a review whose every candidate was refuted).

- **Coverage is Ashlar's record.** A file whose feature turn returned a usable review is cleared. A file whose turn failed, that the reply marked unreviewed, or that has no usable diff is not_cleared. The candidate prompt no longer asks the model for a coverage list.
- **Feature turns get `CALLEE_DEFINITIONS`.** These are the definitions, in other files, of the names the feature's added lines call or render (`calledNames`), up to `CALLEE_DEFINITIONS_MAX_CHARS` (6,000). A TypeScript/JavaScript whole-PR turn already carries its imported definitions and does not get the block.
- **The verifier's evidence adds two things.** First, the definition of every name the cited lines and the candidate's quotes call, including plain lower-case methods. Second, up to three call sites of the function that holds the cited line (`enclosingName`), in any changed or reference file.
- **`VERIFY_RULES` check 6.** A failure that depends on what a caller passes, a client sends, the database or a library does, or a config or registry list holds is real only if the evidence shows a path that supplies it. It is refuted when the callers shown never pass it, or when validation, a schema, a constraint or a list rules it out. With no such path shown it is uncertain, never confirmed.
- **`local_review.pipeline_keep_uncertain` defaults to off.** An undecided candidate is not posted. A value already saved in Settings is kept.

On #566's and #569's real diffs (mock model) this adds about 7–8% prompt text, with the same number of turns.

## Small PRs in the queue (2026-11-09)

On aicc-center, small PRs took 1–2 minutes of pipeline time but 50–90 minutes from request to result. The extra time was spent waiting for the local model: the lease was one FIFO, and a large review held the model for 30–50 minutes.

- **Small lane.** A PR the pipeline reviews as one whole-PR feature (`fitsOneTurn`) with at most 4 reviewable files (`SMALL_REVIEW_MAX_FILES`, `isSmallReview`) waits in the lease's `small` lane: after short (JSON repair) and fix work, before large reviews. The file limit exists because a failed whole-PR turn split-retries per file: a PR that fit one turn but had many files took 23 turns while holding the small lane, so few files bound how long a small review holds the model.
- **Lending to small reviews.** At each turn boundary a large review lends the model to up to `ASHLAR_LOCAL_SMALL_REVIEWS_PER_CHECKPOINT` (default 1) waiting small reviews, then resumes ahead of every other queued job. oMLX keeps KV blocks on SSD, so the large review's prompt cache survives the lend.
- **Re-requests keep their place.** A job that supersedes a waiting or running job for the same PR keeps that job's queue time (`since`) instead of going to the back of the queue.

## Turn timing and fewer prefill tokens (2026-11-09)

The local server handles one request at a time, so a review's wall time is roughly the sum, over its turns, of prefill time and decode time. Until now the pipeline logged only each turn's finish reason and prompt size, so where the time went could not be seen.

- **Per-turn measurement.** Each turn's log line adds its wall time, the time to first token (only for a streamed reply), and the `usage` the server returns: prompt tokens, cached prompt tokens (`prompt_tokens_details.cached_tokens`, or a top-level `cached_tokens`) and output tokens, for example `pipeline verify[c3]#1: finish=stop chars=… 41.2s ttft=30.5s prompt=12512 cached=8192 out=310`. A field the server does not send is left out. The ops line adds totals per stage, for example `… (31 turns, 35 min) · map 2t 1.5m in 9.1K out 900 · feature 9t 21m in 98K cached 40% out 14K · verify 14t 12m in 160K cached 71% out 4.2K · select 1t 0.5m in 3K out 60`. Prefill time follows the uncached prompt tokens and decode time follows the output tokens. Cached tokens are counted only on turns that also report prompt tokens, so the cached share cannot pass 100%. Harbor's server log keeps only the first 300 characters of a line, which cuts the breakdown off the summary, so the pipeline also logs it on a line of its own: `pipeline stages: map 2t 1.5m … · select 1t 0.5m in 3K out 60`.
- **The select turn is kept.** It runs whenever two or more findings remain, even when few remain, because it is the only step that merges one defect reported in two files, and different feature groups do not prove two files unrelated (a group over budget is split, and Swift files are not linked by imports at all).
- **Verify turns ordered for the prompt cache.** The candidates to verify are the same as before (the most severe `MAX_VERIFIED_CANDIDATES`). Their turns now run grouped by file: files in the order of their most severe candidate, and each file's candidates in their own order. The survivors are still ranked in severity order. The cited file's `MODULE_DOCS` is the same for every candidate in that file, and often for the other files of its module too, so the verify request now puts it before the candidate rather than after the candidate's code. Its content and whether it fits are unchanged; only its position moves. On #566's and #569's diffs (mock model), consecutive verify requests went from sharing 34% and 18% of their text to 53% and 34%. Moving the module docs gives almost all of that; grouping by file alone adds little, because the candidate's own code still follows the candidate.

## Build/test-outcome claims and qualified calls (2026-11-17)

On a Swift repository the local reviewer often found the right suspicious code but gave a wrong reason. Three of five wrong reasons were claims about a build or test outcome that the authors' build and test gate had already disproved: "Compile error: String.split expects a Character" (the literal is inferred as a Character, and it builds), "Compilation fails: lines takes 2 arguments" (the call was to a different, same-named `lines` in an extension of another type), and "Running the test causes the assertion to fail" (the test passes).

- **Build/test-outcome claims are dropped before verification** (`local_review.pipeline_drop_build_claims`, default on). A candidate whose title, failure scenario or root cause claims a compile error, that the code does not compile or build, a type error or type mismatch, a failing build, a failing test or assertion, or a failing `XCTAssert…` never gets a verify turn. The patterns are in `BUILD_CLAIM_PATTERNS` (`isBuildOutcomeClaim`) and are kept conservative: `TypeError` written as one word (a Python or JavaScript runtime crash) never matches, a type error or mismatch next to runtime wording (crash, raise, throw, decoding, the response) is kept, and so is a test or assertion failure described as flaky or a crash. The drop runs before the dedupe, so a build claim cannot stand in for a runtime defect reported on the same line. The ops line counts them, for example `… 9 candidate(s), 2 build/test-outcome claim(s) dropped, 7 to verify, …`. The review sample carries no CI results (Ashlar fetches no check runs or commit statuses), so only the setting controls the drop: turn it off for a repository without a build and test gate.
- **A type-qualified call resolves inside that type.** `calledNames` still yields the bare name, but a call `Qualifier.name(` with a capitalised qualifier (a type, not an instance such as `store.save(`) now looks for `name` inside the body of a type or extension called Qualifier first (`callQualifiers`, `scopedDefinition`): Swift `enum`/`struct`/`class`/`actor`/`protocol`/`extension`, Kotlin `class`/`object`/`interface` and the extension function `fun Qualifier.name(`, TypeScript/JavaScript `class`/`namespace`. The body runs from the header line to where the brace depth returns to zero (approximate, one pass per file). Without such a declaration the lookup is the one before. Both `CALLEE_DEFINITIONS` (feature turns) and the verifier's evidence use it.

On the same repository, 11 posted local findings were 5 correct, 4 at the right place with a wrong reason and 2 false positives. The model found the suspicious construct (`try?`, a timer that decides a skip, an index without a length check, a +1 compensation, a comment that contradicts the code) and then gave a consequence from memory that was false: "waitForExistence blocks 13 s per page" (it returns as soon as the element exists; the defect was a 3 s timer that silently skips a capture on a slow machine), "the test assertion fails" (it passes; `texts[0...4]` crashes on fewer than 5 items). The verify turn, on the same model, judged that story: it confirmed the wrong reason or refuted it and lost the real defect.

- **The verify turn finds the reason** (no extra turn). `VERIFY_RULES` now asks whether the code at the reported place fails, and how: the report is a hypothesis whose place is usually right and whose reason may be wrong (the candidate block is labelled `CANDIDATE: REPORTED HYPOTHESIS`). The verifier says what the cited code does, looks for a concrete input from the code shown under which it goes wrong, and quotes the failing line; if none does, the verdict is refuted or uncertain. The reply adds `same_reason`, `title` (≤12 words), `failure` ("if <trigger>, <wrong result>") and `fix` after `proof_quote`, trace still first. A confirmation with `same_reason: false` is posted in the verifier's words: its title and failure, its trace as the root cause, its fix; the reporter's fix and test are dropped (the test line becomes a fixed "Cover the failure described above.", since a posted finding needs one). With `same_reason: true`, or without the new fields (the old reply shape), the reporter's text is kept. The precision guards stay: the proof quote must be code from the evidence, the checks (rule 6 included) apply to the verifier's own failure, a verifier failure that is a build/test-outcome claim (`isBuildOutcomeClaim`) is only uncertain, and so is a `same_reason: false` without a title, failure and fix. With more votes the reason comes from the first confirming vote. The ops line counts them: `2 confirmed (1 reframed)`.
- **No consequences from memory.** The hunt rules (feature turns) and `VERIFY_RULES` share one rule: a reason rests only on what the quoted code and evidence show, not on how a language, library, framework or OS behaves (unless the evidence or `LANGUAGE_NOTES` show it), not on timings, counts or sizes the code does not compute, and not on what the PR description says the code does; the failure is written as "if <trigger>, <wrong result>". The Swift `LANGUAGE_NOTES` (sent only for `.swift` files) add: a `"\n"` literal where a Character is expected is a Character, `"\r\n"` is one Character (so splitting on `"\n"` leaves CRLF text whole), XCTest `waitForExistence(timeout:)` returns as soon as the element exists, and `try?` turns any error into nil silently.

## Partial reviews, turn sizes and short replies (2026-11-18)

On a Swift repository a 15–23-turn run left some files unreviewed (their feature turns failed), and its only candidate was a compile-error claim, which the build-claim gate drops. It ended with no finding, and the pipeline sent `investigated_safe: []` because part of the change was unreviewed. The poster rejects that shape as "empty findings without investigated_safe — Instant-tier skip", so the job failed, the run was thrown away and the head was re-requested: three times in a row, each holding the local model for 1–4.5 hours.

- **A partial review with no finding is posted.** When at least one file was reviewed, no finding is left and some files were not reviewed, `investigated_safe` starts with a factual line, for example `Reviewed 3 of 4 files in feature turns; no defect was confirmed (0 candidate(s) refuted, 1 build/test claim(s) dropped); not reviewed: App/Sync.swift (feature turn failed)`, followed by the feature turns' own entries (`partialReviewLine`). `unreviewed_paths` and the `not_cleared` coverage are unchanged. When no file was reviewed, the result stays empty, as before.
- **It is never a clean pass.** The poster's gate accepts it and carries `unreviewed_paths` as `LiveGateResult.unreviewed`. In harbor's `gateLeg`, `incompleteVerdict` reads that as "N changed path(s) were not reviewed … and no finding is left to post", so the leg is not a complete verdict. It is gated as evidence (`verdictEvidence`), lands in `incompleteProviders`, and `reviewOutcome` gives `raw`, not `clean`. The review body posts the reply verbatim with "No complete review from local (reply posted as evidence)" and the marker `ashlar-findings … raw=1`, which `isConvergedFindings` never reads as CONVERGED. It never carries the clean sentence or an `ashlar-coverage` line.
- **Short replies.** In production, feature turns used 5–16K output tokens for a single file (many were cut at the 16,384-token cap), verify turns 2–6K and map turns 3–6K, far more than their JSON needs. The prompts now set output lengths. Feature turns (`HUNT_INSTRUCTIONS`): every text field is one or two short sentences, `evidence` quotes only the line(s) needed, `investigated_safe` is one short line per file, and the model stops after the JSON. Verify turns (`VERIFY_RULES`, still first in the request): `trace` is at most 2 sentences, `failure` and `fix` are one sentence each, and `blocking_code` / `proof_quote` hold only the deciding line(s). Map turns: a one-sentence summary, with guards and effects as short phrases. Select turn: no reasons. No precision rule was removed.

### Checking turn sizes in the logs

Each turn logs one line: `pipeline <stage>: finish=<reason> think=<on|off> chars=<prompt chars> <wall>s [ttft=<s>] [prompt=<n>] [cached=<n>] [out=<n>] reply=<n>c [reasoning=<n>c]`, for example `pipeline general[App/Sync.swift]: finish=length think=on chars=41230 312.4s ttft=40.1s prompt=11800 cached=6100 out=16384 reply=2210c reasoning=48120c`. `reply` is the length in characters of the reply's content, and `reasoning` is the length of the thinking text the server sent beside it (`reasoning_content`, which the stream aggregator collects, or `reasoning`). It is left out when the server sent none. `finish=length` means the turn hit the output cap (`local_review.max_tokens`), and its reply is retried once with a request to keep it short. A large `out` with a small `reply` and a large `reasoning` means the tokens went to thinking, not to the JSON. `think` says whether the turn was allowed to think (`local_review.pipeline_thinking`, below).

## Thinking per stage (2026-11-18)

The per-turn `reply=` / `reasoning=` fields showed that the local model (oMLX, a thinking model) thinks on every pipeline turn, and that the thinking is most of its output:

- Map turns, which only summarise facts: reply 1.7–5.9K chars against reasoning 11.5–18.4K chars, about 4–5K completion tokens and 75–180 s per turn.
- A feature turn: reply 1.7K chars against reasoning 22K chars (93% thinking).
- Turns cut at the 16384-token output cap (`finish=length`) are thinking that never ends: 500–650 s each. 61% of the same-prompt retries after a cut were cut again.

`local_review.pipeline_thinking` (env `ASHLAR_LOCAL_PIPELINE_THINKING`) decides which turns may think. A turn that may not is sent with `chat_template_kwargs: {enable_thinking: false}`, which the server honours (the JSON repair path already sends it, `local_repair_no_thinking`). Only the request body changes: the prompt, and so the cached prompt prefix, is the same.

- `on`: every turn thinks (the behaviour before this change); no kwargs are sent.
- `focused` (default): only the first attempt of a feature turn and of a verify turn thinks. Map turns (and their reformat retry), the select turn, and every retry (after a reply cut at the output cap, after a reply that was not JSON, after a review that showed no reviewed file) are sent with thinking off.
- `off`: no pipeline turn thinks.

Why `focused` is the default:

- Map and select summarise and rank what is already in the prompt; they need no exploration, so their thinking is time on the shared model for nothing.
- A retry after a cut-off that thinks again repeats the runaway (61% did); without thinking, the retry only re-emits a short JSON reply.
- Feature and verify turns find and check defects, which is where thinking can help. They keep it until a replay comparison (`ASHLAR_LOCAL_PIPELINE_THINKING=off npm run replay:local …` against `focused`, below) shows `off` keeps precision and recall.

A server that rejects the unknown `chat_template_kwargs` field needs `on`.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `local_review.pipeline` | on | Off restores the grouped tool loop. |
| `local_review.pipeline_max_findings` | 5 | 1–8: the selection's cap. |
| `local_review.pipeline_verify_votes` | 1 | 1–3: refute turns per candidate. All must confirm. |
| `local_review.pipeline_lenses` | 3 | 1–3: candidate passes for a PR reviewed in one turn (1 = one combined pass). A PR split into features always gets one pass per feature. |
| `local_review.pipeline_keep_uncertain` | off | Post an undecided candidate at P2 when its own quote is real code. |
| `local_review.pipeline_drop_build_claims` | on | Drop a candidate that claims a compile error or a failing test before it is verified (env `ASHLAR_LOCAL_PIPELINE_DROP_BUILD_CLAIMS`). |
| `local_review.pipeline_thinking` | focused | `on`, `focused` or `off`: which turns may think. `focused` lets only the first attempt of a feature or verify turn think; map, select and every retry are sent with `enable_thinking: false` (env `ASHLAR_LOCAL_PIPELINE_THINKING`). |

## Measuring it with the real model

The tests use a mocked model. The real effect has to be measured on the machine that serves the local model, from the live Ashlar checkout, so the same settings and model are used:

```
GITHUB_TOKEN=… npm run replay:local -- --pr TheMetalabs/aicc-center#1251 --head <reviewed sha> --base <base sha> \
  --mode all --labels /path/to/fp-eval/index.json --save-snapshot /tmp/1251.json --out /tmp/1251-report.json
```

- `--mode all` runs the pipeline and the old loop on the same snapshot.
- `--expect` takes the defects a review must catch (`[{file, keywords}]`) and scores recall. A case whose review fails counts its expected defects as missed. `--cases` runs many heads in one go (`[{pr, head, expect?}]`) and prints totals.
- Each run scores the posted findings against the judged eval labels (valid / false_positive / unclear / unjudged).
- Later runs can use `--snapshot /tmp/1251.json` and skip GitHub.

The targets:
- the valid #1397 finding is still posted;
- fewer false positives than the gate alone (82% removed on peer18);
- about 1–2 posted findings per review, as with ChatGPT.
