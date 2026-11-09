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
| 2. Features | 1 per feature group | the review instructions, the feature's diff and context (`buildChatParts` local budget), the **PR map of every other file**, the PR description and policy docs | candidate findings, at most 4 per feature |
| 3. Refute | 1 per candidate, after the deterministic gate (at most 12) | the candidate plus evidence Ashlar collects itself: the cited code ±30 lines, the code each evidence step cites, definitions of the symbols the finding names, their uses in other changed files, the module docs for the file, the PR description, and PR map lines | `confirmed` / `refuted`, a proof quote and a severity |
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

- **Small lane.** A PR the pipeline reviews as one whole-PR feature (`fitsOneTurn`) waits in the lease's `small` lane: after short (JSON repair) and fix work, before large reviews.
- **Lending to small reviews.** At each turn boundary a large review lends the model to up to `ASHLAR_LOCAL_SMALL_REVIEWS_PER_CHECKPOINT` (default 1) waiting small reviews, then resumes ahead of every other queued job. oMLX keeps KV blocks on SSD, so the large review's prompt cache survives the lend.
- **Re-requests keep their place.** A job that supersedes a waiting or running job for the same PR keeps that job's queue time (`since`) instead of going to the back of the queue.

## Settings

| Field | Default | Meaning |
|---|---|---|
| `local_review.pipeline` | on | Off restores the grouped tool loop. |
| `local_review.pipeline_max_findings` | 5 | 1–8: the selection's cap. |
| `local_review.pipeline_verify_votes` | 1 | 1–3: refute turns per candidate. All must confirm. |
| `local_review.pipeline_lenses` | 3 | 1–3: candidate passes for a PR reviewed in one turn (1 = one combined pass). A PR split into features always gets one pass per feature. |
| `local_review.pipeline_keep_uncertain` | off | Post an undecided candidate at P2 when its own quote is real code. |

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
